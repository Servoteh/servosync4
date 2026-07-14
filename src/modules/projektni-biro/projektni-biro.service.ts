import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { jsonSafe } from "../../common/sy15/json-safe";
import { pageMeta, parsePagination } from "../../common/pagination";
import type {
  ListTasksQueryDto,
  LoadStatsQueryDto,
  TipsQueryDto,
  WorkReportSummaryQueryDto,
  WorkReportsQueryDto,
} from "./dto/pb-query.dto";
import type {
  BulkTasksDto,
  CreateCommentDto,
  CreateDepDto,
  CreateTaskDto,
  CreateWorkReportDto,
  NotifConfigPatchDto,
  ProgressDto,
  SaveTipDto,
  SoftDeleteTasksDto,
  TaskFileMetaDto,
  TipCategoryDto,
  UpdateCommentDto,
  UpdateTaskDto,
} from "./dto/pb-mutation.dto";

const PB_TASK_FILES_BUCKET = "pb-task-files";
const PB_ENG_TIP_FILES_BUCKET = "pb-eng-tip-files";

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
  constructor(
    private readonly sy15: Sy15Service,
    private readonly storage: Sy15StorageService,
  ) {}

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

  /**
   * Lista saveta (pb_list_eng_tips). Ključevi p_filter-a su 1:1 sa ŽIVIM telom fn i 1.0
   * `pbEngTips.listEngTips` (§C paritet): `search`/`category_ids`(uuid[])/`tags`/`my_only`/
   * `include_drafts`/`sort`/`limit`/`offset`. RPC NEMA project/status filter; draft vidljivost
   * je `include_drafts` (autor∨admin u DB). Defaulti kao 1.0 (sort=recent, limit=200, offset=0).
   */
  listTips(email: string, query: TipsQueryDto) {
    const tags = (query.tags ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const filter = {
      search: query.q?.trim() || null,
      category_ids: query.categoryId ? [query.categoryId] : null,
      tags: tags.length ? tags : null,
      my_only: query.myOnly === "true",
      include_drafts: query.includeDrafts === "true",
      sort: query.sort ?? "recent",
      limit: clampInt(query.limit, 200, 1, 500),
      offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    };
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

  // ============================================================================
  // R2 — MUTACIJE (REST write kroz withUserRls/runIdempotentRls; RLS presuđuje red)
  // ============================================================================
  // Sav write ide pod `SET LOCAL ROLE authenticated` (withUserRls/runIdempotentRls) →
  // sy15 RLS/DEFINER rade IDENTIČNO kao 1.0 PostgREST — scope se NE duplira u kodu
  // (doktrina A.2a/§C). Enum kolone se pišu kao 1.0 LABELE uz `::pb_*` cast (bez Prisma
  // enum-member prevoda; §C ne menja enume). Komentar/prilog/work-report INSERT MORAJU
  // referisati `auth.uid()`/`pb_current_employee_id()` (RLS WITH CHECK — izmereno 13.07),
  // pa idu kroz $queryRaw. RLS-filtrovan UPDATE/DELETE (0 redova) → `assertAffected`
  // razdvaja 404 (ne postoji) od 403 (postoji ali nema prava).

  /** Idempotentna mutacija sa nus-efektima (create task/comment/work-report/tip/file). */
  private async runIdem<T>(
    email: string,
    clientEventId: string,
    action: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ) {
    try {
      const out = await this.sy15.runIdempotentRls(
        email,
        clientEventId,
        action,
        fn,
      );
      return { data: out.result, meta: { idempotent: out.idempotent } };
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /** Posle updateMany/deleteMany sa 0 pogodaka: 404 ako red ne postoji, inače 403 (RLS). */
  private assertAffected(exists: boolean, count: number, what: string): void {
    if (count > 0) return;
    if (!exists) throw new NotFoundException(`${what} ne postoji`);
    throw new ForbiddenException(`Nemate pravo nad: ${what}`);
  }

  // ---------- Taskovi: CRUD + bulk + soft-delete + progress ----------

  /** Kreiraj task (paritet createPbTask; RLS INSERT = pb_can_edit_tasks). Enum labele → ::pb_*. */
  createTask(email: string, dto: CreateTaskDto) {
    return this.runIdem(email, dto.clientEventId, "pb.create-task", async (tx) => {
      const cols: Prisma.Sql[] = [];
      const vals: Prisma.Sql[] = [];
      for (const [c, v] of taskColumnValues(dto)) {
        cols.push(c);
        vals.push(v);
      }
      cols.push(Prisma.sql`created_by`, Prisma.sql`updated_by`);
      vals.push(Prisma.sql`${email}`, Prisma.sql`${email}`);
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`INSERT INTO pb_tasks (${Prisma.join(cols, ", ")})
           VALUES (${Prisma.join(vals, ", ")}) RETURNING *`,
      );
      return jsonSafe(rows)[0] ?? null;
    });
  }

  /** Izmena taska (paritet updatePbTask; optimistic lock updated_at → 409). */
  async updateTask(email: string, id: string, dto: UpdateTaskDto) {
    return this.withUserMapped(email, async (tx) => {
      const sets = taskColumnValues(dto).map(
        ([c, v]) => Prisma.sql`${c} = ${v}`,
      );
      sets.push(Prisma.sql`updated_by = ${email}`);
      sets.push(Prisma.sql`updated_at = now()`);
      const lock = dto.expectedUpdatedAt
        ? Prisma.sql` AND updated_at = ${dto.expectedUpdatedAt}::timestamptz`
        : Prisma.empty;
      const existsRows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`SELECT id FROM pb_tasks WHERE id = ${id}::uuid AND deleted_at IS NULL`,
      );
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`UPDATE pb_tasks SET ${Prisma.join(sets, ", ")}
           WHERE id = ${id}::uuid AND deleted_at IS NULL${lock} RETURNING *`,
      );
      if (!rows.length) {
        if (!existsRows.length)
          throw new NotFoundException(`Task ${id} ne postoji`);
        if (dto.expectedUpdatedAt)
          throw new ConflictException(
            "Zadatak je u međuvremenu izmenjen. Osveži pregled i pokušaj ponovo.",
          );
        throw new ForbiddenException(`Nemate pravo nad: Task ${id}`);
      }
      return { data: jsonSafe(rows)[0] };
    });
  }

  /** Bulk PATCH (status/prioritet/inženjer nad id=in). Vraća STVARNO izmenjen broj (RLS). */
  bulkUpdateTasks(email: string, dto: BulkTasksDto) {
    return this.withUserMapped(email, async (tx) => {
      const sets: Prisma.Sql[] = [];
      if (dto.status !== undefined)
        sets.push(Prisma.sql`status = ${dto.status}::pb_task_status`);
      if (dto.prioritet !== undefined)
        sets.push(Prisma.sql`prioritet = ${dto.prioritet}::pb_prioritet`);
      if (dto.employeeId !== undefined)
        sets.push(Prisma.sql`employee_id = ${dto.employeeId}::uuid`);
      if (!sets.length)
        throw new UnprocessableEntityException("Nema polja za izmenu");
      sets.push(Prisma.sql`updated_by = ${email}`);
      sets.push(Prisma.sql`updated_at = now()`);
      const rows = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`UPDATE pb_tasks SET ${Prisma.join(sets, ", ")}
           WHERE id = ANY(${dto.ids}::uuid[]) AND deleted_at IS NULL RETURNING id`,
      );
      return { data: { updated: rows.length, requested: dto.ids.length } };
    });
  }

  /** Soft delete taska (pb_soft_delete_task; RLS pb_can_edit_tasks). */
  softDeleteTask(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pb_soft_delete_task(${id}::uuid)`,
      );
      return { data: { ok: true } };
    });
  }

  /** Bulk soft delete (pb_soft_delete_tasks → broj obrisanih). */
  bulkSoftDeleteTasks(email: string, dto: SoftDeleteTasksDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ n: number }[]>(
        Prisma.sql`SELECT pb_soft_delete_tasks(${dto.ids}::uuid[]) AS n`,
      );
      return {
        data: { deleted: Number(rows[0]?.n ?? 0), requested: dto.ids.length },
      };
    });
  }

  /** Restriktovani edit inženjera (pb_update_task_progress — jedini write van pb.edit). */
  updateProgress(email: string, id: string, dto: ProgressDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_update_task_progress(${id}::uuid, ${
          dto.status ?? null
        }, ${dto.procenat ?? null})`,
      );
      return { data: jsonSafe(rows)[0] ?? null };
    });
  }

  // ---------- Komentari (RLS INSERT: pb_can_comment ∧ created_by_user_id=auth.uid) ----------

  /** Kreiraj komentar (created_by_user_id=auth.uid() — RLS WITH CHECK; mentions iz @-tokena). */
  createComment(email: string, taskId: string, dto: CreateCommentDto) {
    return this.runIdem(
      email,
      dto.clientEventId,
      "pb.create-comment",
      async (tx) => {
        const body = dto.body.slice(0, 4000);
        const mentions = parseMentions(body);
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`INSERT INTO pb_task_comments
             (task_id, body, mentions, created_by, created_by_user_id)
             VALUES (${taskId}::uuid, ${body}, ${mentions}::text[], ${email}, auth.uid())
             RETURNING *`,
        );
        return jsonSafe(rows)[0] ?? null;
      },
    );
  }

  /** Izmena komentara (1h prozor + autor∨admin presuđuje RLS → 0 redova = 403). */
  async updateComment(email: string, commentId: string, dto: UpdateCommentDto) {
    return this.withUserMapped(email, async (tx) => {
      const body = dto.body.slice(0, 4000);
      const exists =
        (await tx.pbTaskComment.count({ where: { id: commentId } })) > 0;
      const { count } = await tx.pbTaskComment.updateMany({
        where: { id: commentId },
        data: { body, mentions: parseMentions(body), editedAt: new Date() },
      });
      this.assertAffected(exists, count, `Komentar ${commentId}`);
      return {
        data: await tx.pbTaskComment.findUnique({ where: { id: commentId } }),
      };
    });
  }

  async deleteComment(email: string, commentId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists =
        (await tx.pbTaskComment.count({ where: { id: commentId } })) > 0;
      const { count } = await tx.pbTaskComment.deleteMany({
        where: { id: commentId },
      });
      this.assertAffected(exists, count, `Komentar ${commentId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Zavisnosti (anti-ciklus trigger → 409, dup → 409) ----------

  /** Dodaj zavisnost (task_id čeka depends_on). Ciklus (23514)/dup (23505) → 409. */
  async addDep(email: string, taskId: string, dto: CreateDepDto) {
    if (taskId === dto.dependsOnTaskId)
      throw new ConflictException("Zadatak ne može zavisiti od sebe.");
    return this.withUserMapped(email, async (tx) => {
      try {
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`INSERT INTO pb_task_deps (task_id, depends_on_task_id, created_by)
             VALUES (${taskId}::uuid, ${dto.dependsOnTaskId}::uuid, ${email})
             RETURNING *`,
        );
        return { data: jsonSafe(rows)[0] ?? null };
      } catch (e) {
        const code =
          (e as { meta?: { code?: string } }).meta?.code ??
          (e as { code?: string }).code;
        const msg = (e as Error).message ?? "";
        if (code === "23514" || /iklic|cycle/i.test(msg))
          throw new ConflictException("Ciklična zavisnost nije dozvoljena.");
        if (code === "23505") throw new ConflictException("Ta zavisnost već postoji.");
        throw e;
      }
    });
  }

  async deleteDep(email: string, depId: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.pbTaskDep.count({ where: { id: depId } })) > 0;
      const { count } = await tx.pbTaskDep.deleteMany({ where: { id: depId } });
      this.assertAffected(exists, count, `Zavisnost ${depId}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Prilozi taska (storage pb-task-files + meta; RLS uploaded_by=auth.uid) ----------

  /**
   * Upload priloga: (1) meta INSERT PRE storage upload-a (RLS write-scope → bez orphan
   * fajla ako RLS odbije), (2) storage.upload, (3) na neuspeh best-effort hard-delete meta.
   * Putanja `{taskId}/{uuid12}_{safeName}` — FORMAT paritet 1.0 (parallelni rad).
   */
  uploadTaskFile(
    email: string,
    taskId: string,
    dto: TaskFileMetaDto,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer) throw new UnprocessableEntityException("Nedostaje fajl");
    const origName = file.originalname || "file";
    const storagePath = `${taskId}/${randomUUID().replace(/-/g, "").slice(0, 12)}_${safeFileName(origName)}`;
    return this.runIdem(
      email,
      dto.clientEventId,
      "pb.upload-task-file",
      async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`INSERT INTO pb_task_files
             (task_id, file_name, storage_path, mime_type, size_bytes, category, description,
              uploaded_by, uploaded_by_email)
             VALUES (${taskId}::uuid, ${origName}, ${storagePath}, ${file.mimetype ?? null},
              ${file.size ?? null}, ${dto.category ?? null}, ${dto.description ?? null},
              auth.uid(), ${email})
             RETURNING id`,
        );
        const id = rows[0]?.id ?? null;
        try {
          await this.storage.upload(
            PB_TASK_FILES_BUCKET,
            storagePath,
            file.buffer,
            file.mimetype || "application/octet-stream",
            false,
          );
        } catch (e) {
          await tx
            .$executeRaw(
              Prisma.sql`DELETE FROM pb_task_files WHERE id = ${id}::uuid`,
            )
            .catch(() => undefined);
          throw e;
        }
        return { id, storagePath, fileName: origName };
      },
    );
  }

  /** Soft delete priloga taska (meta) + best-effort storage remove. */
  async deleteTaskFile(email: string, fileId: string) {
    return this.withUserMapped(email, async (tx) => {
      const file = await tx.pbTaskFile.findUnique({ where: { id: fileId } });
      const exists = file != null && file.deletedAt == null;
      const { count } = await tx.pbTaskFile.updateMany({
        where: { id: fileId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      this.assertAffected(exists, count, `Prilog ${fileId}`);
      if (file?.storagePath)
        await this.storage.remove(PB_TASK_FILES_BUCKET, file.storagePath);
      return { data: { ok: true } };
    });
  }

  /** Presigned GET za prilog taska (guard = pb.comment; bucket read = pb_can_comment). */
  async signTaskFile(email: string, fileId: string) {
    return this.withUserMapped(email, async (tx) => {
      const file = await tx.pbTaskFile.findFirst({
        where: { id: fileId, deletedAt: null },
      });
      if (!file) throw new NotFoundException(`Prilog ${fileId} ne postoji`);
      return { data: await this.storage.signUrl(PB_TASK_FILES_BUCKET, file.storagePath, 300) };
    });
  }

  // ---------- Work reports (self ∨ reports_all — RLS WITH CHECK po employee_id) ----------

  /** Unos van-planskih sati; employee_id default = pb_current_employee_id() (self). */
  async createWorkReport(email: string, dto: CreateWorkReportDto) {
    const sati = Number(dto.sati);
    if (!Number.isFinite(sati) || sati < 0.5 || sati > 24)
      throw new UnprocessableEntityException("Sati moraju biti između 0.5 i 24");
    return this.runIdem(
      email,
      dto.clientEventId,
      "pb.create-work-report",
      async (tx) => {
        const rows = await tx.$queryRaw<unknown[]>(
          Prisma.sql`INSERT INTO pb_work_reports (employee_id, datum, sati, opis, created_by)
             VALUES (COALESCE(${dto.employeeId ?? null}::uuid, pb_current_employee_id()),
               ${dto.datum}::date, ${sati}, ${dto.opis ?? ""}, ${email})
             RETURNING *`,
        );
        const row = jsonSafe(rows)[0] as { sati?: unknown } | undefined;
        return row ? { ...row, sati: Number(row.sati) } : null;
      },
    );
  }

  async deleteWorkReport(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const exists = (await tx.pbWorkReport.count({ where: { id } })) > 0;
      const { count } = await tx.pbWorkReport.deleteMany({ where: { id } });
      this.assertAffected(exists, count, `Izveštaj ${id}`);
      return { data: { ok: true } };
    });
  }

  // ---------- Notif config (pb.admin) ----------

  /** PATCH pb_notification_config (id=1). Dispatch OSTAJE 1.0 pozadina (§0.1). */
  updateNotificationConfig(email: string, dto: NotifConfigPatchDto) {
    return this.withUserMapped(email, async (tx) => {
      const data: Prisma.PbNotificationConfigUpdateInput = {
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.deadlineWarningDays !== undefined
          ? { deadlineWarningDays: dto.deadlineWarningDays }
          : {}),
        ...(dto.overloadThresholdPct !== undefined
          ? { overloadThresholdPct: dto.overloadThresholdPct }
          : {}),
        ...(dto.emailRecipients !== undefined
          ? { emailRecipients: dto.emailRecipients }
          : {}),
        ...(dto.notifyOnBlocked !== undefined
          ? { notifyOnBlocked: dto.notifyOnBlocked }
          : {}),
        ...(dto.notifyOnOverload !== undefined
          ? { notifyOnOverload: dto.notifyOnOverload }
          : {}),
        ...(dto.notifyOnDeadlineWarning !== undefined
          ? { notifyOnDeadlineWarning: dto.notifyOnDeadlineWarning }
          : {}),
        ...(dto.notifyOnDeadlineOverdue !== undefined
          ? { notifyOnDeadlineOverdue: dto.notifyOnDeadlineOverdue }
          : {}),
        ...(dto.notifyOnNoEngineer !== undefined
          ? { notifyOnNoEngineer: dto.notifyOnNoEngineer }
          : {}),
        ...(dto.digestMode !== undefined ? { digestMode: dto.digestMode } : {}),
        updatedBy: email,
        updatedAt: new Date(),
      };
      await tx.pbNotificationConfig.update({ where: { id: 1 }, data });
      return {
        data: await tx.pbNotificationConfig.findUnique({ where: { id: 1 } }),
      };
    });
  }

  // ---------- Saveti (eng tips — DEFINER RPC; jsonb ključevi 1:1 sa §C paritetom) ----------

  /**
   * Save savet (pb_save_eng_tip). p_payload ključevi 1:1 sa živim telom fn:
   * id/naslov/telo/category_id/tags/vendor/url/project_id/status (verifikovano 13.07).
   * id prisutan = update (autor∨admin u DB); odsutan = create (can_write_pb_eng_tips u DB).
   */
  saveTip(email: string, dto: SaveTipDto) {
    const payload = {
      id: dto.id ?? null,
      naslov: dto.naslov.trim(),
      telo: dto.telo.trim(),
      category_id: dto.categoryId ?? null,
      tags: (dto.tags ?? []).map((t) => String(t).trim()).filter(Boolean),
      vendor: dto.vendor?.trim() || null,
      url: dto.url?.trim() || null,
      project_id: dto.projectId ?? null,
      status: dto.status ?? "draft",
    };
    return this.runIdem(email, dto.clientEventId, "pb.save-tip", async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT pb_save_eng_tip(${JSON.stringify(payload)}::jsonb) AS result`,
      );
      return jsonSafe(rows[0]?.result ?? null);
    });
  }

  /** Toggle like (pb_toggle_eng_tip_like → { liked, likes_count }). */
  toggleTipLike(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT pb_toggle_eng_tip_like(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  /** Soft delete saveta (pb_soft_delete_eng_tip; autor∨admin u DB). */
  softDeleteTip(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT pb_soft_delete_eng_tip(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  /** Upsert kategorije saveta (pb_upsert_eng_tip_category; pb.admin u DB). Ključevi 1:1. */
  upsertTipCategory(email: string, dto: TipCategoryDto) {
    const payload = {
      id: dto.id ?? null,
      naziv: dto.naziv.trim(),
      slug: dto.slug?.trim() || null,
      ikona: dto.ikona?.trim() || null,
      boja: dto.boja?.trim() || null,
      redosled: dto.redosled ?? null,
      je_aktivna: dto.jeAktivna ?? null,
    };
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT * FROM pb_upsert_eng_tip_category(${JSON.stringify(payload)}::jsonb)`,
      );
      return { data: jsonSafe(rows)[0] ?? null };
    });
  }

  deleteTipCategory(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>(
        Prisma.sql`SELECT pb_delete_eng_tip_category(${id}::uuid) AS result`,
      );
      return { data: jsonSafe(rows[0]?.result ?? null) };
    });
  }

  // ---------- Prilozi saveta (RPC meta + storage pb-eng-tip-files) ----------

  /** Upload priloga saveta: (1) RPC pb_add_eng_tip_file (meta+provera), (2) storage upload,
   *  (3) na neuspeh best-effort RPC pb_delete_eng_tip_file. Putanja `{tipId}/{uuid}__{safeName}`. */
  uploadTipFile(
    email: string,
    tipId: string,
    clientEventId: string,
    file?: Express.Multer.File,
  ) {
    if (!file?.buffer) throw new UnprocessableEntityException("Nedostaje fajl");
    const origName = file.originalname || "file";
    const storagePath = `${tipId}/${randomUUID()}__${safeFileName(origName)}`;
    return this.runIdem(
      email,
      clientEventId,
      "pb.upload-tip-file",
      async (tx) => {
        const metaRows = await tx.$queryRaw<{ result: { id?: string } }[]>(
          Prisma.sql`SELECT pb_add_eng_tip_file(${tipId}::uuid, ${storagePath}, ${origName},
             ${file.mimetype ?? null}, ${file.size ?? null}) AS result`,
        );
        const meta = jsonSafe(metaRows[0]?.result ?? null) as {
          id?: string;
        } | null;
        try {
          await this.storage.upload(
            PB_ENG_TIP_FILES_BUCKET,
            storagePath,
            file.buffer,
            file.mimetype || "application/octet-stream",
            false,
          );
        } catch (e) {
          if (meta?.id)
            await tx
              .$executeRaw(
                Prisma.sql`SELECT pb_delete_eng_tip_file(${meta.id}::uuid)`,
              )
              .catch(() => undefined);
          throw e;
        }
        return { ...(meta ?? {}), storagePath, fileName: origName };
      },
    );
  }

  /** Brisanje priloga saveta (pb_delete_eng_tip_file → { ok, storage_path }) + storage remove. */
  async deleteTipFile(email: string, fileId: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<{ result: { storage_path?: string } }[]>(
        Prisma.sql`SELECT pb_delete_eng_tip_file(${fileId}::uuid) AS result`,
      );
      const res = jsonSafe(rows[0]?.result ?? null) as {
        storage_path?: string;
      } | null;
      if (res?.storage_path)
        await this.storage.remove(PB_ENG_TIP_FILES_BUCKET, res.storage_path);
      return { data: res };
    });
  }

  /** Presigned GET za prilog saveta (guard = pb.read; bucket read = svi auth). */
  async signTipFile(email: string, fileId: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.pbEngTipFile.findUnique({ where: { id: fileId } });
      if (!rows) throw new NotFoundException(`Prilog ${fileId} ne postoji`);
      return {
        data: await this.storage.signUrl(
          PB_ENG_TIP_FILES_BUCKET,
          rows.storagePath,
          3600,
        ),
      };
    });
  }
}

/**
 * Kolone taska (create ∨ update) → [kolona, vrednost] parovi za dinamički SQL.
 * Prazan string → NULL (paritet 1.0 sanitizeTaskPayload). Enum kolone se pišu kao
 * LABELE uz `::pb_*` cast (§C — bez Prisma enum-member prevoda). Uključuje `naziv`
 * SAMO kad je prisutan (create ga uvek nosi; update opciono).
 */
function taskColumnValues(dto: {
  naziv?: string;
  opis?: string;
  problem?: string;
  projectId?: string;
  employeeId?: string;
  vrsta?: string;
  prioritet?: string;
  status?: string;
  datumPocetkaPlan?: string;
  datumZavrsetkaPlan?: string;
  datumPocetkaReal?: string;
  datumZavrsetkaReal?: string;
  procenatZavrsenosti?: number;
  normaSatiDan?: number;
}): [Prisma.Sql, Prisma.Sql][] {
  const out: [Prisma.Sql, Prisma.Sql][] = [];
  const txt = (col: string, v?: string) => {
    if (v === undefined) return;
    out.push([Prisma.raw(col), Prisma.sql`${v === "" ? null : v}`]);
  };
  const uuid = (col: string, v?: string) => {
    if (v === undefined) return;
    out.push([Prisma.raw(col), Prisma.sql`${v === "" ? null : v}::uuid`]);
  };
  const en = (col: string, cast: string, v?: string) => {
    if (v === undefined) return;
    out.push([Prisma.raw(col), Prisma.sql`${v}::${Prisma.raw(cast)}`]);
  };
  const dt = (col: string, v?: string) => {
    if (v === undefined) return;
    out.push([Prisma.raw(col), Prisma.sql`${v === "" ? null : v}::date`]);
  };
  const num = (col: string, v?: number) => {
    if (v === undefined) return;
    out.push([Prisma.raw(col), Prisma.sql`${v}`]);
  };
  txt("naziv", dto.naziv);
  txt("opis", dto.opis);
  txt("problem", dto.problem);
  uuid("project_id", dto.projectId);
  uuid("employee_id", dto.employeeId);
  en("vrsta", "pb_task_vrsta", dto.vrsta);
  en("prioritet", "pb_prioritet", dto.prioritet);
  en("status", "pb_task_status", dto.status);
  dt("datum_pocetka_plan", dto.datumPocetkaPlan);
  dt("datum_zavrsetka_plan", dto.datumZavrsetkaPlan);
  dt("datum_pocetka_real", dto.datumPocetkaReal);
  dt("datum_zavrsetka_real", dto.datumZavrsetkaReal);
  num("procenat_zavrsenosti", dto.procenatZavrsenosti);
  num("norma_sati_dan", dto.normaSatiDan);
  return out;
}

/** @-mentions iz teksta (paritet 1.0 parseMentions): @ime/@email → jedinstveni bez @. */
function parseMentions(text: string): string[] {
  const matches = String(text || "").match(/@[\w.\-+]+/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/** Bezbedno ime fajla (paritet 1.0 sanitizeFileName): NFKD, ne-\w.- → _, trim, ≤80. */
function safeFileName(name: string): string {
  return (
    String(name || "file")
      .normalize("NFKD")
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "file"
  );
}

/** Radni-dani prozor: broj 1..120 (paritet 1.0 opterećenosti); default 20. */
function clampWindow(v?: string): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(n, 120);
}

/** Parsiraj int uz default + clamp [min,max] (limit/offset saveta; RPC re-clampa i sam). */
function clampInt(
  v: string | undefined,
  def: number,
  min: number,
  max: number,
): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/** BigInt kolona (Prisma model) → Number (BigInt ne prežive res.json). */
function bigIntOut<T extends Record<string, unknown>>(row: T, key: keyof T): T {
  const v = row[key];
  return v == null || typeof v !== "bigint"
    ? row
    : { ...row, [key]: Number(v) };
}
