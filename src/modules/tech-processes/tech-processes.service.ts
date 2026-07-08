import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

/** Vrste kvaliteta delova (`part_quality_types`, spec §1): 0=dobar,1=dorada,2=škart. */
export const PART_QUALITY = { GOOD: 0, REWORK: 1, SCRAP: 2 } as const;

/**
 * Prag za „kritičan postupak" u danima do roka izrade (production_deadline sa RN-a).
 * severity 1 (žuta) / 2 (narandžasta) / 3 (crvena) — spec §2 (`frmKriticniPostupci`).
 */
const CRITICAL_YELLOW_MAX_DAYS = 7;
const CRITICAL_ORANGE_MAX_DAYS = 2;

export interface ListTechProcessesQuery {
  page?: string;
  pageSize?: string;
  /** Filter by ident number (substring, case-insensitive). */
  identNumber?: string;
  /** Filter by project id. */
  projectId?: string;
}

/** „Kartica TP" — jedan postupak = trojka (projectId, identNumber, variant). */
export interface CardQuery {
  projectId?: string;
  identNumber?: string;
  variant?: string;
}

export interface CriticalQuery {
  page?: string;
  pageSize?: string;
}

export interface WorkerPerformanceQuery {
  /** Period od (ISO 8601). */
  from?: string;
  /** Period do (ISO 8601). */
  to?: string;
}

export interface RnProgressQuery {
  page?: string;
  pageSize?: string;
  projectId?: string;
  /** Pretraga: ident / naziv pozicije / crtež. */
  q?: string;
}

// --- oblici sirovih redova iz $queryRaw upita (snake_case iz baze) ---

interface CriticalRaw {
  id: number;
  project_id: number;
  ident_number: string;
  variant: number;
  operation_number: number;
  work_center_code: string;
  worker_id: number;
  piece_count: number;
  entered_at: Date;
  production_deadline: Date;
  days_remaining: number;
}

interface CriticalCountsRaw {
  red: number;
  orange: number;
  yellow: number;
  total: number;
}

interface WorkerPerfRaw {
  worker_id: number;
  process_count: number;
  finished_count: number;
  total_pieces: number;
  good_pieces: number;
  rework_pieces: number;
  scrap_pieces: number;
  total_elapsed_seconds: number;
}

interface RnProgressRaw {
  id: number;
  project_id: number;
  ident_number: string;
  variant: number;
  part_name: string;
  drawing_number: string;
  planned: number;
  production_deadline: Date | null;
  handover_status_id: number;
  worker_id: number;
  made_good_significant: number;
  made_good_any: number;
  operation_count: number;
  finished_operation_count: number;
}

/**
 * Read-only access to technological processes (`tech_processes`).
 *
 * Relacije se razrešavaju batch upitima (ne Prisma required-relation JOIN) jer
 * legacy podaci imaju orphan FK-ove koji bi inače dali 500. Sume (komadi/vreme)
 * računa DB/API, ne UI (spec §3 pravilo 6). READ ONLY (do §11/RBAC).
 */
@Injectable()
export class TechProcessesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- LIST

  async list(query: ListTechProcessesQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.TechProcessWhereInput = {};
    if (query.identNumber) {
      where.identNumber = { contains: query.identNumber, mode: "insensitive" };
    }
    const projectId = Number.parseInt(query.projectId ?? "", 10);
    if (!Number.isNaN(projectId)) where.projectId = projectId;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.techProcess.findMany({
        where,
        orderBy: [{ enteredAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: {
          id: true,
          workerId: true,
          projectId: true,
          identNumber: true,
          variant: true,
          operationNumber: true,
          workCenterCode: true,
          identMark: true,
          pieceCount: true,
          enteredAt: true,
          finishedAt: true,
          isProcessFinished: true,
          workOrderId: true,
          qualityTypeId: true,
          signature: true,
          note: true,
        },
      }),
      this.prisma.techProcess.count({ where }),
    ]);

    const workers = await this.resolveWorkers(rows.map((r) => r.workerId));
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- CARD (Kartica TP)

  /**
   * „Kartica TP": svi redovi (operacije) jednog postupka + API-side sume.
   * Postupak je identifikovan trojkom (projectId, identNumber, variant).
   * Sume (komadi po kvalitetu 0/1/2, ukupno vreme) računa API — ne UI (spec §3 pravilo 6).
   */
  async card(query: CardQuery) {
    const projectId = Number.parseInt(query.projectId ?? "", 10);
    if (Number.isNaN(projectId))
      throw new BadRequestException(
        "Parametar 'projectId' je obavezan i mora biti broj.",
      );
    const identNumber = (query.identNumber ?? "").trim();
    if (!identNumber)
      throw new BadRequestException("Parametar 'identNumber' je obavezan.");
    const variantParsed = Number.parseInt(query.variant ?? "", 10);
    const variant = Number.isNaN(variantParsed) ? 0 : variantParsed;

    const rows = await this.prisma.techProcess.findMany({
      where: { projectId, identNumber, variant },
      orderBy: [{ operationNumber: "asc" }, { id: "asc" }],
      include: { documents: true },
    });
    if (!rows.length)
      throw new NotFoundException(
        `Kartica TP za predmet ${projectId}, ident ${identNumber}, varijanta ${variant} ne postoji`,
      );

    const [workers, quals, ops] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      this.resolveOperationsByCode(rows.map((r) => r.workCenterCode)),
    ]);

    // Sume na API-ju (spec §3 pravilo 6: SUM na DB/API, ne u UI).
    const piecesByQuality = { good: 0, rework: 0, scrap: 0 };
    let totalPieces = 0;
    let finishedCount = 0;
    let totalElapsedSeconds = 0;
    let hasElapsed = false;
    for (const r of rows) {
      const pieces = r.pieceCount;
      totalPieces += pieces;
      if (r.qualityTypeId === PART_QUALITY.GOOD) piecesByQuality.good += pieces;
      else if (r.qualityTypeId === PART_QUALITY.REWORK)
        piecesByQuality.rework += pieces;
      else if (r.qualityTypeId === PART_QUALITY.SCRAP)
        piecesByQuality.scrap += pieces;
      if (r.isProcessFinished) finishedCount += 1;
      if (r.finishedAt) {
        totalElapsedSeconds += Math.max(
          0,
          (r.finishedAt.getTime() - r.enteredAt.getTime()) / 1000,
        );
        hasElapsed = true;
      }
    }

    const data = {
      projectId,
      identNumber,
      variant,
      operationCount: rows.length,
      finishedCount,
      summary: {
        totalPieces,
        piecesByQuality,
        // Izvedeno: tech_processes nema kolonu radnog vremena — elapsed entered→finished.
        totalElapsedMinutes: hasElapsed
          ? Math.round(totalElapsedSeconds / 60)
          : null,
      },
      rows: rows.map((r) => ({
        ...r,
        worker: workers.get(r.workerId) ?? null,
        operation: ops.get(r.workCenterCode) ?? null,
        qualityType: quals.get(r.qualityTypeId) ?? null,
      })),
    };
    return { data };
  }

  // ---------------------------------------------------------------- CRITICAL

  /**
   * Kritični postupci — nezavršeni postupci čiji RN rok (production_deadline)
   * ističe (severity 1/2/3). Rok se čita sa `work_orders` preko trojke
   * (projectId, identNumber, variant); tech_processes nema sopstveni rok.
   * severity: 3=crvena (rok prošao), 2=narandžasta (≤2 dana), 1=žuta (≤7 dana).
   */
  async critical(query: CriticalQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    // Zajednička baza: nezavršeni postupci + rok sa pripadajućeg RN-a (MIN).
    const base = Prisma.sql`
      SELECT tp.id, tp.project_id, tp.ident_number, tp.variant, tp.operation_number,
             tp.work_center_code, tp.worker_id, tp.piece_count, tp.entered_at,
             (SELECT MIN(wo.production_deadline) FROM work_orders wo
                WHERE wo.project_id = tp.project_id
                  AND wo.ident_number = tp.ident_number
                  AND wo.variant = tp.variant) AS production_deadline
      FROM tech_processes tp
      WHERE COALESCE(tp.is_process_finished, false) = false
    `;

    const rows = await this.prisma.$queryRaw<CriticalRaw[]>(Prisma.sql`
      WITH tp_dl AS (${base})
      SELECT id, project_id, ident_number, variant, operation_number,
             work_center_code, worker_id, piece_count, entered_at,
             production_deadline,
             (production_deadline::date - CURRENT_DATE) AS days_remaining
      FROM tp_dl
      WHERE production_deadline IS NOT NULL
        AND (production_deadline::date - CURRENT_DATE) <= ${CRITICAL_YELLOW_MAX_DAYS}
      ORDER BY days_remaining ASC, project_id ASC, ident_number ASC, operation_number ASC
      LIMIT ${take} OFFSET ${skip}
    `);

    const counts = await this.prisma.$queryRaw<CriticalCountsRaw[]>(Prisma.sql`
      WITH tp_dl AS (${base}),
      f AS (
        SELECT (production_deadline::date - CURRENT_DATE) AS dr
        FROM tp_dl
        WHERE production_deadline IS NOT NULL
          AND (production_deadline::date - CURRENT_DATE) <= ${CRITICAL_YELLOW_MAX_DAYS}
      )
      SELECT
        (COUNT(*) FILTER (WHERE dr < 0))::int AS red,
        (COUNT(*) FILTER (WHERE dr BETWEEN 0 AND ${CRITICAL_ORANGE_MAX_DAYS}))::int AS orange,
        (COUNT(*) FILTER (WHERE dr BETWEEN ${CRITICAL_ORANGE_MAX_DAYS + 1} AND ${CRITICAL_YELLOW_MAX_DAYS}))::int AS yellow,
        (COUNT(*))::int AS total
      FROM f
    `);
    const c = counts[0] ?? { red: 0, orange: 0, yellow: 0, total: 0 };

    const [workers, ops] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.worker_id)),
      this.resolveOperationsByCode(rows.map((r) => r.work_center_code)),
    ]);

    const data = rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      identNumber: r.ident_number,
      variant: r.variant,
      operationNumber: r.operation_number,
      workCenterCode: r.work_center_code,
      pieceCount: r.piece_count,
      enteredAt: r.entered_at,
      workerId: r.worker_id,
      worker: workers.get(r.worker_id) ?? null,
      operation: ops.get(r.work_center_code) ?? null,
      productionDeadline: r.production_deadline,
      daysRemaining: r.days_remaining,
      severity: this.severityFromDays(r.days_remaining),
    }));

    return {
      data,
      meta: {
        ...pageMeta(page, pageSize, c.total),
        severityCounts: { yellow: c.yellow, orange: c.orange, red: c.red },
        thresholds: {
          redWhenOverdue: true,
          orangeMaxDays: CRITICAL_ORANGE_MAX_DAYS,
          yellowMaxDays: CRITICAL_YELLOW_MAX_DAYS,
        },
      },
    };
  }

  private severityFromDays(days: number): 1 | 2 | 3 {
    if (days < 0) return 3;
    if (days <= CRITICAL_ORANGE_MAX_DAYS) return 2;
    return 1;
  }

  // ---------------------------------------------------------------- WORKER PERFORMANCE

  /**
   * Učinak po radniku u periodu — agregacija komada (po kvalitetu 0/1/2) i vremena
   * po `worker_id` iz `tech_processes`. Period se filtrira po `entered_at` (kada je
   * rad evidentiran). „Vreme" je izvedeno (elapsed entered→finished za završene) jer
   * tech_processes nema kolonu radnog vremena. Sume računa DB (spec §3 pravilo 6).
   */
  async workerPerformance(query: WorkerPerformanceQuery) {
    const from = this.parseDateParam(query.from, "from");
    const to = this.parseDateParam(query.to, "to");

    const conds: Prisma.Sql[] = [];
    if (from) conds.push(Prisma.sql`entered_at >= ${from}`);
    if (to) conds.push(Prisma.sql`entered_at < ${to}`);
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<WorkerPerfRaw[]>(Prisma.sql`
      SELECT worker_id,
             (COUNT(*))::int AS process_count,
             (COUNT(*) FILTER (WHERE COALESCE(is_process_finished, false)))::int AS finished_count,
             COALESCE(SUM(piece_count), 0)::int AS total_pieces,
             COALESCE(SUM(piece_count) FILTER (WHERE quality_type_id = ${PART_QUALITY.GOOD}), 0)::int AS good_pieces,
             COALESCE(SUM(piece_count) FILTER (WHERE quality_type_id = ${PART_QUALITY.REWORK}), 0)::int AS rework_pieces,
             COALESCE(SUM(piece_count) FILTER (WHERE quality_type_id = ${PART_QUALITY.SCRAP}), 0)::int AS scrap_pieces,
             COALESCE(SUM(EXTRACT(EPOCH FROM (finished_at - entered_at))) FILTER (WHERE finished_at IS NOT NULL), 0)::float8 AS total_elapsed_seconds
      FROM tech_processes
      ${whereSql}
      GROUP BY worker_id
      ORDER BY total_pieces DESC, worker_id ASC
    `);

    const workers = await this.resolveWorkers(rows.map((r) => r.worker_id));
    const data = rows.map((r) => ({
      workerId: r.worker_id,
      worker: workers.get(r.worker_id) ?? null,
      processCount: r.process_count,
      finishedCount: r.finished_count,
      totalPieces: r.total_pieces,
      piecesByQuality: {
        good: r.good_pieces,
        rework: r.rework_pieces,
        scrap: r.scrap_pieces,
      },
      totalElapsedSeconds: Math.round(r.total_elapsed_seconds),
      totalElapsedMinutes: Math.round(r.total_elapsed_seconds / 60),
    }));

    return {
      data,
      meta: {
        from: from?.toISOString() ?? null,
        to: to?.toISOString() ?? null,
        workerCount: data.length,
      },
    };
  }

  private parseDateParam(
    value: string | undefined,
    name: string,
  ): Date | undefined {
    if (value === undefined || value === "") return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime()))
      throw new BadRequestException(
        `Parametar '${name}' nije ispravan datum (ISO 8601).`,
      );
    return d;
  }

  // ---------------------------------------------------------------- RN PROGRESS

  /**
   * „Pregled RN — statusi delova": po RN-u planirano vs napravljeno + procenat.
   * JOIN work_orders × tech_processes po (projectId, identNumber, variant).
   * „Napravljeno" = DOBAR komadi (kvalitet 0) — samo dobar broji za pokriće plana
   * (spec §3, migration/15 §5). Prednost imaju operacije `significant_for_finishing`;
   * ako ih nema, pada na max dobar preko svih operacija. Endpoint živi u
   * tech-processes kontroleru (ne dira se work-orders folder).
   */
  async rnProgress(query: RnProgressQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const conds: Prisma.Sql[] = [];
    const projectId = Number.parseInt(query.projectId ?? "", 10);
    if (!Number.isNaN(projectId))
      conds.push(Prisma.sql`wo.project_id = ${projectId}`);
    if (query.q) {
      const like = `%${query.q}%`;
      conds.push(
        Prisma.sql`(wo.ident_number ILIKE ${like} OR wo.part_name ILIKE ${like} OR wo.drawing_number ILIKE ${like})`,
      );
    }
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<RnProgressRaw[]>(Prisma.sql`
      SELECT wo.id, wo.project_id, wo.ident_number, wo.variant,
             wo.part_name, wo.drawing_number, wo.piece_count AS planned,
             wo.production_deadline, wo.handover_status_id, wo.worker_id,
             COALESCE((SELECT MAX(tp.piece_count) FROM tech_processes tp
                       JOIN operations op ON op.work_center_code = tp.work_center_code
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant
                         AND tp.quality_type_id = ${PART_QUALITY.GOOD}
                         AND COALESCE(op.significant_for_finishing, false) = true), 0)::int AS made_good_significant,
             COALESCE((SELECT MAX(tp.piece_count) FROM tech_processes tp
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant
                         AND tp.quality_type_id = ${PART_QUALITY.GOOD}), 0)::int AS made_good_any,
             COALESCE((SELECT COUNT(*) FROM tech_processes tp
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant), 0)::int AS operation_count,
             COALESCE((SELECT COUNT(*) FROM tech_processes tp
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant
                         AND COALESCE(tp.is_process_finished, false) = true), 0)::int AS finished_operation_count
      FROM work_orders wo
      ${whereSql}
      ORDER BY wo.production_deadline ASC NULLS LAST, wo.id ASC
      LIMIT ${take} OFFSET ${skip}
    `);

    const totalRes = await this.prisma.$queryRaw<
      { count: number }[]
    >(Prisma.sql`
      SELECT (COUNT(*))::int AS count FROM work_orders wo ${whereSql}
    `);
    const total = totalRes[0]?.count ?? 0;

    const [workers, statuses] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.worker_id)),
      this.resolveStatuses(rows.map((r) => r.handover_status_id)),
    ]);

    const data = rows.map((r) => {
      const madeGood =
        r.made_good_significant > 0 ? r.made_good_significant : r.made_good_any;
      const planned = r.planned;
      const cappedMade = Math.min(madeGood, planned);
      const completionPercent =
        planned > 0 ? Math.round((cappedMade / planned) * 100) : null;
      return {
        workOrderId: r.id,
        projectId: r.project_id,
        identNumber: r.ident_number,
        variant: r.variant,
        partName: r.part_name,
        drawingNumber: r.drawing_number,
        productionDeadline: r.production_deadline,
        handoverStatusId: r.handover_status_id,
        handoverStatus: statuses.get(r.handover_status_id) ?? null,
        workerId: r.worker_id,
        worker: workers.get(r.worker_id) ?? null,
        plannedPieces: planned,
        madeGoodPieces: madeGood,
        madeGoodSource: r.made_good_significant > 0 ? "significant" : "any",
        operationCount: r.operation_count,
        finishedOperationCount: r.finished_operation_count,
        completionPercent,
        isCompleted: planned > 0 && madeGood >= planned,
      };
    });

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- FIND ONE

  async findOne(id: number) {
    const tp = await this.prisma.techProcess.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!tp)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);

    const workers = await this.resolveWorkers([tp.workerId]);
    return { data: { ...tp, worker: workers.get(tp.workerId) ?? null } };
  }

  // --- batch resolveri (izbegavaju required-relation JOIN koji puca na orphan FK) ---

  /** NIKAD ne vraćati workers.password / workers.workerPassword (SAFE_WORKER_SELECT). */
  private async resolveWorkers(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  private async resolveQualityTypes(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.partQualityType.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true },
      }),
    );
  }

  private async resolveStatuses(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.handoverStatus.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true },
      }),
    );
  }

  private async resolveOperationsByCode(codes: string[]) {
    const uniq = [...new Set(codes.filter(Boolean))];
    const map = new Map<
      string,
      { workCenterCode: string; workCenterName: string; workUnitCode: string }
    >();
    if (!uniq.length) return map;
    const rows = await this.prisma.operation.findMany({
      where: { workCenterCode: { in: uniq } },
      select: {
        workCenterCode: true,
        workCenterName: true,
        workUnitCode: true,
      },
    });
    for (const r of rows) map.set(r.workCenterCode, r);
    return map;
  }
}
