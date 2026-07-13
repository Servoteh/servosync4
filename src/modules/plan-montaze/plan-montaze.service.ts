import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { mapSy15Error } from "../../common/sy15-error";
import { jsonSafe } from "../../common/json-safe";
import type {
  ReportsQueryDto,
} from "./dto/plan-montaze-query.dto";

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
  constructor(private readonly sy15: Sy15Service) {}

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

  // ---------- interno ----------

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
