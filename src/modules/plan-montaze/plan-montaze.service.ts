import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
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
 * montaza_izvestaji/_fotke, montaza_ai_settings, bigtehn_*_cache) kroz Prisma/$queryRaw,
 * sve u `withUserRls`. Lista projekata = `pb_list_projects()` (DEFINER RPC, projekti
 * ⋈ predmet_aktivacija je_aktivan∧je_projektovanje_montaza). Mutacije (faze/WP/projekt
 * upsert, izveštaji POST + AI port + storage) su R2.
 */
@Injectable()
export class PlanMontazeService {
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
    private readonly ai: AiProviderService,
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
        { id: number; model: string; updated_at: Date; updated_by: string | null }[]
      >(
        Prisma.sql`SELECT id, model, updated_at, updated_by FROM montaza_ai_settings WHERE id = 1`,
      );
      return { data: rows[0] ?? null };
    });
  }

  // ---------- Lookups ----------

  /**
   * Pretraga predmeta (bigtehn_items_cache) — paritet searchBigtehnItems (deli sa
   * Lokacijama/Talas A): ilike po broj/naziv/ugovor/narudžbenica, onlyActive
   * (status='U TOKU' ∧ datum_zakljucenja IS NULL), + kratki naziv komitenta.
   */
  async lookupPredmeti(email: string, q?: string) {
    const s = (q ?? "").trim();
    const like = s ? `%${s}%` : null;
    return this.read(email, async (tx) => {
      const items = await tx.$queryRaw<
        Array<Record<string, unknown> & { id: number; customer_id: number | null }>
      >(
        Prisma.sql`SELECT id, broj_predmeta, naziv_predmeta, opis, status, department_code,
            broj_ugovora, broj_narudzbenice, rok_zavrsetka, modified_at, datum_zakljucenja, customer_id
          FROM bigtehn_items_cache
          WHERE status = 'U TOKU' AND datum_zakljucenja IS NULL
            ${like ? Prisma.sql`AND (broj_predmeta ILIKE ${like} OR naziv_predmeta ILIKE ${like} OR broj_ugovora ILIKE ${like} OR broj_narudzbenice ILIKE ${like})` : Prisma.empty}
          ORDER BY modified_at DESC NULLS LAST LIMIT 50`,
      );
      const custIds = [
        ...new Set(items.map((r) => r.customer_id).filter((v) => v != null)),
      ] as number[];
      let custMap = new Map<number, { name: string; short_name: string | null }>();
      if (custIds.length) {
        const custRows = await tx.$queryRaw<
          { id: number; name: string; short_name: string | null }[]
        >(
          Prisma.sql`SELECT id, name, short_name FROM bigtehn_customers_cache WHERE id IN (${Prisma.join(custIds)})`,
        );
        custMap = new Map(custRows.map((c) => [c.id, c]));
      }
      const data = items.map((r) => ({
        ...r,
        customer_name: r.customer_id != null ? (custMap.get(r.customer_id as number)?.name ?? null) : null,
      }));
      return { data: jsonSafe(data) };
    });
  }

  /**
   * Exists-check brojeva crteža (bigtehn_drawings_cache, aktivni). Signed URL = R2 (storage).
   * Paritet 1.0 drawings exists-check: vraća samo brojeve koji imaju keširan PDF.
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
    return this.read(email, async (tx) => {
      const rows = await tx.$queryRaw<
        { drawing_no: string; storage_path: string; file_name: string | null }[]
      >(
        Prisma.sql`SELECT drawing_no, storage_path, file_name FROM bigtehn_drawings_cache
          WHERE removed_at IS NULL AND drawing_no IN (${Prisma.join(list)})`,
      );
      const found = new Map(rows.map((r) => [r.drawing_no, r]));
      const data = list.map((code) => ({
        drawing_no: code,
        exists: found.has(code),
        storage_path: found.get(code)?.storage_path ?? null,
        file_name: found.get(code)?.file_name ?? null,
      }));
      return { data };
    });
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

  async updateWorkPackage(email: string, id: string, dto: UpdateWorkPackageDto) {
    return this.mut(email, async (tx) => {
      const exists = await tx.pmWorkPackage.count({ where: { id } });
      const r = await tx.pmWorkPackage.updateMany({
        where: { id },
        data: {
          rnCode: dto.rnCode ?? undefined,
          rnOrder: dto.rnOrder ?? undefined,
          name: dto.name ?? undefined,
          location: dto.location ?? undefined,
          responsibleEngineerDefault: dto.responsibleEngineerDefault ?? undefined,
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
              ...(dto.checks !== undefined
                ? { checks: dto.checks as Prisma.InputJsonValue }
                : {}),
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
          ...(dto.checks !== undefined
            ? { checks: dto.checks as Prisma.InputJsonValue }
            : {}),
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
              dodatniClanovi: (dto.dodatniClanovi ?? []) as Prisma.InputJsonValue,
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
      throw new UnprocessableEntityException(`Najviše ${MONTAZA_MAX_SLIKE} fotki.`);
    }
    const rbList = (redni ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s));
    let opisList: string[] = [];
    if (opisi) {
      try {
        const parsed: unknown = JSON.parse(opisi);
        if (Array.isArray(parsed)) opisList = parsed.map((v) => String(v ?? ""));
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
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const rb =
        Number.isFinite(rbList[i]) && rbList[i] > 0 ? rbList[i] : base + i + 1;
      const token = randomUUID().replace(/-/g, "").slice(0, 8);
      const path = `${id}/foto-${rb}-${token}.jpg`;
      try {
        await this.storage.upload(
          MONTAZA_BUCKET,
          path,
          new Uint8Array(f.buffer),
          "image/jpeg",
        );
        uploaded.push(rb);
        rows.push({
          izvestajId: id,
          redniBroj: rb,
          storagePath: path,
          opis: opisList[i] ?? null,
          mimeType: "image/jpeg",
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
   * Putanja 1.0-kompatibilna: `{id}/{sanitizovan-broj}.pdf`. Autorizacija = report
   * UPDATE scope (autor∨mgmt∨admin) kroz updateMany + assertAffected.
   */
  async uploadPdf(email: string, id: string, file?: Express.Multer.File) {
    if (!file?.buffer?.length || file.mimetype !== "application/pdf") {
      throw new UnprocessableEntityException(
        "Očekivan PDF fajl (multipart polje `file`)",
      );
    }
    const report = await this.mut(email, async (tx) => {
      const r = await tx.pmIzvestaj.findUnique({
        where: { id },
        select: { id: true, brojIzvestaja: true },
      });
      if (!r) throw new NotFoundException(`Izveštaj ${id} ne postoji`);
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
   * `montaza_ai_settings` (allowlist), obogaćivanje predmeta iz `bigtehn_items_cache`
   * kroz `withUserRls`. 1.0 edge ostaje živ za paralelni rad.
   */
  async aiGenerate(email: string, dto: AiGenerateDto) {
    const tekst = (dto.tekst ?? "").trim();
    if (tekst.length > MONTAZA_MAX_TEKST_CHARS) {
      throw new UnprocessableEntityException("Tekst je predugačak (max 20000).");
    }
    const slike = (dto.slike ?? []).slice(0, MONTAZA_MAX_SLIKE);
    for (const s of slike) {
      if ((s.data?.length ?? 0) > MONTAZA_MAX_SLIKA_B64) {
        throw new UnprocessableEntityException("Fotka je prevelika (max ~4MB).");
      }
    }
    if (!tekst && slike.length === 0) {
      throw new UnprocessableEntityException("Prazan unos (tekst i fotke).");
    }

    const model = await this.read(email, (tx) => this.resolveAiModel(tx));

    const dopune = (dto.dopune ?? []).map((d) => String(d ?? "").trim()).filter(Boolean);
    const textBlock =
      `Monter/serviser je napisao (slobodan tekst):\n"""\n${tekst || "(prazno)"}\n"""` +
      (dopune.length
        ? `\n\nNaknadno dopunjeni podaci (uvrsti ih):\n- ${dopune.join("\n- ")}`
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
      system: MONTAZA_AI_SYSTEM_PROMPT,
      tool: MONTAZA_AI_TOOL,
      content,
      maxTokens: 4000,
    });
    const out = normalizeMontazaOut(res.toolInput);
    await this.enrichPredmet(email, out);
    return { data: out, meta: { model: res.model, usage: res.usage } };
  }

  /** Obogati predmet iz bigtehn keša (edge enrichPredmet; DB je autoritet). */
  private async enrichPredmet(email: string, out: MontazaAiOut): Promise<void> {
    if (!out.predmet) return;
    await this.read(email, async (tx) => {
      const items = await tx.$queryRaw<
        {
          id: number;
          broj_predmeta: string;
          naziv_predmeta: string | null;
          customer_id: number | null;
        }[]
      >(
        Prisma.sql`SELECT id, broj_predmeta, naziv_predmeta, customer_id
          FROM bigtehn_items_cache
          WHERE broj_predmeta = ${out.predmet} AND datum_zakljucenja IS NULL
          ORDER BY datum_zakljucenja DESC NULLS FIRST LIMIT 1`,
      );
      const it = items[0];
      if (!it) return;
      let klijent = "";
      if (it.customer_id != null) {
        const cust = await tx.$queryRaw<
          { name: string | null; short_name: string | null }[]
        >(
          Prisma.sql`SELECT name, short_name FROM bigtehn_customers_cache WHERE id = ${it.customer_id} LIMIT 1`,
        );
        klijent = cust[0]?.short_name || cust[0]?.name || "";
      }
      out.predmet_item_id = Number(it.id);
      out.predmet = it.broj_predmeta || out.predmet;
      out.naziv_projekta = it.naziv_predmeta || out.naziv_projekta;
      out.klijent = klijent;
    });
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
