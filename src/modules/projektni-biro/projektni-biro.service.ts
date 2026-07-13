import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { jsonSafe } from "../../common/sy15/json-safe";
import { pageMeta, parsePagination } from "../../common/pagination";
import type {
  ListTasksQueryDto,
  LoadStatsQueryDto,
  TipsQueryDto,
  WorkReportSummaryQueryDto,
  WorkReportsQueryDto,
} from "./dto/pb-query.dto";

/**
 * Projektni biro — 3.0 TALAS D, R1 read sloj (MODULE_SPEC_pb_profil_podesavanja_30.md §3.1).
 * Podaci žive u sy15 (1.0) bazi (doktrina §A.1); ovaj servis samo ČITA:
 *  - `pb_tasks` embed (projects/employees) kroz $queryRaw — status/vrsta/prioritet enum kolone
 *    se čitaju kao TEKST (1.0 labele „U toku"…), filter je `col::text = $` (bez Prisma
 *    enum-member prevoda; doktrina §C: ne menjati enume/formate),
 *  - komentare/zavisnosti/fajlove/notif-config kroz Prisma modele (bez FK — batch resolve),
 *  - DEFINER RPC-ove (pb_list_projects, pb_get_mechanical_projecting_engineers,
 *    pb_get_load_stats/team_load_stats, pb_get_work_report_summary, pb_list_eng_tips,
 *    pb_get_eng_tip, pb_list_eng_tip_categories) kroz isti most.
 * SVE ide kroz `Sy15Service.withUserRls` (GUC claims + SET LOCAL ROLE authenticated):
 * konekciona rola je BYPASSRLS, pa row-scope (work_reports self-scope ∨ reports_all,
 * eng-tips draft/org-članstvo vidljivost, komentar-1h) sprovodi RLS/DEFINER TEK pod
 * `authenticated` — scope se NE duplira u WHERE. Mutacije + presigned storage su R2.
 */
@Injectable()
export class ProjektniBiroService {
  constructor(private readonly sy15: Sy15Service) {}

  // ---------- Dropdown / lookup (DEFINER RPC) ----------

  /** Projekti za filter/dropdown (pb_list_projects — SECURITY DEFINER). */
  listProjects(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_list_projects()`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Inženjeri (dropdown) — pb_get_mechanical_projecting_engineers (org-članstvo je AUTHZ podatak, §2.4.2). */
  listEngineers(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_get_mechanical_projecting_engineers()`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Taskovi (pb_tasks + embed projects/employees) ----------

  /** Lista taskova sa filterima + embed (paritet 1.0 loadTasks). deleted_at IS NULL default. */
  async listTasks(email: string, query: ListTasksQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const conds: Prisma.Sql[] = [];
    if (query.includeDeleted !== "true")
      conds.push(Prisma.sql`t.deleted_at IS NULL`);
    if (query.projectId)
      conds.push(Prisma.sql`t.project_id = ${query.projectId}::uuid`);
    if (query.employeeId)
      conds.push(Prisma.sql`t.employee_id = ${query.employeeId}::uuid`);
    if (query.status) conds.push(Prisma.sql`t.status::text = ${query.status}`);
    if (query.vrsta) conds.push(Prisma.sql`t.vrsta::text = ${query.vrsta}`);
    if (query.q) {
      const like = `%${query.q}%`;
      conds.push(
        Prisma.sql`(t.naziv ILIKE ${like} OR t.opis ILIKE ${like} OR t.problem ILIKE ${like})`,
      );
    }
    const where = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;
    return this.withUserMapped(email, async (tx) => {
      const [data, countRows] = await Promise.all([
        tx.$queryRaw<unknown[]>(
          Prisma.sql`SELECT t.*, p.project_code, p.project_name, e.full_name AS employee_name
             FROM pb_tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             LEFT JOIN employees e ON e.id = t.employee_id
             ${where}
             ORDER BY t.datum_zavrsetka_plan ASC NULLS LAST, t.prioritet ASC, t.created_at DESC
             LIMIT ${take} OFFSET ${skip}`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM pb_tasks t ${where}`,
        ),
      ]);
      const total = Number(countRows[0]?.n ?? 0);
      return { data: jsonSafe(data), meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Detalj taska + embed. */
  async findTask(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT t.*, p.project_code, p.project_name, e.full_name AS employee_name
           FROM pb_tasks t
           LEFT JOIN projects p ON p.id = t.project_id
           LEFT JOIN employees e ON e.id = t.employee_id
           WHERE t.id = ${id}::uuid`,
      );
      if (!rows.length) throw new NotFoundException(`Task ${id} ne postoji`);
      return { data: jsonSafe(rows[0]) };
    });
  }

  /** Komentari taska (SELECT `true` — svi prijavljeni; 1h edit-prozor je write-scope u RLS/R2). */
  listComments(email: string, taskId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pbTaskComment.findMany({
        where: { taskId },
        orderBy: [{ createdAt: "asc" }],
      });
      return { data };
    });
  }

  /** Zavisnosti taska (anti-ciklus je trigger na write). */
  listDeps(email: string, taskId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pbTaskDep.findMany({
        where: { taskId },
        orderBy: [{ createdAt: "asc" }],
      });
      return { data };
    });
  }

  /** Prilozi taska (metapodaci; presigned bytes su R2). deleted_at IS NULL. */
  listFiles(email: string, taskId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pbTaskFile.findMany({
        where: { taskId, deletedAt: null },
        orderBy: [{ uploadedAt: "desc" }],
      });
      return { data: data.map((f) => bigIntOut(f, "sizeBytes")) };
    });
  }

  // ---------- Opterećenost (DEFINER RPC) ----------

  /** Opterećenost po inženjeru (pb_get_load_stats, default prozor 20 r.d.). */
  loadStats(email: string, query: LoadStatsQueryDto) {
    const win = clampWindow(query.windowDays);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_get_load_stats(${win})`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Opterećenost po timu (pb_get_team_load_stats). */
  teamLoadStats(email: string, query: LoadStatsQueryDto) {
    const win = clampWindow(query.windowDays);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_get_team_load_stats(${win})`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Work reports (self-scope ∨ reports_all — RLS/DEFINER u DB) ----------

  /** Lista van-planskih sati (RLS: employee_id = pb_current_employee_id() ∨ reports_all). */
  listWorkReports(email: string, query: WorkReportsQueryDto) {
    const where: Prisma.PbWorkReportWhereInput = {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.from || query.to
        ? {
            datum: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.pbWorkReport.findMany({
        where,
        orderBy: [{ datum: "desc" }, { createdAt: "desc" }],
      });
      return { data: rows.map((r) => ({ ...r, sati: Number(r.sati) })) };
    });
  }

  /** Obračun po periodu (pb_get_work_report_summary; svi-vs-svoje odlučuje DB fn). */
  workReportSummary(email: string, query: WorkReportSummaryQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_get_work_report_summary(${query.from}::date, ${query.to}::date, ${query.employeeId ?? null}::uuid)`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Saveti (eng tips — DEFINER RPC, draft/vidljivost u DB) ----------

  /** Lista saveta (pb_list_eng_tips, tsv pretraga + filteri; draft vidi autor+admin — RLS). */
  listTips(email: string, query: TipsQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.q) filter.q = query.q;
    if (query.categoryId) filter.category_id = query.categoryId;
    if (query.status) filter.status = query.status;
    if (query.projectId) filter.project_id = query.projectId;
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_list_eng_tips(${JSON.stringify(filter)}::jsonb)`,
      );
      return { data: jsonSafe(data) };
    });
  }

  /** Detalj saveta (pb_get_eng_tip — inkrementira views u DB; vidljivost u RLS/DEFINER). */
  findTip(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_get_eng_tip(${id}::uuid)`,
      );
      const row = jsonSafe(rows)[0] ?? null;
      if (row == null) throw new NotFoundException(`Savet ${id} ne postoji`);
      return { data: row };
    });
  }

  /** Kategorije saveta (pb_list_eng_tip_categories). */
  listTipCategories(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_list_eng_tip_categories()`,
      );
      return { data: jsonSafe(data) };
    });
  }

  // ---------- Notifikacije config (SELECT `true`; PATCH je pb.admin/R2) ----------

  /** PB notif config singleton (id=1; dispatch OSTAJE 1.0 pozadina — §0.1). */
  notificationConfig(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.pbNotificationConfig.findUnique({
        where: { id: 1 },
      });
      return { data };
    });
  }

  // ---------- interno ----------

  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * SQLSTATE iz DB fn/RLS → HTTP semantika (paritet Reversi/Sastanci §5):
   * 42501→403, P0001/P0002/23514→422, 23505→409, P2025→403.
   */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}

/** Radni-dani prozor: broj 1..120 (paritet 1.0 opterećenosti); default 20. */
function clampWindow(v?: string): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 120);
}

/** BigInt kolona (Prisma model) → Number (BigInt ne prežive res.json). */
function bigIntOut<T extends Record<string, unknown>>(row: T, key: keyof T): T {
  const v = row[key];
  return v == null || typeof v !== "bigint"
    ? row
    : { ...row, [key]: Number(v) };
}
