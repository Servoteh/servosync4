import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createConnection } from "node:net";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ScopeService } from "../../common/authz/scope.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseDateParam } from "../../common/date-params";
import { parseBarcode, formatOrderBarcode } from "./barcode";
import {
  type ScanTechProcessDto,
  validateScan,
} from "./dto/scan-tech-process.dto";
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
import { type PrintLabelDto, validatePrintLabel } from "./dto/print-label.dto";

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

/**
 * Pogonska vremenska zona za kalendarske/satne kante u analitici sesija (A-4).
 * `Timestamptz` se pre `::date`/`date_trunc('hour')` kastuje `AT TIME ZONE`, da smena
 * 08–16 istog dana ne bude pogrešno „preko dana" (dizajn A-4 §4).
 */
const SHOP_TZ = "Europe/Belgrade";

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

/**
 * Akumulator agregata po operaciji u kartici TP — ključ (operationNumber,
 * workCenterCode). Legacy semantika zbira: `Sum(Komada) GROUP BY (trojka,
 * Operacija, RJgrupaRC)` — tTehPostupak_NapravljenoKomada.sql / RNPregledPostupci.sql.
 */
interface CardOperationAcc {
  operationNumber: number;
  workCenterCode: string;
  /** Broj kucanja (redova) grupe — KOM=0 sesije ulaze u broj, ne u komade. */
  entryCount: number;
  /** Σ pieceCount: `total` = SVI redovi; good/rework/scrap po kvalitetu 0/1/2. */
  pieces: { total: number; good: number; rework: number; scrap: number };
  /** Bar jedan red grupe je zatvoren (isProcessFinished). */
  isFinished: boolean;
  firstEnteredAt: Date;
  lastFinishedAt: Date | null;
  /** Σ elapsed (finishedAt−enteredAt) po redovima koji imaju oba vremena. */
  elapsedSeconds: number;
  hasElapsed: boolean;
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

/** Filteri za analitiku vremenskih sesija (A-4: dnevnik / zbir / po satu / loše). */
export interface SessionQuery {
  /** Od (ISO); default = to − 30 dana. */
  from?: string;
  /** Do (ISO); default = sada. */
  to?: string;
  workCenterCode?: string;
  workerId?: string;
  page?: string;
  pageSize?: string;
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

interface SessionDailyRaw {
  day: Date;
  session_count: number;
  worker_count: number;
  pieces: number;
  elapsed_seconds: number;
  open_count: number;
}

interface SessionSummaryRaw {
  project_id: number;
  ident_number: string;
  variant: number;
  operation_number: number;
  work_center_code: string;
  made: number;
  actual_seconds: number;
  session_count: number;
  setup_time: number | null;
  cycle_time: number | null;
}

interface SessionHourlyRaw {
  hour_local: string;
  session_count: number;
  worker_count: number;
  pieces: number;
  seconds: number;
}

interface PoorlyRecordedRaw {
  id: number;
  tech_process_id: number;
  worker_id: number;
  project_id: number;
  ident_number: string;
  variant: number;
  operation_number: number;
  work_center_code: string;
  started_at: Date;
  stopped_at: Date | null;
  piece_count: number;
  auto_closed: boolean;
  reason: string;
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
    private readonly notifications: NotificationsService,
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
    else if (query.finished === "false")
      filter.isProcessFinished = { not: true };
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
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

    const [workers, ops, quals, technologists] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveOperationsByCode(rows.map((r) => r.workCenterCode)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      this.resolveWorkOrderTechnologists(rows.map((r) => r.workOrderId)),
    ]);
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      operation: ops.get(r.workCenterCode) ?? null,
      qualityType: quals.get(r.qualityTypeId) ?? null,
      // Tehnolog autor TP-a = work_orders.worker_id (Miljan t.6a: „Tehnolog"
      // kolona je do sada prikazivala radnika koji je kucao red — `worker`
      // ostaje to, a ovo je pravi tehnolog sa RN-a; null kad RN nije razrešen).
      technologist: technologists.get(r.workOrderId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Batch: workOrderId → tehnolog (work_orders.worker_id). Legacy redovi često
   * imaju workOrderId 0 (veza kroz JOIN, ne FK) — preskaču se; orphan RN/radnik
   * → null (obrazac common/relations, bez required JOIN-a).
   */
  private async resolveWorkOrderTechnologists(ids: number[]) {
    const uniq = uniqueIds(ids);
    const map = new Map<
      number,
      { id: number; fullName: string | null; username: string | null }
    >();
    if (!uniq.length) return map;
    const workOrders = await this.prisma.workOrder.findMany({
      where: { id: { in: uniq } },
      select: { id: true, workerId: true },
    });
    const workers = await this.resolveWorkers(
      workOrders.map((w) => w.workerId),
    );
    for (const wo of workOrders) {
      const worker = workers.get(wo.workerId);
      if (worker) map.set(wo.id, worker);
    }
    return map;
  }

  // ---------------------------------------------------------------- CARD (Kartica TP)

  /**
   * „Kartica TP": svi redovi (kucanja) jednog postupka + API-side sume.
   * Postupak je identifikovan trojkom (projectId, identNumber, variant).
   * Red = jedno kucanje (legacy tTehPostupak); operacija = grupa redova po
   * (operationNumber, workCenterCode) — agregati u `data.operations`.
   * Sume (komadi po kvalitetu 0/1/2, ukupno vreme) računa API — ne UI (spec §3 pravilo 6).
   *
   * Header brojevi: `operationCount` = DISTINCT (operationNumber, workCenterCode)
   * parovi, `finishedCount` = parovi sa bar jednim zatvorenim redom,
   * `summary.entryCount` = ukupan broj redova (kucanja).
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
      // workCenterCode in orderBy keeps each (OP, RC) group contiguous — the UI
      // inserts a group header on every key change between adjacent rows.
      orderBy: [
        { operationNumber: "asc" },
        { workCenterCode: "asc" },
        { id: "asc" },
      ],
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

    // Sume na API-ju (spec §3 pravilo 6: SUM na DB/API, ne u UI) + agregat po
    // operaciji (OP, RC) u istoj petlji — redovi su već sortirani, pa Map čuva
    // redosled pojavljivanja. Storno (negativan pieceCount) se prirodno netuje.
    const piecesByQuality = { good: 0, rework: 0, scrap: 0 };
    let totalPieces = 0;
    let totalElapsedSeconds = 0;
    let hasElapsed = false;
    const opGroups = new Map<string, CardOperationAcc>();
    for (const r of rows) {
      const pieces = r.pieceCount;
      totalPieces += pieces;
      if (r.qualityTypeId === PART_QUALITY.GOOD) piecesByQuality.good += pieces;
      else if (r.qualityTypeId === PART_QUALITY.REWORK)
        piecesByQuality.rework += pieces;
      else if (r.qualityTypeId === PART_QUALITY.SCRAP)
        piecesByQuality.scrap += pieces;
      const elapsedSeconds = r.finishedAt
        ? Math.max(0, (r.finishedAt.getTime() - r.enteredAt.getTime()) / 1000)
        : null;
      if (elapsedSeconds !== null) {
        totalElapsedSeconds += elapsedSeconds;
        hasElapsed = true;
      }

      const key = `${r.operationNumber}|${r.workCenterCode}`;
      let g = opGroups.get(key);
      if (!g) {
        g = {
          operationNumber: r.operationNumber,
          workCenterCode: r.workCenterCode,
          entryCount: 0,
          pieces: { total: 0, good: 0, rework: 0, scrap: 0 },
          isFinished: false,
          firstEnteredAt: r.enteredAt,
          lastFinishedAt: null,
          elapsedSeconds: 0,
          hasElapsed: false,
        };
        opGroups.set(key, g);
      }
      g.entryCount += 1;
      g.pieces.total += pieces;
      if (r.qualityTypeId === PART_QUALITY.GOOD) g.pieces.good += pieces;
      else if (r.qualityTypeId === PART_QUALITY.REWORK)
        g.pieces.rework += pieces;
      else if (r.qualityTypeId === PART_QUALITY.SCRAP) g.pieces.scrap += pieces;
      if (r.isProcessFinished === true) g.isFinished = true;
      if (r.enteredAt < g.firstEnteredAt) g.firstEnteredAt = r.enteredAt;
      if (
        r.finishedAt &&
        (!g.lastFinishedAt || r.finishedAt > g.lastFinishedAt)
      )
        g.lastFinishedAt = r.finishedAt;
      if (elapsedSeconds !== null) {
        g.elapsedSeconds += elapsedSeconds;
        g.hasElapsed = true;
      }
    }

    const operations = [...opGroups.values()].map((g) => ({
      operationNumber: g.operationNumber,
      workCenterCode: g.workCenterCode,
      operation: ops.get(g.workCenterCode) ?? null,
      entryCount: g.entryCount,
      pieces: g.pieces,
      isFinished: g.isFinished,
      firstEnteredAt: g.firstEnteredAt,
      lastFinishedAt: g.lastFinishedAt,
      // Izvedeno (kao summary): null dok nijedan red grupe nije zatvoren.
      elapsedMinutes: g.hasElapsed ? Math.round(g.elapsedSeconds / 60) : null,
    }));

    // HITNO (Miljan t.10): flag sa primopredaje vezane za RN ove trojke —
    // isti put kao rok u critical() (RN po trojci → drawing_handover); najstariji
    // RN = original (klonovi dele drawing_handover_id).
    const cardWorkOrder = await this.prisma.workOrder.findFirst({
      where: { projectId, identNumber, variant, drawingHandoverId: { gt: 0 } },
      select: { drawingHandoverId: true },
      orderBy: { id: "asc" },
    });
    const cardHandover = cardWorkOrder
      ? await this.prisma.drawingHandover.findUnique({
          where: { id: cardWorkOrder.drawingHandoverId },
          select: { isUrgent: true },
        })
      : null;

    const data = {
      projectId,
      identNumber,
      variant,
      isUrgent: cardHandover?.isUrgent ?? false,
      // DISTINCT (operationNumber, workCenterCode) parovi — ne broj kucanja.
      operationCount: operations.length,
      // Parovi sa bar jednim zatvorenim redom — ne broj zatvorenih redova.
      finishedCount: operations.filter((o) => o.isFinished).length,
      summary: {
        totalPieces,
        piecesByQuality,
        // Ukupan broj redova (kucanja) preko svih operacija.
        entryCount: rows.length,
        // Izvedeno: tech_processes nema kolonu radnog vremena — elapsed entered→finished.
        totalElapsedMinutes: hasElapsed
          ? Math.round(totalElapsedSeconds / 60)
          : null,
      },
      operations,
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
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");

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
    let decoded: ReturnType<typeof parseBarcode>;
    try {
      decoded = parseBarcode(barcode);
    } catch (e) {
      // Dijagnostika iz pogona: loguj ŠTA je skener stvarno poslao (pogrešan barkod
      // sa papira, presečen sken, raspored tastature skenera...) — čita se iz docker logs.
      this.logger.warn(
        `barcode decode FAIL: "${String(barcode ?? "").slice(0, 64)}" — ${(e as Error).message}`,
      );
      throw e;
    }
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

    // nalog → razreši RN + broj operacija u tehnološkom postupku + routing.
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

    // Routing RN-a (work_order_operations) — kiosk po njemu zna da li je skenirana
    // operacija U NALOGU i kad `tech_processes` red još ne postoji (create-on-scan
    // za RN kreiran u 2.0; red se otvara pri prvom skenu).
    const routing = workOrder
      ? await this.prisma.workOrderOperation.findMany({
          where: { workOrderId: workOrder.id },
          orderBy: { operationNumber: "asc" },
          select: { operationNumber: true, workCenterCode: true },
        })
      : [];

    return {
      data: {
        type: decoded.type,
        marker: decoded.marker,
        fields: decoded.fields,
        workOrder,
        techProcess: { operationCount },
        routing,
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
    const { operationNumber, workCenterCode, identMark } = operation.fields;

    // Machine-access (spec §3.4, 🔴): identifikovani radnik radi samo na svojim mašinama.
    // Poštuje AUTHZ_ENFORCE (kao guard): enforce → 403; shadow → upozorenje + flag u odgovoru.
    let machineAccessWarning: string | null = null;
    if (worker && !this.isTestWorker(worker.id)) {
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
      // D5 klon-varijanta („Prepiši isti postupak", potvrda Negovan — legacy
      // semantika): izmena tehnologije/crteža otvara NOVI RN red sa MAX(variant)+1.
      // Zato se skeniranoj varijanti NE veruje: rad se knjiži na TEKUĆU varijantu
      // (najviši `work_orders` red), a red operacije je PINOVAN na nju — kucanja
      // stare varijante ostaju netaknuta. Skenirana varijanta služi samo za
      // staleWorkOrder guard ispod. CREATE-ON-SCAN: red se otvara pri prvom skenu
      // (validacija protiv routinga RN-a).
      const { tp } = await this.findOrOpenRoutingTp(
        tx,
        projectId,
        identNumber,
        workCenterCode,
        operationNumber,
        identMark,
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

      // Verzioni guard (UPOZORENJE, ne blokada — MODULE_SPEC_stampa §5): posle D5
      // klona tekući RN ima veću varijantu od one na starom otisku. `tp.variant` je
      // pinovan na tekući RN (findOrOpenRoutingTp), pa manja varijanta sa otiska =
      // radnik je uzeo STAR odštampan nalog. Rad se svejedno evidentira na tekuću
      // varijantu, uz upozorenje.
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

  // ---------------------------------------------------------------- ANALITIKA SESIJA (A-4: v_work_sessions)

  /** Opseg (from/to) za analitiku sesija; default poslednjih 30 dana. */
  private sessionRange(query: SessionQuery) {
    const to = parseDateParam(query.to, "to") ?? new Date();
    const from =
      parseDateParam(query.from, "from") ??
      new Date(to.getTime() - 30 * 86_400_000);
    return { from, to };
  }

  /** WHERE uslovi zajednički dnevniku/zbiru/po-satu (nad v_work_sessions). */
  private sessionConds(
    query: SessionQuery,
    from: Date,
    to: Date,
  ): Prisma.Sql[] {
    const conds: Prisma.Sql[] = [
      Prisma.sql`started_at >= ${from}`,
      Prisma.sql`started_at < ${to}`,
    ];
    if (query.workCenterCode?.trim())
      conds.push(Prisma.sql`work_center_code = ${query.workCenterCode.trim()}`);
    const wid = Number.parseInt(query.workerId ?? "", 10);
    if (!Number.isNaN(wid)) conds.push(Prisma.sql`worker_id = ${wid}`);
    return conds;
  }

  /** Naziv RC po šifri (za obogaćivanje pregleda). */
  private async resolveWorkCenterNames(codes: string[]) {
    const uniq = [...new Set(codes.filter(Boolean))];
    const map = new Map<string, string>();
    if (!uniq.length) return map;
    const rows = await this.prisma.operation.findMany({
      where: { workCenterCode: { in: uniq } },
      select: { workCenterCode: true, workCenterName: true },
    });
    for (const r of rows) map.set(r.workCenterCode, r.workCenterName);
    return map;
  }

  /**
   * DNEVNIK PROIZVODNJE — po danu (lokalna TZ): broj sesija/operacija, radnika, komada,
   * utrošeno vreme (gde je sesija zatvorena), otvoreno. Nad `v_work_sessions` (uključuje
   * i legacy redove — dnevnik prikazuje SVU evidentiranu aktivnost).
   */
  async sessionsDaily(query: SessionQuery) {
    const { from, to } = this.sessionRange(query);
    const whereSql = Prisma.sql`WHERE ${Prisma.join(this.sessionConds(query, from, to), " AND ")}`;
    const rows = await this.prisma.$queryRaw<SessionDailyRaw[]>(Prisma.sql`
      SELECT (started_at AT TIME ZONE ${SHOP_TZ})::date AS day,
             (COUNT(*))::int AS session_count,
             (COUNT(DISTINCT worker_id))::int AS worker_count,
             COALESCE(SUM(piece_count), 0)::int AS pieces,
             COALESCE(SUM(EXTRACT(EPOCH FROM (stopped_at - started_at)))
                      FILTER (WHERE source = 'entry' AND stopped_at IS NOT NULL AND stopped_at >= started_at), 0)::float8 AS elapsed_seconds,
             (COUNT(*) FILTER (WHERE stopped_at IS NULL))::int AS open_count
      FROM v_work_sessions
      ${whereSql}
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    const data = rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      sessionCount: r.session_count,
      workerCount: r.worker_count,
      pieces: r.pieces,
      elapsedSeconds: Math.round(r.elapsed_seconds),
      elapsedMinutes: Math.round(r.elapsed_seconds / 60),
      openCount: r.open_count,
    }));
    return {
      data,
      meta: {
        from: from.toISOString(),
        to: to.toISOString(),
        days: data.length,
      },
    };
  }

  /**
   * ZBIR PO OPERACIJAMA — utrošeno vreme (Σ stop−start) vs normirano (Tpz + Tk×kom;
   * `work_order_operations.setup_time/cycle_time`). Nad `v_work_sessions` (legacy daje
   * grublje vreme entered→finished). Paginirano; sortirano po utrošenom vremenu.
   */
  async sessionsSummary(query: SessionQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const { from, to } = this.sessionRange(query);
    // Uslovi sa `s.` prefiksom (JOIN alias) — GROUP BY je nad v_work_sessions s.
    const conds: Prisma.Sql[] = [
      Prisma.sql`s.started_at >= ${from}`,
      Prisma.sql`s.started_at < ${to}`,
    ];
    if (query.workCenterCode?.trim())
      conds.push(
        Prisma.sql`s.work_center_code = ${query.workCenterCode.trim()}`,
      );
    const wid = Number.parseInt(query.workerId ?? "", 10);
    if (!Number.isNaN(wid)) conds.push(Prisma.sql`s.worker_id = ${wid}`);
    const sWhere = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;

    const normSubq = (col: "setup_time" | "cycle_time") => Prisma.sql`
      (SELECT op.${Prisma.raw(col)} FROM work_order_operations op
         JOIN work_orders wo ON wo.id = op.work_order_id
        WHERE wo.project_id = s.project_id AND wo.ident_number = s.ident_number
          AND wo.variant = s.variant AND op.operation_number = s.operation_number
          AND op.work_center_code = s.work_center_code
        ORDER BY op.id LIMIT 1)::float8`;

    const rows = await this.prisma.$queryRaw<SessionSummaryRaw[]>(Prisma.sql`
      SELECT s.project_id, s.ident_number, s.variant, s.operation_number, s.work_center_code,
             COALESCE(SUM(s.piece_count), 0)::int AS made,
             COALESCE(SUM(EXTRACT(EPOCH FROM (s.stopped_at - s.started_at)))
                      FILTER (WHERE s.source = 'entry' AND s.stopped_at IS NOT NULL AND s.stopped_at >= s.started_at), 0)::float8 AS actual_seconds,
             (COUNT(*))::int AS session_count,
             ${normSubq("setup_time")} AS setup_time,
             ${normSubq("cycle_time")} AS cycle_time
      FROM v_work_sessions s
      ${sWhere}
      GROUP BY s.project_id, s.ident_number, s.variant, s.operation_number, s.work_center_code
      ORDER BY actual_seconds DESC, made DESC
      LIMIT ${take} OFFSET ${skip}
    `);
    const totalRes = await this.prisma.$queryRaw<
      { count: number }[]
    >(Prisma.sql`
      SELECT (COUNT(*))::int AS count FROM (
        SELECT 1 FROM v_work_sessions s ${sWhere}
        GROUP BY s.project_id, s.ident_number, s.variant, s.operation_number, s.work_center_code
      ) g
    `);
    const total = totalRes[0]?.count ?? 0;

    const names = await this.resolveWorkCenterNames(
      rows.map((r) => r.work_center_code),
    );
    const data = rows.map((r) => {
      const setup = r.setup_time ?? 0;
      const cycle = r.cycle_time ?? 0;
      const normMinutes = setup + cycle * r.made;
      const actualMinutes = r.actual_seconds / 60;
      return {
        projectId: r.project_id,
        identNumber: r.ident_number,
        variant: r.variant,
        operationNumber: r.operation_number,
        workCenterCode: r.work_center_code,
        workCenterName: names.get(r.work_center_code) ?? null,
        made: r.made,
        sessionCount: r.session_count,
        actualMinutes: Math.round(actualMinutes * 10) / 10,
        normMinutes: Math.round(normMinutes * 10) / 10,
        diffMinutes: Math.round((actualMinutes - normMinutes) * 10) / 10,
        hasNorm: r.setup_time !== null || r.cycle_time !== null,
      };
    });
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * PO SATU — iskorišćenost po satu (lokalna TZ): broj sesija, radnika, komada, sekundi.
   * Nad `v_work_sessions`. Sat je `YYYY-MM-DD HH:00` u pogonskoj zoni.
   */
  async sessionsHourly(query: SessionQuery) {
    const { from, to } = this.sessionRange(query);
    const whereSql = Prisma.sql`WHERE ${Prisma.join(this.sessionConds(query, from, to), " AND ")}`;
    const rows = await this.prisma.$queryRaw<SessionHourlyRaw[]>(Prisma.sql`
      SELECT to_char(date_trunc('hour', started_at AT TIME ZONE ${SHOP_TZ}), 'YYYY-MM-DD HH24:00') AS hour_local,
             (COUNT(*))::int AS session_count,
             (COUNT(DISTINCT worker_id))::int AS worker_count,
             COALESCE(SUM(piece_count), 0)::int AS pieces,
             COALESCE(SUM(EXTRACT(EPOCH FROM (stopped_at - started_at)))
                      FILTER (WHERE source = 'entry' AND stopped_at IS NOT NULL AND stopped_at >= started_at), 0)::float8 AS seconds
      FROM v_work_sessions
      ${whereSql}
      GROUP BY 1
      ORDER BY 1 DESC
    `);
    const data = rows.map((r) => ({
      hourLocal: r.hour_local,
      sessionCount: r.session_count,
      workerCount: r.worker_count,
      pieces: r.pieces,
      seconds: Math.round(r.seconds),
      minutes: Math.round(r.seconds / 60),
    }));
    return {
      data,
      meta: {
        from: from.toISOString(),
        to: to.toISOString(),
        hours: data.length,
      },
    };
  }

  /**
   * LOŠE EVIDENTIRANI — vremenske sesije bez ispravnog para START/STOP: bez stopa,
   * negativno trajanje, auto-zatvorene, ili start/stop u različitim danima. Samo NATIVNE
   * sesije (`work_time_entries`) — legacy „otvoreni" postupci su normala (vide se u Evidenciji).
   */
  async sessionsPoorlyRecorded(query: SessionQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const conds: Prisma.Sql[] = [
      Prisma.sql`(stopped_at IS NULL
        OR stopped_at < started_at
        OR auto_closed = true
        OR (started_at AT TIME ZONE ${SHOP_TZ})::date <> (stopped_at AT TIME ZONE ${SHOP_TZ})::date)`,
    ];
    if (query.workCenterCode?.trim())
      conds.push(Prisma.sql`work_center_code = ${query.workCenterCode.trim()}`);
    const wid = Number.parseInt(query.workerId ?? "", 10);
    if (!Number.isNaN(wid)) conds.push(Prisma.sql`worker_id = ${wid}`);
    const whereSql = Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`;

    const rows = await this.prisma.$queryRaw<PoorlyRecordedRaw[]>(Prisma.sql`
      SELECT id, tech_process_id, worker_id, project_id, ident_number, variant,
             operation_number, work_center_code, started_at, stopped_at, piece_count, auto_closed,
             CASE WHEN stopped_at IS NULL THEN 'bez_stopa'
                  WHEN stopped_at < started_at THEN 'negativno'
                  WHEN auto_closed = true THEN 'auto_zatvoreno'
                  ELSE 'preko_dana' END AS reason
      FROM work_time_entries
      ${whereSql}
      ORDER BY started_at DESC
      LIMIT ${take} OFFSET ${skip}
    `);
    const totalRes = await this.prisma.$queryRaw<
      { count: number }[]
    >(Prisma.sql`
      SELECT (COUNT(*))::int AS count FROM work_time_entries ${whereSql}
    `);
    const total = totalRes[0]?.count ?? 0;

    const [workers, names] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.worker_id)),
      this.resolveWorkCenterNames(rows.map((r) => r.work_center_code)),
    ]);
    const data = rows.map((r) => ({
      id: r.id,
      techProcessId: r.tech_process_id,
      workerId: r.worker_id,
      worker: workers.get(r.worker_id) ?? null,
      projectId: r.project_id,
      identNumber: r.ident_number,
      variant: r.variant,
      operationNumber: r.operation_number,
      workCenterCode: r.work_center_code,
      workCenterName: names.get(r.work_center_code) ?? null,
      startedAt: r.started_at,
      stoppedAt: r.stopped_at,
      pieceCount: r.piece_count,
      autoClosed: r.auto_closed,
      reason: r.reason,
    }));
    return { data, meta: pageMeta(page, pageSize, total) };
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
    const { operationNumber, workCenterCode, identMark } = operation.fields;
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      workCenterCode,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // CREATE-ON-SCAN: RN kreiran u 2.0 nema unapred red — otvara se pri prvom skenu.
      const { tp } = await this.findOrOpenRoutingTp(
        tx,
        projectId,
        identNumber,
        workCenterCode,
        operationNumber,
        identMark,
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
    const { operationNumber, workCenterCode, identMark } = operation.fields;
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      workCenterCode,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // CREATE-ON-SCAN: RN kreiran u 2.0 nema unapred red — otvara se pri prvom skenu
      // (single-shot STOP bez START-a na svežem RN-u takođe mora da prođe).
      const { tp } = await this.findOrOpenRoutingTp(
        tx,
        projectId,
        identNumber,
        workCenterCode,
        operationNumber,
        identMark,
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

    // Tekući RN (najviša varijanta — D5 klon otvara novi red); operacija se traži
    // PINOVANO na njegovu varijantu, isto kao START/STOP write-path.
    const wo = await this.findCurrentWorkOrder(
      this.prisma,
      projectId,
      identNumber,
    );
    if (!wo)
      throw new NotFoundException(
        `RN za predmet ${projectId}, ident ${identNumber} nije nađen.`,
      );

    const tp = await this.findRoutingTp(
      this.prisma,
      projectId,
      identNumber,
      wo.variant,
      workCenterCode,
      operationNumber,
    );
    if (!tp) {
      // Red za tekuću varijantu još ne postoji (RN kreiran u 2.0 ili sveža D5
      // klon-varijanta) — validiraj protiv routinga RN-a i vrati „nema sesije":
      // START skena će red otvoriti (create-on-scan). Read-only ruta ne kreira.
      const routing = await this.prisma.workOrderOperation.findFirst({
        where: {
          workOrderId: wo.id,
          workCenterCode,
          ...(operationNumber !== null ? { operationNumber } : {}),
        },
        select: { id: true },
      });
      if (!routing)
        throw new NotFoundException(
          `Operacija (RC ${workCenterCode}${
            operationNumber !== null ? `, op. ${operationNumber}` : ""
          }) nije nađena u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
        );
      return {
        data: {
          techProcessId: null,
          operationFinished: false,
          open: false,
          session: null,
          worker: { id: worker.id, fullName: worker.fullName },
        },
      };
    }

    const entry = await this.prisma.workTimeEntry.findFirst({
      where: { workerId: worker.id, techProcessId: tp.id, stoppedAt: null },
      orderBy: { id: "desc" },
      select: { id: true, startedAt: true },
    });

    return {
      data: {
        techProcessId: tp.id as number | null,
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
    const hours =
      Number.isFinite(olderThanHours) && olderThanHours > 0
        ? olderThanHours
        : 12;
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
   * P1: DORADA/ŠKART (kvalitet 1/2) se knjiži, ali child RN (`-D/-S`) je P2 →
   * odgovor nosi `childOrderPending: true`. D8: dorada/škart POSLE transakcije emituje
   * in-app notifikaciju (tehnolozi + projektant crteža — `notifyQualityIssue`).
   * Nalepnica (RNZ) se vraća u `label` (front štampa preko proxy-ja).
   * `machine_access` provera kontrolora — TODO(P2).
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

    // A-5: (1) osoba mora biti OVLAŠĆEN kontrolor (sistematizacija „Kontrola" =
    // workerType.additionalPrivileges) i (2) razdvajanje dužnosti — ne sme da radi završnu
    // nad sopstvenim proizvodnim radom. Poštuje AUTHZ_ENFORCE kao guard: enforce → 403;
    // shadow → upozorenje (kontrola dozvoljena, flag u odgovoru). Login-put (rola s
    // `tehnologija.approve`) pokriva guard nad kontrolerom; ovde je karta-put (izvršilac).
    const controllerWarnings: string[] = [];
    const testWorker = this.isTestWorker(worker.id);
    if (testWorker)
      this.logger.warn(
        `TEST radnik #${worker.id} (${worker.fullName ?? worker.username}) — kontrolor-auth i SoD provere preskočene (AUTHZ_TEST_WORKER_IDS, ODLUKE #32).`,
      );
    if (
      !testWorker &&
      !(await this.isAuthorizedController(worker.workerTypeId))
    ) {
      const msg = `Radnik „${worker.fullName ?? worker.username}" nije ovlašćen kontrolor (tip radnika bez kontrolorskih privilegija).`;
      if (this.scope.isEnforced()) throw new ForbiddenException(msg);
      this.logger.warn(
        `SHADOW kontrolor-auth: ${msg} (AUTHZ_ENFORCE=false, kontrola dozvoljena)`,
      );
      controllerWarnings.push(msg);
    }
    if (
      !testWorker &&
      (await this.selfControlViolation(
        projectId,
        identNumber,
        variant,
        worker.id,
      ))
    ) {
      const msg = `Razdvajanje dužnosti: „${worker.fullName ?? worker.username}" je evidentirao rad na ovom delu — ne sme da radi završnu kontrolu nad sopstvenim radom.`;
      if (this.scope.isEnforced()) throw new ForbiddenException(msg);
      this.logger.warn(
        `SHADOW self-control: ${msg} (AUTHZ_ENFORCE=false, kontrola dozvoljena)`,
      );
      controllerWarnings.push(msg);
    }

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

      // Završna kontrola POTVRĐUJE sve ostale neotkucane/otvorene operacije RN-a
      // (Nesa 2026-07-10): deo koji je prošao završnu kontrolu je fizički prošao i
      // prethodne operacije — one se zatvaraju (isProcessFinished + finishedAt), a
      // komadi/radnik im se NE diraju (0 ako nisu kucane — ne izmišljamo evidenciju).
      // Druge ZAVRŠNE operacije (significantForFinishing) se ne potvrđuju implicitno:
      // zapis o kvalitetu sme da nastane samo stvarnom kontrolom.
      const significant = await tx.operation.findMany({
        where: { significantForFinishing: true },
        select: { workCenterCode: true },
      });
      const confirmedOps = await tx.techProcess.updateMany({
        where: {
          projectId,
          identNumber,
          variant,
          id: { not: tp.id },
          isProcessFinished: { not: true },
          workCenterCode: { notIn: significant.map((o) => o.workCenterCode) },
        },
        data: { isProcessFinished: true, finishedAt: now },
      });

      // Ceo RN silazi sa prioriteta (ne samo kontrolna operacija) — nalog je gotov.
      const prioritized = await tx.workOrderOperation.updateMany({
        where: {
          workOrderId: workOrder.id,
          priority: { not: OPERATION_PRIORITY_DONE },
        },
        data: { priority: OPERATION_PRIORITY_DONE },
      });
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
        prioritized: prioritized.count,
        confirmedOperations: confirmedOps.count,
        workOrderCompleted,
        opened: !existingOpen,
      };
    });

    const label = await this.buildLabelData(
      result.workOrder.id,
      dto.pieceCount,
    );
    const childOrderPending = dto.qualityTypeId !== PART_QUALITY.GOOD;

    // D8 emit: DORADA i ŠKART (odluka Nenad, PLAN_dorade §D8) → in-app notifikacija
    // tehnolozima + projektantu crteža. POSLE uspešne transakcije, best-effort —
    // helper je ceo u try/catch, pad notifikacije NE obara kucanje kontrole.
    if (childOrderPending) {
      await this.notifyQualityIssue({
        workOrderId: result.workOrder.id,
        identNumber: result.workOrder.identNumber,
        operationNumber,
        workCenterCode,
        qualityTypeId: dto.qualityTypeId,
        pieceCount: dto.pieceCount,
        controllerName: worker.fullName || worker.username,
      });
    }

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
        // Broj neotkucanih/otvorenih operacija RN-a zatvorenih ovom završnom kontrolom.
        confirmedOperations: result.confirmedOperations,
        workOrderCompleted: result.workOrderCompleted,
        // true = red kontrole je otvoren u ovom pozivu (nije postojao); false = ažuriran postojeći.
        techProcessOpened: result.opened,
        workOrder: result.workOrder,
        // A-5 (shadow): upozorenja o ovlašćenju kontrolora / razdvajanju dužnosti (null ako OK).
        controllerWarnings: controllerWarnings.length
          ? controllerWarnings
          : null,
        label,
        // Dorada/škart: child RN (-D/-S) je P2; notifikacija tehnolozima je poslata (D8).
        childOrderPending,
      },
      ...(childOrderPending
        ? {
            meta: {
              note: "Kvalitet dorada/škart evidentiran; notifikacija tehnolozima poslata (D8). Kreiranje child RN-a (-D/-S) dolazi u P2 (MODULE_SPEC_kontrola §8).",
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

  /**
   * `GET /worker/me` — auto-identifikacija radnika iz LIČNOG naloga (JWT `workerId`,
   * `users.worker_id`). Kiosk preskače skeniranje ID kartice kad je prijavljen lični nalog
   * (npr. marina.mutic@ na telefonu); deljeni terminal-nalozi (kontrola@, tehnologija@)
   * NEMAJU vezanog radnika → `data: null` → kartica ostaje obavezna (odluka Nesa 2026-07-09).
   * Vraća i `cardId` da front nastavi postojeći tok (workerCard u scan/control/start/stop).
   */
  async identifyWorkerFromUser(user?: AuthUser) {
    if (!user?.userId) return { data: null };
    // Veza se čita SVEŽE iz baze (ne iz JWT claim-a) — stari token izdat pre izmene
    // users.worker_id ne sme da auto-prijavi pogrešnog radnika na deljenom terminalu.
    const account = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { workerId: true },
    });
    const workerId = account?.workerId ?? null;
    if (!workerId) return { data: null };
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      select: {
        id: true,
        fullName: true,
        username: true,
        workerTypeId: true,
        cardId: true,
      },
    });
    // Bez radnika ili bez kartice → nazad na skeniranje kartice (tok traži cardId).
    if (!worker || !worker.cardId?.trim()) return { data: null };
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
        cardId: worker.cardId,
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

  /**
   * `POST /labels/print` — RAW TSPL2 direktno na mrežni štampač (TCP 9100, TSC ML340P).
   * Server je na istom LAN-u kao štampač; browser NE dira localhost (Chrome „Local
   * Network Access" blokira HTTPS→localhost, pa je per-PC proxy nepouzdan). Iste odbrane
   * kao 1.0 label-proxy: TSPL2 komande koje menjaju KONFIGURACIJU štampača se odbijaju
   * (422) — pogrešan SIZE/GAP ume da „zaglavi" štampač. Printer adresa: env
   * `LABEL_PRINTER_HOST`/`LABEL_PRINTER_PORT` (default 192.168.70.20:9100).
   */
  async printRawLabel(dto: PrintLabelDto) {
    validatePrintLabel(dto);
    const tspl2 = dto.tspl2;
    const FORBIDDEN = [
      "SIZE ",
      "GAP ",
      "DENSITY ",
      "SPEED ",
      "CODEPAGE ",
      "SET TEAR",
      "REFERENCE ",
      "OFFSET ",
    ];
    const upper = tspl2.toUpperCase();
    const hit = FORBIDDEN.find((c) => upper.includes(c));
    if (hit)
      throw new UnprocessableEntityException(
        `TSPL2 sadrži zabranjenu komandu '${hit.trim()}' (menja konfiguraciju štampača) — štampa odbijena.`,
      );

    const host = process.env.LABEL_PRINTER_HOST || "192.168.70.20";
    const port =
      Number.parseInt(process.env.LABEL_PRINTER_PORT ?? "", 10) || 9100;

    const bytes = await new Promise<number>((resolve, reject) => {
      const sock = createConnection({ host, port });
      const fail = (msg: string) => {
        sock.destroy();
        reject(new BadGatewayException(`Štampač ${host}:${port} — ${msg}`));
      };
      sock.setTimeout(10_000, () => fail("timeout (10s)"));
      sock.once("error", (e) => fail(e.message));
      sock.once("connect", () => {
        sock.write(tspl2, "binary", (err) => {
          if (err) return fail(err.message);
          const n = Buffer.byteLength(tspl2, "binary");
          sock.end(() => resolve(n));
        });
      });
    });

    this.logger.log(
      `label print: ${bytes} B → ${host}:${port} (copies=${dto.copies ?? "?"})`,
    );
    return { data: { ok: true, bytes, printer: `${host}:${port}` } };
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
    if (!tp)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);

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
        await tx.techProcessDocument.deleteMany({
          where: { techProcessId: id },
        });
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
   * PRIVREMENI TEST RADNICI (ODLUKE #32, Nesa 2026-07-10): env `AUTHZ_TEST_WORKER_IDS`
   * (CSV worker id-jeva, npr. "74" = Jovica Milošević). Test radnik preskače SERVISNE
   * provere na kiosku (machine-access, kontrolor-auth, razdvajanje dužnosti) da bi mogao
   * da testira SVE tokove. Guard/permisije se NE preskaču (nalog mora imati rolu).
   * UKIDANJE: obriši env red + `docker compose up -d`. Ne koristiti za stvarne radnike.
   */
  private isTestWorker(workerId: number): boolean {
    if (!workerId) return false;
    return (process.env.AUTHZ_TEST_WORKER_IDS ?? "")
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter(Number.isFinite)
      .includes(workerId);
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
    if (this.isTestWorker(workerId)) return null; // ODLUKE #32: test radnik
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
   * Tekući RN za (projectId, identNumber) = red sa najvišom varijantom. D5
   * klon-varijanta („Prepiši isti postupak", legacy semantika — potvrda Negovan)
   * pri izmeni tehnologije/crteža otvara NOVI `work_orders` red sa MAX(variant)+1,
   * pa tekuću varijantu određuje `work_orders`, ne `tech_processes`.
   */
  private async findCurrentWorkOrder(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
  ) {
    return tx.workOrder.findFirst({
      where: { projectId, identNumber },
      orderBy: { variant: "desc" },
      select: { id: true, variant: true },
    });
  }

  /**
   * Red operacije u routingu PINOVAN na zadatu varijantu (varijanta tekućeg RN-a
   * iz `findCurrentWorkOrder`). Nova klon-varijanta (D5) nema kucanja — red stare
   * varijante NE sme da „upije" rad novog otiska, zato je `variant` deo ključa.
   */
  private async findRoutingTp(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
    variant: number,
    workCenterCode: string,
    operationNumber: number | null,
  ) {
    const where: Prisma.TechProcessWhereInput = {
      projectId,
      identNumber,
      variant,
      workCenterCode,
    };
    if (operationNumber !== null) where.operationNumber = operationNumber;
    return tx.techProcess.findFirst({
      where,
      orderBy: [{ isProcessFinished: "asc" }, { id: "asc" }],
    });
  }

  /**
   * A-5: da li je radnik OVLAŠĆEN kontrolor — tip radnika ima `additionalPrivileges`
   * (sistematizacija „Kontrola"; legacy `tVrsteRadnika.DodatnaOvlascenja`). Isti signal kao
   * `identifyWorker.isController`. Login-put (rola sa `tehnologija.approve`) je zaseban gate na guard-u.
   */
  private async isAuthorizedController(workerTypeId: number): Promise<boolean> {
    if (!workerTypeId) return false;
    const t = await this.prisma.workerType.findUnique({
      where: { id: workerTypeId },
      select: { additionalPrivileges: true },
    });
    return t?.additionalPrivileges === true;
  }

  /**
   * A-5 razdvajanje dužnosti: da li je radnik evidentirao PROIZVODNI rad na ovom delu
   * (project+ident+variant). Ako jeste → ne sme da radi završnu kontrolu nad njim.
   *
   * „Proizvodni rad" NE uključuje kontrolne operacije: ni završnu (`significantForFinishing`)
   * ni RC-ove čiji naziv sadrži „kontrol" (npr. 8.4 Međufazna Kontrola) — kontrolor koji je
   * radio međufaznu SME da radi završnu (analiza 90d: 422/1190 kontrola bi inače lažno okinulo).
   */
  private async selfControlViolation(
    projectId: number,
    identNumber: string,
    variant: number,
    workerId: number,
  ): Promise<boolean> {
    const rows = await this.prisma.techProcess.findMany({
      where: { projectId, identNumber, variant, workerId },
      select: { workCenterCode: true },
    });
    if (!rows.length) return false;
    const codes = [
      ...new Set(rows.map((r) => r.workCenterCode).filter(Boolean)),
    ];
    const controlOps = await this.prisma.operation.findMany({
      where: {
        workCenterCode: { in: codes },
        OR: [
          { significantForFinishing: true },
          { workCenterName: { contains: "ontrol", mode: "insensitive" } },
        ],
      },
      select: { workCenterCode: true },
    });
    const controlSet = new Set(controlOps.map((o) => o.workCenterCode));
    // Proizvodni rad = bar jedan red čiji RC nije nikakva kontrola.
    return rows.some((r) => !controlSet.has(r.workCenterCode));
  }

  /**
   * CREATE-ON-SCAN za OBIČNE operacije (Nesa 2026-07-10): red u `tech_processes`
   * se NAĐE ili OTVORI za TEKUĆU varijantu RN-a — i za RN kreiran u 2.0 (nema
   * unapred redove; legacy nalozi su ih dobijali iz MSSQL sync-a) i za svežu D5
   * klon-varijantu (novi RN red, kucanja kreću od nule). Operacija se validira
   * protiv routinga tekućeg RN-a (`work_order_operations`). Isti obrazac kao
   * `control()` (legacy SacuvajRNSIzUnosaBarKoda). 404 ako RN ne postoji;
   * 422 ako operacija nije u routingu.
   */
  private async findOrOpenRoutingTp(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
    workCenterCode: string,
    operationNumber: number | null,
    identMark: string,
  ) {
    // Tekući RN prvo — kiosk uvek knjiži na najvišu varijantu (D5 klon = novi red).
    const wo = await this.findCurrentWorkOrder(tx, projectId, identNumber);
    if (!wo)
      throw new NotFoundException(
        `RN za predmet ${projectId}, ident ${identNumber} nije nađen.`,
      );

    const existing = await this.findRoutingTp(
      tx,
      projectId,
      identNumber,
      wo.variant,
      workCenterCode,
      operationNumber,
    );
    if (existing) return { tp: existing, opened: false };

    const routingWhere: Prisma.WorkOrderOperationWhereInput = {
      workOrderId: wo.id,
      workCenterCode,
    };
    if (operationNumber !== null)
      routingWhere.operationNumber = operationNumber;
    const routing = await tx.workOrderOperation.findFirst({
      where: routingWhere,
      orderBy: { id: "asc" },
      select: { operationNumber: true },
    });
    if (!routing)
      throw new UnprocessableEntityException(
        `Operacija (RC ${workCenterCode}${
          operationNumber !== null ? `, op. ${operationNumber}` : ""
        }) nije u tehnološkom postupku RN ${identNumber} (predmet ${projectId}).`,
      );

    await this.alignTechProcessSequence(tx);
    const tp = await tx.techProcess.create({
      data: {
        projectId,
        identNumber,
        variant: wo.variant,
        operationNumber: routing.operationNumber,
        workCenterCode,
        identMark: identMark || "0",
        pieceCount: 0,
        workerId: 0,
        workOrderId: wo.id,
      },
    });
    return { tp, opened: true };
  }

  /**
   * D8 emit 1 (PLAN_dorade §D8, odluka Nenad: I dorada I škart): završna kontrola
   * sa kvalitetom ≠ dobar → in-app notifikacija. Primaoci: grupa TEHNOLOG +
   * (best-effort) projektant crteža (`resolveWorkOrderDesignerId`). Poziva se
   * POSLE uspešne transakcije; CEO helper je u try/catch — pad notifikacije se
   * loguje i NIKAD ne obara kucanje kontrole.
   */
  private async notifyQualityIssue(input: {
    workOrderId: number;
    identNumber: string;
    operationNumber: number;
    workCenterCode: string;
    qualityTypeId: number;
    pieceCount: number;
    controllerName: string | null;
  }): Promise<void> {
    try {
      const scrap = input.qualityTypeId === PART_QUALITY.SCRAP;
      const recipients =
        await this.notifications.resolveTechnologistWorkerIds();
      const designerId = await this.resolveWorkOrderDesignerId(
        input.workOrderId,
      );
      if (designerId) recipients.push(designerId);

      const created = await this.notifications.notifyWorkers(recipients, {
        type: scrap ? "kontrola.skart" : "kontrola.dorada",
        message: `${scrap ? "ŠKART" : "DORADA"} na RN ${input.identNumber} op ${input.operationNumber} (${input.workCenterCode}) — kontrolor ${input.controllerName ?? "?"}, ${input.pieceCount} kom`,
        refTable: "work_orders",
        refId: input.workOrderId,
      });
      this.logger.log(
        `D8 notifikacija ${scrap ? "ŠKART" : "DORADA"} (RN ${input.identNumber}): ${created} primalaca${designerId ? ` (uklj. projektant #${designerId})` : ""}`,
      );
    } catch (e) {
      this.logger.error(
        `D8 notifikacija FAIL (RN ${input.identNumber}, kvalitet ${input.qualityTypeId}): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Best-effort lanac do projektanta crteža RN-a (PLAN_dorade §D8, odluka #6):
   * work_order → `drawingHandoverId` → drawing_handovers.drawingId → najskorija
   * ne-isključena stavka nacrta (nema FK-a — isti obrazac kao handovers
   * `resolveDraftContext`) → handover_drafts.designerId. Kad lanac pukne na bilo
   * kom koraku (legacy RN-ovi nemaju primopredaju), FALLBACK: `drawings.designedBy`
   * string → tačno (case-insensitive) poklapanje sa `workers.fullName` aktivnog
   * radnika. Bez poklapanja → `null` BEZ greške.
   */
  private async resolveWorkOrderDesignerId(
    workOrderId: number,
  ): Promise<number | null> {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { drawingHandoverId: true, drawingId: true },
    });
    if (!wo) return null;

    let drawingId = wo.drawingId;
    if (wo.drawingHandoverId > 0) {
      const handover = await this.prisma.drawingHandover.findUnique({
        where: { id: wo.drawingHandoverId },
        select: { drawingId: true },
      });
      if (handover) {
        drawingId = handover.drawingId;
        const item = await this.prisma.handoverDraftItem.findFirst({
          where: { drawingId: handover.drawingId, excludeFromHandover: false },
          orderBy: [{ draftId: "desc" }, { id: "desc" }],
          select: { draftId: true },
        });
        if (item) {
          const draft = await this.prisma.handoverDraft.findUnique({
            where: { id: item.draftId },
            select: { designerId: true },
          });
          if (draft && draft.designerId > 0) return draft.designerId;
        }
      }
    }
    return this.resolveDesignerByDrawingAuthor(drawingId);
  }

  /**
   * Fallback odluke #6: `drawings.designedBy` je slobodan string (ime iz PDM-a),
   * ne ključ — zato SAMO tačno (case-insensitive) poklapanje sa `fullName`
   * AKTIVNOG radnika; fuzzy bi rizikovao pogrešan inbox. Nema poklapanja → null.
   */
  private async resolveDesignerByDrawingAuthor(
    drawingId: number,
  ): Promise<number | null> {
    if (!drawingId || drawingId <= 0) return null;
    const drawing = await this.prisma.drawing.findUnique({
      where: { id: drawingId },
      select: { designedBy: true },
    });
    const name = drawing?.designedBy?.trim();
    if (!name) return null;
    const worker = await this.prisma.worker.findFirst({
      where: { fullName: { equals: name, mode: "insensitive" }, active: true },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return worker?.id ?? null;
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
      throw new NotFoundException(
        `Radnik sa ID karticom '${card}' nije nađen.`,
      );
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
    if (!wo)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);

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

    const codes = [
      ...new Set(rows.map((r) => r.workCenterCode).filter(Boolean)),
    ];
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
