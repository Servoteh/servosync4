import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseBarcode, formatOrderBarcode } from "./barcode";
import { type ScanTechProcessDto, validateScan } from "./dto/scan-tech-process.dto";
import {
  type FinishTechProcessDto,
  validateFinish,
} from "./dto/finish-tech-process.dto";
import {
  type ControlTechProcessDto,
  validateControl,
} from "./dto/control-tech-process.dto";
import {
  type StornoTechProcessDto,
  validateStorno,
} from "./dto/storno-tech-process.dto";
import { type StartWorkDto, validateStartWork } from "./dto/start-work.dto";
import { type StopWorkDto, validateStopWork } from "./dto/stop-work.dto";

/** Vrste kvaliteta delova (`part_quality_types`, spec §1): 0=dobar,1=dorada,2=škart. */
export const PART_QUALITY = { GOOD: 0, REWORK: 1, SCRAP: 2 } as const;

/**
 * „Skinuto sa prioriteta" pri zatvaranju postupka (§3 pravilo 2,
 * legacy `OznaciDaJeZavrsenPostupak`). `tech_processes` NEMA `priority` kolonu —
 * prioritet živi na `work_order_operations` (Was: tStavkeRN) → tamo se upisuje 255.
 */
const OPERATION_PRIORITY_DONE = 255;

/**
 * Prag za „kritičan postupak" u danima do roka izrade (production_deadline sa RN-a).
 * severity 1 (žuta) / 2 (narandžasta) / 3 (crvena) — spec §2 (`frmKriticniPostupci`).
 */
const CRITICAL_YELLOW_MAX_DAYS = 7;
const CRITICAL_ORANGE_MAX_DAYS = 2;

export interface ListTechProcessesQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: ident broj (substring, case-insensitive). Alias za `identNumber`. */
  q?: string;
  /** Filter by ident number (substring, case-insensitive). */
  identNumber?: string;
  /** Filter by project id. */
  projectId?: string;
  /** Radnik (tačan id). */
  workerId?: string;
  /** Radni centar (RJgrupaRC). */
  workCenterCode?: string;
  /** Vrsta kvaliteta (0=dobar,1=dorada,2=škart). */
  qualityTypeId?: string;
  /** `"true"` = samo završeni; `"false"` = samo otvoreni (nezavršeni); prazno = svi. */
  finished?: string;
  /** Evidentirano od/do (ISO 8601) — filter po `enteredAt`. */
  from?: string;
  to?: string;
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
 * računa DB/API, ne UI (spec §3 pravilo 6).
 *
 * Sadrži i WRITE-PATH barkod prijave rada (§3 pravila 1/2; ODLUKE 2026-07-08:
 * proizvodne tabele su ServoSync vlasništvo) — sve mutacije u `$transaction`.
 */
@Injectable()
export class TechProcessesService {
  private readonly logger = new Logger(TechProcessesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  // ---------------------------------------------------------------- LIST

  async list(query: ListTechProcessesQuery, user?: AuthUser) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    const filter: Prisma.TechProcessWhereInput = {};
    const ident = query.q?.trim() || query.identNumber;
    if (ident) filter.identNumber = { contains: ident, mode: "insensitive" };
    filter.projectId = intEq(query.projectId);
    filter.workerId = intEq(query.workerId);
    filter.qualityTypeId = intEq(query.qualityTypeId);
    if (query.workCenterCode?.trim())
      filter.workCenterCode = query.workCenterCode.trim();
    if (query.finished === "true") filter.isProcessFinished = true;
    else if (query.finished === "false") filter.isProcessFinished = { not: true };
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
      filter.enteredAt = range;
    }

    // Row-scope: `proizvodni_radnik` vidi samo svoje mašine; ostali (već read-ovlašćeni) sve.
    const where = await this.scope.withTechProcessScope(user, filter);

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

    const [workers, ops, quals] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveOperationsByCode(rows.map((r) => r.workCenterCode)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
    ]);
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      operation: ops.get(r.workCenterCode) ?? null,
      qualityType: quals.get(r.qualityTypeId) ?? null,
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

  // ============================================================ WRITE-PATH
  // Barkod prijava rada (kiosk). §3 pravila 1/2; mutacije odobrene §7 (ODLUKE
  // 2026-07-08: proizvodne tabele = ServoSync vlasništvo). Sve mutacije u
  // Prisma `$transaction` (legacy nije bio atomičan — §6 zamka).

  // ---------------------------------------------------------------- DECODE

  /**
   * `POST /barcode/decode` — parsira i validira JEDAN barkod. Vraća tip
   * (nalog/operacija) + polja; za **nalog** dodatno razrešava RN (`work_orders`)
   * i broj operacija u tehnološkom postupku po trojci (projectId, identNumber,
   * variant). Nevalidan barkod → 400 (`parseBarcode` baca `BadRequestException`).
   */
  async decodeBarcode(barcode: string) {
    const decoded = parseBarcode(barcode);
    if (decoded.type === "operacija") {
      // Razreši metapodatke radnog centra: `significantForFinishing` (= završna
      // kontrola → kiosk grana u KONTROLA režim, MODULE_SPEC_kontrola §1) + naziv.
      const op = await this.prisma.operation.findUnique({
        where: { workCenterCode: decoded.fields.workCenterCode },
        select: { workCenterName: true, significantForFinishing: true },
      });
      return {
        data: {
          type: decoded.type,
          marker: decoded.marker,
          fields: decoded.fields,
          operation: op
            ? {
                workCenterName: op.workCenterName,
                significantForFinishing: op.significantForFinishing === true,
              }
            : null,
        },
      };
    }

    // nalog → razreši RN + broj operacija u tehnološkom postupku.
    const { projectId, identNumber, variant } = decoded.fields;
    const [workOrder, operationCount] = await Promise.all([
      this.prisma.workOrder.findFirst({
        where: { projectId, identNumber, variant },
        orderBy: { id: "asc" },
        select: {
          id: true,
          projectId: true,
          identNumber: true,
          variant: true,
          partName: true,
          drawingNumber: true,
          pieceCount: true,
          productionDeadline: true,
          handoverStatusId: true,
          status: true,
        },
      }),
      this.prisma.techProcess.count({
        where: { projectId, identNumber, variant },
      }),
    ]);

    return {
      data: {
        type: decoded.type,
        marker: decoded.marker,
        fields: decoded.fields,
        workOrder,
        techProcess: { operationCount },
      },
    };
  }

  // ---------------------------------------------------------------- SCAN (prijava rada)

  /**
   * `POST /scan` — barkod prijava rada. Radnik skenira nalog + operaciju i unosi
   * broj napravljenih komada. Koraci (§3 pravilo 1, migration/15 §5):
   *  1. parsiraj oba barkoda (400 na nevalidan); orderBarcode mora biti nalog,
   *     operationBarcode operacija; `revision` mora biti ista (🔴 isti otisak).
   *     Dodatno: ako je otisak starije revizije od tekućeg RN-a → `staleWorkOrder`
   *     upozorenje (ne blokira; MODULE_SPEC_stampa §5).
   *  2. u transakciji nađi `tech_processes` red po trojci + `workCenterCode`
   *     (+ `operationNumber` ako je numeričan) — jedan red = jedna operacija.
   *  3. **akumuliraj** `pieceCount` (prijava = novi napravljeni komadi); ako je
   *     dosegnut plan RN-a → `isProcessFinished=true` + `finishedAt` i `priority=255`
   *     na `work_order_operations`.
   *  4. ako su SVE značajne operacije završene → označi RN (`work_orders.status=true`).
   *
   * NAPOMENA: `tech_processes` NEMA kolonu radnog vremena — vreme ostaje izvedeno
   * (elapsed entered→finished, vidi `card`/`workerPerformance`); ovde se NE upisuje.
   */
  async scan(dto: ScanTechProcessDto) {
    validateScan(dto);
    // Identitet radnika iz ID kartice (opciono) → audit ko je radio (§4/§5).
    const worker = dto.workerCard
      ? await this.resolveWorkerByCard(dto.workerCard)
      : null;
    const order = parseBarcode(dto.orderBarcode);
    const operation = parseBarcode(dto.operationBarcode);
    if (order.type !== "nalog")
      throw new BadRequestException(
        "'orderBarcode' nije nalog-barkod (očekivano 'RNZ:...').",
      );
    if (operation.type !== "operacija")
      throw new BadRequestException(
        "'operationBarcode' nije operacija-barkod (očekivano 'S:...').",
      );
    // 🔴 „isti otisak": operacioni barkod mora imati istu reviziju kao nalog
    // (polje 5). Legacy je ovde koristio PrnTimer; 2.0 = revizija (MODULE_SPEC_stampa §5).
    if (order.fields.revision !== operation.fields.revision)
      throw new BadRequestException(
        `Revizija se ne poklapa: nalog=${order.fields.revision}, operacija=${operation.fields.revision} — barkodovi ne pripadaju istom otisku.`,
      );

    const { projectId, identNumber } = order.fields;
    const scannedVariant = order.fields.variant;
    const { operationNumber, workCenterCode } = operation.fields;

    // Machine-access (spec §3.4, 🔴): identifikovani radnik radi samo na svojim mašinama.
    // Poštuje AUTHZ_ENFORCE (kao guard): enforce → 403; shadow → upozorenje + flag u odgovoru.
    let machineAccessWarning: string | null = null;
    if (worker) {
      const violation = await this.scope.workerMachineViolation(
        worker.id,
        workCenterCode,
      );
      if (violation) {
        if (this.scope.isEnforced()) throw new ForbiddenException(violation);
        this.logger.warn(
          `SHADOW machine-access: ${violation} (AUTHZ_ENFORCE=false, prijava rada dozvoljena)`,
        );
        machineAccessWarning = violation;
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Varijanta se menja U MESTU pri izmeni tehnologije/crteža (Vasa) — zato NE
      // pinujemo skeniranu varijantu: (projectId, identNumber) jednoznačno određuje RN,
      // pa uzimamo TEKUĆI red operacije (najviša varijanta). Staru varijantu sa otiska
      // koristimo samo za detekciju zastarelosti (guard ispod).
      const where: Prisma.TechProcessWhereInput = {
        projectId,
        identNumber,
        workCenterCode,
      };
      if (operationNumber !== null) where.operationNumber = operationNumber;

      const tp = await tx.techProcess.findFirst({
        where,
        orderBy: [
          { variant: "desc" },
          { isProcessFinished: "asc" },
          { id: "asc" },
        ],
      });
      if (!tp)
        throw new NotFoundException(
          `Operacija (RC ${workCenterCode}${
            operationNumber !== null ? `, op. ${operationNumber}` : ""
          }) nije nađena u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
        );
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Operacija (postupak ${tp.id}) je već zatvorena — prijava rada nije moguća.`,
        );

      const workOrder = await this.findWorkOrderByTriple(
        tx,
        projectId,
        identNumber,
        tp.variant,
      );
      const planned = workOrder?.pieceCount ?? null;

      // Verzioni guard (UPOZORENJE, ne blokada — MODULE_SPEC_stampa §5): pri izmeni
      // tehnologije/crteža `variant` se podiže U MESTU (Vasa). Ako je varijanta sa
      // otiska starija od tekuće → radnik je uzeo STAR odštampan nalog. Rad se svejedno
      // evidentira na tekuću varijantu (`tp.variant`), uz upozorenje.
      const currentVariant = tp.variant;
      const staleWorkOrder = scannedVariant < currentVariant;

      // Prijava rada = akumulacija napravljenih komada na redu operacije.
      const newPieceCount = tp.pieceCount + dto.pieceCount;
      const reachedPlan = planned !== null && newPieceCount >= planned;

      const updated = await tx.techProcess.update({
        where: { id: tp.id },
        data: {
          pieceCount: newPieceCount,
          // Audit: radnik koji je prijavio rad (ID kartica) — legacy `SifraRadnika`.
          ...(worker ? { workerId: worker.id } : {}),
          ...(reachedPlan
            ? { isProcessFinished: true, finishedAt: new Date() }
            : {}),
        },
      });

      // Dosegnut plan → operacija „skinuta sa prioriteta" (priority=255).
      const prioritized = reachedPlan
        ? await this.setOperationDonePriority(
            tx,
            workOrder?.id ?? tp.workOrderId,
            tp.operationNumber,
            tp.workCenterCode,
          )
        : 0;

      const workOrderCompleted = await this.markWorkOrderIfComplete(
        tx,
        projectId,
        identNumber,
        tp.variant,
      );

      return {
        tp: updated,
        workOrder,
        planned,
        reachedPlan,
        prioritized,
        workOrderCompleted,
        staleWorkOrder,
        printedVariant: scannedVariant,
        currentVariant,
      };
    });

    const workers = await this.resolveWorkers([result.tp.workerId]);
    return {
      data: {
        techProcess: {
          ...result.tp,
          worker: workers.get(result.tp.workerId) ?? null,
        },
        reportedPieces: dto.pieceCount,
        plannedPieces: result.planned,
        operationFinished: result.reachedPlan,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        workOrder: result.workOrder,
        // Verzioni guard: upozorenje ako je skenirani otisak starije varijante (§5).
        staleWorkOrder: result.staleWorkOrder,
        printedVariant: result.printedVariant,
        currentVariant: result.currentVariant,
        // Machine-access (shadow): radnik nema pravo na taj RC (u enforce režimu bi bio 403).
        machineAccessWarning,
      },
    };
  }

  // ---------------------------------------------------------------- FINISH

  /**
   * `POST /:id/finish` — zatvaranje postupka (§3 pravilo 2, legacy
   * `OznaciDaJeZavrsenPostupak`). U jednoj transakciji:
   *  - provera količina: napravljeno (`dto.pieceCount ?? postojeći`) ne sme
   *    premašiti planirano sa RN-a → **422** (ne zatvara);
   *  - `isProcessFinished=true` + `finishedAt`;
   *  - `priority=255` na `work_order_operations` (TechProcess nema `priority`);
   *  - ako su sve značajne operacije završene → označi RN (`status=true`).
   */
  async finish(id: number, dto?: FinishTechProcessDto) {
    validateFinish(dto);
    const worker = dto?.workerCard
      ? await this.resolveWorkerByCard(dto.workerCard)
      : null;

    const result = await this.prisma.$transaction(async (tx) => {
      const tp = await tx.techProcess.findUnique({ where: { id } });
      if (!tp)
        throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Postupak ${id} je već zatvoren.`,
        );

      const workOrder = await this.findWorkOrderByTriple(
        tx,
        tp.projectId,
        tp.identNumber,
        tp.variant,
      );
      const planned = workOrder?.pieceCount ?? null;
      const effectivePieces = dto?.pieceCount ?? tp.pieceCount;

      // 🔴 provera količina: premašaj plana → 422 (ne zatvara).
      if (planned !== null && effectivePieces > planned)
        throw new UnprocessableEntityException(
          `Napravljeno (${effectivePieces}) premašuje planirano (${planned}) — postupak se ne može zatvoriti.`,
        );

      const updated = await tx.techProcess.update({
        where: { id },
        data: {
          ...(dto?.pieceCount !== undefined
            ? { pieceCount: dto.pieceCount }
            : {}),
          ...(dto?.note?.trim() ? { note: dto.note.trim() } : {}),
          ...(worker ? { workerId: worker.id } : {}),
          isProcessFinished: true,
          finishedAt: new Date(),
        },
      });

      const prioritized = await this.setOperationDonePriority(
        tx,
        workOrder?.id ?? tp.workOrderId,
        tp.operationNumber,
        tp.workCenterCode,
      );

      const workOrderCompleted = await this.markWorkOrderIfComplete(
        tx,
        tp.projectId,
        tp.identNumber,
        tp.variant,
      );

      return {
        tp: updated,
        workOrder,
        planned,
        effectivePieces,
        prioritized,
        workOrderCompleted,
      };
    });

    const workers = await this.resolveWorkers([result.tp.workerId]);
    return {
      data: {
        techProcess: {
          ...result.tp,
          worker: workers.get(result.tp.workerId) ?? null,
        },
        finishedPieces: result.effectivePieces,
        plannedPieces: result.planned,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        workOrder: result.workOrder,
      },
    };
  }

  // ---------------------------------------------------------------- START/STOP (A-4: evidencija vremena)

  /**
   * `POST /work/start` — START skena („dva skena", A-4). Otvara vremensku sesiju
   * (`work_time_entries`, `stopped_at = NULL`) za radnika + operaciju. Sesija je
   * ključana po (workerId, techProcessId) — parcijalni unique indeks garantuje najviše
   * jednu otvorenu sesiju po radniku+operaciji (2.0 analogon `DefinisiIDPostupkaZaRadnika`).
   * NE dira `tech_processes` (komadi se knjiže tek na STOP). Multitasking = samo upozorenje.
   */
  async startWork(dto: StartWorkDto) {
    validateStartWork(dto);
    const worker = await this.resolveWorkerByCard(dto.workerCard);
    const { order, operation } = this.parseWorkBarcodes(
      dto.orderBarcode,
      dto.operationBarcode,
    );
    const { projectId, identNumber } = order.fields;
    const scannedVariant = order.fields.variant;
    const { operationNumber, workCenterCode } = operation.fields;
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      workCenterCode,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const tp = await this.findRoutingTp(
        tx,
        projectId,
        identNumber,
        workCenterCode,
        operationNumber,
      );
      if (!tp)
        throw new NotFoundException(
          `Operacija (RC ${workCenterCode}${
            operationNumber !== null ? `, op. ${operationNumber}` : ""
          }) nije nađena u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
        );
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Operacija (postupak ${tp.id}) je već zatvorena — rad se ne može započeti.`,
        );

      const workOrder = await this.findWorkOrderByTriple(
        tx,
        projectId,
        identNumber,
        tp.variant,
      );

      // Multitasking (2.0 nema `MultiNalog` kolonu): otvorena sesija na DRUGOJ operaciji
      // → samo upozorenje (rad se svejedno započinje). Hard-block je P2.
      const otherOpen = await tx.workTimeEntry.findFirst({
        where: {
          workerId: worker.id,
          stoppedAt: null,
          NOT: { techProcessId: tp.id },
        },
        select: { operationNumber: true, workCenterCode: true },
      });

      let entry;
      try {
        entry = await tx.workTimeEntry.create({
          data: {
            techProcessId: tp.id,
            workOrderId: workOrder?.id ?? (tp.workOrderId || null),
            projectId,
            identNumber,
            variant: tp.variant,
            operationNumber: tp.operationNumber,
            workCenterCode: tp.workCenterCode,
            workerId: worker.id,
            startedAt: new Date(),
            stoppedAt: null,
            pieceCount: 0,
          },
        });
      } catch (e) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        )
          throw new ConflictException(
            `Rad na ovoj operaciji je već započet (otvorena sesija) — skeniraj STOP da završiš.`,
          );
        throw e;
      }

      return {
        entry,
        tp,
        workOrder,
        otherOpen,
        staleWorkOrder: scannedVariant < tp.variant,
        currentVariant: tp.variant,
      };
    });

    return {
      data: {
        session: {
          id: result.entry.id,
          startedAt: result.entry.startedAt,
          techProcessId: result.tp.id,
        },
        techProcess: result.tp,
        workOrder: result.workOrder,
        staleWorkOrder: result.staleWorkOrder,
        printedVariant: scannedVariant,
        currentVariant: result.currentVariant,
        machineAccessWarning,
        multitaskingWarning: result.otherOpen
          ? `Već imaš otvorenu sesiju na drugoj operaciji (RC ${result.otherOpen.workCenterCode}, op. ${result.otherOpen.operationNumber}). Rad je svejedno započet.`
          : null,
      },
    };
  }

  /**
   * `POST /work/stop` — STOP skena („dva skena", A-4). Zatvara otvorenu sesiju radnika
   * za tu operaciju (`stopped_at`, `piece_count`) i AKUMULIRA komade na `tech_processes`
   * (isti efekat kao `scan` — komadi ostaju autoritativni na redu operacije). Ako otvorena
   * sesija ne postoji, kreira trenutnu (`started_at = stopped_at`) — jednokratni fallback.
   */
  async stopWork(dto: StopWorkDto) {
    validateStopWork(dto);
    const worker = await this.resolveWorkerByCard(dto.workerCard);
    const { order, operation } = this.parseWorkBarcodes(
      dto.orderBarcode,
      dto.operationBarcode,
    );
    const { projectId, identNumber } = order.fields;
    const scannedVariant = order.fields.variant;
    const { operationNumber, workCenterCode } = operation.fields;
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      workCenterCode,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const tp = await this.findRoutingTp(
        tx,
        projectId,
        identNumber,
        workCenterCode,
        operationNumber,
      );
      if (!tp)
        throw new NotFoundException(
          `Operacija (RC ${workCenterCode}${
            operationNumber !== null ? `, op. ${operationNumber}` : ""
          }) nije nađena u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
        );
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Operacija (postupak ${tp.id}) je već zatvorena — prijava rada nije moguća.`,
        );

      const workOrder = await this.findWorkOrderByTriple(
        tx,
        projectId,
        identNumber,
        tp.variant,
      );
      const planned = workOrder?.pieceCount ?? null;
      const note = dto.note?.trim() || null;
      const now = new Date();

      // Zatvori otvorenu sesiju ili kreiraj trenutnu (single-shot fallback).
      const open = await tx.workTimeEntry.findFirst({
        where: { workerId: worker.id, techProcessId: tp.id, stoppedAt: null },
        orderBy: { id: "desc" },
      });
      const startedAt = open ? open.startedAt : now;
      const session = open
        ? await tx.workTimeEntry.update({
            where: { id: open.id },
            data: { stoppedAt: now, pieceCount: dto.pieceCount, note },
          })
        : await tx.workTimeEntry.create({
            data: {
              techProcessId: tp.id,
              workOrderId: workOrder?.id ?? (tp.workOrderId || null),
              projectId,
              identNumber,
              variant: tp.variant,
              operationNumber: tp.operationNumber,
              workCenterCode: tp.workCenterCode,
              workerId: worker.id,
              startedAt: now,
              stoppedAt: now,
              pieceCount: dto.pieceCount,
              note,
            },
          });

      // AKUMULACIJA (isto kao scan()): komadi na red operacije + eventualno zatvaranje.
      const newPieceCount = tp.pieceCount + dto.pieceCount;
      const reachedPlan = planned !== null && newPieceCount >= planned;
      const updated = await tx.techProcess.update({
        where: { id: tp.id },
        data: {
          pieceCount: newPieceCount,
          workerId: worker.id,
          ...(reachedPlan ? { isProcessFinished: true, finishedAt: now } : {}),
        },
      });
      const prioritized = reachedPlan
        ? await this.setOperationDonePriority(
            tx,
            workOrder?.id ?? tp.workOrderId,
            tp.operationNumber,
            tp.workCenterCode,
          )
        : 0;
      const workOrderCompleted = await this.markWorkOrderIfComplete(
        tx,
        projectId,
        identNumber,
        tp.variant,
      );

      return {
        tp: updated,
        session,
        startedAt,
        stoppedAt: now,
        instant: !open,
        workOrder,
        planned,
        reachedPlan,
        prioritized,
        workOrderCompleted,
        staleWorkOrder: scannedVariant < tp.variant,
        currentVariant: tp.variant,
      };
    });

    const workers = await this.resolveWorkers([result.tp.workerId]);
    const elapsedSeconds = Math.max(
      0,
      Math.round(
        (result.stoppedAt.getTime() - result.startedAt.getTime()) / 1000,
      ),
    );
    return {
      data: {
        techProcess: {
          ...result.tp,
          worker: workers.get(result.tp.workerId) ?? null,
        },
        session: {
          id: result.session.id,
          startedAt: result.startedAt,
          stoppedAt: result.stoppedAt,
          elapsedSeconds,
          instant: result.instant,
        },
        reportedPieces: dto.pieceCount,
        plannedPieces: result.planned,
        operationFinished: result.reachedPlan,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        workOrder: result.workOrder,
        staleWorkOrder: result.staleWorkOrder,
        printedVariant: scannedVariant,
        currentVariant: result.currentVariant,
        machineAccessWarning,
      },
    };
  }

  /**
   * `GET /work/open` — stanje sesije za (radnik, operacija) razrešeno iz barkodova.
   * Vodi kiosk: postoji otvorena sesija → STOP režim; ne postoji → START režim.
   */
  async openSession(query: {
    orderBarcode?: string;
    operationBarcode?: string;
    workerCard?: string;
  }) {
    const worker = await this.resolveWorkerByCard(query.workerCard ?? "");
    const { order, operation } = this.parseWorkBarcodes(
      query.orderBarcode ?? "",
      query.operationBarcode ?? "",
    );
    const { projectId, identNumber } = order.fields;
    const { operationNumber, workCenterCode } = operation.fields;

    const tp = await this.findRoutingTp(
      this.prisma,
      projectId,
      identNumber,
      workCenterCode,
      operationNumber,
    );
    if (!tp)
      throw new NotFoundException(
        `Operacija (RC ${workCenterCode}${
          operationNumber !== null ? `, op. ${operationNumber}` : ""
        }) nije nađena u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
      );

    const entry = await this.prisma.workTimeEntry.findFirst({
      where: { workerId: worker.id, techProcessId: tp.id, stoppedAt: null },
      orderBy: { id: "desc" },
      select: { id: true, startedAt: true },
    });

    return {
      data: {
        techProcessId: tp.id,
        operationFinished: tp.isProcessFinished ?? false,
        open: !!entry,
        session: entry ? { id: entry.id, startedAt: entry.startedAt } : null,
        worker: { id: worker.id, fullName: worker.fullName },
      },
    };
  }

  /**
   * `POST /work/auto-close` — zatvori sesije ostavljene otvorene (npr. preko noći).
   * Poziva ga EKSTERNI cron/systemd (bez nove zavisnosti, ODLUKE #A4-autoclose).
   * Sve `stopped_at IS NULL` starije od `olderThanHours` (default 12h) → `stopped_at = now`,
   * `auto_closed = true`; komadi ostaju (0 ako nije bilo STOP-a). Ostaju flag-ovane u
   * „Loše evidentirani". NE dira `tech_processes`.
   */
  async autoCloseOpenSessions(olderThanHours = 12) {
    const hours = Number.isFinite(olderThanHours) && olderThanHours > 0 ? olderThanHours : 12;
    const cutoff = new Date(Date.now() - hours * 3_600_000);
    const res = await this.prisma.workTimeEntry.updateMany({
      where: { stoppedAt: null, startedAt: { lt: cutoff } },
      data: { stoppedAt: new Date(), autoClosed: true },
    });
    this.logger.log(
      `auto-close sesija: zatvoreno ${res.count} (otvorene duže od ${hours}h)`,
    );
    return { data: { closed: res.count, olderThanHours: hours } };
  }

  // ---------------------------------------------------------------- CONTROL (završna kontrola)

  /**
   * `POST /control` — ZAVRŠNA KONTROLA (MODULE_SPEC_kontrola §3.2/§5; legacy
   * BarKodUnos2024 ekrani 5–7). Kontrolor skenira nalog + operaciju + ID karticu.
   * CREATE-ON-SCAN: za završnu kontrolu red u `tech_processes` obično ne postoji
   * unapred — servis ga NAĐE (otvoren) ili OTVORI, pošto proveri da je operacija u
   * routingu RN-a (`work_order_operations`) i završna kontrola. U jednoj transakciji:
   *  - kontrolor iz ID kartice (`workerCard` → `workers.cardId`) — audit ko+kada (ODLUKE #14);
   *  - operacija MORA biti završna kontrola (`operations.significantForFinishing`);
   *  - 🔴 zbir `locations[].quantity` = `pieceCount` (DTO), premašaj plana → 422;
   *  - knjiži `part_locations` (+quantity placement; §3.7 — lokacija tek posle završne kontrole)
   *    sa `qualityTypeId` i kontrolorom kao izvršiocem;
   *  - zatvara postupak (`isProcessFinished`, `finishedAt`, `qualityTypeId`, `workerId`,
   *    `priority=255`); ako su sve značajne operacije gotove → RN završen.
   *
   * P1: DORADA/ŠKART (kvalitet 1/2) se knjiži, ali child RN (`-D/-S`) + poruka tehnologu
   * su P2 → odgovor nosi `childOrderPending: true`. Nalepnica (RNZ) se vraća u `label`
   * (front štampa preko proxy-ja). `machine_access` provera kontrolora — TODO(P2).
   */
  async control(dto: ControlTechProcessDto) {
    validateControl(dto);
    const worker = await this.resolveWorkerByCard(dto.workerCard);

    const order = parseBarcode(dto.orderBarcode);
    const operation = parseBarcode(dto.operationBarcode);
    if (order.type !== "nalog")
      throw new BadRequestException(
        "'orderBarcode' nije nalog-barkod (očekivano 'RNZ:...').",
      );
    if (operation.type !== "operacija")
      throw new BadRequestException(
        "'operationBarcode' nije operacija-barkod (očekivano 'S:...').",
      );
    if (order.fields.revision !== operation.fields.revision)
      throw new BadRequestException(
        `Revizija se ne poklapa: nalog=${order.fields.revision}, operacija=${operation.fields.revision} — barkodovi ne pripadaju istom otisku.`,
      );
    if (operation.fields.operationNumber === null)
      throw new BadRequestException(
        "Operacija-barkod nema numerički broj operacije — kontrola nije moguća.",
      );

    const { projectId, identNumber, variant } = order.fields;
    const { operationNumber, workCenterCode, identMark } = operation.fields;

    const result = await this.prisma.$transaction(async (tx) => {
      const workOrder = await this.findWorkOrderByTriple(
        tx,
        projectId,
        identNumber,
        variant,
      );
      if (!workOrder)
        throw new NotFoundException(
          `RN za predmet ${projectId}, ident ${identNumber}, var. ${variant} nije nađen.`,
        );

      // Operacija mora biti u routingu RN-a (work_order_operations) i završna kontrola.
      const routing = await tx.workOrderOperation.findFirst({
        where: { workOrderId: workOrder.id, operationNumber, workCenterCode },
        select: { id: true },
      });
      if (!routing)
        throw new UnprocessableEntityException(
          `Operacija ${operationNumber} (RC ${workCenterCode}) nije u tehnološkom postupku RN ${identNumber}.`,
        );
      const op = await tx.operation.findUnique({
        where: { workCenterCode },
        select: { significantForFinishing: true },
      });
      if (op?.significantForFinishing !== true)
        throw new UnprocessableEntityException(
          `Operacija (RC ${workCenterCode}) nije završna kontrola — koristite prijavu rada/zatvaranje.`,
        );

      const planned = workOrder.pieceCount ?? null;
      if (planned !== null && dto.pieceCount > planned)
        throw new UnprocessableEntityException(
          `Iskontrolisano (${dto.pieceCount}) premašuje planirano (${planned}) — kontrola se ne može snimiti.`,
        );

      // Knjiženje lokacija iskontrolisanih delova (+quantity placement, ledger §3.1/§3.7).
      await this.alignPartLocationSequence(tx);
      const now = new Date();
      for (const loc of dto.locations) {
        const pos = await tx.position.findUnique({
          where: { id: loc.positionId },
          select: { id: true },
        });
        if (!pos)
          throw new NotFoundException(`Pozicija ${loc.positionId} ne postoji.`);
        await tx.partLocation.create({
          data: {
            workOrderId: workOrder.id,
            projectId: workOrder.projectId,
            positionId: loc.positionId,
            qualityTypeId: dto.qualityTypeId,
            workerId: worker.id, // kontrolor = izvršilac (audit)
            quantity: loc.quantity, // placement = +qty
            recordDate: now,
          },
        });
      }

      // CREATE-ON-SCAN (legacy SacuvajRNSIzUnosaBarKoda): nađi OTVOREN red kontrole ili
      // ga OTVORI (za završnu kontrolu red obično ne postoji unapred). Otvoren → ažuriraj.
      const existingOpen = await tx.techProcess.findFirst({
        where: {
          projectId,
          identNumber,
          variant,
          workCenterCode,
          operationNumber,
          isProcessFinished: { not: true },
        },
        orderBy: { id: "asc" },
      });

      const finishData = {
        pieceCount: dto.pieceCount,
        qualityTypeId: dto.qualityTypeId,
        workerId: worker.id, // kontrolor (audit ko+kada — ODLUKE #14)
        workOrderId: workOrder.id,
        isProcessFinished: true,
        finishedAt: now,
        ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
      };

      let tp;
      if (existingOpen) {
        tp = await tx.techProcess.update({
          where: { id: existingOpen.id },
          data: finishData,
        });
      } else {
        // Serijska sekvenca (synced eksplicitni id-jevi) — poravnaj pre insert-a.
        await this.alignTechProcessSequence(tx);
        tp = await tx.techProcess.create({
          data: {
            projectId,
            identNumber,
            variant,
            operationNumber,
            workCenterCode,
            identMark: identMark || "0",
            ...finishData,
          },
        });
      }

      const prioritized = await this.setOperationDonePriority(
        tx,
        workOrder.id,
        operationNumber,
        workCenterCode,
      );
      const workOrderCompleted = await this.markWorkOrderIfComplete(
        tx,
        projectId,
        identNumber,
        variant,
      );

      return {
        tp,
        workOrder,
        planned,
        prioritized,
        workOrderCompleted,
        opened: !existingOpen,
      };
    });

    const label = await this.buildLabelData(result.workOrder.id, dto.pieceCount);
    const childOrderPending = dto.qualityTypeId !== PART_QUALITY.GOOD;

    return {
      data: {
        techProcess: {
          ...result.tp,
          worker: {
            id: worker.id,
            fullName: worker.fullName,
            username: worker.username,
          },
        },
        controlledPieces: dto.pieceCount,
        plannedPieces: result.planned,
        qualityTypeId: dto.qualityTypeId,
        locationsBooked: dto.locations.length,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        // true = red kontrole je otvoren u ovom pozivu (nije postojao); false = ažuriran postojeći.
        techProcessOpened: result.opened,
        workOrder: result.workOrder,
        label,
        // Dorada/škart: child RN (-D/-S) + poruka tehnologu su P2.
        childOrderPending,
      },
      ...(childOrderPending
        ? {
            meta: {
              note: "Kvalitet dorada/škart evidentiran; kreiranje child RN-a (-D/-S) i poruka tehnologu dolaze u P2 (MODULE_SPEC_kontrola §8).",
            },
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------- WORKER IDENTIFY (kiosk kartica)

  /**
   * `GET /worker?card=…` — razreši radnika iz ID kartice (kiosk login karticom,
   * BarKodUnos2024 ekran 1). Vraća javni podskup + `isController` (tip radnika sa
   * `additionalPrivileges` = kontrolor; legacy `tVrsteRadnika.DodatnaOvlascenja`).
   */
  async identifyWorker(cardId: string) {
    const worker = await this.resolveWorkerByCard(cardId);
    const type = worker.workerTypeId
      ? await this.prisma.workerType.findUnique({
          where: { id: worker.workerTypeId },
          select: { name: true, additionalPrivileges: true },
        })
      : null;
    return {
      data: {
        id: worker.id,
        fullName: worker.fullName,
        username: worker.username,
        workerTypeId: worker.workerTypeId,
        workerType: type?.name ?? null,
        isController: type?.additionalPrivileges === true,
      },
    };
  }

  // ---------------------------------------------------------------- LABEL (nalepnica — podaci)

  /**
   * `GET /label?workOrderId=…&quantity=…` — podaci za termalnu nalepnicu (§6):
   * polja `Nalepnice` reporta + RNZ barkod (`formatOrderBarcode`, kiosk-dekodabilan).
   * Front gradi TSPL (`tspl2`) i štampa preko proxy-ja. Reuse: štampa na kontroli i reprint.
   */
  async label(query: { workOrderId?: string; quantity?: string }) {
    const workOrderId = Number.parseInt(query.workOrderId ?? "", 10);
    if (Number.isNaN(workOrderId))
      throw new BadRequestException(
        "Parametar 'workOrderId' je obavezan i mora biti broj.",
      );
    const q = Number.parseInt(query.quantity ?? "", 10);
    const quantity = Number.isNaN(q) || q < 1 ? 1 : q;
    return { data: await this.buildLabelData(workOrderId, quantity) };
  }

  // ---------------------------------------------------------------- ISPRAVKE (kucanje)
  // Storno (kontra-red) i audited-delete otkucane operacije. Snapshot pre brisanja ide u
  // `audit_log.beforeData` (red je povratljiv). NAPOMENA: dedikovana
  // `tech_process_corrections` tabela + restore UI su moguća kasnija dorada (sad audit_log).

  /**
   * `POST /:id/storno` — STORNIRANJE (legacy `StornirajTehPostupak`): upiši KONTRA-red
   * sa `pieceCount = -n` (radnik ostaje izvorni; neto se poništava). Guard: `n` ≤
   * evidentirano na redu. Ne briše ništa. Audit u `audit_log` (beforeData = izvorni red).
   */
  async storno(id: number, dto: StornoTechProcessDto) {
    validateStorno(dto);
    const result = await this.prisma.$transaction(async (tx) => {
      const tp = await tx.techProcess.findUnique({ where: { id } });
      if (!tp)
        throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
      if (dto.pieceCount > tp.pieceCount)
        throw new UnprocessableEntityException(
          `Storno (${dto.pieceCount}) je veći od evidentiranog broja komada (${tp.pieceCount}).`,
        );

      await this.alignTechProcessSequence(tx);
      const counter = await tx.techProcess.create({
        data: {
          workerId: tp.workerId, // izvorni radnik (kao legacy INSERT SELECT)
          projectId: tp.projectId,
          identNumber: tp.identNumber,
          variant: tp.variant,
          operationNumber: tp.operationNumber,
          workCenterCode: tp.workCenterCode,
          identMark: tp.identMark,
          pieceCount: -dto.pieceCount,
          qualityTypeId: tp.qualityTypeId,
          workOrderId: tp.workOrderId,
          isProcessFinished: true,
          finishedAt: new Date(),
          note: `STORNO${dto.note?.trim() ? ": " + dto.note.trim() : ""} (izvor postupak ${id})`,
        },
      });
      await tx.auditLog.create({
        data: {
          action: "STORNO",
          entityType: "tech-processes",
          entityId: String(id),
          beforeData: this.snapshot(tp),
          afterData: {
            counterRowId: counter.id,
            storniranoKomada: dto.pieceCount,
          },
        },
      });
      return { counter };
    });
    return {
      data: {
        storniranoKomada: dto.pieceCount,
        counterRow: result.counter,
        sourceTechProcessId: id,
      },
    };
  }

  /**
   * `DELETE /:id` — audited brisanje otkucane operacije (legacy `spObrisiTP`): snapshot
   * reda (+ dokumenata) u `audit_log.beforeData`, pa brisanje. Alat za ispravku loše
   * evidentiranih kucanja (bez lock-guarda, kao legacy — potvrda je na UI-u).
   */
  async deleteEntry(id: number, dto?: { note?: string }) {
    const tp = await this.prisma.techProcess.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!tp) throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);

    await this.prisma.$transaction(async (tx) => {
      await tx.auditLog.create({
        data: {
          action: "DELETE tech-processes",
          entityType: "tech-processes",
          entityId: String(id),
          beforeData: this.snapshot(tp),
          metadata: dto?.note?.trim() ? { note: dto.note.trim() } : undefined,
        },
      });
      if (tp.documents.length)
        await tx.techProcessDocument.deleteMany({ where: { techProcessId: id } });
      await tx.techProcess.delete({ where: { id } });
    });
    return { data: { id, deleted: true, backedUpTo: "audit_log" } };
  }

  /** JSON-bezbedan snimak reda za `audit_log` (datumi → ISO string). */
  private snapshot(row: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(row)) as Prisma.InputJsonValue;
  }

  // --- write-path helperi (unutar transakcije) ---

  /** RN (`work_orders`) po trojci (projectId, identNumber, variant); null ako ne postoji. */
  private async findWorkOrderByTriple(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
    variant: number,
  ) {
    return tx.workOrder.findFirst({
      where: { projectId, identNumber, variant },
      orderBy: { id: "asc" },
      select: {
        id: true,
        projectId: true,
        identNumber: true,
        variant: true,
        partName: true,
        drawingNumber: true,
        pieceCount: true,
        productionDeadline: true,
        handoverStatusId: true,
        status: true,
        revision: true,
      },
    });
  }

  /**
   * Parsiraj + validiraj nalog/operacija barkodove (isti otisak: ista revizija u oba).
   * Deljeno između start/stop/openSession (isti ugovor kao `scan()`).
   */
  private parseWorkBarcodes(orderBarcode: string, operationBarcode: string) {
    const order = parseBarcode(orderBarcode);
    const operation = parseBarcode(operationBarcode);
    if (order.type !== "nalog")
      throw new BadRequestException(
        "'orderBarcode' nije nalog-barkod (očekivano 'RNZ:...').",
      );
    if (operation.type !== "operacija")
      throw new BadRequestException(
        "'operationBarcode' nije operacija-barkod (očekivano 'S:...').",
      );
    if (order.fields.revision !== operation.fields.revision)
      throw new BadRequestException(
        `Revizija se ne poklapa: nalog=${order.fields.revision}, operacija=${operation.fields.revision} — barkodovi ne pripadaju istom otisku.`,
      );
    return { order, operation };
  }

  /**
   * Machine-access provera (spec §3.4). Poštuje AUTHZ_ENFORCE kao guard: enforce → 403;
   * shadow → upozorenje (vraća poruku, rad dozvoljen). Isti obrazac kao `scan()`.
   */
  private async checkMachineAccess(
    workerId: number,
    workCenterCode: string,
  ): Promise<string | null> {
    const violation = await this.scope.workerMachineViolation(
      workerId,
      workCenterCode,
    );
    if (!violation) return null;
    if (this.scope.isEnforced()) throw new ForbiddenException(violation);
    this.logger.warn(
      `SHADOW machine-access: ${violation} (AUTHZ_ENFORCE=false, rad dozvoljen)`,
    );
    return violation;
  }

  /**
   * Tekući red operacije u routingu (najviša varijanta) — varijanta se menja U MESTU
   * pri izmeni tehnologije/crteža, pa (projectId, identNumber, workCenterCode[, opNumber])
   * jednoznačno vodi na tekuću. Isti lookup kao `scan()`.
   */
  private async findRoutingTp(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
    workCenterCode: string,
    operationNumber: number | null,
  ) {
    const where: Prisma.TechProcessWhereInput = {
      projectId,
      identNumber,
      workCenterCode,
    };
    if (operationNumber !== null) where.operationNumber = operationNumber;
    return tx.techProcess.findFirst({
      where,
      orderBy: [{ variant: "desc" }, { isProcessFinished: "asc" }, { id: "asc" }],
    });
  }

  /**
   * ID kartica (`workers.cardId`) → radnik (javni podskup: id/ime/username/tip).
   * 400 na praznu karticu, 404 ako radnik ne postoji. Legacy cardId ≈ jedinstven;
   * na duplikat uzima najmanji id.
   */
  private async resolveWorkerByCard(cardId: string) {
    const card = (cardId ?? "").trim();
    if (!card)
      throw new BadRequestException("ID kartica (workerCard) je obavezna.");
    const worker = await this.prisma.worker.findFirst({
      where: { cardId: card },
      orderBy: { id: "asc" },
      select: { id: true, fullName: true, username: true, workerTypeId: true },
    });
    if (!worker)
      throw new NotFoundException(`Radnik sa ID karticom '${card}' nije nađen.`);
    return worker;
  }

  /**
   * Podaci za nalepnicu (§6): polja `Nalepnice` reporta + RNZ barkod
   * (`RNZ:projectId:identNumber:variant:revision`). Naziv predmeta = `projects.projectName`,
   * komitent = `customers.name` (preko predmeta). Batch-safe (skalar FK → poseban upit).
   */
  private async buildLabelData(workOrderId: number, quantity: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: {
        id: true,
        projectId: true,
        identNumber: true,
        variant: true,
        revision: true,
        partName: true,
        drawingNumber: true,
        material: true,
        pieceCount: true,
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);

    const project = await this.prisma.project.findUnique({
      where: { id: wo.projectId },
      select: { projectName: true, customerId: true },
    });
    const customer = project?.customerId
      ? await this.prisma.customer.findUnique({
          where: { id: project.customerId },
          select: { name: true },
        })
      : null;

    return {
      workOrderId: wo.id,
      barcode: formatOrderBarcode({
        projectId: wo.projectId,
        identNumber: wo.identNumber,
        variant: wo.variant,
        revision: wo.revision,
      }),
      plannedPieces: wo.pieceCount,
      quantity,
      fields: {
        brojPredmeta: wo.identNumber,
        komitent: customer?.name ?? "",
        nazivPredmeta: project?.projectName ?? "",
        nazivDela: wo.partName ?? "",
        brojCrteza: wo.drawingNumber ?? "",
        materijal: wo.material ?? "",
        kolicina: `${quantity}/${wo.pieceCount}`,
      },
    };
  }

  /**
   * Poravnaj `part_locations.id` sekvencu pre insert-a (synced eksplicitni id-jevi
   * bi inače kolidirali sa autoincrement-om — isti obrazac kao PartLocationsService).
   */
  private async alignPartLocationSequence(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('part_locations','id'), COALESCE((SELECT MAX(id) FROM part_locations),1), EXISTS(SELECT 1 FROM part_locations))`,
    );
  }

  /**
   * Poravnaj `tech_processes.id` sekvencu pre insert-a (synced eksplicitni id-jevi
   * bi inače kolidirali sa autoincrement-om) — koristi create-on-scan u `control()`.
   */
  private async alignTechProcessSequence(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('tech_processes','id'), COALESCE((SELECT MAX(id) FROM tech_processes),1), EXISTS(SELECT 1 FROM tech_processes))`,
    );
  }

  /**
   * Upiši `priority=255` na `work_order_operations` red(ove) koji odgovaraju
   * zatvorenoj operaciji (RN + operationNumber + workCenterCode). Best-effort:
   * ako RN nije razrešen (workOrderId ≤ 0) ili nema odgovarajuće operative RN-a,
   * vraća 0 (legacy tech_processes.workOrderId je često 0 — veza kroz JOIN).
   */
  private async setOperationDonePriority(
    tx: Prisma.TransactionClient,
    workOrderId: number,
    operationNumber: number,
    workCenterCode: string,
  ): Promise<number> {
    if (!workOrderId || workOrderId <= 0) return 0;
    const res = await tx.workOrderOperation.updateMany({
      where: { workOrderId, operationNumber, workCenterCode },
      data: { priority: OPERATION_PRIORITY_DONE },
    });
    return res.count;
  }

  /**
   * Kanonska definicija „RN završen" (§3, migration/15 §5): sve operacije čiji je
   * radni centar `significantForFinishing=true` moraju biti završene
   * (`isProcessFinished=true`). Ako jesu → označi RN (`work_orders.status=true`)
   * i vrati `true`. Ako nema značajnih operacija ili nisu sve gotove → `false`,
   * RN se ne dira.
   *
   * NAPOMENA (pretpostavka): ne postoji materijalizovana `isCompleted` kolona
   * (§3 „materijalizovati isCompleted" traži migraciju — van skopa); dok se ne
   * uvede, „RN završen" se beleži na postojeći `work_orders.status` (Boolean).
   */
  private async markWorkOrderIfComplete(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
    variant: number,
  ): Promise<boolean> {
    const rows = await tx.techProcess.findMany({
      where: { projectId, identNumber, variant },
      select: { workCenterCode: true, isProcessFinished: true },
    });
    if (!rows.length) return false;

    const codes = [...new Set(rows.map((r) => r.workCenterCode).filter(Boolean))];
    const significant = await tx.operation.findMany({
      where: { workCenterCode: { in: codes }, significantForFinishing: true },
      select: { workCenterCode: true },
    });
    const sigCodes = new Set(significant.map((o) => o.workCenterCode));
    const significantRows = rows.filter((r) => sigCodes.has(r.workCenterCode));
    // Bez značajnih operacija nema kanonskog kriterijuma → ne označavamo.
    if (!significantRows.length) return false;
    if (!significantRows.every((r) => r.isProcessFinished === true))
      return false;

    const wo = await tx.workOrder.findFirst({
      where: { projectId, identNumber, variant },
      orderBy: { id: "asc" },
      select: { id: true, status: true },
    });
    if (!wo) return false;
    if (wo.status === true) return true; // već označen — idempotentno
    await tx.workOrder.update({
      where: { id: wo.id },
      data: { status: true },
    });
    return true;
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
