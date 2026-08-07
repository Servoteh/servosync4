import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { sanitizeDrawingNo } from "../../common/drawings";
import {
  assertAttachments,
  assertPdfAttachment,
  IMAGE_ATTACHMENT_FORMATS,
} from "../../common/attachments/attachment-format.util";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
// Matični podaci (predmeti/komitenti) se od 07.08.2026 čitaju iz 3.0 glavne baze —
// `AppPrisma` je tagged-template motor te baze (sy15 `Prisma` ostaje za sve ostalo).
import { Prisma as AppPrisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { AI_MODULE } from "../../common/ai/ai-limits.service";
import {
  AI_TASK,
  AiModelPolicyService,
} from "../../common/ai/ai-model-policy.service";
import {
  MONTAZA_INJECTION_FENCE,
  fenceUserInput,
} from "../../common/ai/injection-fence";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import type { ReportsQueryDto } from "./dto/plan-montaze-query.dto";
import type {
  AiGenerateDto,
  CreateReportDto,
  LinkPredmetDto,
  UpdatePhaseDto,
  UpdateProjectDto,
  UpdateWorkPackageDto,
  UpsertPhaseDto,
  UpsertProjectDto,
  UpsertWorkPackageDto,
} from "./dto/plan-montaze-mutation.dto";
import {
  MONTAZA_AI_ALLOWED_MODELS,
  MONTAZA_AI_DEFAULT_MODEL,
  MONTAZA_AI_SYSTEM_PROMPT,
  MONTAZA_AI_TOOL,
  MONTAZA_MAX_SLIKA_B64,
  MONTAZA_MAX_SLIKE,
  MONTAZA_MAX_TEKST_CHARS,
  MONTAZA_VISION_MIME,
  normalizeMontazaOut,
  type MontazaAiOut,
} from "./montaza-ai";

const MONTAZA_BUCKET = "montaza-izvestaji";

/**
 * Broj crteža iz Plana montaže (`phases.linked_drawings`) → ključ 3.0 `drawing_pdfs`.
 *
 * Stari sy15 keš je držao broj i reviziju SPOJENE u jednoj koloni (`drawing_no`), 3.0 ih
 * drži ODVOJENO (`drawing_number` + `revision`, složeni PK). Pravilo spajanja je izmereno
 * na produ 07.08.2026, ne pretpostavljeno:
 *
 *   drawing_no  ===  drawing_number || '_' || revision
 *
 * Potvrde:
 *   • SVIH 5.426 aktivnih `drawing_no` ima TAČNO JEDNU donju crtu (0 sa dve+, 0 bez) →
 *     podela je jednoznačna, prva i poslednja `_` daju identičan rezultat (5.426/5.426).
 *   • `drawing_pdfs.file_name` je doslovno `{drawing_number}_{revision}.pdf` (npr. `1125707_C.pdf`).
 *   • Prazna revizija je LEGITIMNA (209 redova u 3.0): `1029554_` → broj `1029554`, revizija ``.
 *     Zato se NE odbacuje prazan drugi deo i NE radi se `filter(Boolean)`.
 *   • Poklapanje starog keša sa 3.0: 5.426/5.426 (100%), svih 5.426 ima `pdf_binary`.
 *     3.0 je NADSKUP — ima još 670 parova kojih u kešu nema.
 *
 * Vraća `null` za kod bez donje crte (nije validan ključ `drawing_pdfs`) → pozivalac 404/exists:false.
 */
export function splitDrawingCode(
  code: string,
): { drawingNumber: string; revision: string } | null {
  const s = String(code ?? "").trim();
  const i = s.lastIndexOf("_");
  if (i <= 0) return null;
  return { drawingNumber: s.slice(0, i), revision: s.slice(i + 1) };
}

type ProjectRow = {
  id: string;
  project_code: string;
  project_name: string;
  status: string | null;
  predmet_item_id: number | null;
  projectm: string | null;
  project_deadline: Date | null;
  pm_email: string | null;
  leadpm_email: string | null;
  reminder_enabled: boolean | null;
};

/**
 * Plan montaže + izveštaji montera — 3.0 TALAS C, R1 read sloj
 * (MODULE_SPEC_planovi_pracenje_30.md §3). Public tabele (projects/WP/phases,
 * montaza_izvestaji/_fotke, montaza_ai_settings) kroz Prisma/$queryRaw,
 * sve u `withUserRls`. **Izuzetak od 07.08.2026:** matični podaci (predmeti/komitenti)
 * se čitaju iz 3.0 glavne baze (`projects`/`customers`, `PrismaService`) — sy15
 * `bigtehn_items_cache`/`bigtehn_customers_cache` više se NE koriste (v. `lookupPredmeti`).
 * Lista projekata = `pb_list_projects()` (DEFINER RPC, projekti
 * ⋈ predmet_aktivacija je_aktivan∧je_projektovanje_montaza). Mutacije (faze/WP/projekt
 * upsert, izveštaji POST + AI port + storage) su R2.
 */
@Injectable()
export class PlanMontazeService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
    private readonly ai: AiProviderService,
    private readonly policy: AiModelPolicyService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------- Projekti (stablo) ----------

  /**
   * Stablo projekat→WP→faze JEDNIM logičkim čitanjem (PRESUDA C8: 1.0 radi N+1, 2.0
   * batch-uje u 3 upita bez N+1; semantika/redosled isti). Lista projekata iz
   * `pb_list_projects()` (aktivacija-filter), WP/faze iz Prisma tabela.
   */
  async projectsTree(email: string) {
    return this.read(email, async (tx) => {
      const projects = await tx.$queryRaw<ProjectRow[]>(
        Prisma.sql`SELECT * FROM pb_list_projects()`,
      );
      const projectIds = projects.map((p) => p.id);
      type Wp = Awaited<ReturnType<typeof tx.pmWorkPackage.findMany>>[number];
      type Ph = Awaited<ReturnType<typeof tx.pmPhase.findMany>>[number];
      let wps: Wp[] = [];
      let phases: Ph[] = [];
      if (projectIds.length) {
        [wps, phases] = await Promise.all([
          tx.pmWorkPackage.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: [{ rnOrder: "asc" }, { sortOrder: "asc" }],
          }),
          tx.pmPhase.findMany({
            where: { projectId: { in: projectIds } },
            orderBy: [{ sortOrder: "asc" }],
          }),
        ]);
      }

      const phasesByWp = new Map<string, Ph[]>();
      for (const ph of phases) {
        const arr = phasesByWp.get(ph.workPackageId) ?? [];
        arr.push(ph);
        phasesByWp.set(ph.workPackageId, arr);
      }
      const wpsByProject = new Map<string, unknown[]>();
      for (const wp of wps) {
        const arr = wpsByProject.get(wp.projectId) ?? [];
        arr.push({ ...wp, phases: phasesByWp.get(wp.id) ?? [] });
        wpsByProject.set(wp.projectId, arr);
      }
      const tree = projects.map((p) => ({
        ...p,
        workPackages: wpsByProject.get(p.id) ?? [],
      }));
      return { data: jsonSafe(tree) };
    });
  }

  // ---------- Izveštaji montera ----------

  /** Lista izveštaja (paritet listIzvestaji: filter status + q pretraga po 6 polja, created_at desc). */
  async listReports(email: string, q: ReportsQueryDto) {
    const limit = Math.max(1, Math.min(Number(q.limit) || 300, 1000));
    const term = (q.q ?? "").trim();
    return this.read(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      if (term) {
        const like = `%${term}%`;
        conds.push(
          Prisma.sql`(broj_izvestaja ILIKE ${like} OR predmet_broj ILIKE ${like}
            OR naziv_projekta ILIKE ${like} OR klijent ILIKE ${like}
            OR lokacija ILIKE ${like} OR autor_ime ILIKE ${like})`,
        );
      }
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, broj_izvestaja, status, datum_rada, predmet_broj, naziv_projekta,
            klijent, lokacija, pocetak_rada, kraj_rada, opis_radova, problemi, otvorene_stavke,
            dodatni_clanovi, autor_ime, sirovi_tekst, ai_model, pdf_path, pdf_naziv, created_at
          FROM montaza_izvestaji ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Detalj izveštaja + fotke (meta). Signed URL fotki/PDF-a = R2 (storage proxy). */
  async reportDetail(email: string, id: string) {
    return this.read(email, async (tx) => {
      const report = await tx.pmIzvestaj.findUnique({ where: { id } });
      if (!report) throw new NotFoundException(`Izveštaj ${id} ne postoji`);
      const fotke = await tx.pmIzvestajFoto.findMany({
        where: { izvestajId: id },
        orderBy: [{ redniBroj: "asc" }],
      });
      return { data: { ...jsonSafe(report), fotke: jsonSafe(fotke) } };
    });
  }

  /** Fotke izveštaja (meta; storage bucket montaza-izvestaji). */
  async reportPhotos(email: string, id: string) {
    return this.read(email, async (tx) => {
      const data = await tx.pmIzvestajFoto.findMany({
        where: { izvestajId: id },
        orderBy: [{ redniBroj: "asc" }],
      });
      return { data: jsonSafe(data) };
    });
  }

  /** Model za AI strukturiranje izveštaja (montaza_ai_settings singleton; PUT = R2 admin). */
  async aiModel(email: string) {
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: number;
          model: string;
          updated_at: Date;
          updated_by: string | null;
        }[]
      >(
        Prisma.sql`SELECT id, model, updated_at, updated_by FROM montaza_ai_settings WHERE id = 1`,
      );
      return { data: rows[0] ?? null };
    });
  }

  // ---------- Lookups ----------

  /**
   * Pretraga predmeta — ilike po broj/naziv/ugovor/narudžbenica, + naziv komitenta.
   *
   * ⚠️ `onlyActive` je DEFAULT `false` — paritet 1.0 montaža „Poveži predmet" picker-a
   * (`searchBigtehnItems(q,40,{onlyActive:false})`, izvestajiView.js): serviser vezuje
   * izveštaj na ZATVOREN predmet (servisni rad ide POSLE zatvaranja projekta). Aktivni-only
   * filter se primenjuje SAMO kad se traži.
   *
   * ── IZVOR: 3.0 `projects`/`customers`, NE sy15 `bigtehn_*_cache` (odluka 07.08.2026:
   * „komitente, predmete i artikle koristimo SAMO iz nove baze 3.0"). Bez prekidača izvora
   * (za razliku od sastanaka, gde se u sy15 PISALO) — ovde je čitanje, a stari keš je
   * dokazano MRTAV, ne alternativa. Izmereno na produkciji 07.08.2026:
   *
   *   • Stari keš puni bridge `syncItems.js` iz **SQL Servera** (QBigTehn), koji je ugašen
   *     22.07.2026: `max(modified_at)` = `2026-07-22 08:47:03` i tu stoji. 3.0 `projects`
   *     puni ŽIVI `.mdb` kanal iz BigBita (`bb_mdb_stage_predmeti`, drop 06.08.2026).
   *   • Zato keš LAŽE o statusu: 1.861 predmeta koje BigBit danas vodi kao `GOTOVO` keš
   *     još drži na `U TOKU`. Provereno u sirovom drop-u (id 10450/10442/10439/10437/
   *     10429/10403 → svi `GOTOVO` u BigBitu, svi `U TOKU` u kešu).
   *   • `onlyActive=true`: keš 1.804 reda, 3.0 **91** — i BigBit drop nezavisno daje
   *     tačno 91. Sužavanje je ISPRAVKA (keš je pokazivao zatvorene kao aktivne),
   *     ne regresija. Vrednosti statusa su iste u oba izvora (`U TOKU` / `GOTOVO`).
   *   • 3.0 je nadskup: 7.633 vs 7.626 reda; keš staje na `id` 10486, 3.0 ima i
   *     10487–10493. Komitenti 6.259 vs 6.251.
   */
  async lookupPredmeti(email: string, q?: string, onlyActiveRaw?: string) {
    const s = (q ?? "").trim();
    const like = s ? `%${s}%` : null;
    const onlyActive = ["1", "true", "yes"].includes(
      String(onlyActiveRaw ?? "").toLowerCase(),
    );
    // Isti kanon kao pre, samo 3.0 imena kolona: `datum_zakljucenja` → `closed_at`.
    const activeFilter = onlyActive
      ? AppPrisma.sql`p.status = 'U TOKU' AND p.closed_at IS NULL`
      : AppPrisma.sql`TRUE`;
    // `email` se ne koristi za RLS (3.0 matični podaci nisu RLS-ovani, isto kao
    // plan-proizvodnje read sloj); pravo se proverava na kontroleru (MONTAZA_READ).
    void email;
    const items = await this.prisma.$queryRaw<
      Array<Record<string, unknown> & { id: number; customer_id: number | null }>
    >(
      // Aliasi drže FE ugovor (`PredmetOption`, frontend/src/api/plan-montaze.ts)
      // NEPROMENJENIM — ekrani montaže i dalje dobijaju `broj_predmeta`/`naziv_predmeta`/…
      //
      // `created_at AS modified_at` NIJE improvizacija: 3.0 `projects.created_at` je
      // BigBit `Predmeti.DatumIVreme` — ISTA kolona koju je bridge upisivao u
      // `bigtehn_items_cache.modified_at` (`DatumIVreme AS modified_at`, syncItems.js).
      // Provereno 7.630/7.631 uparenih redova identično sa sirovim drop-om.
      //
      // Sort ostaje `DESC NULLS LAST`, ali sada RADI: u kešu su 9 NAJNOVIJIH predmeta
      // (10478–10486) imali `modified_at IS NULL`, pa ih je `NULLS LAST` gurao na dno i
      // u podrazumevanoj listi (q prazno) se NIKAD nisu videli. U 3.0 NULL ima samo 502
      // predmeta iz 2016 (id 2338–2882) — njih je i ispravno držati na dnu.
      // `id DESC` je dodat kao tie-breaker: keš je imao bulk-pečat na milisekundu
      // (10465 i 10469 oba `08:47:03.05`), pa je poredak pri `LIMIT 50` bio nasumičan.
      AppPrisma.sql`SELECT p.id,
          p.project_number  AS broj_predmeta,
          p.project_name    AS naziv_predmeta,
          p.description     AS opis,
          p.status,
          p.work_unit_code  AS department_code,
          p.contract_number AS broj_ugovora,
          p.order_number    AS broj_narudzbenice,
          p.deadline        AS rok_zavrsetka,
          p.created_at      AS modified_at,
          p.closed_at       AS datum_zakljucenja,
          p.customer_id
        FROM projects p
        WHERE ${activeFilter}
          ${like ? AppPrisma.sql`AND (p.project_number ILIKE ${like} OR p.project_name ILIKE ${like} OR p.contract_number ILIKE ${like} OR p.order_number ILIKE ${like})` : AppPrisma.empty}
        ORDER BY p.created_at DESC NULLS LAST, p.id DESC LIMIT 50`,
    );
    const custIds = [
      ...new Set(items.map((r) => r.customer_id).filter((v) => v != null)),
    ] as number[];
    let custMap = new Map<number, { name: string; short_name: string | null }>();
    if (custIds.length) {
      const custRows = await this.prisma.$queryRaw<
        { id: number; name: string; short_name: string | null }[]
      >(
        AppPrisma.sql`SELECT id, name, short_name FROM customers WHERE id IN (${AppPrisma.join(custIds)})`,
      );
      custMap = new Map(custRows.map((c) => [c.id, c]));
    }
    const data = items.map((r) => ({
      ...r,
      customer_name:
        r.customer_id != null ? (custMap.get(r.customer_id)?.name ?? null) : null,
    }));
    return { data: jsonSafe(data) };
  }

  /**
   * Exists-check brojeva crteža — od 07.08.2026 iz 3.0 `drawing_pdfs` (v. `splitDrawingCode`).
   * Paritet 1.0: vraća samo brojeve za koje POSTOJI PDF sa sadržajem (`pdf_binary`).
   *
   * `storage_path` je UKLONJEN iz odgovora: bio je putanja u sy15 storage bucket-u
   * `bigtehn-drawings`, a 3.0 drži bajtove u bazi — putanja više ne postoji kao pojam.
   * Nijedna FE komponenta ga nije čitala (samo deklaracija u `DrawingExists`), pa je
   * uklanjanje bezbedno; `file_name` ostaje (`drawing_pdfs.file_name`, npr. `1125707_C.pdf`).
   */
  async lookupDrawings(email: string, codes: string) {
    const list = [
      ...new Set(
        (codes ?? "")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean),
      ),
    ];
    if (!list.length) return { data: [] };
    // 3.0 matični crteži nisu RLS-ovani (isto kao `lookupPredmeti`); pravo je na kontroleru.
    void email;
    const pairs = list
      .map((code) => ({ code, split: splitDrawingCode(code) }))
      .filter((p) => p.split != null) as {
      code: string;
      split: { drawingNumber: string; revision: string };
    }[];
    const found = new Map<string, string | null>();
    if (pairs.length) {
      const rows = await this.prisma.$queryRaw<
        { drawing_number: string; revision: string; file_name: string | null }[]
      >(
        AppPrisma.sql`SELECT drawing_number, revision, file_name FROM drawing_pdfs
          WHERE pdf_binary IS NOT NULL
            AND (drawing_number, revision) IN (${AppPrisma.join(
              pairs.map(
                (p) =>
                  AppPrisma.sql`(${p.split.drawingNumber}, ${p.split.revision})`,
              ),
            )})`,
      );
      for (const r of rows)
        found.set(`${r.drawing_number}_${r.revision}`, r.file_name);
    }
    const data = list.map((code) => {
      const s = splitDrawingCode(code);
      const key = s ? `${s.drawingNumber}_${s.revision}` : null;
      return {
        drawing_no: code,
        exists: key != null && found.has(key),
        file_name: key != null ? (found.get(key) ?? null) : null,
      };
    });
    return { data };
  }

  /**
   * URL PDF-a crteža (chip „Veza sa crtežima" u fazi) — od 07.08.2026 iz 3.0 `drawing_pdfs`.
   *
   * Ranije je vraćao POTPISAN URL ka sy15 storage bucket-u `bigtehn-drawings` (TTL 300s).
   * 3.0 nema object storage — bajtovi su `drawing_pdfs.pdf_binary` (bytea) — pa se, po
   * PRESEDANU praćenja (`pracenje-read.service.ts` `crtezSignUrl`), vraća auth-gated
   * content ruta ovog istog modula. Oblik `{ url, expiresIn }` je NEPROMENJEN;
   * `expiresIn: 0` = nema potpisa/TTL-a, autorizacija ide kroz JWT + `montaza.drawings_read`.
   *
   * ⚠️ Ključ je `drawing_number` + `revision`, a NE `drawings.id` (kako radi praćenje):
   * izmereno 07.08.2026 na produ — 354 reda u `drawing_pdfs` NEMA parnjaka u `drawings`,
   * a 346 od njih je aktivno u starom kešu, tj. montaža ih danas otvara. Razrešavanje
   * kroz `drawings` bi tih 346 crteža TIHO oborilo na 404.
   */
  async drawingSignUrl(email: string, code: string) {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    void email;
    await this.assertDrawingPdfExists(clean);
    return {
      data: {
        url: `/api/v1/montaza/lookups/drawings/pdf/content?code=${encodeURIComponent(clean)}`,
        expiresIn: 0,
      },
    };
  }

  /** 404 ako broj nije u `drawing_pdfs` ili nema binarnog sadržaja (bez čitanja bajtova). */
  private async assertDrawingPdfExists(clean: string): Promise<void> {
    const s = splitDrawingCode(clean);
    if (!s) throw new NotFoundException(`Crtež ${clean} nije pronađen.`);
    const rows = await this.prisma.$queryRaw<{ ok: boolean }[]>(
      AppPrisma.sql`SELECT (pdf_binary IS NOT NULL) AS ok FROM drawing_pdfs
        WHERE drawing_number = ${s.drawingNumber} AND revision = ${s.revision} LIMIT 1`,
    );
    if (!rows[0]?.ok)
      throw new NotFoundException(`Crtež ${clean} nije pronađen.`);
  }

  /**
   * Strim uskladištenog PDF-a crteža (`drawing_pdfs.pdf_binary`) — zamena za sy15 signed URL.
   * Gate je na kontroleru (`montaza.drawings_read`). Bajtovi se učitavaju SAMO ovde;
   * liste/exists-check NIKAD ne selektuju `pdf_binary` (v. `DRAWING_PDF_SELECT` doktrina).
   */
  async streamDrawingPdf(
    code: string,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const clean = sanitizeDrawingNo(code);
    if (!clean) throw new BadRequestException("Neispravan broj crteža.");
    const s = splitDrawingCode(clean);
    if (!s) throw new NotFoundException(`Crtež ${clean} nije pronađen.`);
    const rows = await this.prisma.$queryRaw<
      { pdf_binary: Buffer | null; file_name: string | null }[]
    >(
      AppPrisma.sql`SELECT pdf_binary, file_name FROM drawing_pdfs
        WHERE drawing_number = ${s.drawingNumber} AND revision = ${s.revision} LIMIT 1`,
    );
    const row = rows[0];
    if (!row?.pdf_binary)
      throw new NotFoundException(
        `PDF crteža ${clean} nema uskladišten sadržaj.`,
      );
    return {
      buffer: Buffer.from(row.pdf_binary),
      fileName: row.file_name?.trim() || `${clean}.pdf`,
    };
  }

  // ==========================================================================
  // R2 — MUTACIJE (REST write kroz withUserRls; row-odluka has_edit_role/autor u DB)
  // ==========================================================================
  // PM CRUD = upsert-po-id (paritet 1.0 buildXPayload; sort_order = rn_order; faze
  // `checks` = 8-bool niz, `linked_drawings` = string niz). Sve pod SET LOCAL ROLE
  // authenticated (withUserRls) → RLS `has_edit_role(project_id)` presuđuje (42501→403,
  // P2025→403). NE dupliramo scope u TS. `updated_by` faze = email (server).

  // ---------- Projekti ----------

  /** Upsert projekat (POST; upsert-po-id ako je `id` poslat). RLS has_edit_role → 403. */
  async upsertProject(email: string, dto: UpsertProjectDto) {
    const data = {
      projectCode: dto.projectCode,
      projectName: dto.projectName,
      projectm: dto.projectm ?? undefined,
      projectDeadline: this.toDbDate(dto.projectDeadline),
      pmEmail: dto.pmEmail ?? undefined,
      leadpmEmail: dto.leadpmEmail ?? undefined,
      status: dto.status ?? undefined,
      updatedAt: new Date(),
    };
    return this.mut(email, async (tx) => {
      const row = dto.id
        ? await tx.pmProject.upsert({
            where: { id: dto.id },
            create: { id: dto.id, ...data },
            update: data,
          })
        : await tx.pmProject.create({ data });
      return { data: jsonSafe(row) };
    });
  }

  async updateProject(email: string, id: string, dto: UpdateProjectDto) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmProject.count({ where: { id } });
      const r = await tx.pmProject.updateMany({
        where: { id },
        data: {
          projectCode: dto.projectCode ?? undefined,
          projectName: dto.projectName ?? undefined,
          projectm: dto.projectm ?? undefined,
          projectDeadline: this.toDbDate(dto.projectDeadline),
          pmEmail: dto.pmEmail ?? undefined,
          leadpmEmail: dto.leadpmEmail ?? undefined,
          status: dto.status ?? undefined,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists > 0, r.count, `Projekat ${id}`);
      return { data: { id } };
    });
  }

  async deleteProject(email: string, id: string) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmProject.count({ where: { id } });
      const r = await tx.pmProject.deleteMany({ where: { id } });
      this.assertAffected(exists > 0, r.count, `Projekat ${id}`);
      return { data: { id } };
    });
  }

  // ---------- Work packages (nalog montaže) ----------

  /** Upsert WP; `sort_order` prati `rn_order` (paritet 1.0 buildWPPayload). */
  async upsertWorkPackage(email: string, dto: UpsertWorkPackageDto) {
    const data = {
      projectId: dto.projectId,
      rnCode: dto.rnCode ?? undefined,
      rnOrder: dto.rnOrder ?? undefined,
      name: dto.name,
      location: dto.location ?? undefined,
      responsibleEngineerDefault: dto.responsibleEngineerDefault ?? undefined,
      montageLeadDefault: dto.montageLeadDefault ?? undefined,
      deadline: this.toDbDate(dto.deadline),
      sortOrder: dto.rnOrder ?? undefined, // sort_order == rn_order (§ 1.0)
      isActive: dto.isActive ?? undefined,
      assemblyDrawingNo:
        dto.assemblyDrawingNo != null
          ? String(dto.assemblyDrawingNo).trim()
          : undefined,
      updatedAt: new Date(),
    };
    return this.mut(email, async (tx) => {
      const row = dto.id
        ? await tx.pmWorkPackage.upsert({
            where: { id: dto.id },
            create: { id: dto.id, ...data },
            update: data,
          })
        : await tx.pmWorkPackage.create({ data });
      return { data: jsonSafe(row) };
    });
  }

  async updateWorkPackage(
    email: string,
    id: string,
    dto: UpdateWorkPackageDto,
  ) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmWorkPackage.count({ where: { id } });
      const r = await tx.pmWorkPackage.updateMany({
        where: { id },
        data: {
          rnCode: dto.rnCode ?? undefined,
          rnOrder: dto.rnOrder ?? undefined,
          name: dto.name ?? undefined,
          location: dto.location ?? undefined,
          responsibleEngineerDefault:
            dto.responsibleEngineerDefault ?? undefined,
          montageLeadDefault: dto.montageLeadDefault ?? undefined,
          deadline: this.toDbDate(dto.deadline),
          sortOrder: dto.rnOrder ?? undefined,
          isActive: dto.isActive ?? undefined,
          assemblyDrawingNo:
            dto.assemblyDrawingNo != null
              ? String(dto.assemblyDrawingNo).trim()
              : undefined,
          updatedAt: new Date(),
        },
      });
      this.assertAffected(exists > 0, r.count, `Nalog montaže ${id}`);
      return { data: { id } };
    });
  }

  async deleteWorkPackage(email: string, id: string) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmWorkPackage.count({ where: { id } });
      const r = await tx.pmWorkPackage.deleteMany({ where: { id } });
      this.assertAffected(exists > 0, r.count, `Nalog montaže ${id}`);
      return { data: { id } };
    });
  }

  // ---------- Faze ----------

  /** Upsert faza; `checks` = 8-bool niz, `linked_drawings` = dedup string niz. */
  async upsertPhase(email: string, dto: UpsertPhaseDto) {
    const shared = this.phaseData(dto, email);
    const createData = {
      projectId: dto.projectId,
      workPackageId: dto.workPackageId,
      phaseName: dto.phaseName,
      checks: (dto.checks ?? new Array(8).fill(false)) as Prisma.InputJsonValue,
      linkedDrawings: this.cleanDrawings(dto.linkedDrawings),
      ...shared,
    };
    return this.mut(email, async (tx) => {
      const row = dto.id
        ? await tx.pmPhase.upsert({
            where: { id: dto.id },
            create: { id: dto.id, ...createData },
            update: {
              phaseName: dto.phaseName,
              ...shared,
              ...(dto.checks !== undefined ? { checks: dto.checks } : {}),
              ...(dto.linkedDrawings !== undefined
                ? { linkedDrawings: this.cleanDrawings(dto.linkedDrawings) }
                : {}),
            },
          })
        : await tx.pmPhase.create({ data: createData });
      return { data: jsonSafe(row) };
    });
  }

  async updatePhase(email: string, id: string, dto: UpdatePhaseDto) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmPhase.count({ where: { id } });
      const r = await tx.pmPhase.updateMany({
        where: { id },
        data: {
          ...(dto.phaseName !== undefined ? { phaseName: dto.phaseName } : {}),
          ...this.phaseData(dto, email),
          ...(dto.checks !== undefined ? { checks: dto.checks } : {}),
          ...(dto.linkedDrawings !== undefined
            ? { linkedDrawings: this.cleanDrawings(dto.linkedDrawings) }
            : {}),
        },
      });
      this.assertAffected(exists > 0, r.count, `Faza ${id}`);
      return { data: { id } };
    });
  }

  async deletePhase(email: string, id: string) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmPhase.count({ where: { id } });
      const r = await tx.pmPhase.deleteMany({ where: { id } });
      this.assertAffected(exists > 0, r.count, `Faza ${id}`);
      return { data: { id } };
    });
  }

  // ---------- Izveštaji montera ----------

  /**
   * Kreiranje izveštaja — idempotentno preko klijentskog UUID `id` (doktrina A4;
   * postojeći mehanizam 1.0). INSERT WITH CHECK autor_user_id=auth.uid() (DB default
   * iz GUC sub-a); broj dodeljuje BEFORE INSERT trigger (IZV-GGGG-NNNN). Retry sa
   * istim `id` → vraća sačuvan rezultat bez ponovnog upisa.
   */
  async createReport(email: string, dto: CreateReportDto) {
    try {
      const out = await this.sy15.runIdempotentRls(
        email,
        dto.id,
        "montaza.create-izvestaj",
        async (tx) => {
          const row = await tx.pmIzvestaj.create({
            data: {
              id: dto.id,
              status: dto.status ?? "u_toku",
              datumRada: this.toDbDate(dto.datum),
              predmetItemId: dto.predmetItemId ?? null,
              predmetBroj: dto.predmet ?? null,
              nazivProjekta: dto.nazivProjekta ?? null,
              klijent: dto.klijent ?? null,
              lokacija: dto.lokacija ?? null,
              pocetakRada: dto.pocetakRada ?? null,
              krajRada: dto.krajRada ?? null,
              opisRadova: dto.opisRadova ?? null,
              problemi: dto.problemi ?? null,
              otvoreneStavke: dto.otvoreneStavke ?? null,
              dodatniClanovi: dto.dodatniClanovi ?? [],
              autorIme: dto.autorIme ?? null,
              siroviTekst: dto.siroviTekst ?? null,
              aiModel: dto.aiModel ?? null,
              aiJson: (dto.aiJson ?? null) as Prisma.InputJsonValue,
              finalizedAt: new Date(),
              // autor_user_id: DB default auth.uid() (GUC sub) — WITH CHECK paritet.
            },
          });
          return jsonSafe(row);
        },
      );
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      mapSy15Error(e);
    }
  }

  /** Poveži/odveži predmet (poveziPredmet): UVEK piše sve 4 kolone (prazno = odveži). */
  async linkPredmet(email: string, id: string, dto: LinkPredmetDto) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmIzvestaj.count({ where: { id } });
      const r = await tx.pmIzvestaj.updateMany({
        where: { id },
        data: {
          predmetItemId: dto.predmetItemId ?? null,
          predmetBroj: dto.predmetBroj ?? null,
          nazivProjekta: dto.nazivProjekta ?? null,
          klijent: dto.klijent ?? null,
        },
      });
      this.assertAffected(exists > 0, r.count, `Izveštaj ${id}`);
      return { data: { id } };
    });
  }

  /**
   * Upload fotki (multipart) u `montaza-izvestaji` + meta u montaza_izvestaj_fotke.
   * Putanja 1.0-kompatibilna: `{id}/foto-{rb}-{token}.jpg`. Ciljani retry = klijent
   * šalje SAMO neuspele (sa njihovim `redni`). Autorizacija se proverava PRE upload-a
   * (fotke INSERT scope: autor∨mgmt∨admin) da nema orphan fajlova.
   *
   * Format se presuđuje po SADRŽAJU pre ijednog upload-a (`common/attachments`, samo
   * slike). Ranije se `image/jpeg` upisivalo NAPAMET za svaki fajl (i putanja `.jpg`),
   * pa je HEIC sa telefona završavao u bucketu kao lažni JPEG koji izveštaj nikad
   * ne prikaže. Sada: ili cela serija prolazi, ili nijedan bajt ne ode.
   */
  async uploadPhotos(
    email: string,
    id: string,
    files: Express.Multer.File[],
    redni?: string,
    opisi?: string,
  ) {
    if (!files?.length) {
      throw new UnprocessableEntityException(
        "Očekivane fotke (multipart polje `files`)",
      );
    }
    if (files.length > MONTAZA_MAX_SLIKE) {
      throw new UnprocessableEntityException(
        `Najviše ${MONTAZA_MAX_SLIKE} fotki.`,
      );
    }
    const checked = assertAttachments(files, {
      allow: IMAGE_ATTACHMENT_FORMATS,
      hint: 'Izveštaj je sačuvan — fotografije pošaljite ponovo dugmetom „Fotografije ponovo".',
    });
    const rbList = (redni ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s));
    let opisList: string[] = [];
    if (opisi) {
      try {
        const parsed: unknown = JSON.parse(opisi);
        if (Array.isArray(parsed))
          opisList = parsed.map((v) => String(v ?? ""));
      } catch {
        throw new UnprocessableEntityException("`opisi` mora biti JSON niz.");
      }
    }
    // Autorizacija + početni redni broj (posle postojećih) PRE upload-a.
    const base = await this.mut(email, async (tx) => {
      const ok = await tx.$queryRaw<{ allowed: boolean }[]>(
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM montaza_izvestaji i
          WHERE i.id = ${id}::uuid AND (i.autor_user_id = auth.uid()
            OR current_user_is_management() OR current_user_is_admin())) AS allowed`,
      );
      if (!ok[0]?.allowed) {
        const cnt = await tx.pmIzvestaj.count({ where: { id } });
        if (!cnt) throw new NotFoundException(`Izveštaj ${id} ne postoji`);
        throw new ForbiddenException("Nemate pravo na ovaj izveštaj");
      }
      return tx.pmIzvestajFoto.count({ where: { izvestajId: id } });
    });

    const uploaded: number[] = [];
    const failedRedni: number[] = [];
    const rows: Array<{
      izvestajId: string;
      redniBroj: number;
      storagePath: string;
      opis: string | null;
      mimeType: string;
      sizeBytes: bigint | null;
    }> = [];
    for (let i = 0; i < checked.length; i++) {
      const { file: f, contentType, format } = checked[i];
      const rb =
        Number.isFinite(rbList[i]) && rbList[i] > 0 ? rbList[i] : base + i + 1;
      const token = randomUUID().replace(/-/g, "").slice(0, 8);
      // `.jpg` ostaje 1.0-kompatibilan default; PNG dobija svoju ekstenziju umesto
      // da se (kao ranije) lažno predstavi kao JPEG.
      const path = `${id}/foto-${rb}-${token}.${format === "png" ? "png" : "jpg"}`;
      try {
        await this.storage.upload(
          MONTAZA_BUCKET,
          path,
          new Uint8Array(f.buffer),
          contentType,
        );
        uploaded.push(rb);
        rows.push({
          izvestajId: id,
          redniBroj: rb,
          storagePath: path,
          opis: opisList[i] ?? null,
          mimeType: contentType,
          sizeBytes: f.size ? BigInt(f.size) : null,
        });
      } catch {
        failedRedni.push(rb);
      }
    }
    if (rows.length) {
      await this.mut(email, async (tx) => {
        await tx.pmIzvestajFoto.createMany({ data: rows });
      });
    }
    return {
      data: {
        total: files.length,
        uploaded: uploaded.length,
        failed: failedRedni.length,
        failedRedni,
      },
    };
  }

  /**
   * Upload PDF-a izveštaja u `montaza-izvestaji` + PATCH pdf_path/pdf_naziv.
   * Putanja 1.0-kompatibilna: `{id}/{sanitizovan-broj}.pdf`.
   *
   * ⚠️ Autorizacija (autor∨mgmt∨admin) MORA PRE `storage.upload` (kao uploadPhotos):
   * putanja je DETERMINISTIČKA (`{id}/{broj}.pdf`) a upload ide servisnim ključem
   * (x-upsert) koji zaobilazi bucket RLS — provera POSLE upload-a bi značila da napadač
   * (svaka rola ima `montaza.izvestaji`, `montaza_izvestaji` SELECT=true) prepiše tuđi
   * PDF pre nego što dobije 403 (IDOR, bez rollback-a). Provera je isti EXISTS kao fotke.
   */
  async uploadPdf(email: string, id: string, file?: Express.Multer.File) {
    // Magic bytes, ne `mimetype` iz zahteva (klijent ga laže) — `common/attachments`.
    assertPdfAttachment(file);
    const report = await this.mut(email, async (tx) => {
      const r = await tx.pmIzvestaj.findUnique({
        where: { id },
        select: { id: true, brojIzvestaja: true },
      });
      if (!r) throw new NotFoundException(`Izveštaj ${id} ne postoji`);
      const ok = await tx.$queryRaw<{ allowed: boolean }[]>(
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM montaza_izvestaji i
          WHERE i.id = ${id}::uuid AND (i.autor_user_id = auth.uid()
            OR current_user_is_management() OR current_user_is_admin())) AS allowed`,
      );
      if (!ok[0]?.allowed) {
        throw new ForbiddenException("Nemate pravo na ovaj izveštaj");
      }
      return r;
    });
    const safeBroj = String(report.brojIzvestaja || "izvestaj").replace(
      /[^\w.-]+/g,
      "_",
    );
    const path = `${id}/${safeBroj}.pdf`;
    const fileName = `${safeBroj}.pdf`;
    await this.storage.upload(
      MONTAZA_BUCKET,
      path,
      new Uint8Array(file.buffer),
      "application/pdf",
    );
    await this.mut(email, async (tx) => {
      const exists = await tx.pmIzvestaj.count({ where: { id } });
      const r = await tx.pmIzvestaj.updateMany({
        where: { id },
        data: { pdfPath: path, pdfNaziv: fileName },
      });
      this.assertAffected(exists > 0, r.count, `Izveštaj ${id}`);
    });
    return { data: { pdfPath: path, pdfNaziv: fileName } };
  }

  /** Presigned URL PDF-a izveštaja (SELECT je `true`; kratak TTL). */
  async reportPdfUrl(email: string, id: string) {
    const path = await this.mut(email, async (tx) => {
      const r = await tx.pmIzvestaj.findUnique({
        where: { id },
        select: { pdfPath: true },
      });
      if (!r) throw new NotFoundException(`Izveštaj ${id} ne postoji`);
      if (!r.pdfPath) throw new NotFoundException("Izveštaj nema PDF");
      return r.pdfPath;
    });
    return { data: await this.storage.signUrl(MONTAZA_BUCKET, path, 300) };
  }

  /** Presigned URL fotke izveštaja (po foto id-ju; SELECT je `true`). */
  async photoUrl(email: string, photoId: string) {
    const path = await this.mut(email, async (tx) => {
      const r = await tx.pmIzvestajFoto.findUnique({
        where: { id: photoId },
        select: { storagePath: true },
      });
      if (!r) throw new NotFoundException(`Fotka ${photoId} ne postoji`);
      return r.storagePath;
    });
    return { data: await this.storage.signUrl(MONTAZA_BUCKET, path, 300) };
  }

  // ---------- AI (port edge montaza-izvestaj-ai) ----------

  /**
   * AI strukturiranje izveštaja (PRESUDA C6: port edge → NestJS, BE ANTHROPIC_API_KEY).
   * Identičan prompt/tool-schema/limiti/model-allowlist kao 1.0 edge; model iz
   * `montaza_ai_settings` (allowlist), obogaćivanje predmeta iz 3.0 `projects`
   * (v. `enrichPredmet`). 1.0 edge ostaje živ za paralelni rad.
   */
  async aiGenerate(
    email: string,
    dto: AiGenerateDto,
    actor?: { userId: number },
  ) {
    const tekst = (dto.tekst ?? "").trim();
    if (tekst.length > MONTAZA_MAX_TEKST_CHARS) {
      throw new UnprocessableEntityException(
        "Tekst je predugačak (max 20000).",
      );
    }
    const slike = (dto.slike ?? []).slice(0, MONTAZA_MAX_SLIKE);
    for (const s of slike) {
      if ((s.data?.length ?? 0) > MONTAZA_MAX_SLIKA_B64) {
        throw new UnprocessableEntityException(
          "Fotka je prevelika (max ~4MB).",
        );
      }
    }
    if (!tekst && slike.length === 0) {
      throw new UnprocessableEntityException("Prazan unos (tekst i fotke).");
    }

    const legacyModel = await this.read(email, (tx) => this.resolveAiModel(tx));
    // Talas AI-0 (stavka 7c): registar prvi, montaza_ai_settings kao fallback.
    const resolved = await this.policy.resolve(
      AI_TASK.MONTAZA_REPORT,
      legacyModel,
    );
    const model = (MONTAZA_AI_ALLOWED_MODELS as readonly string[]).includes(
      resolved.model,
    )
      ? resolved.model
      : legacyModel;

    const dopune = (dto.dopune ?? [])
      .map((d) => String(d ?? "").trim())
      .filter(Boolean);
    // Talas AI-0 (stavka 6): ograda ide SAMO oko monterovog teksta i dopuna.
    // Instrukcije aplikacije („uvrsti ih", broj fotografija) ostaju IZVAN markera —
    // unutar ograde model ih tretira kao podatke, a ne kao nalog koji treba izvršiti.
    const textBlock =
      `Monter/serviser je napisao (slobodan tekst):\n${fenceUserInput(tekst || "(prazno)")}` +
      (dopune.length
        ? `\n\nNaknadno dopunjeni podaci (uvrsti ih):\n${fenceUserInput(
            dopune.map((d) => `- ${d}`).join("\n"),
          )}`
        : "") +
      `\n\nPriloženo fotografija: ${slike.length}.`;
    const content: unknown[] = [{ type: "text", text: textBlock }];
    for (const s of slike) {
      const mt = MONTAZA_VISION_MIME.includes(s.media_type)
        ? s.media_type
        : "image/jpeg";
      content.push({
        type: "image",
        source: { type: "base64", media_type: mt, data: s.data },
      });
    }

    const res = await this.ai.extractWithTool({
      model,
      system: `${MONTAZA_AI_SYSTEM_PROMPT}\n\n${MONTAZA_INJECTION_FENCE}`,
      tool: MONTAZA_AI_TOOL,
      content,
      maxTokens: 4000,
      ctx: {
        module: AI_MODULE.MONTAZA_REPORT,
        userId: actor?.userId ?? null,
      },
    });
    const out = normalizeMontazaOut(res.toolInput);
    await this.enrichPredmet(email, out);
    return { data: out, meta: { model: res.model, usage: res.usage } };
  }

  /**
   * Obogati predmet iz 3.0 `projects`/`customers` (edge enrichPredmet; DB je autoritet).
   * Izvor prebačen sa sy15 keša zajedno sa `lookupPredmeti` — isto obrazloženje (v. tamo):
   * keš je zamrznut snimak ugašenog QBigTehn-a, 3.0 je živi BigBit nadskup. `id` prostor
   * je isti, pa `predmet_item_id` koji ide u izveštaj ostaje isti broj kao i pre.
   */
  private async enrichPredmet(email: string, out: MontazaAiOut): Promise<void> {
    if (!out.predmet) return;
    void email; // 3.0 matični podaci nisu RLS-ovani (v. lookupPredmeti).
    const items = await this.prisma.$queryRaw<
      {
        id: number;
        broj_predmeta: string;
        naziv_predmeta: string | null;
        customer_id: number | null;
      }[]
    >(
      // ⚠️ NEMA `AND closed_at IS NULL` — veran port edge-a (enrichPredmet,
      // montaza-izvestaj-ai/index.ts): većina predmeta su zatvoreni, sa jedinstvenim
      // brojem; filter bi za njih vratio 0 i ostavio predmet_item_id/naziv/klijent prazne.
      // `ORDER closed_at DESC NULLS FIRST` = aktivan ima prednost, ali vraća i zatvoren.
      AppPrisma.sql`SELECT id,
          project_number AS broj_predmeta,
          project_name   AS naziv_predmeta,
          customer_id
        FROM projects
        WHERE project_number = ${out.predmet}
        ORDER BY closed_at DESC NULLS FIRST LIMIT 1`,
    );
    const it = items[0];
    if (!it) return;
    let klijent = "";
    if (it.customer_id != null) {
      const cust = await this.prisma.$queryRaw<
        { name: string | null; short_name: string | null }[]
      >(
        AppPrisma.sql`SELECT name, short_name FROM customers WHERE id = ${it.customer_id} LIMIT 1`,
      );
      klijent = cust[0]?.short_name || cust[0]?.name || "";
    }
    out.predmet_item_id = Number(it.id);
    out.predmet = it.broj_predmeta || out.predmet;
    out.naziv_projekta = it.naziv_predmeta || out.naziv_projekta;
    out.klijent = klijent;
  }

  /** Model iz montaza_ai_settings (allowlist), fallback env/default (edge resolveModel). */
  private async resolveAiModel(tx: Sy15Tx): Promise<string> {
    const rows = await tx.$queryRaw<{ model: string | null }[]>(
      Prisma.sql`SELECT model FROM montaza_ai_settings WHERE id = 1 LIMIT 1`,
    );
    const m = rows[0]?.model ?? "";
    if ((MONTAZA_AI_ALLOWED_MODELS as readonly string[]).includes(m)) return m;
    const env = process.env.MONTAZA_AI_MODEL ?? "";
    return (MONTAZA_AI_ALLOWED_MODELS as readonly string[]).includes(env)
      ? env
      : MONTAZA_AI_DEFAULT_MODEL;
  }

  /** Postavi AI model (set_montaza_ai_model; DEFINER štiti admin; allowlist u DB). */
  async setAiModel(email: string, model: string) {
    return this.mut(email, async (tx) => {
      const rows = await tx.$queryRaw<{ r: string }[]>(
        Prisma.sql`SELECT set_montaza_ai_model(${model}::text) AS r`,
      );
      return { data: { model: rows[0]?.r ?? model } };
    });
  }

  // ---------- interno ----------

  /** 'YYYY-MM-DD' → Date za @db.Date (undefined = ne diraj, null = obriši). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  /** Zajednička (ne-ključna) polja faze za create/update. */
  private phaseData(dto: UpdatePhaseDto, email: string) {
    return {
      location: dto.location ?? undefined,
      startDate: this.toDbDate(dto.startDate),
      endDate: this.toDbDate(dto.endDate),
      responsibleEngineer: dto.responsibleEngineer ?? undefined,
      montageLead: dto.montageLead ?? undefined,
      status: dto.status ?? undefined,
      pct: dto.pct ?? undefined,
      blocker: dto.blocker ?? undefined,
      note: dto.note ?? undefined,
      sortOrder: dto.sortOrder ?? undefined,
      phaseType: dto.phaseType ?? undefined,
      description: dto.description ?? undefined,
      actualStartDate: this.toDbDate(dto.actualStartDate),
      actualEndDate: this.toDbDate(dto.actualEndDate),
      updatedBy: email,
      updatedAt: new Date(),
    };
  }

  /** Trim + dedup brojeva crteža (paritet 1.0 buildPhasePayload linked_drawings). */
  private cleanDrawings(arr?: string[]): Prisma.InputJsonValue {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of arr ?? []) {
      const s = String(v ?? "").trim();
      if (s && !seen.has(s)) {
        seen.add(s);
        out.push(s);
      }
    }
    return out;
  }

  /** Posle updateMany/deleteMany 0 pogodaka: 404 ako ne postoji, inače 403 (RLS scope). */
  private assertAffected(exists: boolean, count: number, what: string): void {
    if (count > 0) return;
    if (!exists) throw new NotFoundException(`${what} ne postoji`);
    throw new ForbiddenException(`Nemate pravo nad: ${what}`);
  }

  private async mut<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      mapSy15Error(e);
    }
  }

  private async read<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      mapSy15Error(e);
    }
  }
}
