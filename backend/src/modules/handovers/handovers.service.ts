import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import { parseDateParam } from "../../common/date-params";
import { resolveActorWorkerId } from "../../common/workers/resolve-actor-worker";
import {
  engineerWorkerWhere,
  isActiveTechnologist,
  technologistWorkerWhere,
  TECHNOLOGIST_CHECK_SELECT,
} from "../../common/workers/technologist-criteria";
import { PRIMOPREDAJA_APPROVERS } from "../../common/authz/primopredaja-approvers";
import type { AuthUser } from "../auth/jwt.strategy";
import { LaunchHandoverDto } from "./dto/launch-handover.dto";
import { ApproveHandoverDto } from "./dto/approve-handover.dto";
import {
  ApproveHandoverBatchDto,
  RejectHandoverBatchDto,
  validateHandoverIds,
} from "./dto/batch-handover.dto";
import { ReturnHandoverDto } from "./dto/return-handover.dto";

/**
 * Status primopredaje (`drawing_handovers.status_id`) — ISTA `handover_statuses`
 * lookup tabela koju koristi i `work_orders.handover_status_id`
 * (`WorkOrder.handoverStatus` relacija, vidi schema.prisma). Vrednosti 1:1
 * preslikane iz `work-orders/work-orders.service.ts` (`WO_STATUS`) po
 * instrukciji zadatka — state machine 0/1/2/3.
 */
export const HANDOVER_STATUS = {
  PENDING: 0, // U OBRADI — na čekanju odobravanja ("NaCekanju" iz specifikacije)
  APPROVED: 1, // SAGLASAN
  REJECTED: 2, // ODBIJENO
  LAUNCHED: 3, // LANSIRAN
} as const;

/** Podskup polja crteža za prikaz uz primopredaju. */
const DRAWING_SELECT = {
  id: true,
  drawingNumber: true,
  revision: true,
  name: true,
  material: true,
  dimensions: true,
} satisfies Prisma.DrawingSelect;

const HANDOVER_SELECT = {
  id: true,
  drawingId: true,
  handoverDate: true,
  handoverWorkerId: true,
  statusId: true,
  statusChangedAt: true,
  statusChangedById: true,
  statusChangeComment: true,
  launchedAt: true,
  launchedById: true,
  note: true,
  isLocked: true,
  createdAt: true,
  updatedAt: true,
  technologistId: true,
  legacyRnId: true,
  technologistAssignedAt: true,
  technologistAssignedById: true,
  productionDeadline: true,
  isUrgent: true,
} satisfies Prisma.DrawingHandoverSelect;

/** Podskup RN polja koji launch/prepare vraćaju (isti kao dosadašnji launch). */
const HANDOVER_WO_SELECT = {
  id: true,
  identNumber: true,
  variant: true,
  projectId: true,
  drawingNumber: true,
  revision: true,
  pieceCount: true,
  handoverStatusId: true,
} satisfies Prisma.WorkOrderSelect;

/** Zaglavlje primopredaje potrebno za kreiranje RN-a (launch/prepare). */
interface HandoverForWorkOrder {
  id: number;
  drawingId: number;
  statusId: number;
  isLocked: boolean | null;
  handoverWorkerId: number;
  technologistId: number;
  legacyRnId: number | null;
  /** Rok unet pri odobravanju (§6.5.1) — fallback za `work_orders.production_deadline`. */
  productionDeadline: Date | null;
}

/** Razrešeni kontekst (crtež + nacrt/stavka + predmet) za građenje RN zaglavlja. */
interface HandoverWorkOrderContext {
  drawing: {
    id: number;
    drawingNumber: string;
    revision: string;
    name: string;
    material: string | null;
    dimensions: string | null;
  };
  draftCtx: {
    draftId: number;
    draftNumber: string;
    projectId: number;
    itemId: number;
    quantityToProduce: number;
  };
  project: { id: number; projectNumber: string; customerId: number };
}

type HandoverRow = Prisma.DrawingHandoverGetPayload<{
  select: typeof HANDOVER_SELECT;
}>;

/**
 * Row shape the reject flows hand to `notifyRejected()`: enough to group per
 * generator (`handoverWorkerId`) and list the rejected drawings.
 */
interface RejectedHandoverRef {
  id: number;
  handoverWorkerId: number;
  drawingId: number;
}

/**
 * Serbian plural of "stavka" for the rejection mail subject/message
 * (1/21 stavka, 2–4 stavke, 5+ stavki — standard paucal rule).
 */
function stavkaLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} stavka`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return `${n} stavke`;
  return `${n} stavki`;
}

export interface ListHandoversQuery {
  page?: string;
  pageSize?: string;
  statusId?: string;
  drawingNumber?: string;
  projectId?: string;
  /** Filter "moje primopredaje" (tehnolog) — dok ne postoji User↔Worker veza, prosleđuje se eksplicitno. */
  handoverWorkerId?: string;
  /** Dodeljeni tehnolog (piše TP) — `drawing_handovers.technologist_id`. */
  technologistId?: string;
  /**
   * Broj RN — matches `work_orders.ident_number` otkucanog/lansiranog RN-a
   * (contains, case-insensitive). Razrešava se u `drawing_handovers.id` preko
   * soft FK-a `work_orders.drawing_handover_id` (bez Prisma relacije, default 0).
   */
  rn?: string;
  /** Opseg po `handoverDate` (ISO). */
  from?: string;
  to?: string;
}

/**
 * Primopredaje crteža (`drawing_handovers`) — MODULE_SPEC_nacrti_primopredaje
 * §6.4. Ovaj servis radi nad POSTOJEĆIM redovima: pregled +
 * approve/reject/launch/return-to-pending/prepare-work-order. Kreiranje
 * `drawing_handovers` redova (predaja nacrta u primopredaju —
 * `/handover-drafts/:id/submit`, §6.3) je u `HandoverDraftsService.submit()`.
 *
 * Audit autor (`statusChangedById`/`launchedById`) = `AuthUser.workerId` iz
 * JWT-a (`users.worker_id` veza); `null` kad nalog nema vezanog radnika
 * (kancelarijski nalozi / stari tokeni). `workOrder.workerId` je TEHNOLOG
 * (dodeljen pri odobravanju), NE kreator — vidi `createHandoverWorkOrder`.
 */
@Injectable()
export class HandoversService {
  private readonly logger = new Logger(HandoversService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // MailModule is @Global — no handovers.module.ts import needed.
    private readonly mail: MailService,
  ) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListHandoversQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.DrawingHandoverWhereInput = {};
    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    where.statusId = intEq(query.statusId);
    where.handoverWorkerId = intEq(query.handoverWorkerId);
    where.technologistId = intEq(query.technologistId);
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      where.handoverDate = range;
    }

    const drawingIdSets: number[][] = [];
    if (query.drawingNumber) {
      const drawings = await this.prisma.drawing.findMany({
        where: {
          drawingNumber: { contains: query.drawingNumber, mode: "insensitive" },
        },
        select: { id: true },
      });
      drawingIdSets.push(drawings.map((d) => d.id));
    }
    const projectId = intEq(query.projectId);
    if (projectId !== undefined) {
      drawingIdSets.push(await this.resolveProjectDrawingIds(projectId));
    }
    if (drawingIdSets.length) {
      const [first, ...rest] = drawingIdSets;
      const intersected = rest.reduce(
        (acc, set) => acc.filter((id) => set.includes(id)),
        first,
      );
      where.drawingId = { in: intersected };
    }

    // Filter po broju RN-a: `drawing_handovers` nema RN (RN je vidljiv samo u
    // prelaznom stanju „otkucan a nelansiran"), pa se razrešava preko soft FK-a
    // `work_orders.drawing_handover_id`. Prazan skup → prazna strana (tačno).
    if (query.rn) {
      const workOrders = await this.prisma.workOrder.findMany({
        where: {
          identNumber: { contains: query.rn, mode: "insensitive" },
          drawingHandoverId: { gt: 0 },
        },
        select: { drawingHandoverId: true },
      });
      where.id = {
        in: [...new Set(workOrders.map((w) => w.drawingHandoverId))],
      };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.drawingHandover.findMany({
        where,
        orderBy: [{ handoverDate: "desc" }, { id: "desc" }],
        skip,
        take,
        select: HANDOVER_SELECT,
      }),
      this.prisma.drawingHandover.count({ where }),
    ]);

    const data = await this.enrich(rows);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id },
      include: { handoverPdfs: true }, // to-many — bezbedno (§ pravilo o obaveznoj to-one relaciji se ne odnosi na ovo)
    });
    if (!handover)
      throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
    const [data] = await this.enrich([handover]);
    return { data };
  }

  /** Tehnolog inbox: `status = U OBRADI` (na čekanju), §6.5. */
  async pendingApproval(query: ListHandoversQuery) {
    return this.list({ ...query, statusId: String(HANDOVER_STATUS.PENDING) });
  }

  /** `GET /handovers/lookups` — draft statusi + handover statusi (§6.5). */
  async lookups() {
    const [draftStatuses, handoverStatuses] = await Promise.all([
      this.prisma.handoverDraftStatus.findMany({ orderBy: { id: "asc" } }),
      this.prisma.handoverStatus.findMany({ orderBy: { id: "asc" } }),
    ]);
    return { data: { draftStatuses, handoverStatuses } };
  }

  /**
   * `GET /handovers/technologists` — aktivni radnici vrste „Tehnolog"
   * (worker_types po imenu, legacy paritet `tRadnici.IDVrsteRadnika=1`; P4
   * spec §6.3, odluka #2 — `defines_approval` je NAPUŠTEN za ovaj kriterijum).
   * Zajednički helper = isti izvor istine kao approve validacija, take-over
   * gate i notifikacije. Samo id/fullName/username (§3.4/§8.3).
   */
  async technologists() {
    const where = await technologistWorkerWhere(this.prisma);
    if (!where) return { data: [] };
    const data = await this.prisma.worker.findMany({
      where,
      select: SAFE_WORKER_SELECT,
      orderBy: { fullName: "asc" },
    });
    return { data };
  }

  /**
   * `GET /handovers/engineers` — AKTIVNI radnici vrste „Inženjeri" za
   * projektant-picker u nacrtu (živa proba 13.07: slobodan unos šifre je
   * dozvolio neaktivnog operatera). Isti oblik kao `technologists()`.
   */
  async engineers() {
    const where = await engineerWorkerWhere(this.prisma);
    if (!where) return { data: [] };
    const data = await this.prisma.worker.findMany({
      where,
      select: SAFE_WORKER_SELECT,
      orderBy: { fullName: "asc" },
    });
    return { data };
  }

  /**
   * Odobravači primopredaje — fiksnih 6 (PRIMOPREDAJA_APPROVERS, Nenad 13.07),
   * filtrirano na AKTIVNE radnike (neaktivan odobravač se ne nudi). Vraća isti
   * oblik kao engineers/technologists (id/fullName/username) da FE picker deli
   * komponentu. Redosled po imenu.
   */
  async approvers() {
    const ids = PRIMOPREDAJA_APPROVERS.map((a) => a.workerId);
    const data = await this.prisma.worker.findMany({
      where: { id: { in: ids }, active: true },
      select: SAFE_WORKER_SELECT,
      orderBy: { fullName: "asc" },
    });
    return { data };
  }

  /**
   * `GET /handovers/writing-stats` — pregled „na pisanju tehnologije" (Miljan
   * t.9): SAGLASAN + dodeljen tehnolog (lansiranjem status prelazi u LANSIRAN,
   * pa filter po statusu implicitno isključuje lansirane). Brojači po tehnologu
   * i po predmetu; predmet se razrešava preko draft konteksta crteža — isti
   * izvor istine kao `enrich()` (`resolveDraftContext`). Skup „na pisanju" je
   * operativno mali (desetine redova), pa se broji u servisu umesto groupBy
   * (predmet nije kolona primopredaje već izveden odnos).
   */
  async writingStats() {
    const rows = await this.prisma.drawingHandover.findMany({
      where: {
        statusId: HANDOVER_STATUS.APPROVED,
        technologistId: { gt: 0 },
      },
      select: { id: true, drawingId: true, technologistId: true },
    });

    const [workers, draftCtx] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.technologistId)),
      this.resolveDraftContext(rows.map((r) => r.drawingId)),
    ]);
    const projectIds = uniqueIds(
      [...draftCtx.values()].map((c) => c.projectId),
    );
    const projects = byId(
      await this.prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, projectNumber: true, description: true },
      }),
    );

    const techCounts = new Map<number, number>();
    const projectCounts = new Map<number | null, number>();
    for (const r of rows) {
      techCounts.set(
        r.technologistId,
        (techCounts.get(r.technologistId) ?? 0) + 1,
      );
      const projectId = draftCtx.get(r.drawingId)?.projectId ?? null;
      projectCounts.set(projectId, (projectCounts.get(projectId) ?? 0) + 1);
    }

    const byTechnologist = [...techCounts.entries()]
      .map(([workerId, count]) => ({
        workerId,
        fullName: workers.get(workerId)?.fullName ?? null,
        count,
      }))
      .sort((a, b) => b.count - a.count);
    const byProject = [...projectCounts.entries()]
      .map(([projectId, count]) => ({
        projectId,
        code:
          projectId != null
            ? (projects.get(projectId)?.projectNumber ?? null)
            : null,
        name:
          projectId != null
            ? (projects.get(projectId)?.description ?? null)
            : null,
        count,
      }))
      .sort((a, b) => b.count - a.count);

    return { data: { total: rows.length, byTechnologist, byProject } };
  }

  // ------------------------------------------------------------ WORKFLOW

  /**
   * Odobri primopredaju (§6.4 + P1): šef tehnologije OBAVEZNO bira tehnologa
   * (`technologistId`) koji piše TP. Tehnolog mora biti AKTIVAN radnik vrste
   * „Tehnolog" (zajednički helper, P4 spec §6.3 — isti kriterijum kao
   * `GET /handovers/technologists`; `defines_approval` je napušten za ovaj
   * kriterijum i ostaje samo RN-level approve/launch gate, §6.2). Opcioni
   * `dueDate` (§6.5.1) upisuje rok izrade (`production_deadline`) koji se
   * kasnije propagira u RN. Uz tehnologa se pišu i audit kolone
   * `technologist_assigned_at/by` (isti mehanizam kao take-over).
   * Preduslov: status U OBRADI.
   */
  async approve(id: number, dto: ApproveHandoverDto, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const technologistId = dto?.technologistId;
    if (
      typeof technologistId !== "number" ||
      !Number.isInteger(technologistId) ||
      technologistId <= 0
    )
      throw new UnprocessableEntityException(
        "Tehnolog (technologistId) je obavezan — pozitivan ceo broj.",
      );
    // `status_change_comment` je VarChar(250) — ista provera kao reject/return,
    // inače Prisma P2000 → goli 500 umesto 422.
    const comment = dto?.comment?.trim() || undefined;
    if (comment && comment.length > 250)
      throw new UnprocessableEntityException(
        "Komentar može imati najviše 250 karaktera.",
      );
    // `new Date("bilo šta")` = Invalid Date → PrismaClientValidationError →
    // goli 500; validiraj rok pre bilo kakvog upisa (ista provera kao launch).
    const dueDate = parseDateParam(dto?.dueDate, "dueDate");

    const technologist = await this.prisma.worker.findUnique({
      where: { id: technologistId },
      select: TECHNOLOGIST_CHECK_SELECT,
    });
    if (!technologist)
      throw new UnprocessableEntityException(
        `Tehnolog ${technologistId} ne postoji.`,
      );
    if (!(await isActiveTechnologist(this.prisma, technologist)))
      throw new UnprocessableEntityException(
        `Radnik ${technologistId} nije aktivan radnik vrste "Tehnolog" — izaberite tehnologa sa /handovers/technologists liste.`,
      );

    await this.transition(id, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.APPROVED,
      comment,
      actorWorkerId,
      extra: {
        technologistId,
        technologistAssignedAt: new Date(),
        technologistAssignedById: actorWorkerId,
        // `?? null` (ne undefined): approve bez roka mora da OBRIŠE eventualni
        // stari rok — approve je autoritativan za rok (return-to-pending ga
        // ionako prazni, ali budi eksplicitan).
        productionDeadline: dueDate ?? null,
        // HITNO (t.10): approve je autoritativan i za urgentnost — izostanak
        // flaga je eksplicitno false (legacy: crvena nalepnica se lepi pri
        // slanju tehnolozima, tj. tačno u ovom koraku).
        isUrgent: dto?.isUrgent === true,
      },
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odobrena.",
    });
    return this.findOne(id);
  }

  /**
   * GRUPNO odobravanje (proba 13.07, Miljan; legacy paritet:
   * `spPromeniStatusPrimopredaje` statuse 0/1/2 radi grupno po nacrtu).
   * Isti tehnolog/rok/HITNO/komentar za sve; per-red guardovi (PENDING,
   * otključan, ne-legacy) kroz uslovni `updateMany` — redovi koji ne prolaze
   * se preskaču i vraćaju u `skipped` sa razlogom (best-effort, kao legacy
   * grupni UPDATE). Lansiranje NIJE grupno (legacy je per-RN).
   */
  async approveBatch(dto: ApproveHandoverBatchDto, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const ids = validateHandoverIds(dto?.handoverIds);
    const technologistId = dto?.technologistId;
    if (
      typeof technologistId !== "number" ||
      !Number.isInteger(technologistId) ||
      technologistId <= 0
    )
      throw new UnprocessableEntityException(
        "Tehnolog (technologistId) je obavezan — pozitivan ceo broj.",
      );
    const comment = dto?.comment?.trim() || undefined;
    if (comment && comment.length > 250)
      throw new UnprocessableEntityException(
        "Komentar može imati najviše 250 karaktera.",
      );
    const dueDate = parseDateParam(dto?.dueDate, "dueDate");

    const technologist = await this.prisma.worker.findUnique({
      where: { id: technologistId },
      select: TECHNOLOGIST_CHECK_SELECT,
    });
    if (!technologist)
      throw new UnprocessableEntityException(
        `Tehnolog ${technologistId} ne postoji.`,
      );
    if (!(await isActiveTechnologist(this.prisma, technologist)))
      throw new UnprocessableEntityException(
        `Radnik ${technologistId} nije aktivan radnik vrste "Tehnolog" — izaberite tehnologa sa /handovers/technologists liste.`,
      );

    const result = await this.batchTransition(ids, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.APPROVED,
      comment,
      actorWorkerId,
      extra: {
        technologistId,
        technologistAssignedAt: new Date(),
        technologistAssignedById: actorWorkerId,
        productionDeadline: dueDate ?? null,
        isUrgent: dto?.isUrgent === true,
      },
    });
    // HTTP payload unchanged ({ approved, skipped }) — `transitioned` is
    // internal (used only by rejectBatch for generator notifications).
    return { data: { approved: result.approved, skipped: result.skipped } };
  }

  /** GRUPNO odbijanje (legacy paritet: status 2 grupno). `reason` OBAVEZAN. */
  async rejectBatch(dto: RejectHandoverBatchDto, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const ids = validateHandoverIds(dto?.handoverIds);
    const reason = dto?.reason?.trim();
    if (!reason)
      throw new UnprocessableEntityException("Razlog odbijanja je obavezan.");
    if (reason.length > 250)
      throw new UnprocessableEntityException(
        "Razlog odbijanja može imati najviše 250 karaktera.",
      );

    const result = await this.batchTransition(ids, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.REJECTED,
      comment: reason,
      actorWorkerId,
    });
    // AFTER the transaction, best-effort (D8): one mail + in-app notification
    // per generator, only for the rows that actually transitioned.
    if (result.transitioned.length)
      await this.notifyRejected(result.transitioned, reason, actorWorkerId);
    return { data: { approved: result.approved, skipped: result.skipped } };
  }

  /**
   * Zajednički grupni prelaz: pre-check po redu (postojanje/status/lock/legacy
   * → `skipped` sa srpskim razlogom), pa JEDAN uslovni `updateMany` nad
   * preostalima (isti guard `where` kao `transition()` — konkurentna promena
   * ne biva pregažena, samo završi u skipped kao „promenjena u međuvremenu").
   *
   * Returns `{ approved, skipped, transitioned }`; `transitioned` lists the
   * rows that ACTUALLY changed status (id + generator + drawing) so callers
   * can notify only for real transitions (rejectBatch mail). Callers wrap the
   * HTTP payload themselves — the response shape stays `{ approved, skipped }`.
   */
  private async batchTransition(
    ids: number[],
    opts: {
      from: number;
      to: number;
      comment?: string;
      actorWorkerId: number | null;
      extra?: Prisma.DrawingHandoverUncheckedUpdateManyInput;
    },
  ): Promise<{
    approved: number;
    skipped: { id: number; reason: string }[];
    transitioned: RejectedHandoverRef[];
  }> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.drawingHandover.findMany({
        where: { id: { in: ids } },
        // handoverWorkerId/drawingId are not needed for the transition itself —
        // they ride along so callers can notify generators without a re-read.
        select: {
          id: true,
          statusId: true,
          isLocked: true,
          legacyRnId: true,
          handoverWorkerId: true,
          drawingId: true,
        },
      });
      const byIdMap = new Map(rows.map((r) => [r.id, r]));

      const skipped: { id: number; reason: string }[] = [];
      const eligible: number[] = [];
      const eligibleRows: RejectedHandoverRef[] = [];
      for (const id of ids) {
        const row = byIdMap.get(id);
        if (!row) skipped.push({ id, reason: "Primopredaja ne postoji." });
        else if (
          row.legacyRnId != null &&
          process.env.HANDOVER_LEGACY_GUARD !== "false"
        )
          skipped.push({
            id,
            reason: "Legacy primopredaja — do cutover-a se menja u QBigTehn-u.",
          });
        else if (row.isLocked)
          skipped.push({ id, reason: "Primopredaja je zaključana." });
        else if (row.statusId !== opts.from)
          skipped.push({
            id,
            reason: "Nije više na čekanju (status promenjen).",
          });
        else {
          eligible.push(id);
          eligibleRows.push({
            id: row.id,
            handoverWorkerId: row.handoverWorkerId,
            drawingId: row.drawingId,
          });
        }
      }

      let approved = 0;
      let transitioned: RejectedHandoverRef[] = [];
      if (eligible.length) {
        const updated = await tx.drawingHandover.updateMany({
          where: {
            id: { in: eligible },
            statusId: opts.from,
            isLocked: false,
          },
          data: {
            statusId: opts.to,
            statusChangedAt: new Date(),
            statusChangedById: opts.actorWorkerId,
            statusChangeComment: opts.comment ?? null,
            ...opts.extra,
          },
        });
        approved = updated.count;
        if (approved === eligible.length) {
          // Common case: every eligible row moved — no re-read needed.
          transitioned = eligibleRows;
        } else {
          // Concurrent change between pre-check and update: the conditional
          // `where` skipped some rows. Re-read (same tx) which rows actually
          // reached the target status, so notifications go only to real
          // transitions and the rest is reported as skipped (precisely, not
          // "first N" as before).
          transitioned = await tx.drawingHandover.findMany({
            where: { id: { in: eligible }, statusId: opts.to },
            select: { id: true, handoverWorkerId: true, drawingId: true },
          });
          const movedIds = new Set(transitioned.map((r) => r.id));
          skipped.push(
            ...eligible
              .filter((id) => !movedIds.has(id))
              .map((id) => ({
                id,
                reason: "Promenjena u međuvremenu — osvežite listu.",
              })),
          );
        }
      }
      return { approved, skipped, transitioned };
    });
  }

  /** Odbij primopredaju. `reason` je OBAVEZAN (razlika od approve), §6.4. */
  async reject(id: number, reason: string, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    if (!reason || !reason.trim())
      throw new UnprocessableEntityException("Razlog odbijanja je obavezan.");
    if (reason.trim().length > 250)
      throw new UnprocessableEntityException(
        "Razlog odbijanja može imati najviše 250 karaktera.",
      );

    await this.transition(id, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.REJECTED,
      comment: reason.trim(),
      actorWorkerId,
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odbijena.",
    });
    // AFTER the transaction, best-effort (D8): mail + in-app notification to
    // the generator. The re-read is guarded too (`.catch`) — a failed lookup
    // must not break a reject that already committed.
    const rejectedRow = await this.prisma.drawingHandover
      .findUnique({
        where: { id },
        select: { id: true, handoverWorkerId: true, drawingId: true },
      })
      .catch(() => null);
    if (rejectedRow)
      await this.notifyRejected([rejectedRow], reason.trim(), actorWorkerId);
    return this.findOne(id);
  }

  /**
   * "Vrati na čekanje" — undo odobravanja (SAGLASAN → U OBRADI) + čišćenje
   * dodeljenog tehnologa. Blokirano (409) ako za primopredaju već postoji RN
   * (prepare/launch tok): odluka o storniranju RN-a je otvorena, pa poruka
   * upućuje da se RN prvo obriše/razreši. `reason` ide u postojeće
   * `status_change_comment` polje.
   */
  async returnToPending(id: number, dto?: ReturnHandoverDto, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const reason = dto?.reason?.trim() || undefined;
    if (reason && reason.length > 250)
      throw new UnprocessableEntityException(
        "Razlog može imati najviše 250 karaktera.",
      );

    await this.prisma.$transaction(async (tx) => {
      // Isti advisory lock kao prepare/launch: bez njega konkurentni prepare
      // (kreira RN u još nekomitovanoj transakciji) ili launch (drži row-lock
      // na primopredaji) prođu pored guard-a "RN postoji → 409" i undo prepiše
      // lansiranu/pripremljenu primopredaju. Provere ispod čitaju SVEŽE stanje
      // tek POSLE lock-a.
      await this.lockHandoverWorkOrder(tx, id);

      const handover = await tx.drawingHandover.findUnique({
        where: { id },
        select: { id: true, statusId: true, isLocked: true, legacyRnId: true },
      });
      if (!handover)
        throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
      this.assertNotLegacyGuarded(handover);
      if (handover.isLocked)
        throw new UnprocessableEntityException("Primopredaja je zaključana.");
      if (handover.statusId !== HANDOVER_STATUS.APPROVED)
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN da bi bila vraćena na čekanje.",
        );

      const workOrder = await this.findHandoverWorkOrder(tx, id);
      if (workOrder)
        throw new ConflictException(
          `Za ovu primopredaju već postoji RN ${workOrder.identNumber} — prvo obrišite/razrešite RN, pa vratite primopredaju na čekanje (storniranje RN-a je otvorena odluka).`,
        );

      await tx.drawingHandover.update({
        where: { id },
        data: {
          statusId: HANDOVER_STATUS.PENDING,
          technologistId: 0, // undo dodele tehnologa
          // Uz undo tehnologa se prazne i audit kolone dodele (nema „tekućeg"
          // tehnologa → nema ni „kada/ko dodelio") i rok unet pri odobravanju
          // (§6.5.1 — sledeći approve upisuje svež rok).
          technologistAssignedAt: null,
          technologistAssignedById: null,
          productionDeadline: null,
          isUrgent: false, // sledeći approve ponovo odlučuje o hitnosti
          statusChangedAt: new Date(),
          statusChangedById: actorWorkerId,
          // `?? null` (ne undefined): undo bez razloga mora da OBRIŠE komentar
          // prethodnog prelaza (approve poruku) — undefined bi ga tiho zadržao.
          statusChangeComment: reason ?? null,
        },
      });
    });
    return this.findOne(id);
  }

  /**
   * „Preuzmi izradu" (P4 spec §6.4, odluka #4): bilo koji AKTIVAN radnik vrste
   * „Tehnolog" (isti helper kao §6.3; permisioni gate `primopredaje.write` je u
   * kontroleru — worker-type provera je drugi, precizniji gate) preuzima
   * zaduženje na SAGLASNOJ, nezaključanoj, ne-legacy primopredaji. Legacy
   * paritet: `UPDATE tRN SET SifraRadnika` — tehnolozi „jedni drugima imaju
   * pravo da pomažu". `technologist_id` se PREPIŠE (prvobitno dodeljeni se ne
   * pamti), audit ide u `technologist_assigned_at/by`; ako postoji pripremljen
   * RN koji nije lansiran/zaključan, i `work_orders.worker_id` prelazi na
   * preuzimaoca (bez toga bi kartica RN-a pokazivala starog tehnologa).
   * Idempotentno: već moj → 200 `{ alreadyOwner: true }` bez upisa.
   * NAPOMENA (prihvaćeno odstupanje): `alreadyOwner` je top-level ključ pored
   * `data` — doslovna forma iz spec §6.4 („200 {alreadyOwner: true}"), svesno
   * van envelope ugovora BACKEND_RULES §5 ({ data, meta }); FE tip
   * (api/handovers.ts) je vezan za ovaj oblik — ne „popravljati" bez FE-a.
   * Konkurentnost: uslovni `updateMany` — poslednji pobeđuje (poslovno
   * prihvatljivo), ali launch/lock u međuvremenu obara na 409.
   */
  async takeOver(id: number, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik) — inače
    // bi tehnolog čiji je radnik vezan posle logina bio blokiran 422 dok se ne
    // re-loguje (ista zamka kao nacrti create, proba 13.07 Igor).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    if (!actorWorkerId || actorWorkerId <= 0)
      throw new UnprocessableEntityException(
        'Nalog nije vezan za radnika (users.worker_id) — preuzimanje izrade zahteva aktivnog radnika vrste "Tehnolog".',
      );
    const worker = await this.prisma.worker.findUnique({
      where: { id: actorWorkerId },
      select: TECHNOLOGIST_CHECK_SELECT,
    });
    if (!worker || !(await isActiveTechnologist(this.prisma, worker)))
      throw new UnprocessableEntityException(
        'Samo aktivan radnik vrste "Tehnolog" može preuzeti izradu primopredaje.',
      );

    let alreadyOwner = false;
    let previousTechnologistId = 0;

    await this.prisma.$transaction(async (tx) => {
      // Isti advisory lock kao prepare/launch: serijalizuje take-over sa
      // prepare/launch/return tokovima nad istom primopredajom, pa su provere
      // ispod (i RN update dole) pouzdane u odnosu na te tokove.
      await this.lockHandoverWorkOrder(tx, id);

      const handover = await tx.drawingHandover.findUnique({
        where: { id },
        select: {
          id: true,
          statusId: true,
          isLocked: true,
          legacyRnId: true,
          technologistId: true,
        },
      });
      if (!handover)
        throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
      // Do cutover-a se preuzimanje radi u QBigTehn-u — nativni upis bi
      // pregazio sledeći derivacioni run.
      this.assertNotLegacyGuarded(handover);
      // 409 (ne 422 kao drugde za isLocked): zaključanost je ovde posledica
      // lansiranja — konflikt stanja, ne nevalidan zahtev.
      if (handover.isLocked)
        throw new ConflictException(
          "Primopredaja je zaključana — izrada se ne može preuzeti.",
        );
      if (handover.statusId !== HANDOVER_STATUS.APPROVED)
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN (odobrena, pre lansiranja) da bi se izrada preuzela.",
        );

      if (handover.technologistId === actorWorkerId) {
        alreadyOwner = true; // idempotentno — bez upisa
        return;
      }
      previousTechnologistId = handover.technologistId;

      // Uslovni updateMany (obrazac iz transition()): konkurentni launch/lock
      // ne uzima uvek naš advisory lock (npr. RN-level launch propagacija), pa
      // where ponavlja preduslove — gubitnik pada na 409 umesto da pregazi.
      const updated = await tx.drawingHandover.updateMany({
        where: { id, statusId: HANDOVER_STATUS.APPROVED, isLocked: false },
        data: {
          technologistId: actorWorkerId,
          technologistAssignedAt: new Date(),
          technologistAssignedById: actorWorkerId, // preuzimalac = sam sebi
        },
      });
      if (updated.count === 0)
        throw new ConflictException(
          "Primopredaja je u međuvremenu promenjena (lansirana/zaključana) — osvežite pregled.",
        );

      // Pripremljen RN („Otkucaj TP") koji NIJE lansiran/zaključan prati
      // tehnologa (legacy paritet: tRN JESTE RN pa SifraRadnika menja i
      // vlasnika naloga). Lansiran/zaključan RN se NE dira.
      // `work_orders.is_locked` je Boolean? (legacy sync iz tRN.Zakljucano
      // ostavlja NULL) — spoljna provera `!workOrder.isLocked` NULL tretira
      // kao otključan, pa i where mora da uhvati NULL (eksplicitni OR;
      // `isLocked: false` NE matchuje NULL → worker_id se tiho ne prepiše).
      const workOrder = await this.findHandoverWorkOrder(tx, id);
      if (
        workOrder &&
        !workOrder.isLocked &&
        workOrder.handoverStatusId !== HANDOVER_STATUS.LAUNCHED
      ) {
        await tx.workOrder.updateMany({
          where: {
            id: workOrder.id,
            OR: [{ isLocked: false }, { isLocked: null }],
            handoverStatusId: { not: HANDOVER_STATUS.LAUNCHED },
          },
          data: { workerId: actorWorkerId },
        });
      }
    });

    // Notifikacija prethodnom tehnologu (spec §8 #12): POSLE transakcije,
    // best-effort — pad notifikacije ne obara preuzimanje.
    if (!alreadyOwner && previousTechnologistId > 0)
      await this.notifyTakeOver(id, previousTechnologistId, actorWorkerId);

    const detail = await this.findOne(id);
    return alreadyOwner ? { ...detail, alreadyOwner: true } : detail;
  }

  /**
   * Emit „NN je preuzeo izradu za primopredaju X" prethodnom tehnologu —
   * best-effort obrazac iz `handover-drafts.notifySubmitted` (26d3538): ceo u
   * try/catch, greška se loguje i guta jer je mutacija već uspela.
   */
  private async notifyTakeOver(
    handoverId: number,
    previousTechnologistId: number,
    actorWorkerId: number,
  ): Promise<void> {
    try {
      const workers = await this.resolveWorkers([actorWorkerId]);
      const actorRef = workers.get(actorWorkerId);
      const actorName =
        actorRef?.fullName || actorRef?.username || `#${actorWorkerId}`;
      const created = await this.notifications.notifyWorkers(
        [previousTechnologistId],
        {
          type: "primopredaja.preuzeta",
          message: `${actorName} je preuzeo izradu za primopredaju ${handoverId}`,
          refTable: "drawing_handovers",
          refId: handoverId,
        },
      );
      this.logger.log(
        `Notifikacija primopredaja.preuzeta (primopredaja ${handoverId}): ${created} primalaca`,
      );
    } catch (e) {
      this.logger.error(
        `Notifikacija primopredaja.preuzeta FAIL (primopredaja ${handoverId}): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Emit "handover rejected" to the generators — the draft designers
   * (`handover_drafts.designer_id`, copied into
   * `drawing_handovers.handover_worker_id` on submit): ONE in-app notification
   * + ONE mail per generator with the list of rejected drawings (number +
   * name), the rejection reason and the rejector's name. Called AFTER the
   * transaction, best-effort (D8, same pattern as
   * `handover-drafts.notifyApprover`): the whole method never throws — each
   * channel runs in its own try/catch. `workers` has no email column, so the
   * address comes from the linked `users` account; a generator without one is
   * logged and skipped (in-app notification still goes out by workerId).
   */
  private async notifyRejected(
    rejected: RejectedHandoverRef[],
    reason: string,
    actorWorkerId: number | null,
  ): Promise<void> {
    try {
      const byWorker = new Map<number, RejectedHandoverRef[]>();
      for (const row of rejected) {
        if (row.handoverWorkerId > 0) {
          const list = byWorker.get(row.handoverWorkerId) ?? [];
          list.push(row);
          byWorker.set(row.handoverWorkerId, list);
        }
      }
      if (!byWorker.size) return;

      const [drawings, workers] = await Promise.all([
        this.resolveDrawings(rejected.map((r) => r.drawingId)),
        this.resolveWorkers([actorWorkerId]),
      ]);
      const actorRef =
        actorWorkerId != null ? workers.get(actorWorkerId) : undefined;
      const actorName = actorRef?.fullName || actorRef?.username || "Odobravač";

      for (const [workerId, rows] of byWorker) {
        const labels = rows.map((r) => {
          const d = drawings.get(r.drawingId);
          return d ? `${d.drawingNumber} — ${d.name}` : `crtež #${r.drawingId}`;
        });
        const subject =
          rows.length === 1
            ? `Primopredaja odbijena — ${
                drawings.get(rows[0].drawingId)?.drawingNumber ??
                `crtež #${rows[0].drawingId}`
              }`
            : `Primopredaja odbijena — ${stavkaLabel(rows.length)}`;
        const message =
          rows.length === 1
            ? `${actorName} je odbio primopredaju za crtež ${labels[0]}. Razlog: ${reason}`
            : `${actorName} je odbio ${stavkaLabel(rows.length)} primopredaje (${labels.join("; ")}). Razlog: ${reason}`;

        try {
          await this.notifications.notifyWorkers([workerId], {
            type: "primopredaja.odbijena",
            message,
            refTable: "drawing_handovers",
            refId: rows[0].id,
          });
        } catch (e) {
          this.logger.error(
            `In-app notifikacija primopredaja.odbijena generatoru ${workerId} FAIL: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        try {
          const user = await this.prisma.user.findFirst({
            where: { workerId },
            select: { email: true, fullName: true },
          });
          if (!user?.email) {
            this.logger.warn(
              `Generator ${workerId} nema users nalog (email) — mejl o odbijanju preskočen (primopredaje: ${rows.map((r) => r.id).join(", ")}).`,
            );
            continue;
          }
          await this.mail.send({
            to: user.email,
            subject,
            html:
              `<p>${user.fullName ? `Poštovani ${user.fullName},` : "Poštovani,"}</p>` +
              `<p>${actorName} je odbio sledeće stavke primopredaje:</p>` +
              `<ul>${labels.map((l) => `<li>${l}</li>`).join("")}</ul>` +
              `<p>Razlog odbijanja: <strong>${reason}</strong></p>` +
              `<p>— ServoSync</p>`,
          });
        } catch (e) {
          this.logger.error(
            `Mejl primopredaja.odbijena generatoru ${workerId} FAIL: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } catch (e) {
      // Shared lookups (drawings/actor) failed — log and swallow, the reject
      // itself already committed.
      this.logger.error(
        `Notifikacija primopredaja.odbijena FAIL: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Tranziciona politika do cutover-a: derivirani redovi (`legacyRnId != null`,
   * izvedeni iz tRN derivacionim sync-om) se odobravaju/odbijaju/lansiraju u
   * QBigTehn-u (Miljan) — mutacija ovde bi bila pregažena sledećim sync-om, pa
   * je blokirana sa 409. UKIDANJE NA CUTOVER: `HANDOVER_LEGACY_GUARD=false` u
   * backend.env + compose up (isti rollback obrazac kao AUTHZ_ENFORCE, bez
   * deploy-a); kolona `legacy_rn_id` ostaje kao provenance. Nativni redovi
   * (`legacyRnId == null`) nisu blokirani.
   */
  private assertNotLegacyGuarded(h: { legacyRnId: number | null }): void {
    if (h.legacyRnId != null && process.env.HANDOVER_LEGACY_GUARD !== "false")
      throw new ConflictException(
        "Legacy primopredaja iz QBigTehn-a — do prelaska (cutover) odobravanje/odbijanje/lansiranje se radi u QBigTehn; izmene ovde bi bile pregažene sledećim sync-om.",
      );
  }

  private async transition(
    id: number,
    opts: {
      from: number;
      to: number;
      comment?: string;
      wrongStateMessage: string;
      /** Radnik iz JWT-a (`users.worker_id`) koji izvodi prelaz. */
      actorWorkerId?: number | null;
      /** Dodatne kolone koje se upisuju atomično sa prelazom (npr. technologistId). */
      extra?: Prisma.DrawingHandoverUncheckedUpdateManyInput;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const handover = await tx.drawingHandover.findUnique({
        where: { id },
        select: { id: true, statusId: true, isLocked: true, legacyRnId: true },
      });
      if (!handover)
        throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
      this.assertNotLegacyGuarded(handover);
      if (handover.isLocked)
        throw new UnprocessableEntityException("Primopredaja je zaključana.");
      if (handover.statusId !== opts.from)
        throw new ConflictException(opts.wrongStateMessage);

      // Uslovni update (obrazac iz work-orders.launch): konkurentni approve i
      // reject u READ COMMITTED oba prođu guard iznad, drugi bi bezuslovnim
      // update-om pregazio prvog (npr. reject prepiše approve, a technologistId
      // ostane dodeljen) — where po from-statusu ga umesto toga obara na 409.
      const updated = await tx.drawingHandover.updateMany({
        where: { id, statusId: opts.from, isLocked: false },
        data: {
          statusId: opts.to,
          statusChangedAt: new Date(),
          statusChangedById: opts.actorWorkerId ?? null,
          // `?? null` (ne undefined): prelaz bez komentara mora da OBRIŠE
          // komentar prethodnog prelaza — undefined bi ga tiho zadržao uz
          // novi statusChangedAt/By audit.
          statusChangeComment: opts.comment ?? null,
          ...opts.extra,
        },
      });
      if (updated.count === 0)
        throw new ConflictException(opts.wrongStateMessage);
    });
  }

  /**
   * "Otkucaj TP" (P1) — kreiraj RN za odobrenu primopredaju BEZ lansiranja, da
   * tehnolog može da kuca tehnološki postupak. Idempotentno: ako RN za ovu
   * primopredaju već postoji (prepare ili launch tok), vraća njega
   * (`existing: true`) umesto duplikata. RN se kreira ISTOM logikom zaglavlja
   * kao `launch()` (zajednički helper `createHandoverWorkOrder`), ali:
   * `handoverStatusId = SAGLASAN` (ne LANSIRAN), BEZ launch reda, primopredaja
   * OSTAJE u statusu SAGLASAN — kasniji launch podiže oba na LANSIRAN.
   */
  async prepareWorkOrder(id: number, actor?: AuthUser) {
    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik) — inače
    // se autor RN-a (kad tehnolog nije dodeljen) tiho beleži kao radnik 0.
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const handover = await this.getHandoverForWorkOrder(id);
    // Pre idempotentnog izlaza: i "samo vrati postojeći RN" tok je deo mutirajuće
    // radnje koja se do cutover-a radi u QBigTehn-u za derivirane redove.
    this.assertNotLegacyGuarded(handover);

    // Brzi idempotentni izlaz (van transakcije; race pokriva advisory lock dole).
    const preExisting = await this.findHandoverWorkOrder(this.prisma, id);
    if (preExisting)
      return {
        data: {
          workOrderId: preExisting.id,
          identNumber: preExisting.identNumber,
          existing: true,
        },
      };

    if (handover.isLocked)
      throw new UnprocessableEntityException("Primopredaja je zaključana.");
    if (handover.statusId !== HANDOVER_STATUS.APPROVED)
      throw new ConflictException(
        "Primopredaja mora biti SAGLASAN da bi se otkucao TP (kreirao RN).",
      );

    const ctx = await this.loadWorkOrderContext(handover);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockHandoverWorkOrder(tx, id);

      const fresh = await tx.drawingHandover.findUnique({
        where: { id },
        select: { statusId: true, isLocked: true, legacyRnId: true },
      });
      if (
        !fresh ||
        fresh.isLocked ||
        fresh.statusId !== HANDOVER_STATUS.APPROVED
      )
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN da bi se otkucao TP (kreirao RN).",
        );
      // Sveže stanje posle lock-a: derivacioni sync je mogao da označi red.
      this.assertNotLegacyGuarded(fresh);

      // Guard protiv duplog RN-a: konkurentni prepare/launch je serijalizovan
      // advisory lock-om, pa je ova ponovna provera pouzdana.
      const raced = await this.findHandoverWorkOrder(tx, id);
      if (raced)
        return {
          workOrderId: raced.id,
          identNumber: raced.identNumber,
          existing: true,
        };

      const workOrder = await this.createHandoverWorkOrder(tx, {
        handover,
        ctx,
        handoverStatusId: HANDOVER_STATUS.APPROVED, // NE lansiran — samo TP kucanje
        actorWorkerId,
      });
      return {
        workOrderId: workOrder.id,
        identNumber: workOrder.identNumber,
        existing: false,
      };
    });

    return { data: result };
  }

  /**
   * 🔴 Lansiraj primopredaju → RN (§6.4/§7.5). Preduslov: status SAGLASAN.
   * Ako RN za primopredaju VEĆ postoji (prepare-work-order tok), ne kreira se
   * dupli — postojećem se podiže `handoverStatusId` na LANSIRAN (+ rok/komentar
   * iz tela ako su prosleđeni); u oba toka se kreira launch red i primopredaja
   * ide na LANSIRAN + zaključavanje. Guard protiv duplog RN-a = advisory lock
   * po primopredaji (isti u prepare toku).
   */
  async launch(id: number, dto: LaunchHandoverDto, actor?: AuthUser) {
    // `status_change_comment` je VarChar(250) — ista provera kao reject/return,
    // inače Prisma P2000 → goli 500 umesto 422.
    const comment = dto?.comment?.trim() || undefined;
    if (comment && comment.length > 250)
      throw new UnprocessableEntityException(
        "Komentar može imati najviše 250 karaktera.",
      );
    // `new Date("bilo šta")` = Invalid Date → PrismaClientValidationError →
    // goli 500; validiraj rok pre bilo kakvog upisa.
    const dueDate = parseDateParam(dto?.dueDate, "dueDate");

    const handover = await this.getHandoverForWorkOrder(id);
    this.assertNotLegacyGuarded(handover);
    if (handover.isLocked)
      throw new UnprocessableEntityException("Primopredaja je zaključana.");
    if (handover.statusId !== HANDOVER_STATUS.APPROVED)
      throw new ConflictException(
        "Primopredaja mora biti SAGLASAN pre lansiranja.",
      );

    // Kontekst (crtež/nacrt/predmet, 422 provere) treba samo ako RN još ne
    // postoji — prepare-kreiran RN već nosi kompletno zaglavlje.
    const preExisting = await this.findHandoverWorkOrder(this.prisma, id);
    const ctx = preExisting ? null : await this.loadWorkOrderContext(handover);

    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik).
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockHandoverWorkOrder(tx, id);

      const fresh = await tx.drawingHandover.findUnique({
        where: { id },
        select: { statusId: true, isLocked: true, legacyRnId: true },
      });
      if (
        !fresh ||
        fresh.isLocked ||
        fresh.statusId !== HANDOVER_STATUS.APPROVED
      )
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN pre lansiranja.",
        );
      // Sveže stanje posle lock-a: derivacioni sync je mogao da označi red.
      this.assertNotLegacyGuarded(fresh);

      const existing = await this.findHandoverWorkOrder(tx, id);
      let workOrder: Prisma.WorkOrderGetPayload<{
        select: typeof HANDOVER_WO_SELECT;
      }>;
      if (existing) {
        // Prepare tok: podigni POSTOJEĆI RN na LANSIRAN umesto kreiranja duplog.
        // Guard: RN-level approve/reject/lock ne dira primopredaju, pa postojeći
        // RN može biti ODBIJEN ili zaključan iako je primopredaja SAGLASAN —
        // lansiranje preko takvog RN-a bi zaobišlo RN-level guard-ove.
        if (
          existing.isLocked ||
          existing.handoverStatusId !== HANDOVER_STATUS.APPROVED
        )
          throw new ConflictException(
            `RN ${existing.identNumber} za ovu primopredaju je odbijen/zaključan — razrešite ga na Radnim nalozima pre lansiranja primopredaje.`,
          );
        const data: Prisma.WorkOrderUncheckedUpdateManyInput = {
          handoverStatusId: HANDOVER_STATUS.LAUNCHED,
        };
        if (dueDate) data.productionDeadline = dueDate;
        // `note` postojećeg RN-a se NE prepisuje: tehnolog je na prepare-
        // kreiranom RN-u mogao da upiše napomenu (updateHeader), a launch
        // komentar ionako ide u `drawing_handovers.status_change_comment`.
        // Uslovni update (obrazac iz work-orders.launch): konkurentni RN-level
        // launch/reject/lock ne uzima naš advisory lock, pa je posle gornjeg
        // čitanja mogao da promeni RN — bezuslovni update bi pregazio tuđi
        // prelaz (npr. ODBIJENO → LANSIRAN) i napravio dupli launch red.
        // OR hvata i `is_locked IS NULL` (legacy sync ostavlja NULL; provera
        // iznad NULL tretira kao otključan — `isLocked: false` ga NE matchuje
        // pa bi legacy RN davao trajni lažni 409).
        const updated = await tx.workOrder.updateMany({
          where: {
            id: existing.id,
            handoverStatusId: HANDOVER_STATUS.APPROVED,
            OR: [{ isLocked: false }, { isLocked: null }],
          },
          data,
        });
        if (updated.count === 0)
          throw new ConflictException(
            `RN ${existing.identNumber} je u međuvremenu promenjen (lansiran/odbijen/zaključan) — osvežite pregled.`,
          );
        const refreshed = await tx.workOrder.findUnique({
          where: { id: existing.id },
          select: HANDOVER_WO_SELECT,
        });
        if (!refreshed)
          throw new ConflictException(
            `RN ${existing.identNumber} je u međuvremenu obrisan — osvežite pregled.`,
          );
        workOrder = refreshed;
      } else {
        // `ctx` je null samo ako je RN postojao pri pre-checku pa je obrisan
        // pre lock-a (uska utrka) — učitaj kontekst u mestu umesto `ctx!`
        // (non-null assertion bi pukao sa TypeError → neočekivan 500).
        workOrder = await this.createHandoverWorkOrder(tx, {
          handover,
          ctx: ctx ?? (await this.loadWorkOrderContext(handover)),
          handoverStatusId: HANDOVER_STATUS.LAUNCHED,
          actorWorkerId,
          dueDate,
          comment,
        });
      }

      // Sync (tLansiranRN mapiranje) upisuje eksplicitne legacy id-jeve —
      // poravnaj sekvencu pre insert-a (isti obrazac kao `alignIdSequence`
      // za work_orders u createHandoverWorkOrder).
      await alignIdSequence(tx, "work_order_launches");
      await tx.workOrderLaunch.create({
        data: {
          workOrderId: workOrder.id,
          isLaunched: true,
          enteredAt: new Date(),
          createdByWorkerId: actorWorkerId ?? 0,
          updatedByWorkerId: actorWorkerId ?? 0,
        },
      });

      await tx.drawingHandover.update({
        where: { id },
        data: {
          statusId: HANDOVER_STATUS.LAUNCHED,
          statusChangedAt: new Date(),
          statusChangedById: actorWorkerId,
          // `?? null` (ne undefined): launch bez komentara mora da OBRIŠE
          // komentar prethodnog prelaza (approve poruku) uz novi audit.
          statusChangeComment: comment ?? null,
          launchedAt: new Date(),
          launchedById: actorWorkerId,
          isLocked: true,
        },
      });

      return { workOrder };
    });

    const handoverResp = await this.findOne(id);
    return {
      data: { handover: handoverResp.data, workOrder: result.workOrder },
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Zaglavlje primopredaje za launch/prepare tok (404 ako ne postoji). */
  private async getHandoverForWorkOrder(
    id: number,
  ): Promise<HandoverForWorkOrder> {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id },
      select: {
        id: true,
        drawingId: true,
        statusId: true,
        isLocked: true,
        handoverWorkerId: true,
        technologistId: true,
        legacyRnId: true,
        productionDeadline: true,
      },
    });
    if (!handover)
      throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
    return handover;
  }

  /**
   * Razreši kontekst za kreiranje RN-a iz primopredaje. `drawing_handovers`
   * NEMA `project_id`/`quantity` (samo `drawing_id`) — ti podaci dolaze iz
   * `handover_draft_items` sa istim `drawing_id` (`resolveDraftContext`,
   * best-effort veza jer nema direktnog FK-a u šemi). Ako veza ne postoji ili
   * je nepotpuna → 422, RN se NE kreira.
   */
  private async loadWorkOrderContext(handover: {
    id: number;
    drawingId: number;
  }): Promise<HandoverWorkOrderContext> {
    const draftCtx = (await this.resolveDraftContext([handover.drawingId])).get(
      handover.drawingId,
    );
    const drawing = await this.prisma.drawing.findUnique({
      where: { id: handover.drawingId },
      select: {
        id: true,
        drawingNumber: true,
        revision: true,
        name: true,
        material: true,
        dimensions: true,
      },
    });

    const missing: string[] = [];
    if (!drawing) missing.push("crtež");
    if (!draftCtx)
      missing.push(
        "predmet (nijedan nacrt/stavka nije povezan sa ovim crtežom)",
      );
    else if (!draftCtx.quantityToProduce || draftCtx.quantityToProduce < 1)
      missing.push("količina");
    if (missing.length)
      throw new UnprocessableEntityException(
        `Primopredaja nema sve obavezne podatke za kreiranje RN-a (${missing.join(", ")}) — RN nije kreiran.`,
      );

    const project = await this.prisma.project.findUnique({
      where: { id: draftCtx!.projectId },
      select: { id: true, projectNumber: true, customerId: true },
    });
    if (!project)
      throw new UnprocessableEntityException(
        `Predmet ${draftCtx!.projectId} povezan sa ovom primopredajom ne postoji — RN nije kreiran.`,
      );

    return { drawing: drawing!, draftCtx: draftCtx!, project };
  }

  /**
   * Zajednički helper za `launch()`/`prepareWorkOrder()`: kreira `work_orders`
   * red iz primopredaje (zaglavlje iz crteža + draft konteksta, numeracija sa
   * advisory lock-om po predmetu). NE kreira launch red i NE menja primopredaju
   * — to je odgovornost pozivaoca. `workerId` RN-a = TEHNOLOG
   * (`handover.technologistId` ako je dodeljen, inače radnik iz JWT-a), NE
   * "kreator" — tehnolog je autor TP-a. Rok RN-a (§6.5.1): eksplicitni launch
   * `dueDate` > rok primopredaje (`production_deadline` unet pri odobravanju)
   * > NULL.
   */
  private async createHandoverWorkOrder(
    tx: Prisma.TransactionClient,
    opts: {
      handover: HandoverForWorkOrder;
      ctx: HandoverWorkOrderContext;
      handoverStatusId: number;
      actorWorkerId: number | null;
      /** Već validiran (`parseDateParam` u `launch()`), zato `Date` a ne string. */
      dueDate?: Date;
      comment?: string;
    },
  ) {
    const { handover, ctx } = opts;

    // Sync/import mogu da postave eksplicitne id-jeve (isti obrazac kao
    // work-orders.service.ts alignSeq) — poravnaj sekvencu pre insert-a.
    await alignIdSequence(tx, "work_orders");
    const { identNumber, variant } = await this.nextWorkOrderIdent(
      tx,
      ctx.project.id,
    );

    return tx.workOrder.create({
      data: {
        projectId: ctx.project.id,
        externalCustomerId: ctx.project.customerId,
        identNumber,
        variant,
        partName: ctx.drawing.name,
        drawingNumber: ctx.drawing.drawingNumber,
        material: ctx.drawing.material ?? "",
        materialDimension: ctx.drawing.dimensions ?? "",
        pieceCount: ctx.draftCtx.quantityToProduce,
        unit: "kom",
        revision: ctx.drawing.revision || "A",
        qualityTypeId: 0,
        materialId: 0,
        workerId:
          handover.technologistId > 0
            ? handover.technologistId
            : (opts.actorWorkerId ?? 0),
        drawingId: handover.drawingId,
        drawingHandoverId: handover.id,
        handoverWorkerId: handover.handoverWorkerId,
        handoverStatusId: opts.handoverStatusId,
        enteredAt: new Date(),
        // Override redosled (§6.5.1): eksplicitni launch dueDate > rok unet
        // pri odobravanju primopredaje > bez roka.
        productionDeadline: opts.dueDate ?? handover.productionDeadline ?? null,
        note: opts.comment?.trim() || null,
        status: false,
        isLocked: false,
      },
      select: HANDOVER_WO_SELECT,
    });
  }

  /**
   * RN kreiran iz ove primopredaje — klonovi (rework/bulk-clone) mogu deliti
   * isti `drawing_handover_id`, pa je "original" = najmanji id.
   */
  private findHandoverWorkOrder(
    db: Pick<Prisma.TransactionClient, "workOrder">,
    handoverId: number,
  ) {
    return db.workOrder.findFirst({
      where: { drawingHandoverId: handoverId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        identNumber: true,
        handoverStatusId: true,
        isLocked: true,
      },
    });
  }

  /**
   * Serijalizuj prepare/launch (i provere "RN već postoji") za istu
   * primopredaju — guard protiv duplog RN-a. Isti advisory-lock obrazac kao
   * `handover_draft_submit` u handover-drafts.service.ts.
   */
  private async lockHandoverWorkOrder(
    tx: Prisma.TransactionClient,
    id: number,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`drawing_handover_wo:${id}`}))`;
  }

  /** Duplirano iz `work-orders/work-order-numbering.service.ts` (uputstvo zadatka — ne importovati). */
  private async nextWorkOrderIdent(
    tx: Prisma.TransactionClient,
    projectId: number,
  ): Promise<{ identNumber: string; variant: number }> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${projectId})`;

    const project = await tx.project.findUnique({
      where: { id: projectId },
      select: { projectNumber: true },
    });
    if (!project)
      throw new NotFoundException(`Predmet ${projectId} ne postoji`);

    const rows = await tx.workOrder.findMany({
      where: { projectId },
      select: { identNumber: true },
    });
    let maxOrd = 0;
    for (const r of rows) {
      const ord = Number.parseInt(r.identNumber.split("/").pop() ?? "", 10);
      if (!Number.isNaN(ord) && ord > maxOrd) maxOrd = ord;
    }
    return {
      identNumber: `${project.projectNumber}/${maxOrd + 1}`,
      variant: 0,
    };
  }

  /**
   * Najbolji-pokušaj veza `drawing_id` → nacrt/stavka (§7.5 obrazac iz spec-a).
   * `drawing_handovers` nema FK ka `handover_drafts`/`handover_draft_items` —
   * bira se najskorija ne-isključena stavka istog crteža (najveći `draftId`
   * pa `id`). Ako isti crtež ima više aktivnih nacrta (§7.6 duplikat scenario),
   * ovo je heuristika, ne garancija — potvrditi sa Lukom/Nesom ako zatreba
   * čvršća veza (npr. FK na šemi).
   */
  private async resolveDraftContext(drawingIds: number[]) {
    const uniq = uniqueIds(drawingIds);
    const map = new Map<
      number,
      {
        draftId: number;
        draftNumber: string;
        projectId: number;
        itemId: number;
        quantityToProduce: number;
      }
    >();
    if (!uniq.length) return map;

    const items = await this.prisma.handoverDraftItem.findMany({
      where: { drawingId: { in: uniq }, excludeFromHandover: false },
      select: {
        id: true,
        drawingId: true,
        quantityToProduce: true,
        draftId: true,
      },
      orderBy: [{ draftId: "desc" }, { id: "desc" }],
    });
    const draftIds = uniqueIds(items.map((i) => i.draftId));
    const drafts = byId(
      await this.prisma.handoverDraft.findMany({
        where: { id: { in: draftIds } },
        select: { id: true, draftNumber: true, projectId: true },
      }),
    );

    for (const item of items) {
      if (map.has(item.drawingId)) continue; // prvi pogodak = najskoriji (sortirano gore)
      const draft = drafts.get(item.draftId);
      if (!draft) continue;
      map.set(item.drawingId, {
        draftId: draft.id,
        draftNumber: draft.draftNumber,
        projectId: draft.projectId,
        itemId: item.id,
        quantityToProduce: item.quantityToProduce,
      });
    }
    return map;
  }

  private async resolveProjectDrawingIds(projectId: number): Promise<number[]> {
    const drafts = await this.prisma.handoverDraft.findMany({
      where: { projectId },
      select: { id: true },
    });
    if (!drafts.length) return [];
    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId: { in: drafts.map((d) => d.id) } },
      select: { drawingId: true },
    });
    return [...new Set(items.map((i) => i.drawingId))];
  }

  private async enrich(rows: HandoverRow[]) {
    const [drawings, statuses, workers, draftCtx, workOrders] =
      await Promise.all([
        this.resolveDrawings(rows.map((r) => r.drawingId)),
        this.resolveStatuses(rows.map((r) => r.statusId)),
        this.resolveWorkers([
          ...rows.map((r) => r.handoverWorkerId),
          ...rows.map((r) => r.statusChangedById),
          ...rows.map((r) => r.launchedById),
          ...rows.map((r) => r.technologistId),
          ...rows.map((r) => r.technologistAssignedById),
        ]),
        this.resolveDraftContext(rows.map((r) => r.drawingId)),
        this.resolveWorkOrderRefs(rows.map((r) => r.id)),
      ]);

    // Predmet (broj predmeta) po redu — `drawing_handovers` NEMA `project_id`;
    // predmet se razrešava preko draft konteksta crteža (isti izvor istine kao
    // `writingStats`), pa se projekti batch-resolvuju iz `draftCtx.projectId`.
    const projects = await this.resolveProjects(
      [...draftCtx.values()].map((c) => c.projectId),
    );

    return rows.map((r) => {
      const ctx = draftCtx.get(r.drawingId) ?? null;
      return {
        ...r,
        // UI badge: derivirani red iz tRN (QBigTehn) — mutacije blokira
        // HANDOVER_LEGACY_GUARD do cutover-a.
        isLegacy: r.legacyRnId != null,
        drawing: drawings.get(r.drawingId) ?? null,
        status: statuses.get(r.statusId) ?? null,
        handoverWorker: workers.get(r.handoverWorkerId) ?? null,
        statusChangedBy: r.statusChangedById
          ? (workers.get(r.statusChangedById) ?? null)
          : null,
        launchedBy: r.launchedById
          ? (workers.get(r.launchedById) ?? null)
          : null,
        technologist:
          r.technologistId > 0 ? (workers.get(r.technologistId) ?? null) : null,
        technologistAssignedBy: r.technologistAssignedById
          ? (workers.get(r.technologistAssignedById) ?? null)
          : null,
        workOrder: workOrders.get(r.id) ?? null,
        draftContext: ctx,
        // Predmet po kome je crtež pušten (broj predmeta) — izveden iz draft
        // konteksta; null za redove bez razrešenog nacrta (npr. legacy redovi).
        project: ctx ? (projects.get(ctx.projectId) ?? null) : null,
      };
    });
  }

  /**
   * Batch lookup RN-a po `drawing_handover_id` (obrazac iz common/relations —
   * bez required JOIN-a; orphan/odsutan RN → null). Klonovi mogu deliti isti
   * FK, pa se za svaku primopredaju uzima NAJSTARIJI (najmanji id) = original.
   */
  private async resolveWorkOrderRefs(handoverIds: number[]) {
    const uniq = uniqueIds(handoverIds);
    const map = new Map<number, { id: number; identNumber: string }>();
    if (!uniq.length) return map;
    const rows = await this.prisma.workOrder.findMany({
      where: { drawingHandoverId: { in: uniq } },
      select: { id: true, identNumber: true, drawingHandoverId: true },
      orderBy: { id: "asc" },
    });
    for (const r of rows) {
      if (!map.has(r.drawingHandoverId))
        map.set(r.drawingHandoverId, { id: r.id, identNumber: r.identNumber });
    }
    return map;
  }

  private async resolveDrawings(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.drawing.findMany({
        where: { id: { in: uniq } },
        select: DRAWING_SELECT,
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

  /** Batch predmet (broj predmeta) po id-u — za `project` kolonu u `enrich()`. */
  private async resolveProjects(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.project.findMany({
        where: { id: { in: uniq } },
        select: { id: true, projectNumber: true },
      }),
    );
  }

  private async resolveWorkers(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }
}
