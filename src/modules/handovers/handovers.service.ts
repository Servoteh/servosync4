import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import type { AuthUser } from "../auth/jwt.strategy";
import { LaunchHandoverDto } from "./dto/launch-handover.dto";
import { ApproveHandoverDto } from "./dto/approve-handover.dto";
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
  constructor(private readonly prisma: PrismaService) {}

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
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
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

  /** `GET /handovers/technologists` — `defines_approval=true` radnici, samo id/fullName/username (§3.4/§8.3). */
  async technologists() {
    const data = await this.prisma.worker.findMany({
      where: { definesApproval: true, active: true },
      select: SAFE_WORKER_SELECT,
      orderBy: { fullName: "asc" },
    });
    return { data };
  }

  // ------------------------------------------------------------ WORKFLOW

  /**
   * Odobri primopredaju (§6.4 + P1): šef tehnologije OBAVEZNO bira tehnologa
   * (`technologistId`) koji piše TP. Tehnolog mora biti aktivan radnik sa
   * `defines_approval=true` — isti kriterijum kao `GET /handovers/technologists`.
   * Preduslov: status U OBRADI.
   */
  async approve(id: number, dto: ApproveHandoverDto, actor?: AuthUser) {
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

    const technologist = await this.prisma.worker.findUnique({
      where: { id: technologistId },
      select: { id: true, definesApproval: true, active: true },
    });
    if (!technologist)
      throw new UnprocessableEntityException(
        `Tehnolog ${technologistId} ne postoji.`,
      );
    if (!technologist.definesApproval || !technologist.active)
      throw new UnprocessableEntityException(
        `Radnik ${technologistId} nije aktivan tehnolog (defines_approval) — izaberite tehnologa sa /handovers/technologists liste.`,
      );

    await this.transition(id, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.APPROVED,
      comment,
      actorWorkerId: actor?.workerId ?? null,
      extra: { technologistId },
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odobrena.",
    });
    return this.findOne(id);
  }

  /** Odbij primopredaju. `reason` je OBAVEZAN (razlika od approve), §6.4. */
  async reject(id: number, reason: string, actor?: AuthUser) {
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
      actorWorkerId: actor?.workerId ?? null,
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odbijena.",
    });
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
        select: { id: true, statusId: true, isLocked: true },
      });
      if (!handover)
        throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
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
          statusChangedAt: new Date(),
          statusChangedById: actor?.workerId ?? null,
          statusChangeComment: reason,
        },
      });
    });
    return this.findOne(id);
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
      extra?: Prisma.DrawingHandoverUncheckedUpdateInput;
    },
  ) {
    await this.prisma.$transaction(async (tx) => {
      const handover = await tx.drawingHandover.findUnique({
        where: { id },
        select: { id: true, statusId: true, isLocked: true },
      });
      if (!handover)
        throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
      if (handover.isLocked)
        throw new UnprocessableEntityException("Primopredaja je zaključana.");
      if (handover.statusId !== opts.from)
        throw new ConflictException(opts.wrongStateMessage);

      await tx.drawingHandover.update({
        where: { id },
        data: {
          statusId: opts.to,
          statusChangedAt: new Date(),
          statusChangedById: opts.actorWorkerId ?? null,
          statusChangeComment: opts.comment ?? undefined,
          ...opts.extra,
        },
      });
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
    const handover = await this.getHandoverForWorkOrder(id);

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
        select: { statusId: true, isLocked: true },
      });
      if (
        !fresh ||
        fresh.isLocked ||
        fresh.statusId !== HANDOVER_STATUS.APPROVED
      )
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN da bi se otkucao TP (kreirao RN).",
        );

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
        actorWorkerId: actor?.workerId ?? null,
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

    const handover = await this.getHandoverForWorkOrder(id);
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

    const actorWorkerId = actor?.workerId ?? null;
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockHandoverWorkOrder(tx, id);

      const fresh = await tx.drawingHandover.findUnique({
        where: { id },
        select: { statusId: true, isLocked: true },
      });
      if (
        !fresh ||
        fresh.isLocked ||
        fresh.statusId !== HANDOVER_STATUS.APPROVED
      )
        throw new ConflictException(
          "Primopredaja mora biti SAGLASAN pre lansiranja.",
        );

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
        const data: Prisma.WorkOrderUncheckedUpdateInput = {
          handoverStatusId: HANDOVER_STATUS.LAUNCHED,
        };
        if (dto?.dueDate) data.productionDeadline = new Date(dto.dueDate);
        if (comment) data.note = comment;
        workOrder = await tx.workOrder.update({
          where: { id: existing.id },
          data,
          select: HANDOVER_WO_SELECT,
        });
      } else {
        // `ctx` je null samo ako je RN postojao pri pre-checku pa je obrisan
        // pre lock-a (uska utrka) — učitaj kontekst u mestu umesto `ctx!`
        // (non-null assertion bi pukao sa TypeError → neočekivan 500).
        workOrder = await this.createHandoverWorkOrder(tx, {
          handover,
          ctx: ctx ?? (await this.loadWorkOrderContext(handover)),
          handoverStatusId: HANDOVER_STATUS.LAUNCHED,
          actorWorkerId,
          dueDate: dto?.dueDate,
          comment,
        });
      }

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
          statusChangeComment: comment,
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
   * "kreator" — tehnolog je autor TP-a.
   */
  private async createHandoverWorkOrder(
    tx: Prisma.TransactionClient,
    opts: {
      handover: HandoverForWorkOrder;
      ctx: HandoverWorkOrderContext;
      handoverStatusId: number;
      actorWorkerId: number | null;
      dueDate?: string;
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
        productionDeadline: opts.dueDate ? new Date(opts.dueDate) : null,
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
        ]),
        this.resolveDraftContext(rows.map((r) => r.drawingId)),
        this.resolveWorkOrderRefs(rows.map((r) => r.id)),
      ]);

    return rows.map((r) => ({
      ...r,
      drawing: drawings.get(r.drawingId) ?? null,
      status: statuses.get(r.statusId) ?? null,
      handoverWorker: workers.get(r.handoverWorkerId) ?? null,
      statusChangedBy: r.statusChangedById
        ? (workers.get(r.statusChangedById) ?? null)
        : null,
      launchedBy: r.launchedById ? (workers.get(r.launchedById) ?? null) : null,
      technologist:
        r.technologistId > 0 ? (workers.get(r.technologistId) ?? null) : null,
      workOrder: workOrders.get(r.id) ?? null,
      draftContext: draftCtx.get(r.drawingId) ?? null,
    }));
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
