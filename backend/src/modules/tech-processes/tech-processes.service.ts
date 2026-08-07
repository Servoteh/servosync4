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
import { LabelPrintService } from "../../common/printing/label-print.service";
import { NotificationsService } from "../notifications/notifications.service";
import { QualityService } from "../kvalitet/kvalitet.service";
import { WorkOrdersService } from "../work-orders/work-orders.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseDateParam } from "../../common/date-params";
import { parseBarcode, formatLabelBarcode } from "./barcode";
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
import {
  TP_PRIKAZ_MAX_SEC,
  TP_PRIKAZ_MIN_SEC,
  TP_PRIKAZ_VALIDNA,
} from "../work-orders/time-estimate.service";
import { type StartWorkDto, validateStartWork } from "./dto/start-work.dto";
import { type StopWorkDto, validateStopWork } from "./dto/stop-work.dto";
import type { PrintLabelDto } from "./dto/print-label.dto";

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

/**
 * Status primopredaje RN-a „LANSIRAN" (`work_orders.handover_status_id = 3`) = deo je
 * PUŠTEN u proizvodnju. Vrednost 1:1 iz `handovers.service.ts` `HANDOVER_STATUS.LAUNCHED`
 * — lokalna kopija (bez cross-module importa, BACKEND_RULES §5). Koristi je pretraga
 * po sklopu (A4): delovi sklopa ulaze u rezultat samo ako su pušteni.
 */
const HANDOVER_STATUS_LAUNCHED = 3;

/**
 * Guard-ovi za ekspanziju pretrage po nacrtu/sklopu (`expandSearchWorkOrderIds`):
 * minimalna dužina `q`, cap crteža/RN-ova i čvorova BOM rekurzije. Držani nisko jer
 * su to 3–4 mala indeksirana upita koja teku SINHRONO uz svaku pretragu.
 */
const SEARCH_EXPAND_MIN_LENGTH = 3;
const SEARCH_EXPAND_DRAFT_LIMIT = 10;
const SEARCH_EXPAND_WORK_ORDER_LIMIT = 1000;
const SEARCH_EXPAND_BOM_NODE_CAP = 500;

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
  /**
   * Vrsta unosa („Aktivnost kontrole", K4) — vrednosti kao `entryKindOf`:
   * `"control-final"` = završna kontrola (RC sa `operations.significantForFinishing`),
   * `"control-mid"` = međufazna kontrola (RC sa „…ontrol…" u nazivu, a nije završna),
   * `"work"` = obično kucanje (npr. prijem kooperacije); prazno/nepoznato = svi.
   */
  entryKind?: string;
  /**
   * `"true"` = samo unosi OVLAŠĆENIH KONTROLORA (`worker_types.additionalPrivileges`).
   * Prekidač, ne tvrdo pravilo — legacy kolona može biti nepotpuna (vidi K4 plan).
   */
  controllersOnly?: string;
  /** `"true"` = uz stranicu vrati i `meta.totals` (zbir nad ISTIM filterom). */
  withTotals?: string;
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
  /**
   * Σ elapsed (finishedAt−enteredAt) po redovima koji imaju oba vremena I prolaze
   * higijenski prag prikaza (`TP_PRIKAZ_VALIDNA`: 1 min ≤ Δ ≤ 24 h).
   */
  elapsedSeconds: number;
  hasElapsed: boolean;
  /** Zatvoreni redovi koji NISU ušli u zbir (< 1 min ili > 24 h — zaboravljene). */
  excludedRowCount: number;
}

/**
 * Crtež RN-a za „Otvori PDF" dugme (kartica TP / „Moji otvoreni") + verzioni
 * status. `revisionStale` = RN je na STARIJOJ reviziji od najnovije u `drawings`
 * (stigla nova revizija XML-om/izmenom a RN nije re-izdat) → UPOZORENJE, ne
 * blokira rad (odluka Nenad 15.07). Revizija = string MAX (kao PDM),
 * normalizacija prazno→"A", uppercase.
 */
export interface CardDrawingRef {
  id: number;
  hasPdf: boolean;
  /** RN-ova revizija (null kad RN nema reviziju). */
  revision: string | null;
  /** Najviša revizija tog crteža u bazi (string MAX). */
  latestRevision: string | null;
  revisionStale: boolean;
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

/**
 * Telo za `POST /:id/stop-work` — „Kraj rada" iz „Moji otvoreni" (kiosk): završava
 * RAD po `tech_processes` id-ju, bez barkodova (radnik je već identifikovan karticom
 * ili prijavljenim nalogom). Ista semantika komada kao `POST /work/stop`.
 * class-validator još nije uveden (BACKEND_RULES §6) — validacija je ručna.
 */
export interface StopWorkByIdBody {
  /** ID kartica radnika (opciono — inače radnik iz prijavljenog naloga / JWT). */
  workerCard?: string;
  /** Broj napravljenih komada u ovoj sesiji (ceo broj ≥ 0; 0 = samo vreme). */
  pieceCount: number;
  /** Napomena (opciono) — upisuje se na sesiju i na `tech_processes` red (K0.1). */
  note?: string;
  /**
   * Deljeni red sa više radnika (Nenad 2026-07-22): bez ovoga „Kraj rada" zatvara
   * SAMO svoju sesiju kad drugi radnici imaju otvorene sesije na operaciji;
   * `true` = eksplicitan kiosk izbor „Zatvori za sve" (gasi red + tuđe sesije).
   */
  finishForAll?: boolean;
  /**
   * EKSPLICITNA NAMERA „operacija je gotova" (odluka Nenad 2026-08-05). „Kraj
   * rada" je do sada UVEK gasio operaciju (`forceFinish`), pa je radnik koji je
   * otkucao 21 od 200 komada svojim „gotov sam za danas" proglašavao operaciju
   * završenom (`bool_or(is_process_finished)` je kanon čitanja u celom modulu).
   * Sada: kumulativ ≥ plan → zatvara se samo (polje se ne gleda); ISPOD plana se
   * zatvara SAMO uz `true`. Polje nije poslato + ispod plana → `false`.
   */
  operacijaGotova?: boolean;
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
  /** Σ elapsed po higijenskom pragu prikaza (1 min ≤ Δ ≤ 24 h) — v. TP_PRIKAZ_VALIDNA. */
  total_elapsed_seconds: number;
  /** Zatvorene prijave izuzete iz zbira (< 1 min ili > 24 h — zaboravljene). */
  excluded_row_count: number;
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
  /** Broj ZAVRŠNIH kontrola (significant_for_finishing) u RUTINGU naloga. */
  final_op_count: number;
  /** DOBRI I ZAVRŠENI komadi otkucani NA završnoj kontroli (kanon „RN završen"). */
  made_good_final: number;
  /** Usko grlo: najmanje urađena operacija rutinga — fallback kad nema završne kontrole. */
  made_good_bottleneck: number;
  /** Broj operacija u rutingu (bez `without_process` — one se po prirodi ne kucaju). */
  routing_op_count: number;
  /** Koliko operacija rutinga je otkucano u PUNOJ planiranoj količini. */
  routing_ops_completed: number;
  /**
   * NAPREDAK KROZ RUTING (0..1): AVG(LEAST(done/plan, 1)) po operacijama rutinga.
   * NULL kad nalog nema plan (`piece_count = 0`) ili nema rutinga — tada se meri
   * po starom kanonu (`made_good_*`).
   */
  routing_progress_ratio: number | null;
  operation_count: number;
  finished_operation_count: number;
  last_completed_at: Date | null;
}

interface SessionDailyRaw {
  day: Date;
  session_count: number;
  worker_count: number;
  pieces: number;
  elapsed_seconds: number;
  /** Zatvorene sesije van praga prikaza (> 24 h ili negativno trajanje). */
  excluded_count: number;
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

/** Vrsta unosa u evidenciji (K4) — vidi `entryKindOf`. */
export type TechProcessEntryKind = "control-final" | "control-mid" | "work";

/**
 * K4: vrsta unosa iz razrešenog RC-a — ISTI kanon kao `selfControlViolation`:
 * završna kontrola = `significantForFinishing`; „…ontrol…" u nazivu RC-a (npr.
 * „8.4 Međufazna Kontrola") = međufazna kontrola; sve ostalo = proizvodno kucanje.
 * Nerazrešen/orphan RC → `"work"` (ne izmišljamo kontrolu tamo gde je ne znamo).
 */
export function entryKindOf(
  op: { workCenterName?: string; significantForFinishing?: boolean | null } | null,
): TechProcessEntryKind {
  if (!op) return "work";
  if (op.significantForFinishing === true) return "control-final";
  if (op.workCenterName && /ontrol/i.test(op.workCenterName))
    return "control-mid";
  return "work";
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
    private readonly labelPrint: LabelPrintService,
    // K2: auto-draft neusaglašenosti iz kucanja kontrole (dorada/škart).
    private readonly quality: QualityService,
    // A3: control() dorade/škarta AUTOMATSKI kreira child RN (-D/-S) — legacy paritet
    // (KreirajNalogDoradeIliSkarta): kopija celog TP parenta, Komada = skart/dorada.
    private readonly workOrders: WorkOrdersService,
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
    // A4: `q`/`identNumber` traži po identNumber ILI crtežu (drawing_number) ILI
    // nazivu dela (part_name). Crtež/naziv žive na work_orders (tech_processes NEMA
    // te kolone ni Prisma relaciju) → pred-upit razreši work_order id-jeve pa OR na
    // workOrderId IN (...). Zadržava kompatibilnost postojećeg query parametra.
    const ident = (query.q?.trim() || query.identNumber)?.trim();
    if (ident) {
      // Dva izvora dodatnih work_order id-jeva: (1) crtež/naziv dela na RN-u (contains);
      // (2) A4 ekspanzija po NACRTU primopredaje i po SKLOPU (nacrt-broj → crteži stavki
      // → RN-ovi; sklop-broj → pušteni delovi kroz BOM). Oba pred-upita → OR na
      // workOrderId IN (...). Zadržava kompatibilnost postojećeg query parametra.
      const [woMatches, extraIds] = await Promise.all([
        this.prisma.workOrder.findMany({
          where: {
            OR: [
              { drawingNumber: { contains: ident, mode: "insensitive" } },
              { partName: { contains: ident, mode: "insensitive" } },
            ],
          },
          select: { id: true },
          // Zaštita od ogromnog IN(...) — 1000 najskorijih RN-ova je više nego dovoljno
          // za pretragu u pogonu (rezultat se dodatno stranira).
          take: 1000,
          orderBy: { id: "desc" },
        }),
        this.expandSearchWorkOrderIds(ident),
      ]);
      const woIds = [...new Set([...woMatches.map((w) => w.id), ...extraIds])];
      filter.OR = [
        { identNumber: { contains: ident, mode: "insensitive" } },
        ...(woIds.length ? [{ workOrderId: { in: woIds } }] : []),
      ];
    }
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

    // K4 „Aktivnost kontrole": vrsta unosa + samo kontrolori. Idu kroz `AND` da ne
    // gaze postojeći `OR` (ident/crtež/naziv) ni tačne filtere iznad. Prazan skup
    // kodova/id-jeva je fail-closed (`in: []` = nema rezultata) — namerno.
    const and: Prisma.TechProcessWhereInput[] = [];
    const kind = query.entryKind?.trim();
    if (kind === "control-final" || kind === "control-mid" || kind === "work") {
      const [finalCodes, allControlCodes] = await Promise.all([
        this.controlWorkCenterCodes(true),
        kind === "control-final"
          ? Promise.resolve<string[]>([])
          : this.controlWorkCenterCodes(false),
      ]);
      if (kind === "control-final")
        and.push({ workCenterCode: { in: finalCodes } });
      else if (kind === "control-mid")
        // Međufazna = kontrolni RC koji NIJE završna kontrola (oba uslova se AND-uju).
        and.push({
          workCenterCode: { in: allControlCodes, notIn: finalCodes },
        });
      else and.push({ workCenterCode: { notIn: allControlCodes } });
    }
    if (query.controllersOnly === "true")
      and.push({ workerId: { in: await this.controllerWorkerIds() } });
    if (and.length) filter.AND = and;

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

    const [workers, ops, quals, workOrderRefs] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveOperationsByCode(rows.map((r) => r.workCenterCode)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      this.resolveWorkOrderRefs(rows.map((r) => r.workOrderId)),
    ]);
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      operation: ops.get(r.workCenterCode) ?? null,
      qualityType: quals.get(r.qualityTypeId) ?? null,
      // Tehnolog autor TP-a = work_orders.worker_id (Miljan t.6a: „Tehnolog"
      // kolona je do sada prikazivala radnika koji je kucao red — `worker`
      // ostaje to, a ovo je pravi tehnolog sa RN-a; null kad RN nije razrešen).
      technologist: workOrderRefs.technologists.get(r.workOrderId) ?? null,
      // Crtež sa RN-a (work_orders.drawing_number); null kad workOrderId=0/orphan.
      drawingNumber: workOrderRefs.drawingNumbers.get(r.workOrderId) ?? null,
      // K4: naziv pozicije sa RN-a (work_orders.part_name); isti orphan uslov.
      partName: workOrderRefs.partNames.get(r.workOrderId) ?? null,
      // K4: vrsta unosa (završna kontrola / međufazna / kucanje) — bez dodatnog
      // upita, iz već razrešenog RC-a.
      entryKind: entryKindOf(ops.get(r.workCenterCode) ?? null),
    }));

    // K4 zbirne kartice: sume nad ISTIM `where` (ne nad stranicom). Samo uz
    // `withTotals=true` — postojeći potrošači (Evidencija u proizvodnji) ne plaćaju upit.
    const totals =
      query.withTotals === "true" ? await this.listTotals(where) : null;

    return {
      data,
      meta: {
        ...pageMeta(page, pageSize, total),
        ...(totals ? { totals } : {}),
      },
    };
  }

  /**
   * K4: zbir nad ISTIM `where` kao lista — broj unosa i Σ komada, razloženo po
   * kvalitetu (0=dobar, 1=dorada, 2=škart). Storno redovi su negativni komadi pa
   * se prirodno oduzimaju iz sume.
   */
  private async listTotals(where: Prisma.TechProcessWhereInput) {
    const groups = await this.prisma.techProcess.groupBy({
      by: ["qualityTypeId"],
      where,
      _sum: { pieceCount: true },
      _count: { _all: true },
    });
    const totals = { entries: 0, pieces: 0, good: 0, rework: 0, scrap: 0 };
    for (const g of groups) {
      const pieces = g._sum.pieceCount ?? 0;
      totals.entries += g._count._all;
      totals.pieces += pieces;
      if (g.qualityTypeId === PART_QUALITY.GOOD) totals.good += pieces;
      else if (g.qualityTypeId === PART_QUALITY.REWORK) totals.rework += pieces;
      else if (g.qualityTypeId === PART_QUALITY.SCRAP) totals.scrap += pieces;
    }
    return totals;
  }

  /**
   * K4: šifre RC-ova kontrolnih operacija. `finalOnly` = samo ZAVRŠNA kontrola
   * (`operations.significantForFinishing`); inače i međufazne („…ontrol…" u nazivu
   * RC-a) — isti kanon koji `selfControlViolation` koristi za razdvajanje dužnosti.
   */
  private async controlWorkCenterCodes(finalOnly: boolean): Promise<string[]> {
    const rows = await this.prisma.operation.findMany({
      where: finalOnly
        ? { significantForFinishing: true }
        : {
            OR: [
              { significantForFinishing: true },
              { workCenterName: { contains: "ontrol", mode: "insensitive" } },
            ],
          },
      select: { workCenterCode: true },
    });
    return rows.map((r) => r.workCenterCode);
  }

  /**
   * K4: id-jevi radnika koji su OVLAŠĆENI KONTROLORI — tip radnika sa
   * `additionalPrivileges` (legacy `tVrsteRadnika.DodatnaOvlascenja`), isti signal
   * kao `isAuthorizedController`. Prazno (nepopunjena legacy kolona) → prazan skup:
   * front nudi prekidač „Samo kontrolori" da se ograničenje isključi.
   */
  private async controllerWorkerIds(): Promise<number[]> {
    const types = await this.prisma.workerType.findMany({
      where: { additionalPrivileges: true },
      select: { id: true },
    });
    if (!types.length) return [];
    const workers = await this.prisma.worker.findMany({
      where: { workerTypeId: { in: types.map((t) => t.id) } },
      select: { id: true },
    });
    return workers.map((w) => w.id);
  }

  // ------------------------------------------------- A4 SEARCH EXPANSION

  /**
   * A4 pretraga „praćenja delova": za tekst `q` vraća DODATNE `work_orders.id`-jeve
   * koje treba uključiti u rezultat (uz postojeći ident/crtež/naziv match), iz dva
   * izvora — spaja ih i dedup-uje:
   *
   *  (a) NACRT primopredaje: `handover_drafts.draft_number ILIKE %q%` (npr.
   *      G-yymmdd-nnn / D-...) → `handover_draft_items.drawing_id` → `drawings`
   *      (id + broj) → RN-ovi tih crteža (`drawingId IN` ILI `drawingNumber IN`,
   *      insensitive). Nacrt time postaje dostižan iz kucanja/RN-a.
   *
   *  (b) SKLOP: `drawings.drawing_number = q` (exact, insensitive, trim) → SVA deca
   *      rekurzivno kroz `drawing_components` (ISTI izvor kao PDM BOM — `drawing_assemblies`
   *      je namerno prazan/ignorisan, MODULE_SPEC_pdm Q1) sa cycle-guard-om (Set) i
   *      cap-om čvorova → RN-ovi te dece FILTRIRANI na PUŠTENE (`handover_status_id = 3`).
   *      Sam sklop je već pokriven postojećim `drawing_number` contains matchom.
   *
   * Prazno za `q.trim().length < 3` (kratki upiti su no-op — čuva performanse). Sve
   * su 3–4 mala indeksirana upita; ne baca (best-effort proširenje pretrage).
   */
  private async expandSearchWorkOrderIds(q: string): Promise<number[]> {
    const term = q.trim();
    if (term.length < SEARCH_EXPAND_MIN_LENGTH) return [];

    const [draftDrawings, assemblyChildIds] = await Promise.all([
      this.searchDraftDrawings(term),
      this.searchAssemblyChildDrawingIds(term),
    ]);

    // (a) NACRT → RN-ovi crteža stavki (bilo koji status). Poklapanje po drawingId
    // ILI po broju crteža (insensitive) — legacy RN-ovi nemaju uvek popunjen drawingId.
    const draftDrawingIds = uniqueIds(draftDrawings.map((d) => d.id));
    const draftDrawingNumbers = [
      ...new Set(
        draftDrawings
          .map((d) => d.drawingNumber.trim())
          .filter((n) => n.length),
      ),
    ];
    const draftWos =
      draftDrawingIds.length || draftDrawingNumbers.length
        ? await this.prisma.workOrder.findMany({
            where: {
              OR: [
                ...(draftDrawingIds.length
                  ? [{ drawingId: { in: draftDrawingIds } }]
                  : []),
                ...(draftDrawingNumbers.length
                  ? [
                      {
                        drawingNumber: {
                          in: draftDrawingNumbers,
                          mode: Prisma.QueryMode.insensitive,
                        },
                      },
                    ]
                  : []),
              ],
            },
            select: { id: true },
            take: SEARCH_EXPAND_WORK_ORDER_LIMIT,
            orderBy: { id: "desc" },
          })
        : [];

    // (b) SKLOP → RN-ovi PUŠTENE dece (handover_status_id = 3). Deca su crteži
    // (id-jevi); RN se poklapa po drawingId ILI po broju crteža (kao gore).
    let assemblyWos: { id: number }[] = [];
    if (assemblyChildIds.length) {
      const childDrawings = await this.prisma.drawing.findMany({
        where: { id: { in: assemblyChildIds } },
        select: { id: true, drawingNumber: true },
      });
      const childNumbers = [
        ...new Set(
          childDrawings
            .map((d) => d.drawingNumber.trim())
            .filter((n) => n.length),
        ),
      ];
      assemblyWos = await this.prisma.workOrder.findMany({
        where: {
          handoverStatusId: HANDOVER_STATUS_LAUNCHED,
          OR: [
            { drawingId: { in: assemblyChildIds } },
            ...(childNumbers.length
              ? [
                  {
                    drawingNumber: {
                      in: childNumbers,
                      mode: Prisma.QueryMode.insensitive,
                    },
                  },
                ]
              : []),
          ],
        },
        select: { id: true },
        take: SEARCH_EXPAND_WORK_ORDER_LIMIT,
        orderBy: { id: "desc" },
      });
    }

    return [
      ...new Set([
        ...draftWos.map((w) => w.id),
        ...assemblyWos.map((w) => w.id),
      ]),
    ];
  }

  /**
   * A4 (a): crteži stavki nacrta čiji `draft_number` sadrži `term` (ILIKE, cap na
   * ~10 nacrta) — `handover_drafts` → `handover_draft_items.drawing_id` → `drawings`.
   * Vraća (id, drawingNumber) parove za dalje poklapanje na RN-ove.
   */
  private async searchDraftDrawings(
    term: string,
  ): Promise<{ id: number; drawingNumber: string }[]> {
    const drafts = await this.prisma.handoverDraft.findMany({
      where: { draftNumber: { contains: term, mode: "insensitive" } },
      select: { id: true },
      take: SEARCH_EXPAND_DRAFT_LIMIT,
      orderBy: { id: "desc" },
    });
    if (!drafts.length) return [];
    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId: { in: drafts.map((d) => d.id) } },
      select: { drawingId: true },
    });
    const drawingIds = uniqueIds(items.map((i) => i.drawingId));
    if (!drawingIds.length) return [];
    return this.prisma.drawing.findMany({
      where: { id: { in: drawingIds } },
      select: { id: true, drawingNumber: true },
    });
  }

  /**
   * A4 (b): SVA deca sklopa čiji je broj crteža tačno `term` (exact, insensitive) —
   * rekurzivno kroz `drawing_components` (isti izvor kao PDM BOM). Cycle-guard je Set
   * posećenih parent-a; cap čvorova (`SEARCH_EXPAND_BOM_NODE_CAP`) štiti od preduboke/
   * široke sastavnice. Vraća id-jeve crteža-dece (bez samog sklopa). Prazno kad broj
   * ne pogodi nijedan crtež ili sklop nema komponenti.
   */
  private async searchAssemblyChildDrawingIds(term: string): Promise<number[]> {
    const roots = await this.prisma.drawing.findMany({
      where: { drawingNumber: { equals: term, mode: "insensitive" } },
      select: { id: true },
    });
    if (!roots.length) return [];

    const visited = new Set<number>();
    const children = new Set<number>();
    let frontier = uniqueIds(roots.map((d) => d.id));
    for (const id of frontier) visited.add(id);

    while (
      frontier.length &&
      visited.size + children.size < SEARCH_EXPAND_BOM_NODE_CAP
    ) {
      const edges = await this.prisma.drawingComponent.findMany({
        where: { parentDrawingId: { in: frontier } },
        select: { childDrawingId: true },
      });
      const next: number[] = [];
      for (const e of edges) {
        const child = e.childDrawingId;
        if (child <= 0 || visited.has(child)) continue; // cycle-guard
        visited.add(child);
        children.add(child);
        next.push(child);
        if (visited.size + children.size >= SEARCH_EXPAND_BOM_NODE_CAP) break;
      }
      frontier = next;
    }

    return [...children];
  }

  /**
   * Batch: workOrderId → { tehnolog (work_orders.worker_id), crtež
   * (work_orders.drawing_number), naziv pozicije (work_orders.part_name) }. Legacy
   * redovi često imaju workOrderId 0 (veza kroz JOIN, ne FK) — preskaču se; orphan
   * RN/radnik → null (obrazac common/relations, bez required JOIN-a). Jedan upit
   * nad work_orders daje sve troje.
   */
  private async resolveWorkOrderRefs(ids: number[]) {
    const uniq = uniqueIds(ids);
    const technologists = new Map<
      number,
      { id: number; fullName: string | null; username: string | null }
    >();
    const drawingNumbers = new Map<number, string>();
    const partNames = new Map<number, string>();
    if (!uniq.length) return { technologists, drawingNumbers, partNames };
    const workOrders = await this.prisma.workOrder.findMany({
      where: { id: { in: uniq } },
      select: {
        id: true,
        workerId: true,
        drawingNumber: true,
        // K4: „Naziv pozicije" u Aktivnosti kontrole — kontrolor prepoznaje deo
        // po nazivu, ne po identu.
        partName: true,
      },
    });
    const workers = await this.resolveWorkers(
      workOrders.map((w) => w.workerId),
    );
    for (const wo of workOrders) {
      const worker = workers.get(wo.workerId);
      if (worker) technologists.set(wo.id, worker);
      // drawing_number je NOT NULL u šemi ali može biti "" — prazan → null u UI.
      if (wo.drawingNumber) drawingNumbers.set(wo.id, wo.drawingNumber);
      if (wo.partName) partNames.set(wo.id, wo.partName);
    }
    return { technologists, drawingNumbers, partNames };
  }

  // -------------------------------------------------- MOJI OTVORENI (kiosk)

  /**
   * Otvoreni postupci radnika za kiosk (proba 13.07: radnik je morao ponovo da
   * skenira barkodove da bi zatvorio nalog). Radnik se identifikuje karticom
   * (`card`) ILI prijavljenim nalogom (JWT `users.worker_id`) — isti izbor kao
   * `worker/me`. Vraća `tech_processes WHERE workerId AND isProcessFinished!=true`
   * (bez machine-scope-a — eksplicitno „moji", ne „na mojoj mašini"), obogaćeno
   * operacijom, planiranim (iz `work_orders`) i `hasOpenSession` (postoji
   * otvorena `work_time_entries` sesija) da UI zna „Završi rad" vs „Zatvori".
   * Zatvaranje iz liste koristi POSTOJEĆI `POST /:id/finish` sa `id` reda.
   * Zahtev 015/26: deljeni/opšti nalog na kome radnik NEMA svoju otvorenu sesiju
   * a DRUGI radnik radi se izostavlja (vlasništvo bez učešća ≠ „moj otvoren").
   */
  async openForWorker(card: string | undefined, user?: AuthUser) {
    const trimmed = (card ?? "").trim();
    let workerId: number;
    let workerCard: string | null = null;
    if (trimmed) {
      const worker = await this.resolveWorkerByCard(trimmed);
      workerId = worker.id;
      workerCard = trimmed;
    } else {
      const account = user?.userId
        ? await this.prisma.user.findUnique({
            where: { id: user.userId },
            select: { workerId: true },
          })
        : null;
      if (!account?.workerId)
        throw new BadRequestException(
          "Radnik nije prepoznat — skenirajte ID karticu ili se prijavite ličnim nalogom vezanim za radnika.",
        );
      workerId = account.workerId;
    }

    // Proba 13.07 (Jovica): red operacije se pri START skenu otvara sa
    // workerId=0 (vlasnik se štancuje tek pri prijavi/zatvaranju), a red je i
    // DELJEN između radnika (po trojci+operaciji) — filter samo po
    // tech_processes.worker_id zato NE vidi redove na kojima radnik ima
    // OTVORENU sesiju. „Moji otvoreni" = moji redovi ILI redovi mojih
    // otvorenih sesija (work_time_entries.stopped_at IS NULL).
    const openSessions = await this.prisma.workTimeEntry.findMany({
      where: { workerId, stoppedAt: null },
      select: { techProcessId: true },
    });
    const openSessionIds = new Set(
      openSessions
        .map((s) => s.techProcessId)
        .filter((id): id is number => id != null && id > 0),
    );

    const rows = await this.prisma.techProcess.findMany({
      where: {
        isProcessFinished: { not: true },
        OR: [{ workerId }, { id: { in: [...openSessionIds] } }],
      },
      orderBy: [{ enteredAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        projectId: true,
        identNumber: true,
        variant: true,
        operationNumber: true,
        workCenterCode: true,
        pieceCount: true,
        enteredAt: true,
      },
    });

    // Deljeni red (Nenad 2026-07-22): broj DRUGIH radnika sa otvorenom sesijom po
    // redu — kiosk na „Kraj rada"/„Odustani" tada pita „samo moj rad / za sve".
    // Jedan groupBy za sve redove (bez N+1); distinct radnici po (red, radnik).
    const otherOpenGroups = rows.length
      ? await this.prisma.workTimeEntry.groupBy({
          by: ["techProcessId", "workerId"],
          where: {
            techProcessId: { in: rows.map((r) => r.id) },
            stoppedAt: null,
            workerId: { not: workerId },
          },
        })
      : [];
    const othersOpenByRow = new Map<number, number>();
    for (const g of otherOpenGroups) {
      if (g.techProcessId == null) continue;
      othersOpenByRow.set(
        g.techProcessId,
        (othersOpenByRow.get(g.techProcessId) ?? 0) + 1,
      );
    }

    // Zahtev 015/26 (Jovica, opšti nalog): red koji radnik VIŠE ne radi (nema
    // sopstvenu otvorenu sesiju) a DRUGI radnik na njemu radi (deljeni/opšti
    // nalog) ne sme da ostane u „Moji otvoreni" samo zato što ga radnik POSEDUJE
    // (`tech_processes.worker_id` = kreator koji je prvi START-ovao). „Kraj rada
    // — samo moj rad" (22.07) zatvori radnikovu sesiju, ali red ostaje otvoren
    // zbog drugih; bez ovog filtera bi kreator zauvek video već zatvoren nalog i
    // ne bi mogao da ga skloni. Zadržavamo red kad: (a) radnik ima svoju otvorenu
    // sesiju (aktivno radi), ILI (b) nijedan DRUGI radnik nema otvorenu sesiju
    // (čisto vlasništvo — jednosken/ispod-plana red se i dalje zatvara iz liste,
    // običan nalog netaknut).
    const visibleRows = rows.filter(
      (r) => openSessionIds.has(r.id) || (othersOpenByRow.get(r.id) ?? 0) === 0,
    );

    // `hasOpenSession` dolazi iz već učitanog skupa otvorenih sesija (gore) —
    // bez drugog upita ka work_time_entries.
    const triples = visibleRows.map((r) => ({
      projectId: r.projectId,
      identNumber: r.identNumber,
      variant: r.variant,
    }));
    const [ops, planned, drawings, cumulative] = await Promise.all([
      this.resolveOperationsByCode(visibleRows.map((r) => r.workCenterCode)),
      this.resolvePlannedByTriple(triples),
      this.resolveDrawingByTriple(triples),
      this.resolveCumulativeByOperation(visibleRows),
    ]);

    const data = visibleRows.map((r) => {
      const key = `${r.projectId}|${r.identNumber}|${r.variant}`;
      return {
        ...r,
        operation: ops.get(r.workCenterCode) ?? null,
        plannedPieces: planned.get(key) ?? null,
        // Kumulativ CELE operacije (svi redovi te trojke+op+RC), ne samo ovog reda:
        // FIX A pri nastavku rada otvara NOV red, pa `pieceCount` reda ume da bude
        // manji od stvarno otkucanog. Kiosk po ovome odlučuje da li pita „gotova?".
        cumulativePieces:
          cumulative.get(
            `${r.projectId}|${r.identNumber}|${r.variant}|${r.operationNumber}|${r.workCenterCode}`,
          ) ?? r.pieceCount,
        // Crtež RN-a + hasPdf za „Otvori PDF" dugme (reuse resolveCardDrawing);
        // null kad RN/crtež ne postoji.
        drawing: drawings.get(key) ?? null,
        hasOpenSession: openSessionIds.has(r.id),
        othersOpenCount: othersOpenByRow.get(r.id) ?? 0,
      };
    });
    return { data, meta: { workerId, workerCard } };
  }

  /**
   * Batch: trojka → crtež RN-a (`{ id, hasPdf }`) za „Otvori PDF" dugme u „Moji
   * otvoreni". RN je jedinstven po trojci (uq constraint na (project_id,
   * ident_number, variant)), pa svaka trojka daje najviše jedan (drawingNumber,
   * revision); crtež + hasPdf razrešava zajednički `resolveCardDrawing` (isti kao u
   * `card()`), keširan po (broj, revizija) da se više trojki istog crteža ne
   * razrešava dvaput. null kad RN/crtež ne postoji (skalarni upiti, bez required JOIN-a).
   */
  private async resolveDrawingByTriple(
    triples: { projectId: number; identNumber: string; variant: number }[],
  ): Promise<Map<string, CardDrawingRef | null>> {
    const map = new Map<string, CardDrawingRef | null>();
    const keys = new Set(
      triples.map((t) => `${t.projectId}|${t.identNumber}|${t.variant}`),
    );
    if (!keys.size) return map;
    const idents = [...new Set(triples.map((t) => t.identNumber))];
    const wos = await this.prisma.workOrder.findMany({
      where: { identNumber: { in: idents } },
      select: {
        projectId: true,
        identNumber: true,
        variant: true,
        drawingNumber: true,
        revision: true,
      },
    });
    // Trojka → (drawingNumber, revision) sa RN-a; prvi red po ključu (trojka je jedinstvena).
    const refByKey = new Map<
      string,
      { drawingNumber: string | null; revision: string | null }
    >();
    for (const wo of wos) {
      const key = `${wo.projectId}|${wo.identNumber}|${wo.variant}`;
      if (keys.has(key) && !refByKey.has(key))
        refByKey.set(key, {
          drawingNumber: wo.drawingNumber,
          revision: wo.revision,
        });
    }
    // Keš po (broj, revizija) — više trojki može deliti isti crtež.
    const cache = new Map<string, CardDrawingRef | null>();
    for (const [key, ref] of refByKey) {
      const cacheKey = `${ref.drawingNumber ?? ""}|${ref.revision ?? ""}`;
      let drawing = cache.get(cacheKey);
      if (drawing === undefined) {
        drawing = await this.resolveCardDrawing(
          ref.drawingNumber,
          ref.revision,
        );
        cache.set(cacheKey, drawing);
      }
      map.set(key, drawing);
    }
    return map;
  }

  /**
   * Batch: (trojka + operationNumber + workCenterCode) → KUMULATIV komada na celoj
   * operaciji (`SUM(piece_count)` svih njenih redova, svi kvaliteti). ISTA metrika
   * koju koriste `assertPieceCountWithinPlan` (guard „kucanje preko plana") i FIX A
   * (`belowPlan` u `findOrOpenRoutingTp`) — kiosk mora da pita „gotova?" tačno onda
   * kad sistem operaciju i dalje smatra radnom. Jedan `groupBy` za sve redove liste.
   */
  private async resolveCumulativeByOperation(
    rows: {
      projectId: number;
      identNumber: string;
      variant: number;
      operationNumber: number;
      workCenterCode: string;
    }[],
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (!rows.length) return map;
    const keyOf = (r: {
      projectId: number;
      identNumber: string;
      variant: number;
      operationNumber: number;
      workCenterCode: string;
    }) =>
      `${r.projectId}|${r.identNumber}|${r.variant}|${r.operationNumber}|${r.workCenterCode}`;
    const seen = new Set<string>();
    const or: Prisma.TechProcessWhereInput[] = [];
    for (const r of rows) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.add(k);
      or.push({
        projectId: r.projectId,
        identNumber: r.identNumber,
        variant: r.variant,
        operationNumber: r.operationNumber,
        workCenterCode: r.workCenterCode,
      });
    }
    const groups = await this.prisma.techProcess.groupBy({
      by: [
        "projectId",
        "identNumber",
        "variant",
        "operationNumber",
        "workCenterCode",
      ],
      where: { OR: or },
      _sum: { pieceCount: true },
    });
    for (const g of groups) map.set(keyOf(g), g._sum.pieceCount ?? 0);
    return map;
  }

  /** Batch: trojka → planirano (`work_orders.piece_count`), za prikaz napravljeno/plan. */
  private async resolvePlannedByTriple(
    triples: { projectId: number; identNumber: string; variant: number }[],
  ) {
    const map = new Map<string, number>();
    const keys = new Set(
      triples.map((t) => `${t.projectId}|${t.identNumber}|${t.variant}`),
    );
    if (!keys.size) return map;
    const idents = [...new Set(triples.map((t) => t.identNumber))];
    const wos = await this.prisma.workOrder.findMany({
      where: { identNumber: { in: idents } },
      select: {
        projectId: true,
        identNumber: true,
        variant: true,
        pieceCount: true,
      },
    });
    for (const wo of wos) {
      const key = `${wo.projectId}|${wo.identNumber}|${wo.variant}`;
      if (keys.has(key) && !map.has(key)) map.set(key, wo.pieceCount);
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
    let totalElapsedSecondsRaw = 0;
    let hasElapsed = false;
    let hasElapsedRaw = false;
    let excludedRowCount = 0;
    const opGroups = new Map<string, CardOperationAcc>();
    for (const r of rows) {
      const pieces = r.pieceCount;
      totalPieces += pieces;
      if (r.qualityTypeId === PART_QUALITY.GOOD) piecesByQuality.good += pieces;
      else if (r.qualityTypeId === PART_QUALITY.REWORK)
        piecesByQuality.rework += pieces;
      else if (r.qualityTypeId === PART_QUALITY.SCRAP)
        piecesByQuality.scrap += pieces;
      // HIGIJENA PRIKAZANOG VREMENA (036/26): u zbir ulazi samo prijava koja liči na
      // rad — 1 min ≤ Δ ≤ 24 h (`TP_PRIKAZ_VALIDNA` uz `TP_VALIDNA`, gde piše i zašto
      // se gornja granica prikaza (24 h) razlikuje od granice procene (720 h)).
      // Sirovi zbir se i dalje računa i vraća, a izuzeti redovi se BROJE — UI ispod
      // pločice piše koliko ih je i zašto, da se ništa ne izgubi bez traga.
      const rawSeconds = r.finishedAt
        ? Math.max(0, (r.finishedAt.getTime() - r.enteredAt.getTime()) / 1000)
        : null;
      if (rawSeconds !== null) {
        totalElapsedSecondsRaw += rawSeconds;
        hasElapsedRaw = true;
      }
      const elapsedSeconds =
        rawSeconds !== null &&
        rawSeconds >= TP_PRIKAZ_MIN_SEC &&
        rawSeconds <= TP_PRIKAZ_MAX_SEC
          ? rawSeconds
          : null;
      if (elapsedSeconds !== null) {
        totalElapsedSeconds += elapsedSeconds;
        hasElapsed = true;
      } else if (rawSeconds !== null) {
        excludedRowCount += 1;
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
          excludedRowCount: 0,
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
      } else if (rawSeconds !== null) {
        g.excludedRowCount += 1;
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
      // Izvedeno (kao summary): null dok nijedan red grupe nije zatvoren U OKVIRU
      // higijenskog praga (< 1 min / > 24 h ne ulazi — v. `excludedRowCount`).
      elapsedMinutes: g.hasElapsed ? Math.round(g.elapsedSeconds / 60) : null,
      /** Zatvoreni redovi grupe izuzeti iz vremena (< 1 min ili > 24 h). */
      excludedRowCount: g.excludedRowCount,
    }));

    // HITNO (Miljan t.10) + routing kartice: RN je jedinstven po trojci (uq
    // constraint na (project_id, ident_number, variant)), pa isti red daje i HITNO
    // flag (preko primopredaje) i id za routing operacija. Najstariji RN = original.
    const cardWorkOrder = await this.prisma.workOrder.findFirst({
      where: { projectId, identNumber, variant },
      select: {
        id: true,
        drawingHandoverId: true,
        drawingNumber: true,
        revision: true,
      },
      orderBy: { id: "asc" },
    });
    const cardHandover =
      cardWorkOrder && cardWorkOrder.drawingHandoverId > 0
        ? await this.prisma.drawingHandover.findUnique({
            where: { id: cardWorkOrder.drawingHandoverId },
            select: { isUrgent: true },
          })
        : null;

    // Routing tekućeg RN-a: SVE operacije tehnološkog postupka iz
    // work_order_operations — i one bez ijednog kucanja (paritet QBigTehn „Kartica
    // tehnološkog postupka": npr. međufazna/završna kontrola su prazne dok se ne
    // otkucaju). UI ih prikazuje kao prazne grupe. Naziv RC-a batch-resolve (orphan
    // RC → null, bez required JOIN-a). Postojeća polja (rows/operations) se ne diraju.
    const routingRows = cardWorkOrder
      ? await this.prisma.workOrderOperation.findMany({
          where: { workOrderId: cardWorkOrder.id },
          orderBy: { operationNumber: "asc" },
          select: { operationNumber: true, workCenterCode: true },
        })
      : [];
    const routingOps = await this.resolveOperationsByCode(
      routingRows.map((r) => r.workCenterCode),
    );
    const routing = routingRows.map((r) => ({
      operationNumber: r.operationNumber,
      workCenterCode: r.workCenterCode,
      workCenterName: routingOps.get(r.workCenterCode)?.workCenterName ?? null,
    }));

    // Crtež RN-a za „Otvori PDF" dugme (Miljan t.6): id crteža + da li postoji PDF.
    // null kad RN/crtež ne postoji. Batch-safe (skalarni upiti, bez required JOIN-a).
    const drawing = cardWorkOrder
      ? await this.resolveCardDrawing(
          cardWorkOrder.drawingNumber,
          cardWorkOrder.revision,
        )
      : null;

    const data = {
      projectId,
      identNumber,
      variant,
      isUrgent: cardHandover?.isUrgent ?? false,
      // Crtež + hasPdf za „Otvori PDF" (null kad RN/crtež ne postoji).
      drawing,
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
        // Sabiraju se SAMO prijave koje liče na rad (1 min ≤ Δ ≤ 24 h); ostale se
        // broje u `excludedRowCount` i UI ih izričito pominje ispod pločice.
        totalElapsedMinutes: hasElapsed
          ? Math.round(totalElapsedSeconds / 60)
          : null,
        /** Nefiltrirani zbir — za dijagnostiku „gde je nestalo 275 h" (036/26). */
        totalElapsedMinutesRaw: hasElapsedRaw
          ? Math.round(totalElapsedSecondsRaw / 60)
          : null,
        /** Broj zatvorenih prijava izuzetih iz zbira (< 1 min ili > 24 h). */
        excludedRowCount,
      },
      operations,
      // Routing RN-a — SVE operacije postupka (i neotkucane); UI merge-uje sa `operations`.
      routing,
      rows: rows.map((r) => ({
        ...r,
        worker: workers.get(r.workerId) ?? null,
        operation: ops.get(r.workCenterCode) ?? null,
        qualityType: quals.get(r.qualityTypeId) ?? null,
      })),
    };
    return { data };
  }

  /**
   * Crtež RN-a za „Otvori PDF" dugme kartice TP: nađi `drawings` red po
   * (drawingNumber, revision) sa RN-a; ako tačna revizija ne postoji, uzmi red
   * NAJVIŠE revizije tog `drawingNumber`. `hasPdf` = postoji `drawing_pdfs` red
   * (drawing_number, revision NAĐENOG reda) sa `pdf_binary IS NOT NULL` (sam binarni
   * sadržaj se NE učitava). null kad nema broja crteža ni odgovarajućeg reda.
   * Skalarni upiti (bez required JOIN-a) — legacy orphan reference ne obara odgovor.
   */
  private async resolveCardDrawing(
    drawingNumber: string | null | undefined,
    revision: string | null | undefined,
  ): Promise<CardDrawingRef | null> {
    const num = (drawingNumber ?? "").trim();
    if (!num) return null;
    const rev = (revision ?? "").trim();
    const select = { id: true, drawingNumber: true, revision: true };
    // Najviša revizija tog broja (SQL string MAX semantika, kao PDM uvoz) — služi
    // i kao fallback red i za poređenje „postoji novija revizija".
    const latest = await this.prisma.drawing.findFirst({
      where: { drawingNumber: num },
      orderBy: { revision: "desc" },
      select,
    });
    // Tačna (drawingNumber, revision) sa RN-a; ako je nema, koristi najviši red.
    const exact = rev
      ? await this.prisma.drawing.findFirst({
          where: { drawingNumber: num, revision: rev },
          select,
        })
      : null;
    const drawing = exact ?? latest;
    if (!drawing) return null;
    const pdf = await this.prisma.drawingPdf.findFirst({
      where: {
        drawingNumber: drawing.drawingNumber,
        revision: drawing.revision,
        pdfBinary: { not: null },
      },
      // Ključ, ne binarni sadržaj — hasPdf je puko postojanje reda.
      select: { drawingNumber: true },
    });
    // „Zastareo" = RN ima reviziju, postoji novija revizija tog crteža u bazi
    // (npr. došla novim XML-om/izmenom). Normalizacija prazno→"A", uppercase.
    const norm = (r: string | null | undefined) =>
      (r ?? "").trim().toUpperCase() || "A";
    const latestRevision = latest?.revision ?? null;
    const revisionStale =
      !!rev && latestRevision != null && norm(latestRevision) > norm(rev);
    return {
      id: drawing.id,
      hasPdf: !!pdf,
      revision: rev || null,
      latestRevision,
      revisionStale,
    };
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
   *
   * VREME prolazi isti higijenski prag kao kartica RN-a (`TP_PRIKAZ_VALIDNA`,
   * 036/26): u zbir ulaze samo prijave od 1 min do 24 h; izuzete se BROJE
   * (`excludedRowCount`), ne gutaju. Komadi i brojevi prijava se NE filtriraju —
   * zaboravljena prijava je i dalje evidentiran rad, samo joj trajanje nije merodavno.
   */
  async workerPerformance(query: WorkerPerformanceQuery) {
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");

    const conds: Prisma.Sql[] = [];
    if (from) conds.push(Prisma.sql`tp.entered_at >= ${from}`);
    if (to) conds.push(Prisma.sql`tp.entered_at < ${to}`);
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;

    // Vreme se sabira po ISTOM higijenskom pragu kao kartica RN-a (036/26): inače
    // tab „Učinak" protivreči pločici „UKUPNO VREME" na kartici — jedna zaboravljena
    // prijava (270 h) tamo napravi radnika sa nemogućim učinkom.
    const rows = await this.prisma.$queryRaw<WorkerPerfRaw[]>(Prisma.sql`
      SELECT tp.worker_id,
             (COUNT(*))::int AS process_count,
             (COUNT(*) FILTER (WHERE COALESCE(tp.is_process_finished, false)))::int AS finished_count,
             COALESCE(SUM(tp.piece_count), 0)::int AS total_pieces,
             COALESCE(SUM(tp.piece_count) FILTER (WHERE tp.quality_type_id = ${PART_QUALITY.GOOD}), 0)::int AS good_pieces,
             COALESCE(SUM(tp.piece_count) FILTER (WHERE tp.quality_type_id = ${PART_QUALITY.REWORK}), 0)::int AS rework_pieces,
             COALESCE(SUM(tp.piece_count) FILTER (WHERE tp.quality_type_id = ${PART_QUALITY.SCRAP}), 0)::int AS scrap_pieces,
             COALESCE(SUM(EXTRACT(EPOCH FROM (tp.finished_at - tp.entered_at)))
                      FILTER (WHERE ${TP_PRIKAZ_VALIDNA}), 0)::float8 AS total_elapsed_seconds,
             (COUNT(*) FILTER (WHERE tp.finished_at IS NOT NULL
                                 AND NOT (${TP_PRIKAZ_VALIDNA})))::int AS excluded_row_count
      FROM tech_processes tp
      ${whereSql}
      GROUP BY tp.worker_id
      ORDER BY total_pieces DESC, tp.worker_id ASC
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
      /** Koliko prijava radnika nije ušlo u vreme (< 1 min ili > 24 h). */
      excludedRowCount: r.excluded_row_count,
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
   * „Pregled RN — statusi delova" (tab „Gotovost RN"): planirano vs napravljeno + procenat.
   * „Napravljeno" = DOBAR komadi (kvalitet 0) — samo dobar broji za pokriće plana
   * (spec §3, migration/15 §5). Endpoint živi u tech-processes kontroleru (ne dira
   * se work-orders folder).
   *
   * DVE RAZLIČITE MERE, NAMERNO (obe ispravke 036/26):
   *
   * A) `completionPercent` = KOLIKO JE POSLA URAĐENO = MAX od dve evidencije:
   *    ruting `AVG(LEAST(done / plan, 1))` preko operacija bez `without_process`
   *    (PUT) i overa `madeGood / plan` sa završne kontrole (ISHOD). Overa je jača:
   *    overen nalog je 100% i kad međufaze nikad nisu kucane (legacy). NULL ratio
   *    (nema plana / nema rutinga) → ostaje sama overa iz (B).
   * B) `madeGoodPieces` / `isCompleted` / `completedAt` = OVERA GOTOVOSTI:
   *      1. ruting ima ZAVRŠNU KONTROLU (`significant_for_finishing`) → napravljeno =
   *         zbir DOBRIH I ZAVRŠENIH komada otkucanih na njoj. Isti kanon kao
   *         `markWorkOrderIfComplete` (koji diže `work_orders.status`) i kao „gotovost"
   *         u pracenje-read.service.ts, pa se tri prikaza ne mogu razići.
   *      2. ruting nema završnu kontrolu → USKO GRLO: najmanje urađena operacija.
   *      3. nema rutinga → 0 (nema se šta meriti; ne izmišlja se gotovost).
   *
   * ISTORIJA GREŠAKA (obe iz iste prijave 036/26, crtež 1138882, RN 9400/2/380 —
   * 14 operacija rutinga, 8 otkucanih, ZAVRŠNA KONTROLA neotkucana):
   *   • PRE 28.07: gotovost je padala na `MAX(piece_count)` preko BILO KOJE operacije
   *     kad završna kontrola nije otkucana → jedna operacija u punom lotu dizala je
   *     nalog na 100% (lažnih ~10.200 od 23.700 naloga „100%").
   *   • POSLE 28.07: gotovost je bila SAMO završna kontrola → isti taj nalog pisao je
   *     0% uz kolonu „Operacije 8/14". Ista populacija (10.879 naloga na produ) samo
   *     je prešla iz jednog binarnog ekstrema u drugi.
   *   • ZAMKA TREĆEG KRUGA (uhvaćena u reviziji, nije stigla na produ): sam ruting bi
   *     11.493 od 13.707 OVERENIH naloga spustio ispod 100% uz zeleni bedž „Gotovo".
   *     Zato MAX(ruting, overa), a ne ruting sam.
   * Procenat sada MERI URAĐENO (61% za 1138882), a status i dalje traži overu.
   * `completedAt` (zahtev 023/26) = datum realizacije RN-a; vidi SQL komentar dole.
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
    if (query.q?.trim()) {
      const like = `%${query.q.trim()}%`;
      // A4: uz ident/naziv/crtež contains, uključi i RN-ove iz NACRTA i puštene
      // DELOVE SKLOPA (ista ekspanzija kao `list()`) preko `wo.id = ANY(...)`.
      const extraIds = await this.expandSearchWorkOrderIds(query.q.trim());
      const orParts: Prisma.Sql[] = [
        Prisma.sql`wo.ident_number ILIKE ${like}`,
        Prisma.sql`wo.part_name ILIKE ${like}`,
        Prisma.sql`wo.drawing_number ILIKE ${like}`,
      ];
      if (extraIds.length)
        orParts.push(Prisma.sql`wo.id = ANY(${extraIds}::int[])`);
      conds.push(Prisma.sql`(${Prisma.join(orParts, " OR ")})`);
    }
    const whereSql = conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<RnProgressRaw[]>(Prisma.sql`
      SELECT wo.id, wo.project_id, wo.ident_number, wo.variant,
             wo.part_name, wo.drawing_number, wo.piece_count AS planned,
             wo.production_deadline, wo.handover_status_id, wo.worker_id,
             -- (1) Koliko ZAVRŠNIH kontrola RUTING naloga uopšte ima. Ruting je
             -- work_order_operations (isti izvor koji tab „Kucanja" prikazuje kroz
             -- /card), a NE skup otkucanih redova — nalog bez ijednog kucanja i dalje
             -- ima svoje operacije, pa se zna da NIJE gotov.
             COALESCE((SELECT COUNT(*)
                         FROM work_order_operations op
                         JOIN operations o ON o.work_center_code = op.work_center_code
                        WHERE op.work_order_id = wo.id
                          AND COALESCE(o.significant_for_finishing, false) = true), 0)::int AS final_op_count,
             -- (2) „Napravljeno" = DOBRI I ZAVRŠENI komadi otkucani NA završnoj kontroli.
             -- Kanon „RN završen" (markWorkOrderIfComplete, migration/15 §5; isti kanon u
             -- pracenje-read.service.ts „finding #3"): završnu kontrolu prolazi samo dobar
             -- komad, i to zatvorenim kucanjem. Kucanja se vezuju preko work_order_id +
             -- operacija (idx_tp_work_order), ne preko trojke — trojka ne razlikuje operacije.
             COALESCE((SELECT SUM(t.piece_count)
                         FROM work_order_operations op
                         JOIN operations o ON o.work_center_code = op.work_center_code
                         JOIN tech_processes t
                           ON t.work_order_id = op.work_order_id
                          AND t.operation_number = op.operation_number
                          AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
                        WHERE op.work_order_id = wo.id
                          AND COALESCE(o.significant_for_finishing, false) = true
                          AND t.quality_type_id = ${PART_QUALITY.GOOD}
                          AND COALESCE(t.is_process_finished, false) = true), 0)::int AS made_good_final,
             -- (3) USKO GRLO = najslabija operacija rutinga (MIN, ne MAX!). Koristi se samo
             -- kad ruting NEMA završnu kontrolu — tada nema ko da „overi" količinu, pa je
             -- jedina poštena mera ona operacija koja je najmanje urađena. without_process
             -- operacije (CAM programiranje, opšti nalog) se izuzimaju: po prirodi se ne
             -- kucaju po komadu (na produ 52 od 1516 imaju ijedno kucanje).
             COALESCE((SELECT MIN(x.done) FROM (
                         SELECT COALESCE((SELECT SUM(t.piece_count)
                                            FROM tech_processes t
                                           WHERE t.work_order_id = op.work_order_id
                                             AND t.operation_number = op.operation_number
                                             AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
                                             AND t.quality_type_id = ${PART_QUALITY.GOOD}), 0) AS done
                           FROM work_order_operations op
                           LEFT JOIN operations o ON o.work_center_code = op.work_center_code
                          WHERE op.work_order_id = wo.id
                            AND COALESCE(o.without_process, false) = false
                       ) x), 0)::int AS made_good_bottleneck,
             COALESCE((SELECT COUNT(*)
                         FROM work_order_operations op
                         LEFT JOIN operations o ON o.work_center_code = op.work_center_code
                        WHERE op.work_order_id = wo.id
                          AND COALESCE(o.without_process, false) = false), 0)::int AS routing_op_count,
             -- Koliko operacija rutinga je otkucano u PUNOJ količini — „5/15 operacija" za UI.
             -- wo.piece_count je u WHERE-u spoljnog COUNT-a, NIKAD u FILTER-u agregata:
             -- outer-only referenca u agregatu diže PG 42803 (prod incident 19.07.2026,
             -- isti zapis u pracenje-read.service.ts).
             COALESCE((SELECT COUNT(*) FROM (
                         SELECT COALESCE((SELECT SUM(t.piece_count)
                                            FROM tech_processes t
                                           WHERE t.work_order_id = op.work_order_id
                                             AND t.operation_number = op.operation_number
                                             AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
                                             AND t.quality_type_id = ${PART_QUALITY.GOOD}), 0) AS done
                           FROM work_order_operations op
                           LEFT JOIN operations o ON o.work_center_code = op.work_center_code
                          WHERE op.work_order_id = wo.id
                            AND COALESCE(o.without_process, false) = false
                       ) x WHERE x.done >= wo.piece_count), 0)::int AS routing_ops_completed,
             -- (5) NAPREDAK KROZ RUTING = prosečan udeo urađenog po operacijama
             -- rutinga: AVG(LEAST(done / plan, 1)). Ovo je MERA GOTOVOSTI (druga
             -- prijava 036/26): nalog sa 8 od 14 otkucanih operacija nije ni 0% ni
             -- 100% — on je „na 61%". Isti oblik kao op_pct u
             -- pracenje-read.service.ts (LATERAL opr), samo MIN→AVG.
             -- wo.piece_count (outer referenca) je u WHERE-u istog nivoa na kom stoji
             -- agregat, NIKAD u FILTER-u/argumentu bez inner promenljive: agregat čiji
             -- argumenti nose samo outer promenljive pripada SPOLJNOM nivou upita i
             -- diže PG 42803 (prod incident 19.07.2026). WHERE ujedno garantuje da
             -- deljenje nikad ne deli nulom; prazan skup → NULL (nema rutinga).
             -- without_process operacije se izuzimaju — isto kao usko grlo (3).
             (SELECT AVG(LEAST(x.done::numeric / wo.piece_count, 1)) FROM (
                         SELECT COALESCE((SELECT SUM(t.piece_count)
                                            FROM tech_processes t
                                           WHERE t.work_order_id = op.work_order_id
                                             AND t.operation_number = op.operation_number
                                             AND t.work_center_code IS NOT DISTINCT FROM op.work_center_code
                                             AND t.quality_type_id = ${PART_QUALITY.GOOD}), 0) AS done
                           FROM work_order_operations op
                           LEFT JOIN operations o ON o.work_center_code = op.work_center_code
                          WHERE op.work_order_id = wo.id
                            AND COALESCE(o.without_process, false) = false
                       ) x WHERE wo.piece_count > 0)::float8 AS routing_progress_ratio,
             COALESCE((SELECT COUNT(*) FROM tech_processes tp
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant), 0)::int AS operation_count,
             COALESCE((SELECT COUNT(*) FROM tech_processes tp
                       WHERE tp.project_id = wo.project_id
                         AND tp.ident_number = wo.ident_number
                         AND tp.variant = wo.variant
                         AND COALESCE(tp.is_process_finished, false) = true), 0)::int AS finished_operation_count,
             -- „Datum realizacije" (zahtev 023/26): poslednji DOBAR završetak na RN-u =
             -- max(tech_processes.finished_at) FILTER (is_process_finished AND GOOD). Isti
             -- kanon kao last_completed_at u pracenje-read (docx §4.9 „datum završetka
             -- operacije"), samo rolovan sa operacije na ceo RN — poslednja zatvorena
             -- operacija JESTE trenutak kad je nalog realizovan. NULL dok nijedna operacija
             -- nije zatvorena sa dobrim komadima. work_orders nema kolonu datuma gotovosti.
             (SELECT MAX(tp.finished_at) FROM tech_processes tp
               WHERE tp.project_id = wo.project_id
                 AND tp.ident_number = wo.ident_number
                 AND tp.variant = wo.variant
                 AND COALESCE(tp.is_process_finished, false) = true
                 AND tp.quality_type_id = ${PART_QUALITY.GOOD}) AS last_completed_at
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
      // Gotovost se meri ZAVRŠNOM KONTROLOM naloga (kanon markWorkOrderIfComplete);
      // ako je ruting nema, pada na USKO GRLO (najslabija operacija). Nikad na „bilo
      // koja operacija" — to je bila greška zbog koje je deo sa 5/15 otkucanih
      // operacija pisao 100% (zahtev 036/26).
      const hasFinalOp = r.final_op_count > 0;
      const madeGood = hasFinalOp ? r.made_good_final : r.made_good_bottleneck;
      const madeGoodSource: "zavrsna-kontrola" | "usko-grlo" | "nema-rutinga" =
        hasFinalOp
          ? "zavrsna-kontrola"
          : r.routing_op_count > 0
            ? "usko-grlo"
            : "nema-rutinga";
      const planned = r.planned;
      const cappedMade = Math.min(madeGood, planned);
      // GOTOVOST = MAX(napredak kroz ruting, overa završnom kontrolom).
      //
      // Dve evidencije, a ne jedna: kucanja po operacijama pokazuju PUT, završna
      // kontrola pokazuje ISHOD. Overa je JAČA evidencija — ako je kontrolor
      // otkucao pun lot na završnoj kontroli, posao JESTE urađen, bez obzira na to
      // šta međufaze pokazuju. Zato se uzima veći od dva broja:
      //   • Pavlov slučaj (ruting 61% > overa 0%)            → 61% (prijava 036/26),
      //   • legacy nalog (overa 100% > ruting 57%)           → 100%,
      //   • delimična overa (overa 50% > ruting 30%)         → 50%.
      //
      // Bez MAX-a bi 11.493 od 13.707 OVERENIH naloga dobilo traku ispod 100%
      // (prosek 57%, njih 3.139 ispod 50%) tik uz zeleni bedž „Gotovo" — i to na
      // prvim stranama taba, jer sort ide po roku uzlazno pa su najstariji (dakle
      // gotovi, legacy) prvi. Uzrok su legacy nalozi na kojima su kucane samo
      // završne kontrole, a međufaze nikad; ratio ih meri kao „nezapočete".
      //
      // Kanon „napravljeno" se NE menja: madeGood/isCompleted/completedAt i dalje
      // isključivo iz završne kontrole (usko grlo kad je ruting nema), pa
      // markWorkOrderIfComplete i work_orders.status rade isto kao pre.
      // Ratio je NULL kad nema plana (piece_count = 0) ili nema rutinga — tada
      // ostaje sama overa (bez rutinga ratio i usko grlo ionako daju isto).
      const ratio = r.routing_progress_ratio;
      const rutingPercent =
        ratio === null ? null : Math.round(Math.min(Math.max(ratio, 0), 1) * 100);
      const overaPercent =
        planned > 0 ? Math.round((cappedMade / planned) * 100) : null;
      const completionPercent =
        rutingPercent === null
          ? overaPercent
          : overaPercent === null
            ? rutingPercent
            : Math.max(rutingPercent, overaPercent);
      // Koja strana je dala broj (na izjednačenju je svejedno — nose istu tvrdnju).
      const completionSource: "ruting" | "zavrsna-kontrola" =
        rutingPercent !== null &&
        (overaPercent === null || rutingPercent >= overaPercent)
          ? "ruting"
          : "zavrsna-kontrola";
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
        madeGoodSource,
        operationCount: r.operation_count,
        finishedOperationCount: r.finished_operation_count,
        // Ruting naloga (isto što tab „Kucanja" vidi kroz /card) — da UI može da
        // pokaže „X/Y operacija" i da 100% nikad ne protivreči listi kucanja.
        routingOperationCount: r.routing_op_count,
        routingOperationsCompleted: r.routing_ops_completed,
        completionPercent,
        completionSource,
        isCompleted: planned > 0 && madeGood >= planned,
        completedAt: r.last_completed_at,
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
        select: {
          workCenterName: true,
          significantForFinishing: true,
          withoutProcess: true,
        },
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
                // Opšti nalog (bez postupka): kiosk zna da je operacija UVEK
                // otvorena (nema „Zatvori operaciju"), scan/start/stop uvek prolaze.
                withoutProcess: op.withoutProcess === true,
              }
            : null,
        },
      };
    }

    // nalog → razreši RN + broj operacija u tehnološkom postupku + routing.
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07); kiosk
    // dobija NORMALIZOVANA polja (realan projectId) da nastavak toka radi.
    const { identNumber, variant } = decoded.fields;
    let projectId: number;
    try {
      projectId = await this.resolveScanProjectId(
        this.prisma,
        decoded.fields.projectId,
        identNumber,
      );
    } catch {
      // Decode je PREVIEW ruta — nepoznat/dvosmislen ident ne baca (kiosk i za
      // pun barkod prikazuje „Nalog nije nađen" i dozvoljava nastavak).
      projectId = decoded.fields.projectId;
    }
    decoded.fields.projectId = projectId;
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

  /**
   * TVRDI guard „kucanje preko plana" (Nenad 16.07): prijava rada (scan/stopWork)
   * NE sme da premaši plan RN-a — BEZ potvrde (za razliku od kontrole, koja zadržava
   * `confirmOvershoot`). Kumulativ se računa ISTO kao u `control()`: `_sum(pieceCount)`
   * SVIH redova te operacije (trojka + operationNumber + workCenterCode; svi kvaliteti,
   * svi redovi — uključuje i tekući `tp` red) + `newPieces` iz ove prijave. Kad je plan
   * poznat (`planned > 0`) i `cumulative > planned` → 422; inače prolazi.
   *
   * Guard se poziva SAMO za unos komada — otvaranje redova (FIX A „ispod-plan uvek
   * radna") ostaje netaknuto. `newPieces = 0` (borverk „Kraj rada" bez komada) uvek
   * prolazi. OPŠTI NALOG (withoutProcess) nema plan → pozivalac preskoči guard.
   */
  private async assertPieceCountWithinPlan(
    tx: Prisma.TransactionClient,
    keys: {
      projectId: number;
      identNumber: string;
      variant: number;
      operationNumber: number;
      workCenterCode: string;
    },
    planned: number | null,
    newPieces: number,
  ): Promise<void> {
    // Bez plana ili 0 komada → nema šta da se premaši (0 kom = samo vreme).
    if (planned === null || planned <= 0 || newPieces <= 0) return;
    const sumAgg = await tx.techProcess.aggregate({
      _sum: { pieceCount: true },
      where: {
        projectId: keys.projectId,
        identNumber: keys.identNumber,
        variant: keys.variant,
        operationNumber: keys.operationNumber,
        workCenterCode: keys.workCenterCode,
      },
    });
    const existingSum = sumAgg._sum.pieceCount ?? 0;
    const cumulative = existingSum + newPieces;
    if (cumulative > planned)
      throw new UnprocessableEntityException(
        `Uneto (${cumulative} od toga novo ${newPieces}) premašuje planirano (${planned}) — kucanje preko plana nije dozvoljeno.`,
      );
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

    const { identNumber } = order.fields;
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07).
    const projectId = await this.resolveScanProjectId(
      this.prisma,
      order.fields.projectId,
      identNumber,
    );
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
        worker?.id ?? 0,
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

      // A1 TVRDI guard „kucanje preko plana" (Nenad 16.07): prijava rada ne sme da
      // premaši plan RN-a — BEZ potvrde. OPŠTI NALOG (withoutProcess) nema plan →
      // preskoči (uvek otvoren za prijavu; findOrOpenRoutingTp već otvara nov red).
      const opDef = await tx.operation.findUnique({
        where: { workCenterCode: tp.workCenterCode },
        select: { withoutProcess: true },
      });
      if (opDef?.withoutProcess !== true)
        await this.assertPieceCountWithinPlan(
          tx,
          {
            projectId,
            identNumber,
            variant: tp.variant,
            operationNumber: tp.operationNumber,
            workCenterCode: tp.workCenterCode,
          },
          planned,
          dto.pieceCount,
        );

      // Verzioni guard (UPOZORENJE, ne blokada — MODULE_SPEC_stampa §5): posle D5
      // klona tekući RN ima veću varijantu od one na starom otisku. `tp.variant` je
      // pinovan na tekući RN (findOrOpenRoutingTp), pa manja varijanta sa otiska =
      // radnik je uzeo STAR odštampan nalog. Rad se svejedno evidentira na tekuću
      // varijantu, uz upozorenje.
      const currentVariant = tp.variant;
      const staleWorkOrder = scannedVariant < currentVariant;

      // Prijava rada = akumulacija napravljenih komada na redu operacije.
      // BUG-P1-01 Faza 1 (lost update): red je deljen po (projectId, identNumber,
      // variant, operationNumber, workCenterCode) → dve paralelne prijave čitaju
      // isto `tp.pieceCount` i druga pregazi prvu. Zato akumuliramo ATOMSKI preko
      // Prisma `{ increment }`, a odluku `reachedPlan`/zatvaranje donosimo iz
      // VRAĆENE post-inkrement vrednosti (`updated.pieceCount`), ne iz zastarelog
      // `tp.pieceCount + n`. `assertPieceCountWithinPlan` (gore) ostaje pre inkrementa.
      let updated = await tx.techProcess.update({
        where: { id: tp.id },
        data: {
          pieceCount: { increment: dto.pieceCount },
          // Audit: radnik koji je prijavio rad (ID kartica) — legacy `SifraRadnika`.
          ...(worker ? { workerId: worker.id } : {}),
          // K0.1: napomena uz prijavu rada (kumulativni red — poslednja prepisuje).
          ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
        },
      });

      // 🔴 F1 (05.08.2026): kumulativ CELE operacije, ne jednog reda — isto kao u
      // `accumulateStopWork`. `updated.pieceCount` je samo TAJ red, pa je posle
      // FIX A razbijanja kucanja na više redova („brza prijava" na svež red)
      // operacija sa dostignutim planom ostajala OTVORENA, a dalje kucanje padalo
      // na 422 „preko plana" — red bez izlaza. Zbir se čita posle inkrementa, u
      // istoj transakciji, istim ključem kao `assertPieceCountWithinPlan`.
      const scanCumAgg = await tx.techProcess.aggregate({
        _sum: { pieceCount: true },
        where: {
          projectId,
          identNumber,
          variant: tp.variant,
          operationNumber: tp.operationNumber,
          workCenterCode: tp.workCenterCode,
        },
      });
      const cumulativePieces = scanCumAgg._sum.pieceCount ?? updated.pieceCount;
      const reachedPlan =
        planned !== null && planned > 0 && cumulativePieces >= planned;

      // Ako je plan dostignut → drugi mali update u ISTOJ transakciji za zatvaranje.
      // (Zadržavamo oblik odgovora: `updated` nosi finalno stanje reda.)
      if (reachedPlan)
        updated = await tx.techProcess.update({
          where: { id: tp.id },
          data: { isProcessFinished: true, finishedAt: new Date() },
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
        cumulativePieces,
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
        // Kumulativ CELE operacije posle prijave (isti broj koji je odlučio o
        // zatvaranju) — kiosk njime crta „Napravljeno x/y".
        cumulativePieces: result.cumulativePieces,
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
      // OPŠTI NALOG (Operation.withoutProcess=true): uvek je otvoren za prijavu
      // rada — zatvaranje je zabranjeno (zatvoren red bi blokirao dalje kucanje 422).
      const opDef = await tx.operation.findUnique({
        where: { workCenterCode: tp.workCenterCode },
        select: { withoutProcess: true },
      });
      if (opDef?.withoutProcess === true)
        throw new UnprocessableEntityException(
          "Opšti nalog (bez postupka) se ne zatvara — uvek je otvoren za prijavu rada.",
        );
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

      // 🔴 A2 provera količina: premašaj plana → 422 (ne zatvara). TVRDO (Nenad 16.07):
      // „Zatvori operaciju" (finish) više NEMA `confirmOvershoot` bypass — kucanje preko
      // plana nije dozvoljeno. JEDINO kontrola (control) zadržava potvrdu (strugar +1-2).
      if (planned !== null && effectivePieces > planned)
        throw new UnprocessableEntityException(
          `Napravljeno (${effectivePieces}) premašuje planirano (${planned}) — kucanje preko plana nije dozvoljeno.`,
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

      // Higijena (Nenad 2026-07-22): gašenje reda zatvara i SVE otvorene sesije
      // na njemu (deljeni red — bez ovoga tuđe sesije vise do noćnog auto-close-a).
      await tx.workTimeEntry.updateMany({
        where: { techProcessId: id, stoppedAt: null },
        data: {
          stoppedAt: new Date(),
          autoClosed: true,
          note: "operacija zatvorena — sesija automatski završena",
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
   *
   * VREME nosi isti gornji prag (24 h) kao kartica RN-a i učinak radnika (036/26).
   * Ovde je uticaj mali — zbir ionako pokriva samo `source = 'entry'`
   * (`work_time_entries`, koje imaju auto-close), pa je na produ 15 od 1.330
   * zatvorenih sesija preko 24 h — ali jedna takva sesija dodaje dane „rada" u jedan
   * dan dnevnika. Izuzete sesije se broje (`excludedCount`) i UI ih pominje uz zbir;
   * broj sesija i komadi se NE filtriraju (aktivnost je bila evidentirana).
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
                      FILTER (WHERE source = 'entry' AND stopped_at IS NOT NULL AND stopped_at >= started_at
                                AND stopped_at <= started_at + interval '24 hours'), 0)::float8 AS elapsed_seconds,
             (COUNT(*) FILTER (WHERE source = 'entry' AND stopped_at IS NOT NULL
                                 AND (stopped_at < started_at
                                      OR stopped_at > started_at + interval '24 hours')))::int AS excluded_count,
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
      /** Zatvorene sesije izuzete iz vremena (duže od 24 h / negativno trajanje). */
      excludedCount: r.excluded_count,
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
    const { identNumber } = order.fields;
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07).
    const projectId = await this.resolveScanProjectId(
      this.prisma,
      order.fields.projectId,
      identNumber,
    );
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
        worker.id,
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
    const { identNumber } = order.fields;
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07).
    const projectId = await this.resolveScanProjectId(
      this.prisma,
      order.fields.projectId,
      identNumber,
    );
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
        worker.id,
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

      // AKUMULACIJA (deljeni helper sa `:id/stop-work`): komadi na red operacije +
      // eventualno zatvaranje/skidanje sa prioriteta/„RN završen" — jedna verzija ponašanja.
      // K0.1: napomena se upisuje i na `tech_processes` red (uz sesiju gore).
      const acc = await this.accumulateStopWork(
        tx,
        tp,
        worker.id,
        dto.pieceCount,
        now,
        workOrder,
        false,
        note,
        false,
        // Barkod „Završi rad" do sada NIJE mogao da zatvori operaciju ispod plana
        // (bio je plan-gated). Polje `operacijaGotova` mu daje isti eksplicitni
        // izbor kao „Kraj rada"; bez polja ponašanje je nepromenjeno.
        dto.operacijaGotova,
      );

      return {
        tp: acc.tp,
        session,
        startedAt,
        stoppedAt: now,
        instant: !open,
        workOrder,
        planned: acc.planned,
        reachedPlan: acc.reachedPlan,
        operationClosed: acc.operationClosed,
        cumulativePieces: acc.cumulativePieces,
        prioritized: acc.prioritized,
        workOrderCompleted: acc.workOrderCompleted,
        // Deljeni red — gašenje traženo („Da — gotova je") ali preskočeno jer drugi
        // radnici još imaju otvorene sesije. `accumulateStopWork` ta polja računa i
        // za ovu putanju (`wantsFinish` otključava upit isto kao `fromMyOpen`); do
        // sada su ostajala neiskorišćena, pa je barkod ekran ćutao o razlogu i
        // radnikovo „Da" izgledalo kao da nije ni primljeno. ČISTO PROSLEĐIVANJE —
        // nijedna odluka se ne menja.
        finishSkipped: acc.finishSkipped,
        otherOpenWorkerIds: acc.otherOpenWorkerIds,
        staleWorkOrder: scannedVariant < tp.variant,
        currentVariant: tp.variant,
      };
    });

    const workers = await this.resolveWorkers([
      result.tp.workerId,
      ...result.otherOpenWorkerIds,
    ]);
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
        // Red zatvoren (plan ILI eksplicitno „gotova je") + kumulativ posle prijave.
        operationClosed: result.operationClosed,
        cumulativePieces: result.cumulativePieces,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        workOrder: result.workOrder,
        // Deljeni red (isti oblik kao `:id/stop-work`): gašenje preskočeno + KO još
        // radi. Barkod ekran nema izbor „Zatvori za sve" (ostaje samo u „Mojim
        // otvorenim") — ova polja mu služe SAMO da radniku kaže zašto njegovo „Da —
        // gotova je" nije zatvorilo operaciju.
        finishSkipped: result.finishSkipped,
        otherOpenWorkers: result.otherOpenWorkerIds.map(
          (wid) =>
            workers.get(wid) ?? { id: wid, fullName: null, username: null },
        ),
        staleWorkOrder: result.staleWorkOrder,
        printedVariant: scannedVariant,
        currentVariant: result.currentVariant,
        machineAccessWarning,
      },
    };
  }

  /**
   * `POST /:id/stop-work` — „Kraj rada" iz „Moji otvoreni" (kiosk, #7). Završava RAD
   * po `tech_processes` id-ju, BEZ barkodova (radnik je već identifikovan karticom ili
   * prijavljenim nalogom). Zatvara NJEGOVU otvorenu `work_time_entries` sesiju za taj
   * postupak i akumulira komade na red operacije — ista logika kao `POST /work/stop`
   * (deljeni `accumulateStopWork`). Redovi otvoreni u staroj aplikaciji / jednim
   * skenom NEMAJU otvorenu sesiju: tada se zatvaranje sesije PRESKAČE (session=null,
   * 0 sekundi), a komadi se svejedno akumuliraju — stari 0/1 red (uneto 1 = plan) se
   * tako prirodno zatvara, a nedovršen visered ostaje otvoren.
   * Machine-access provera kao u `stopWork` (enforce → 403, shadow → upozorenje).
   *
   * 🔴 GOTOVOST OPERACIJE (Nenad 2026-08-05): „Kraj rada" VIŠE ne gasi operaciju
   * ispod plana sam od sebe. Kad je kumulativ ispod plana kiosk pita „Otkucao si X
   * od Y. Da li je operacija gotova?" (podrazumevano NE) i šalje `operacijaGotova`.
   * Serversko pravilo je u `accumulateStopWork` — FE-u se ne veruje na reč.
   */
  async stopWorkById(id: number, body: StopWorkByIdBody, user?: AuthUser) {
    this.validateStopWorkById(body);
    const worker = await this.resolveWorkerFromCardOrUser(
      body.workerCard,
      user,
    );

    // Postupak + RC pre transakcije: 404 i machine-access (kao stopWork, pre mutacije).
    const head = await this.prisma.techProcess.findUnique({
      where: { id },
      select: { workCenterCode: true },
    });
    if (!head)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      head.workCenterCode,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // Svež red u transakciji (istovremeni finish ne sme da zatvori dvaput).
      const tp = await tx.techProcess.findUnique({ where: { id } });
      if (!tp)
        throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Operacija (postupak ${tp.id}) je već zatvorena — prijava rada nije moguća.`,
        );

      const workOrder = await this.findWorkOrderByTriple(
        tx,
        tp.projectId,
        tp.identNumber,
        tp.variant,
      );
      const now = new Date();
      const note = body.note?.trim() || null;

      // MOJA otvorena sesija za taj postupak (filter po workerId → tuđa sesija se ne
      // zatvara). Ako je nema (star red / jedan sken u staroj aplikaciji), zatvaranje
      // sesije se PRESKAČE (session=null), a komadi se svejedno akumuliraju ispod.
      const open = await tx.workTimeEntry.findFirst({
        where: { workerId: worker.id, techProcessId: tp.id, stoppedAt: null },
        orderBy: { id: "desc" },
      });
      const session = open
        ? await tx.workTimeEntry.update({
            where: { id: open.id },
            data: { stoppedAt: now, pieceCount: body.pieceCount, note },
          })
        : null;

      const acc = await this.accumulateStopWork(
        tx,
        tp,
        worker.id,
        body.pieceCount,
        now,
        workOrder,
        // Poziv sa „Moji otvoreni" (čita tuđe otvorene sesije; opšti nalog se i
        // dalje čisti bez pitanja).
        true,
        // K0.1: napomena i na `tech_processes` red (uz sesiju gore).
        note,
        body.finishForAll === true,
        // 🔴 Nenad 2026-08-05: ispod plana operacija se gasi SAMO na eksplicitno
        // „Da — gotova je" iz kiosk dijaloga. Bez polja → ostaje otvorena.
        body.operacijaGotova,
      );

      return {
        tp: acc.tp,
        session,
        startedAt: open ? open.startedAt : null,
        stoppedAt: now,
        workOrder,
        planned: acc.planned,
        reachedPlan: acc.reachedPlan,
        operationClosed: acc.operationClosed,
        cumulativePieces: acc.cumulativePieces,
        prioritized: acc.prioritized,
        workOrderCompleted: acc.workOrderCompleted,
        finishSkipped: acc.finishSkipped,
        otherOpenWorkerIds: acc.otherOpenWorkerIds,
      };
    });

    const workers = await this.resolveWorkers([
      result.tp.workerId,
      ...result.otherOpenWorkerIds,
    ]);
    // Null-safe kad nema sesije (star red / jedan sken): startedAt null → 0 sekundi.
    const elapsedSeconds = result.startedAt
      ? Math.max(
          0,
          Math.round(
            (result.stoppedAt.getTime() - result.startedAt.getTime()) / 1000,
          ),
        )
      : 0;
    return {
      data: {
        techProcess: {
          ...result.tp,
          worker: workers.get(result.tp.workerId) ?? null,
        },
        // null kad nema sesije — evidentirani su samo komadi / zatvaranje operacije.
        session: result.session
          ? {
              id: result.session.id,
              startedAt: result.startedAt,
              stoppedAt: result.stoppedAt,
              elapsedSeconds,
              instant: false,
            }
          : null,
        reportedPieces: body.pieceCount,
        plannedPieces: result.planned,
        operationFinished: result.reachedPlan,
        // Red zatvoren (plan ILI eksplicitno „Da — gotova je") + kumulativ posle
        // prijave — kiosk po njima bira poruku i sledeći korak.
        operationClosed: result.operationClosed,
        cumulativePieces: result.cumulativePieces,
        operationsPrioritized: result.prioritized,
        workOrderCompleted: result.workOrderCompleted,
        workOrder: result.workOrder,
        // Deljeni red (Nenad 2026-07-22): gašenje preskočeno — drugi još rade.
        finishSkipped: result.finishSkipped,
        otherOpenWorkers: result.otherOpenWorkerIds.map(
          (wid) =>
            workers.get(wid) ?? { id: wid, fullName: null, username: null },
        ),
        machineAccessWarning,
      },
    };
  }

  /**
   * `POST /:id/dismiss` — „Odustani" iz „Moji otvoreni" (Nenad 17.07). Sklanja SVOJ
   * pogrešno otvoren red BEZ dodavanja komada (redovi otvoreni greškom kroz probu
   * kucanja). Za razliku od „Kraj rada" (stopWorkById) NE akumulira komade.
   *
   * 🔴 NE UPISUJE `is_process_finished` (Nenad 2026-08-05): odustajanje je ČIŠĆENJE
   * GREŠKE, ne završetak operacije — a `bool_or(is_process_finished)` je kanon
   * čitanja u celom modulu, pa je stara verzija tri operacije prijavljivala kao
   * završene bez ijednog komada. Umesto gašenja reda:
   *  - zatvara se eventualna MOJA otvorena sesija (da ne ostane siroče), i
   *  - red se OTKUPLJUJE (`worker_id → 0`) pa nestaje iz „Moji otvoreni" (filter je
   *    `worker_id` ILI moja otvorena sesija), a ostaje OTVOREN i spreman da ga
   *    sledeći sken te operacije preuzme (`findOrOpenRoutingTp` traži upravo otvoren
   *    red te trojke+operacije).
   *
   * 🔴 OTKUP IDE I KAD RED NOSI KOMADE (F4, 05.08.2026). Prva verzija je otkupljivala
   * samo redove sa 0 komada — a proba kucanja po definiciji OSTAVI komade, pa je 60
   * od 113 otvorenih redova na produ ostajalo bez ikakvog izlaza osim laži („Da —
   * gotova je"). Komadi se NE diraju (ostaju kao evidencija na redu i u kumulativu
   * operacije); ispravka pogrešno otkucane količine ide kroz STORNO (`:id/storno`,
   * kontra-red), koji je za to i napravljen.
   *
   * Audit snapshot u audit_log (povratljivo — čuva izvorni `worker_id`). Radnik =
   * kartica ILI prijavljeni nalog (isti izbor kao stopWorkById); machine-access guard.
   */
  async dismissEntry(id: number, body: StopWorkByIdBody, user?: AuthUser) {
    // Dismiss NE nosi pieceCount (ne evidentira komade) — validira samo workerCard/note,
    // ne kroz validateStopWorkById (koji zahteva pieceCount za „Kraj rada").
    if (
      body?.workerCard !== undefined &&
      (typeof body.workerCard !== "string" || !body.workerCard.trim())
    )
      throw new BadRequestException(
        "Polje 'workerCard' mora biti neprazan string (ID kartica).",
      );
    if (
      body?.note !== undefined &&
      (typeof body.note !== "string" || body.note.trim().length > 500)
    )
      throw new BadRequestException(
        "Polje 'note' mora biti string do 500 karaktera.",
      );
    const worker = await this.resolveWorkerFromCardOrUser(
      body.workerCard,
      user,
    );

    const head = await this.prisma.techProcess.findUnique({
      where: { id },
      select: { workCenterCode: true },
    });
    if (!head)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
    const machineAccessWarning = await this.checkMachineAccess(
      worker.id,
      head.workCenterCode,
    );

    const outcome = await this.prisma.$transaction(async (tx) => {
      const tp = await tx.techProcess.findUnique({ where: { id } });
      if (!tp)
        throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
      if (tp.isProcessFinished)
        throw new UnprocessableEntityException(
          `Operacija (postupak ${tp.id}) je već zatvorena.`,
        );

      await tx.auditLog.create({
        data: {
          action: "DISMISS tech-processes (odustani, bez komada)",
          entityType: "tech-processes",
          entityId: String(id),
          beforeData: this.snapshot(tp),
          metadata: {
            byWorkerId: worker.id,
            ...(body.note?.trim() ? { note: body.note.trim() } : {}),
          },
        },
      });

      // Zatvori eventualnu MOJU otvorenu sesiju na tom redu (da ne ostane siroče),
      // BEZ menjanja pieceCount (odustajanje ne evidentira ni vreme ni komade).
      await tx.workTimeEntry.updateMany({
        where: { workerId: worker.id, techProcessId: id, stoppedAt: null },
        data: { stoppedAt: new Date() },
      });

      // Deljeni red (Nenad 2026-07-22): „Odustani" jednog radnika ne dira tuđe
      // učešće — zatvara se samo sopstvena sesija.
      const otherOpen = await tx.workTimeEntry.findFirst({
        where: {
          techProcessId: id,
          stoppedAt: null,
          workerId: { not: worker.id },
        },
        select: { id: true },
      });

      // 🔴 `is_process_finished` se NE dira (v. docblock). Moj red se OTKUPLJUJE
      // (worker_id → 0) da nestane iz „Mojih otvorenih" — bez obzira na komade
      // (F4); komadi ostaju netaknuti, ispravka ide kroz STORNO. Tuđi red se ne
      // dira (nema šta da se skine sa moje liste).
      const released = tp.workerId === worker.id;
      if (released)
        await tx.techProcess.update({ where: { id }, data: { workerId: 0 } });
      return {
        released,
        pieceCountKept: tp.pieceCount,
        othersStillOpen: Boolean(otherOpen),
      };
    });

    return {
      data: {
        id,
        dismissed: true,
        // Red je otkupljen (nestaje iz „Mojih otvorenih"); false = red i nije bio
        // moj (vlasnik je neko drugi), pa nema šta da se skida sa moje liste.
        released: outcome.released,
        // Komadi koji OSTAJU upisani na redu (evidencija) — kiosk to i kaže.
        pieceCountKept: outcome.pieceCountKept,
        // Na operaciji i dalje radi neko drugi (informativno za poruku na kiosku).
        othersStillOpen: outcome.othersStillOpen,
        // Zadržano zbog starijih klijenata: red se od 05.08.2026 NIKAD ne gasi
        // kroz „Odustani", pa je uvek `false`.
        finishSkipped: false,
        machineAccessWarning,
      },
    };
  }

  private validateStopWorkById(body: StopWorkByIdBody): void {
    const errors: string[] = [];
    if (
      body?.workerCard !== undefined &&
      (typeof body.workerCard !== "string" || !body.workerCard.trim())
    )
      errors.push("Polje 'workerCard' mora biti neprazan string (ID kartica).");
    if (
      typeof body?.pieceCount !== "number" ||
      !Number.isInteger(body.pieceCount) ||
      body.pieceCount < 0
    )
      errors.push(
        "Polje 'pieceCount' mora biti ceo broj ≥ 0 (0 = samo vreme).",
      );
    if (
      body?.note !== undefined &&
      (typeof body.note !== "string" || body.note.trim().length > 500)
    )
      errors.push("Polje 'note' mora biti string do 500 karaktera.");
    if (
      body?.finishForAll !== undefined &&
      typeof body.finishForAll !== "boolean"
    )
      errors.push("Polje 'finishForAll' mora biti boolean.");
    if (
      body?.operacijaGotova !== undefined &&
      typeof body.operacijaGotova !== "boolean"
    )
      errors.push("Polje 'operacijaGotova' mora biti boolean.");
    if (errors.length) throw new BadRequestException(errors);
  }

  /**
   * Zajednička STOP akumulacija (barkod `work/stop` i id-based `:id/stop-work`):
   * upiši komade na red operacije, zatvori operaciju kad je dostignut plan RN-a,
   * skini je sa prioriteta i (ako su sve značajne gotove) označi „RN završen". Jedna
   * verzija ponašanja za oba ulaza — spec traži da se STOP logika ne duplira.
   */
  private async accumulateStopWork(
    tx: Prisma.TransactionClient,
    tp: {
      id: number;
      pieceCount: number;
      operationNumber: number;
      workCenterCode: string;
      workOrderId: number;
      projectId: number;
      identNumber: string;
      variant: number;
    },
    workerId: number,
    pieceCount: number,
    now: Date,
    workOrder: { id: number; pieceCount: number } | null,
    // `true` = poziv iz „Kraj rada" (stopWorkById, „Moji otvoreni"), `false` =
    // barkod STOP sken (stopWork).
    //
    // FIX B (Nenad 2026-07-15) je ovde značio „Kraj rada UVEK zatvara red" i to je
    // OBORENO 2026-08-05 (v. `finishIntent` ispod): radnici su dugme koristili kao
    // „gotov sam za danas", pa je 1.475 operacija sa nepotpunom količinom stajalo
    // kao završeno. Ostaje samo ono što je i dalje tačno:
    //  - OPŠTI NALOG (`withoutProcess`) nema plan i po dizajnu je uvek otvoren —
    //    „Kraj rada" ga i dalje gasi kao ČIŠĆENJE reda (sledeći sken otvara nov,
    //    findOrOpenRoutingTp zatvoren withoutProcess red tretira kao istoriju);
    //  - tuđe otvorene sesije se čitaju samo na ovoj putanji (finishSkipped).
    fromMyOpen = false,
    // K0.1: opciona napomena na `tech_processes` red (kumulativni red — prepisuje).
    note: string | null = null,
    // Više radnika na istoj operaciji (Nenad 2026-07-22): red je DELJEN, pa „Kraj
    // rada" jednog radnika NE sme da ga ugasi dok drugi imaju otvorene sesije —
    // red bi nestao svima iz „Mojih otvorenih", a tuđe sesije ostale siročići.
    // `finishForAll=true` je eksplicitan izbor sa kioska („Zatvori za sve").
    finishForAll = false,
    // 🔴 EKSPLICITNA NAMERA „operacija je gotova" (odluka Nenad 2026-08-05,
    // doslovno: „pitanje koje iskoči samo kad količina nije puna … sa
    // podrazumevanim NE"). `undefined` = klijent nije poslao polje → tretira se
    // kao `false` (bezbedan smer; stari klijenti prestaju da lažno zatvaraju).
    finishIntent?: boolean,
  ) {
    const planned = workOrder?.pieceCount ?? null;

    // A1 TVRDI guard „kucanje preko plana" (Nenad 16.07): STOP sken (stopWork /
    // stopWorkById „Kraj rada") ne sme da premaši plan RN-a — BEZ potvrde. 0 kom
    // (borverk, samo vreme) prolazi. OPŠTI NALOG (withoutProcess) nema plan → preskoči.
    const opDef = await tx.operation.findUnique({
      where: { workCenterCode: tp.workCenterCode },
      select: { withoutProcess: true },
    });
    if (opDef?.withoutProcess !== true)
      await this.assertPieceCountWithinPlan(
        tx,
        {
          projectId: tp.projectId,
          identNumber: tp.identNumber,
          variant: tp.variant,
          operationNumber: tp.operationNumber,
          workCenterCode: tp.workCenterCode,
        },
        planned,
        pieceCount,
      );

    // BUG-P1-01 Faza 1 (lost update): akumulacija komada je deljena po redu
    // operacije → čitaj-modifikuj-piši gubi paralelne prijave. Zato atomski
    // `{ increment }`; odluka o gašenju se donosi iz SVEŽEG zbira ispod.
    let updated = await tx.techProcess.update({
      where: { id: tp.id },
      data: {
        pieceCount: { increment: pieceCount },
        workerId,
        ...(note ? { note } : {}),
      },
    });

    // 🔴 KUMULATIV CELE OPERACIJE, ne jednog reda (F1, 05.08.2026). Ranije je ovde
    // stajalo `updated.pieceCount >= planned` — a to je `piece_count` SAMO TOG REDA.
    // Kad rad krene ponovo posle zatvaranja, FIX A otvara NOV red, pa se kucanja
    // razbiju na više redova: red 37 / operacija 50 / plan 50 je davao
    // `reachedPlan = false` iako je plan dostignut. Posledica je bila ZOMBI RED —
    // kiosk ne pita (kumulativ ≥ plan), pa polje `operacijaGotova` ne stigne, red
    // se ne gasi, dokucavanje pada na 422 („preko plana"), a „Odustani" ga ne dira.
    // Živ primer sa produ: tp 118300 · RN 9000/137 · op 20 · RC 8.4 (37/50, plan 50).
    // Zbir se čita POSLE inkrementa i u ISTOJ transakciji — isti ključ i isti
    // `aggregate _sum` koji koriste `assertPieceCountWithinPlan` (dva reda iznad) i
    // FIX A (`belowPlan` u `findOrOpenRoutingTp`). Sada je tvrdnja o „istoj metrici"
    // stvarno tačna.
    const cumAgg = await tx.techProcess.aggregate({
      _sum: { pieceCount: true },
      where: {
        projectId: tp.projectId,
        identNumber: tp.identNumber,
        variant: tp.variant,
        operationNumber: tp.operationNumber,
        workCenterCode: tp.workCenterCode,
      },
    });
    const cumulativePieces = cumAgg._sum.pieceCount ?? updated.pieceCount;
    // `planned > 0`: plan 0 (18 RN na produ) NIJE dokaz gotovosti — inače bi
    // `cum >= 0` gasilo svaki red bez pitanja, a kiosk bi na plan 0 pitao i uzalud
    // dobijao „Ne". Bez plana odlučuje isključivo eksplicitna namera.
    const reachedPlan =
      planned !== null && planned > 0 && cumulativePieces >= planned;
    // 🔴 NULA KOMADA NIJE „GOTOVO" (odluka Nenad 2026-08-07) — brana na SERVERU,
    // jer FE gejt ume da promaši (na barkod ekranu `withoutProcess` dolazi iz
    // decode odgovora sa `?? false`, pa nerazrešena operacija tiho izgubi izuzetak).
    //
    // ZAŠTO: od 05.08. (kad je pitanje uvedeno) operacija je 16 puta zatvorena sa
    // NULA komada, 9 različitih radnika. Dugme ne radi ono što radnik misli — od
    // 069/26 plan računa gotovost po DOBRIM komadima, pa operacija bez ijednog
    // komada nikad ne dobije kvačicu u planu; jedini stvarni efekat je da NESTANE
    // sa liste otvorenih. Za „otvorio sam greškom" postoji „Odustani" (`:id/dismiss`),
    // koji zastavicu izričito NE diže.
    //
    // TRI USLOVA, svaki nosi svoju težinu:
    //  • `finishIntent === true`, a NE `wantsFinish`: `wantsFinish` je istinit i za
    //    OPŠTI NALOG preko `fromMyOpen` (čišćenje reda) — brana na njemu bi oborila
    //    put kojim je RC 0.0 zatvorio 3.969 redova sa nula komada. Hvata se samo
    //    EKSPLICITNA namera koju je poslao klijent.
    //  • `withoutProcess !== true`: pojas i tregeri. Svež opšti nalog / svež CAM
    //    posao (17.0/17.1) kreće od kumulativa 0, pa bi budući klijent koji polje
    //    šalje uvek ostao bez izlaza.
    //  • `<= 0`, ne `=== 0`: storno upisuje kontra-red sa NEGATIVNIM `piece_count`,
    //    pa kumulativ ume da padne ispod nule.
    //
    // MESTO: pre `wantsFinish` i pre upita o tuđim sesijama — inače bi deljeni red
    // umesto 422 dao tihi `finishSkipped` („još neko radi") i sakrio pravi razlog.
    // Sudara se sa `reachedPlan` ne može: on traži `planned > 0 && cum >= planned`.
    // Baca se U TRANSAKCIJI, pa se rolbekuju i zatvaranje sesije i inkrement komada.
    if (
      finishIntent === true &&
      opDef?.withoutProcess !== true &&
      cumulativePieces <= 0
    )
      throw new UnprocessableEntityException(
        // Backtick-ovi: srpski navodnici u repou su „ + ASCII " (v. kiosk tekstove),
        // a ASCII " bi prekinuo dvostruko navođen literal.
        `Na operaciji nije otkucan nijedan komad — ne može biti označena kao gotova. ` +
          `Ako si radio, prvo upiši broj komada pa ponovi „Kraj rada". ` +
          `Ako si red otvorio greškom, skloni ga dugmetom „Odustani" u listi „Moji otvoreni".`,
      );
    // 🔴 PRAVILO GAŠENJA (Nenad 2026-08-05) — serversko, ne veruje se samo FE-u:
    //   1. kumulativ ≥ plan  → zatvori (kao i do sada; polje se ne gleda),
    //   2. inače             → zatvori SAMO ako je stigla eksplicitna namera
    //                          („Da — gotova je" u kiosk dijalogu),
    //   3. OPŠTI NALOG (withoutProcess) je izuzetak: nema plan, po dizajnu je uvek
    //      otvoren, pa „Kraj rada" i dalje čisti red bez pitanja.
    const wantsFinish =
      finishIntent === true || (fromMyOpen && opDef?.withoutProcess === true);
    // Tuđe otvorene sesije na DELJENOM redu (sopstvena je u ovom trenutku već
    // zatvorena od pozivaoca; filter po workerId je zaštita od duplih sopstvenih).
    // `reachedPlan` i dalje gasi bezuslovno (plan je plan) — higijena ispod počisti.
    const otherOpenSessions =
      fromMyOpen || wantsFinish
        ? await tx.workTimeEntry.findMany({
            where: {
              techProcessId: tp.id,
              stoppedAt: null,
              workerId: { not: workerId },
            },
            select: { workerId: true },
          })
        : [];
    const otherOpenWorkerIds = [
      ...new Set(otherOpenSessions.map((s) => s.workerId)),
    ];
    const finish =
      reachedPlan ||
      (wantsFinish && (finishForAll || otherOpenWorkerIds.length === 0));
    // Gašenje reda preskočeno iako je traženo — drugi radnici još rade (kiosk bez
    // izbora „za sve" / trka sa svežim START-om drugog radnika). Kad gašenje NIJE
    // ni traženo („Ne — nastavlja se"), ovo je `false`: red normalno ostaje otvoren.
    const finishSkipped = wantsFinish && !finish;
    if (finish) {
      updated = await tx.techProcess.update({
        where: { id: tp.id },
        data: { isProcessFinished: true, finishedAt: now },
      });
      // Higijena: gašenje reda ne sme da ostavi tuđe sesije da vise (do noćnog
      // auto-close-a + 422 na STOP). Vreme se čuva do `now`, komadi ostaju 0.
      await tx.workTimeEntry.updateMany({
        where: { techProcessId: tp.id, stoppedAt: null },
        data: {
          stoppedAt: now,
          autoClosed: true,
          note: "operacija zatvorena — sesija automatski završena",
        },
      });
    }
    const prioritized = finish
      ? await this.setOperationDonePriority(
          tx,
          workOrder?.id ?? tp.workOrderId,
          tp.operationNumber,
          tp.workCenterCode,
        )
      : 0;
    const workOrderCompleted = await this.markWorkOrderIfComplete(
      tx,
      tp.projectId,
      tp.identNumber,
      tp.variant,
    );
    return {
      tp: updated,
      planned,
      reachedPlan,
      // Red je STVARNO zatvoren (plan dostignut ILI eksplicitno „gotova je" ILI
      // čišćenje opšteg naloga). `reachedPlan` govori SAMO o količini — kiosk
      // razlikuje poruke „dostigla plan" vs „označena kao gotova ispod plana".
      operationClosed: finish,
      // Kumulativ CELE operacije posle ove prijave (isti broj koji je odlučio o
      // `reachedPlan`) — kiosk njime osvežava „Napravljeno x/y" i poruku.
      cumulativePieces,
      prioritized,
      workOrderCompleted,
      finishSkipped,
      otherOpenWorkerIds,
    };
  }

  /**
   * Radnik iz ID kartice (prednost) ILI iz prijavljenog naloga (`users.worker_id`,
   * JWT) — isti izbor kao `openForWorker` / `worker/me`. Veza sa nalogom se čita
   * SVEŽE iz baze (ne iz JWT claim-a). Neprepoznat radnik → 400.
   */
  private async resolveWorkerFromCardOrUser(
    card: string | undefined,
    user?: AuthUser,
  ): Promise<{
    id: number;
    fullName: string | null;
    username: string | null;
    workerTypeId: number;
  }> {
    const trimmed = (card ?? "").trim();
    if (trimmed) return this.resolveWorkerByCard(trimmed);
    const account = user?.userId
      ? await this.prisma.user.findUnique({
          where: { id: user.userId },
          select: { workerId: true },
        })
      : null;
    if (!account?.workerId)
      throw new BadRequestException(
        "Radnik nije prepoznat — skenirajte ID karticu ili se prijavite ličnim nalogom vezanim za radnika.",
      );
    const worker = await this.prisma.worker.findFirst({
      where: { id: account.workerId },
      orderBy: { id: "asc" },
      select: { id: true, fullName: true, username: true, workerTypeId: true },
    });
    if (!worker)
      throw new NotFoundException(`Radnik ${account.workerId} nije nađen.`);
    return worker;
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
    const { identNumber } = order.fields;
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07).
    const projectId = await this.resolveScanProjectId(
      this.prisma,
      order.fields.projectId,
      identNumber,
    );
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
   * ⚠️ SUPERSEDED (Q11, 17.07): endpoint `POST /work/auto-close` sada zove
   * `SessionAutoCloseService.run` (zatvaranje preko evidencije kapije). Ovaj metod
   * (prosto `stopped_at = now`) ostaje kao rezervna/interna varijanta — više nije zakačen.
   *
   * Zatvori sesije ostavljene otvorene (npr. preko noći). Sve `stopped_at IS NULL`
   * starije od `olderThanHours` (default 12h) → `stopped_at = now`, `auto_closed = true`;
   * komadi ostaju (0 ako nije bilo STOP-a). NE dira `tech_processes`.
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

    const { identNumber, variant } = order.fields;
    // Nalepnica/legacy barkod (IDPredmet=0) → predmet po identu (22.07).
    const projectId = await this.resolveScanProjectId(
      this.prisma,
      order.fields.projectId,
      identNumber,
    );
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
        // workCenterName: K2 draft „Radna jedinica" (RC kod + naziv, ako je dostupan).
        select: { significantForFinishing: true, workCenterName: true },
      });
      if (op?.significantForFinishing !== true)
        throw new UnprocessableEntityException(
          `Operacija (RC ${workCenterCode}) nije završna kontrola — koristite prijavu rada/zatvaranje.`,
        );

      const planned = workOrder.pieceCount ?? null;

      // Kumulativ SVIH kontrola te operacije (sve kvalitete: dobar+dorada+škart) —
      // operacija se zatvara TEK kad ukupno iskontrolisano dostigne plan RN-a; do
      // tada je parcijala, red ostaje otvoren i akumulira (odluka korisnika 2026-07-14).
      const sumAgg = await tx.techProcess.aggregate({
        _sum: { pieceCount: true },
        where: {
          projectId,
          identNumber,
          variant,
          operationNumber,
          workCenterCode,
        },
      });
      const existingSum = sumAgg._sum.pieceCount ?? 0;
      const cumulative = existingSum + dto.pieceCount;
      // reachedPlan pri overshoot-u: cumulative > plan ⇒ >= plan ⇒ operacija se zatvara.
      const reachedPlan = planned === null || cumulative >= planned;

      // K0.2: overshoot allowed with explicit confirmation (Nenad 15.07, strugar
      // naparavi 1-2 viška). FE detektuje premašaj pre slanja (ima made+plan) i ponovi
      // sa `confirmOvershoot: true` posle dijaloga; tada se guard preskače.
      if (
        planned !== null &&
        cumulative > planned &&
        dto.confirmOvershoot !== true
      )
        throw new UnprocessableEntityException(
          `Ukupno iskontrolisano (${cumulative}) premašuje planirano (${planned}) — potvrdite unos preko plana.`,
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
      // Q4 (BUG-P1-02, Nenad 16.07): filter po `qualityTypeId` — kontrole različitog
      // kvaliteta (dobar/dorada/škart) žive u ODVOJENIM redovima, svaki sa svojim
      // qualityTypeId koji se NIKAD ne prepisuje tuđim kvalitetom. Isti kvalitet →
      // akumulira na svoj red; nov kvalitet → kreira nov red (else grana). Kumulativ/
      // plan (`sumAgg` gore) i dalje broji SVE kvalitete zajedno — ne dira se.
      const existingOpen = await tx.techProcess.findFirst({
        where: {
          projectId,
          identNumber,
          variant,
          workCenterCode,
          operationNumber,
          qualityTypeId: dto.qualityTypeId,
          isProcessFinished: { not: true },
        },
        orderBy: { id: "asc" },
      });

      // Zatvaranje (isProcessFinished/finishedAt) samo kad je plan dostignut; do tada
      // je parcijala i red ostaje otvoren. pieceCount se razlikuje po grani: update =
      // akumulacija na postojeći otvoreni red, create = ova prijava kontrole.
      const finishData = {
        qualityTypeId: dto.qualityTypeId,
        workerId: worker.id, // kontrolor (audit ko+kada — ODLUKE #14)
        workOrderId: workOrder.id,
        ...(reachedPlan ? { isProcessFinished: true, finishedAt: now } : {}),
        ...(dto.note?.trim() ? { note: dto.note.trim() } : {}),
      };

      let tp;
      if (existingOpen) {
        // BUG-P1-01 Faza 1 (lost update): akumulacija na otvoren red kontrole je
        // deljena → atomski `{ increment }` umesto `existingOpen.pieceCount + n`.
        // Odluka o zatvaranju (`reachedPlan`) se ovde donosi iz SUM-a svih redova
        // (`cumulative`, izračunat gore), ne iz vrednosti jednog reda — pa ostaje.
        tp = await tx.techProcess.update({
          where: { id: existingOpen.id },
          data: {
            ...finishData,
            pieceCount: { increment: dto.pieceCount },
          },
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
            pieceCount: dto.pieceCount,
            ...finishData,
          },
        });
      }

      // Kaskada (potvrda prethodnih operacija) + skidanje celog RN-a sa prioriteta +
      // „RN završen" idu SAMO kad je plan dostignut; parcijalna kontrola ostavlja
      // prethodne operacije i prioritet netaknute (akumulira se do plana).
      let confirmedOperationsCount = 0;
      let prioritizedCount = 0;
      let workOrderCompleted = false;
      if (reachedPlan) {
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
        confirmedOperationsCount = confirmedOps.count;

        // Q4 (BUG-P1-02): pošto se kontrola razdvaja po kvalitetu (odvojeni redovi),
        // pri dostizanju plana OVE (značajne) kontrolne operacije treba zatvoriti i
        // preostale otvorene redove ISTE operacije drugih kvaliteta (npr. 8 DOBAR pa
        // 2 ŠKART = plan → i DOBAR red mora biti finished). `confirmedOps` gore ih
        // preskače (isključuje značajne RC), a `markWorkOrderIfComplete` traži da SVI
        // značajni redovi budu finished — bez ovog raniji red bi ostao otvoren i
        // trajno blokirao zavođenje RN-a kao „Završen". Isti operationNumber/
        // workCenterCode = ista operacija čiji je plan sada dostignut (svi kvaliteti).
        await tx.techProcess.updateMany({
          where: {
            projectId,
            identNumber,
            variant,
            operationNumber,
            workCenterCode,
            id: { not: tp.id },
            isProcessFinished: { not: true },
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
        prioritizedCount = prioritized.count;

        workOrderCompleted = await this.markWorkOrderIfComplete(
          tx,
          projectId,
          identNumber,
          variant,
        );
      }

      return {
        tp,
        workOrder,
        planned,
        reachedPlan,
        cumulative,
        prioritized: prioritizedCount,
        confirmedOperations: confirmedOperationsCount,
        workOrderCompleted,
        opened: !existingOpen,
        // K2 draft „Radna jedinica": RC naziv iz operations (null ako nerazrešen).
        workCenterName: op?.workCenterName ?? null,
      };
    });

    const label = await this.buildLabelData(
      result.workOrder.id,
      dto.pieceCount,
    );
    const isQualityIssue = dto.qualityTypeId !== PART_QUALITY.GOOD;

    // A3 CHILD RN (-D/-S): DORADA/ŠKART sa kontrole AUTOMATSKI otvara child RN (legacy
    // KreirajNalogDoradeIliSkarta — kopira ceo TP parenta, Komada = kol. skarta/dorade).
    // POSLE glavne transakcije, best-effort (kao D8): uspeh → `childOrder` u odgovoru i
    // `childOrderPending=false`; pad → `childOrderPending=true` + logger.error (radnik/
    // tehnolog kreira ručno preko endpointa Agenta B). Ide PRE D8 da poruka nosi broj.
    let childOrder: { id: number; identNumber: string } | null = null;
    let childOrderPending = isQualityIssue;
    if (isQualityIssue) {
      try {
        childOrder = await this.workOrders.createQualityChildOrder({
          parentWorkOrderId: result.workOrder.id,
          // 1 = dorada, 2 = škart (PART_QUALITY.REWORK/SCRAP; isQualityIssue garantuje ≠0).
          qualityTypeId: dto.qualityTypeId as 1 | 2,
          quantity: dto.pieceCount,
          note: dto.note?.trim() ? dto.note.trim() : null,
          actorWorkerId: worker.id,
        });
        childOrderPending = false;
      } catch (e) {
        this.logger.error(
          `A3 child RN (-${dto.qualityTypeId === PART_QUALITY.SCRAP ? "S" : "D"}) FAIL (RN ${identNumber}, kvalitet ${dto.qualityTypeId}): ${(e as Error).message}`,
        );
      }
    }

    // D8 emit: DORADA i ŠKART (odluka Nenad, PLAN_dorade §D8) → in-app notifikacija
    // tehnolozima + projektantu crteža. POSLE uspešne transakcije, best-effort —
    // helper je ceo u try/catch, pad notifikacije NE obara kucanje kontrole.
    if (isQualityIssue) {
      await this.notifyQualityIssue({
        workOrderId: result.workOrder.id,
        identNumber: result.workOrder.identNumber,
        operationNumber,
        workCenterCode,
        qualityTypeId: dto.qualityTypeId,
        pieceCount: dto.pieceCount,
        controllerName: worker.fullName || worker.username,
        // D8 poruka nosi broj child RN-a kad je uspešno kreiran (null ako je pending).
        childOrderIdentNumber: childOrder?.identNumber ?? null,
      });
    }

    // K2: rework/scrap control auto-creates a DRAFT nonconformity report (Nenad 15.07)
    // — best-effort like D8. `createDraftFromControl` never throws by contract, but wrap
    // defensively so the control itself never fails on quality-module trouble.
    let nonconformityDraftCreated = false;
    if (
      dto.qualityTypeId === PART_QUALITY.REWORK ||
      dto.qualityTypeId === PART_QUALITY.SCRAP
    ) {
      try {
        // Culprit proposal: distinct workers (>0) who logged rows on this operation
        // (trojka + op + rc); the controller confirms/corrects them in the quality card.
        const culpritRows = await this.prisma.techProcess.findMany({
          where: {
            projectId,
            identNumber,
            variant,
            operationNumber,
            workCenterCode,
          },
          select: { workerId: true },
        });
        const culpritWorkerIds = [
          ...new Set(culpritRows.map((r) => r.workerId).filter((w) => w > 0)),
        ].slice(0, 10);
        const workUnit = result.workCenterName
          ? `${workCenterCode} · ${result.workCenterName}`
          : workCenterCode;
        await this.quality.createDraftFromControl({
          // QualityService interface uses `qualityTypeId` (1=dorada, 2=škart).
          qualityTypeId: dto.qualityTypeId,
          sourceTechProcessId: result.tp.id,
          workOrderId: result.workOrder?.id ?? null,
          identNumber,
          drawingNumber: result.workOrder?.drawingNumber ?? null,
          partName: result.workOrder?.partName ?? null,
          // Customer name is not cheaply on the RN triple lookup → null (K1 fills it).
          customerName: null,
          quantity: dto.pieceCount,
          workUnit,
          defectDescription: dto.note?.trim() ? dto.note.trim() : null,
          raisedByWorkerId: worker.id,
          culpritWorkerIds,
        });
        nonconformityDraftCreated = true;
      } catch (e) {
        this.logger.error(
          `K2 auto-draft FAIL (RN ${identNumber}, kvalitet ${dto.qualityTypeId}): ${(e as Error).message}`,
        );
      }
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
        // Ukupno iskontrolisano za tu operaciju (zbir svih kontrola, sve kvalitete).
        controlledCumulative: result.cumulative,
        // Operacija zatvorena tek kad kumulativ dostigne plan RN-a (parcijala = false).
        operationFinished: result.reachedPlan,
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
        // A3: automatski kreiran child RN (-D/-S) — { id, identNumber }; null kad pending.
        childOrder,
        // Dorada/škart: true samo ako child RN NIJE kreiran (kreator pao) → ručno preko
        // endpointa Agenta B; false kad je child RN uspešno otvoren (childOrder popunjen).
        childOrderPending,
        // K2: DRAFT neusaglašenosti (škart/dorada) auto-kreiran za radnu listu kontrolora.
        nonconformityDraftCreated,
      },
      ...(childOrderPending
        ? {
            meta: {
              note: "Kvalitet dorada/škart evidentiran; notifikacija tehnolozima poslata (D8). Automatsko kreiranje child RN-a (-D/-S) NIJE uspelo — kreirajte ga ručno (MODULE_SPEC_kontrola §8).",
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
   * polja `Nalepnice` reporta + RNZ barkod (`formatLabelBarcode` — KRATKI oblik
   * `RNZ:0:{ident}:0:0`, 22.07; kiosk/lokacije ga dekodiraju preko ident-fallback-a).
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
    return { data: await this.labelPrint.printRawTspl(dto) };
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
      // BUG-P2-09: guard iznad poredi SAMO izvorni red, ali kontra-redovi su NOVI
      // redovi (izvorni ostaje netaknut) — pa dva uzastopna storna od 10 na redu od
      // 10 oba prolaze i daju NETO -10. Zato dodatni NETO guard: zbir svih redova te
      // operacije (kucanja − dosadašnji storno kontra-redovi) ne sme pasti ispod 0.
      const netAgg = await tx.techProcess.aggregate({
        _sum: { pieceCount: true },
        where: {
          projectId: tp.projectId,
          identNumber: tp.identNumber,
          variant: tp.variant,
          operationNumber: tp.operationNumber,
          workCenterCode: tp.workCenterCode,
        },
      });
      const netAvailable = netAgg._sum.pieceCount ?? 0;
      if (dto.pieceCount > netAvailable)
        throw new UnprocessableEntityException(
          `Storno (${dto.pieceCount}) je veći od preostalog neto stanja operacije (${netAvailable}) — verovatno je već storniran.`,
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
   * `POST /:id/reopen` — ponovo otvara zatvorenu operaciju (DORADA): tehnolog/šef
   * vraća operaciju u rad kada je posle zatvaranja potrebna dorada. U jednoj
   * transakciji: (1) skida `isProcessFinished` sa SVIH redova te operacije
   * (ista trojka + operationNumber + workCenterCode), (2) vraća operaciju na
   * listu prioriteta (priority 100) ako RC koristi prioritet i bila je skinuta
   * (255), (3) skida „RN završen" (`work_orders.status`) ako je bio postavljen.
   */
  async reopen(id: number) {
    const tp = await this.prisma.techProcess.findUnique({ where: { id } });
    if (!tp)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);

    const {
      projectId,
      identNumber,
      variant,
      operationNumber,
      workCenterCode,
      workOrderId,
    } = tp;

    const result = await this.prisma.$transaction(async (tx) => {
      // (a) Otvori SVE zatvorene redove te operacije (deljena po trojci + OP + RC).
      const reopened = await tx.techProcess.updateMany({
        where: {
          projectId,
          identNumber,
          variant,
          operationNumber,
          workCenterCode,
          isProcessFinished: true,
        },
        data: { isProcessFinished: false, finishedAt: null },
      });

      // (b) Vrati operaciju na listu prioriteta ako RC koristi prioritet i bila je
      // skinuta (255 → 100). Ako RC ne koristi prioritet, operacija ionako nije na
      // listi — priority se ne dira.
      const op = await tx.operation.findUnique({
        where: { workCenterCode },
        select: { usesPriority: true },
      });
      if (op?.usesPriority === true)
        await tx.workOrderOperation.updateMany({
          where: {
            workOrderId,
            operationNumber,
            workCenterCode,
            priority: OPERATION_PRIORITY_DONE,
          },
          data: { priority: 100 },
        });

      // (c) Skini „RN završen" ako je bio postavljen — operacija se vratila u rad.
      await tx.workOrder.updateMany({
        where: { id: workOrderId, status: true },
        data: { status: false },
      });

      return { reopened: reopened.count };
    });

    return {
      data: {
        id,
        operationNumber,
        workCenterCode,
        reopened: result.reopened,
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
      // Faza 1 (BUG-P1-03): work_time_entries FK je NO ACTION → red sa sesijom bi
      // srušio brisanje na P2003 (goli 500). Sesije su izveden podatak vremena, a
      // audit snapshot reda ostaje, pa ih brišemo pre reda.
      await tx.workTimeEntry.deleteMany({ where: { techProcessId: id } });
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
      // `pieceCount` (plan RN-a) — FIX A poredi kumulativ operacije sa planom.
      select: { id: true, variant: true, pieceCount: true },
    });
  }

  /**
   * KRATKI barkod nalepnice / legacy 1.0 nalepnica: polje IDPredmet je 0
   * (`RNZ:0:{ident}:0:0` — `formatLabelBarcode`, 22.07). Predmet se tada
   * razrešava po identu: nepostojeći → 404 (ista poruka kao ostatak toka),
   * ident u VIŠE predmeta → 422 (ne pogađati — radnik skenira RN papir).
   * Pun barkod (projectId > 0) prolazi netaknut, bez upita.
   */
  private async resolveScanProjectId(
    tx: Prisma.TransactionClient,
    projectId: number,
    identNumber: string,
  ): Promise<number> {
    if (projectId > 0) return projectId;
    const rows = await tx.workOrder.findMany({
      where: { identNumber },
      select: { projectId: true },
      distinct: ["projectId"],
    });
    if (!rows.length)
      throw new NotFoundException(`RN za ident ${identNumber} nije nađen.`);
    if (rows.length > 1)
      throw new UnprocessableEntityException(
        `Ident ${identNumber} postoji u više predmeta — skenirajte barkod naloga sa RN papira (nalepnica nije dovoljna).`,
      );
    return rows[0].projectId;
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
    // Proba 13.07 (Jovica): red se ranije otvarao sa workerId=0 pa „Moji
    // otvoreni" (filter po tech_processes.worker_id) nije video START-ovan red
    // do prve prijave. Kreator (radnik sa skenirane kartice) se štancuje ODMAH;
    // prijava/zatvaranje i dalje prepisuju vlasnika (legacy semantika).
    creatorWorkerId = 0,
  ) {
    // Tekući RN prvo — kiosk uvek knjiži na najvišu varijantu (D5 klon = novi red).
    const wo = await this.findCurrentWorkOrder(tx, projectId, identNumber);
    if (!wo)
      throw new NotFoundException(
        `RN za predmet ${projectId}, ident ${identNumber} nije nađen.`,
      );

    // OPŠTI NALOG (Operation.withoutProcess=true): radni centar bez tehnološkog
    // postupka NEMA red u routingu (work_order_operations) i UVEK je otvoren za
    // prijavu rada. Zatvoreni redovi su ISTORIJA (legacy sync / ručno „Zatvori
    // operaciju"): preskaču se i otvara se nov red. `opDef` se zato učitava PRE
    // korišćenja `existing`-a — inače bi zatvoren postojeći red bio vraćen i
    // pozivalac (scan/start/stop) bi pao 422 „već zatvorena".
    const opDef = await tx.operation.findUnique({
      where: { workCenterCode },
      select: { withoutProcess: true },
    });
    const withoutProcess = opDef?.withoutProcess === true;

    const existing = await this.findRoutingTp(
      tx,
      projectId,
      identNumber,
      wo.variant,
      workCenterCode,
      operationNumber,
    );

    // FIX A (Nenad 2026-07-15): OBIČNA operacija čiji je KUMULATIV komada (svi
    // kvaliteti, svi redovi te operacije) < plan RN-a je UVEK RADNA — i kad su svi
    // njeni `tech_processes` redovi zatvoreni (`isProcessFinished`). Zatvoreni
    // ispod-plan red se tada tretira kao ISTORIJA (kao withoutProcess): otvara se
    // NOV red umesto greške „već zatvorena". Zatvoren tek kad kumulativ >= plan.
    // Metrika = ukupan `pieceCount` (dosledno sa `card.made` i `control()`
    // kumulativom). Aggregate se radi SAMO za zatvoren obično-operacijski red.
    let belowPlan = false;
    if (existing && existing.isProcessFinished === true && !withoutProcess) {
      const planned = wo.pieceCount ?? null;
      if (planned !== null) {
        const sum = await tx.techProcess.aggregate({
          _sum: { pieceCount: true },
          where: {
            projectId,
            identNumber,
            variant: wo.variant,
            operationNumber: existing.operationNumber,
            workCenterCode,
          },
        });
        belowPlan = (sum._sum.pieceCount ?? 0) < planned;
      }
    }

    // Obična operacija: postojeći red (otvoren ili zatvoren-iznad-plana) je
    // autoritet. withoutProcess ILI zatvoren ispod-plana (belowPlan): postojeći
    // red se koristi SAMO ako je OTVOREN — zatvoren se tretira kao istorija i pada
    // u granu kreiranja novog reda ispod.
    if (
      existing &&
      !((withoutProcess || belowPlan) && existing.isProcessFinished === true)
    )
      return { tp: existing, opened: false };

    // withoutProcess ILI belowPlan: otvori red direktno — preskoči puni routing
    // lookup. withoutProcess NEMA red u routingu po dizajnu (opšti nalog).
    // belowPlan: `existing` (zatvoren red) DOKAZUJE da je operacija NEKAD bila u
    // routingu, ali NE i da je JOŠ uvek — tehnolog je mogao naknadno da je izbaci
    // (BUG-P1-05: 137 fantomskih redova). Zato SAMO za belowPlan proveravamo da
    // operacija još postoji u `work_order_operations`; ako je nema → 422 (Q2
    // odluka, Nenad 2026-07-16), radnik se šalje nadređenom, nov red se NE kreira.
    if (withoutProcess || belowPlan) {
      // BUG-P1-05 (Q2): belowPlan (a NE withoutProcess) mora imati živ routing red.
      if (belowPlan && !withoutProcess) {
        const opNum = operationNumber ?? existing?.operationNumber ?? 0;
        const belowPlanRoutingWhere: Prisma.WorkOrderOperationWhereInput = {
          workOrderId: wo.id,
          workCenterCode,
          operationNumber: opNum,
        };
        const belowPlanRouting = await tx.workOrderOperation.findFirst({
          where: belowPlanRoutingWhere,
          select: { operationNumber: true },
        });
        if (!belowPlanRouting)
          throw new UnprocessableEntityException(
            `Radni nalog je izmenjen — operacija (op. ${opNum}, RC ${workCenterCode}) više nije u tehnološkom postupku. Obrati se nadređenom za proveru.`,
          );
      }
      // Serijska sekvenca (synced eksplicitni id-jevi) — poravnaj pre insert-a.
      await this.alignTechProcessSequence(tx);
      const tp = await tx.techProcess.create({
        data: {
          projectId,
          identNumber,
          variant: wo.variant,
          // belowPlan: nasledi op. broj zatvorenog reda (routing ga već ima).
          operationNumber: operationNumber ?? existing?.operationNumber ?? 0,
          workCenterCode,
          identMark: identMark || "0",
          pieceCount: 0,
          workerId: creatorWorkerId,
          workOrderId: wo.id,
        },
      });
      return { tp, opened: true };
    }

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
        workerId: creatorWorkerId,
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
    // A3: identNumber automatski kreiranog child RN-a (-D/-S); null kad je pending.
    childOrderIdentNumber?: string | null;
  }): Promise<void> {
    try {
      const scrap = input.qualityTypeId === PART_QUALITY.SCRAP;
      const recipients =
        await this.notifications.resolveTechnologistWorkerIds();
      const designerId = await this.resolveWorkOrderDesignerId(
        input.workOrderId,
      );
      if (designerId) recipients.push(designerId);

      // A3: kad je child RN uspešno kreiran, poruka nosi njegov broj (-D/-S).
      const childSuffix = input.childOrderIdentNumber
        ? ` → nalog ${input.childOrderIdentNumber}`
        : "";
      const created = await this.notifications.notifyWorkers(recipients, {
        type: scrap ? "kontrola.skart" : "kontrola.dorada",
        message: `${scrap ? "ŠKART" : "DORADA"} na RN ${input.identNumber} op ${input.operationNumber} (${input.workCenterCode}) — kontrolor ${input.controllerName ?? "?"}, ${input.pieceCount} kom${childSuffix}`,
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
      // KRATKI oblik (RNZ:0:{ident}:0:0, 22.07): pun barkod sa projectId +
      // revizijom je predugačak za čitljiv Code128 na 80mm termalnoj nalepnici
      // (pogon: „novi izgled neće da čita"). Predmet se pri skenu razrešava po
      // identu (resolveScanProjectId); RN A4 papir zadržava pun oblik.
      barcode: formatLabelBarcode(wo.identNumber),
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
   * (`isProcessFinished=true`) I ukupno iskontrolisano na njima mora dostići
   * plan RN-a (`work_orders.pieceCount`). Ako jeste → označi RN
   * (`work_orders.status=true`) i vrati `true`. Ako nema značajnih operacija,
   * nisu sve gotove ili kumulativ ne dostiže plan → `false`, RN se ne dira.
   *
   * Količinski gate dodat 2026-07-14 (odluka Nenad, sanacija „Završeni nalozi"):
   * bez njega bi bilo koji ZAVRŠEN red kontrole (legacy import, istorijski
   * parcijal) označio RN završenim iako kucanje nije dostiglo plan — prod je
   * imao 9 takvih RN-ova (npr. 9000/453: kontrola 110 od 400 → „Završen").
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
      select: {
        workCenterCode: true,
        isProcessFinished: true,
        pieceCount: true,
      },
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
      select: { id: true, status: true, pieceCount: true },
    });
    if (!wo) return false;

    // Količinski gate: ukupno iskontrolisano (svi kvaliteti; storno se netuje)
    // mora dostići plan — završen red kontrole sa parcijalnom količinom
    // (legacy import / istorijski podatak) NE završava RN.
    const controlledTotal = significantRows.reduce(
      (sum, r) => sum + r.pieceCount,
      0,
    );
    if (controlledTotal < wo.pieceCount) return false;

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
      {
        workCenterCode: string;
        workCenterName: string;
        workUnitCode: string;
        significantForFinishing: boolean | null;
        withoutProcess: boolean | null;
      }
    >();
    if (!uniq.length) return map;
    const rows = await this.prisma.operation.findMany({
      where: { workCenterCode: { in: uniq } },
      select: {
        workCenterCode: true,
        workCenterName: true,
        workUnitCode: true,
        // K4: front crta „Završna kontrola / Međufazna / Kucanje" bez dodatnog upita.
        significantForFinishing: true,
        // OPŠTI NALOG: kiosk na „Kraj rada" NE pita „da li je gotova?" (operacija
        // bez postupka nema plan i po dizajnu je uvek otvorena).
        withoutProcess: true,
      },
    });
    for (const r of rows) map.set(r.workCenterCode, r);
    return map;
  }
}
