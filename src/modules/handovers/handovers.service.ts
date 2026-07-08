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
import { LaunchHandoverDto } from "./dto/launch-handover.dto";

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
} satisfies Prisma.DrawingHandoverSelect;

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
  /** Opseg po `handoverDate` (ISO). */
  from?: string;
  to?: string;
}

/**
 * Primopredaje crteža (`drawing_handovers`) — MODULE_SPEC_nacrti_primopredaje
 * §6.4. Ovaj servis radi nad POSTOJEĆIM redovima: pregled +
 * approve/reject/launch. Kreiranje `drawing_handovers` redova (predaja nacrta u
 * primopredaju — `/handover-drafts/:id/submit`, §6.3) je u
 * `HandoverDraftsService.submit()`.
 *
 * TODO(auth): JWT payload nosi samo `userId` (User), nema User↔Worker vezu
 * (RBAC V2). Zato se `statusChangedById`/`launchedById` ovde postavljaju na
 * `null`, a `workOrder.workerId` na `0` — isti obrazac kao u
 * `work-orders.service.ts` (TODO(auth) markeri, ne izmišljena vrednost).
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

  /** Odobri primopredaju. Preduslov: status U OBRADI (§6.4). */
  async approve(id: number, comment?: string) {
    await this.transition(id, {
      from: HANDOVER_STATUS.PENDING,
      to: HANDOVER_STATUS.APPROVED,
      comment,
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odobrena.",
    });
    return this.findOne(id);
  }

  /** Odbij primopredaju. `reason` je OBAVEZAN (razlika od approve), §6.4. */
  async reject(id: number, reason: string) {
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
      wrongStateMessage:
        "Primopredaja mora biti U OBRADI (na čekanju) da bi bila odbijena.",
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
          statusChangedById: null, // TODO(auth): User↔Worker veza
          statusChangeComment: opts.comment ?? undefined,
        },
      });
    });
  }

  /**
   * 🔴 Lansiraj primopredaju → kreira `work_orders` red (§6.4/§7.5). Preduslov:
   * status SAGLASAN. Numeracija RN-a je NAMERNO duplirana iz
   * `work-orders/work-order-numbering.service.ts` (ne importuje se odatle —
   * uputstvo zadatka); menjati obe kopije zajedno ako se šema numeracije menja.
   *
   * `drawing_handovers` NEMA `project_id`/`quantity` (samo `drawing_id`) — ti
   * podaci dolaze iz `handover_draft_items` sa istim `drawing_id`
   * (`resolveDraftContext`, best-effort veza jer nema direktnog FK-a u šemi).
   * Ako veza ne postoji ili je nepotpuna → 422, RN se NE kreira.
   */
  async launch(id: number, dto: LaunchHandoverDto) {
    const handover = await this.prisma.drawingHandover.findUnique({
      where: { id },
      select: {
        id: true,
        drawingId: true,
        statusId: true,
        isLocked: true,
        handoverWorkerId: true,
      },
    });
    if (!handover)
      throw new NotFoundException(`Primopredaja ${id} ne postoji.`);
    if (handover.isLocked)
      throw new UnprocessableEntityException("Primopredaja je zaključana.");
    if (handover.statusId !== HANDOVER_STATUS.APPROVED)
      throw new ConflictException(
        "Primopredaja mora biti SAGLASAN pre lansiranja.",
      );

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
        `Primopredaja nema sve obavezne podatke za lansiranje (${missing.join(", ")}) — RN nije kreiran.`,
      );

    const project = await this.prisma.project.findUnique({
      where: { id: draftCtx!.projectId },
      select: { id: true, projectNumber: true, customerId: true },
    });
    if (!project)
      throw new UnprocessableEntityException(
        `Predmet ${draftCtx!.projectId} povezan sa ovom primopredajom ne postoji — RN nije kreiran.`,
      );

    const result = await this.prisma.$transaction(async (tx) => {
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

      // Sync/import mogu da postave eksplicitne id-jeve (isti obrazac kao
      // work-orders.service.ts create()) — poravnaj sekvencu pre insert-a.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('work_orders','id'), (SELECT COALESCE(MAX(id),0) FROM work_orders))`,
      );
      const { identNumber, variant } = await this.nextWorkOrderIdent(
        tx,
        project.id,
      );

      const workOrder = await tx.workOrder.create({
        data: {
          projectId: project.id,
          externalCustomerId: project.customerId,
          identNumber,
          variant,
          partName: drawing!.name,
          drawingNumber: drawing!.drawingNumber,
          material: drawing!.material ?? "",
          materialDimension: drawing!.dimensions ?? "",
          pieceCount: draftCtx!.quantityToProduce,
          unit: "kom",
          revision: drawing!.revision || "A",
          qualityTypeId: 0,
          materialId: 0,
          workerId: 0, // TODO(auth): tehnolog izvršilac kad postoji User↔Worker veza
          drawingId: handover.drawingId,
          drawingHandoverId: handover.id,
          handoverWorkerId: handover.handoverWorkerId,
          handoverStatusId: HANDOVER_STATUS.LAUNCHED,
          enteredAt: new Date(),
          productionDeadline: dto?.dueDate ? new Date(dto.dueDate) : null,
          note: dto?.comment?.trim() || null,
          status: false,
          isLocked: false,
        },
        select: {
          id: true,
          identNumber: true,
          variant: true,
          projectId: true,
          drawingNumber: true,
          revision: true,
          pieceCount: true,
          handoverStatusId: true,
        },
      });

      await tx.workOrderLaunch.create({
        data: {
          workOrderId: workOrder.id,
          isLaunched: true,
          enteredAt: new Date(),
          createdByWorkerId: 0, // TODO(auth)
          updatedByWorkerId: 0, // TODO(auth)
        },
      });

      await tx.drawingHandover.update({
        where: { id },
        data: {
          statusId: HANDOVER_STATUS.LAUNCHED,
          statusChangedAt: new Date(),
          statusChangedById: null, // TODO(auth)
          statusChangeComment: dto?.comment?.trim() || undefined,
          launchedAt: new Date(),
          launchedById: null, // TODO(auth)
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
    const [drawings, statuses, workers, draftCtx] = await Promise.all([
      this.resolveDrawings(rows.map((r) => r.drawingId)),
      this.resolveStatuses(rows.map((r) => r.statusId)),
      this.resolveWorkers([
        ...rows.map((r) => r.handoverWorkerId),
        ...rows.map((r) => r.statusChangedById),
        ...rows.map((r) => r.launchedById),
      ]),
      this.resolveDraftContext(rows.map((r) => r.drawingId)),
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
      draftContext: draftCtx.get(r.drawingId) ?? null,
    }));
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
