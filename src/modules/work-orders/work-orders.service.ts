import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import {
  CreateWorkOrderDto,
  validateCreateWorkOrder,
} from "./dto/create-work-order.dto";
import { WorkOrderNumberingService } from "./work-order-numbering.service";

/** Radni status (MODULE_SPEC_radni_nalozi §4): handover_statuses id. */
export const WO_STATUS = {
  IN_PROGRESS: 0, // U OBRADI
  APPROVED: 1, // SAGLASAN
  REJECTED: 2, // ODBIJENO
  LAUNCHED: 3, // LANSIRAN
} as const;

export interface ListWorkOrdersQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: ident / naziv pozicije / crtež. */
  q?: string;
  /** Radni status (handoverStatusId). */
  statusId?: string;
  projectId?: string;
  /** Tehnolog autor. */
  workerId?: string;
  /** Komitent. */
  customerId?: string;
  /** Otvoren od (ISO). */
  from?: string;
  /** Otvoren do (ISO). */
  to?: string;
}

@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: WorkOrderNumberingService,
  ) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListWorkOrdersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.WorkOrderWhereInput = {};
    if (query.q) {
      where.OR = [
        { identNumber: { contains: query.q, mode: "insensitive" } },
        { partName: { contains: query.q, mode: "insensitive" } },
        { drawingNumber: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    where.handoverStatusId = intEq(query.statusId);
    where.projectId = intEq(query.projectId);
    where.workerId = intEq(query.workerId);
    where.externalCustomerId = intEq(query.customerId);
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
      where.enteredAt = range;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workOrder.findMany({
        where,
        orderBy: [{ enteredAt: "desc" }, { id: "desc" }],
        skip,
        take,
        select: {
          id: true,
          projectId: true,
          identNumber: true,
          variant: true,
          externalCustomerId: true,
          externalProjectName: true,
          partName: true,
          drawingNumber: true,
          product: true,
          pieceCount: true,
          material: true,
          materialDimension: true,
          unit: true,
          revision: true,
          isLocked: true,
          handoverStatusId: true,
          workerId: true,
          qualityTypeId: true,
          enteredAt: true,
          productionDeadline: true,
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    const [workers, quals, statuses] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      this.resolveStatuses(rows.map((r) => r.handoverStatusId)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      qualityType: quals.get(r.qualityTypeId) ?? null,
      handoverStatus: statuses.get(r.handoverStatusId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      include: {
        operations: { orderBy: { operationNumber: "asc" } },
        machinedParts: true,
        blanks: true,
        nonStandardParts: true,
        components: true,
        itemComponents: true,
        approvals: { orderBy: { enteredAt: "desc" } },
        launches: { orderBy: { enteredAt: "desc" } },
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);

    const [workers, quals, statuses, ops] = await Promise.all([
      this.resolveWorkers([
        wo.workerId,
        wo.handoverWorkerId,
        ...wo.operations.map((o) => o.workerId),
        ...wo.machinedParts.map((p) => p.workerId),
        ...wo.blanks.map((p) => p.workerId),
        ...wo.nonStandardParts.map((p) => p.workerId),
      ]),
      this.resolveQualityTypes([wo.qualityTypeId]),
      this.resolveStatuses([wo.handoverStatusId]),
      this.resolveOperationsByCode(wo.operations.map((o) => o.workCenterCode)),
    ]);
    const w = (wid: number) => workers.get(wid) ?? null;

    const data = {
      ...wo,
      worker: w(wo.workerId),
      handoverWorker: w(wo.handoverWorkerId),
      qualityType: quals.get(wo.qualityTypeId) ?? null,
      handoverStatus: statuses.get(wo.handoverStatusId) ?? null,
      operations: wo.operations.map((o) => ({
        ...o,
        worker: w(o.workerId),
        operation: ops.get(o.workCenterCode) ?? null,
      })),
      machinedParts: wo.machinedParts.map((p) => ({
        ...p,
        worker: w(p.workerId),
      })),
      blanks: wo.blanks.map((p) => ({ ...p, worker: w(p.workerId) })),
      nonStandardParts: wo.nonStandardParts.map((p) => ({
        ...p,
        worker: w(p.workerId),
      })),
    };
    return { data };
  }

  // --- batch resolveri (izbegavaju required-relation JOIN koji puca na orphan FK) ---

  private async resolveWorkers(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: { id: true, fullName: true, username: true },
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

  // ---------------------------------------------------------------- CREATE

  async create(dto: CreateWorkOrderDto) {
    validateCreateWorkOrder(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      // Sync postavlja eksplicitne legacy id-jeve; poravnaj sekvencu pre insert-a
      // da autoincrement ne kolidira sa uvezenim redovima.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('work_orders','id'), (SELECT COALESCE(MAX(id),0) FROM work_orders))`,
      );
      const { identNumber, variant } = await this.numbering.next(
        tx,
        dto.projectId,
      );
      return tx.workOrder.create({
        data: {
          projectId: dto.projectId,
          externalCustomerId: dto.externalCustomerId,
          identNumber,
          variant,
          partName: dto.partName.trim(),
          drawingNumber: dto.drawingNumber.trim(),
          material: dto.material.trim(),
          materialDimension: dto.materialDimension.trim(),
          pieceCount: dto.pieceCount,
          unit: dto.unit?.trim() || "kom",
          product: dto.product?.trim() || null,
          note: dto.note?.trim() || null,
          revision: dto.revision?.trim() || "A",
          qualityTypeId: dto.qualityTypeId ?? 0,
          materialId: dto.materialId ?? 0,
          workerId: dto.workerId ?? 0,
          externalProjectName: dto.externalProjectName?.trim() || null,
          productionDeadline: dto.productionDeadline
            ? new Date(dto.productionDeadline)
            : null,
          enteredAt: new Date(),
          handoverStatusId: WO_STATUS.IN_PROGRESS, // 0 — ne DDL default 3
          status: false,
          isLocked: false,
        },
        select: { id: true },
      });
    });
    return this.findOne(created.id);
  }

  // ---------------------------------------------------------------- WORKFLOW

  /**
   * Odobri / odbij RN. TODO(auth): permisija `rn.approve` (Worker.definesApproval,
   * workerType ∈ {Tehnolog, Inženjeri}) — aktivira se uz RBAC (V2).
   */
  async approve(id: number, approve: boolean) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    if (wo.isLocked)
      throw new UnprocessableEntityException(
        "Zaključan RN se ne može menjati.",
      );
    if (approve) {
      const ops = await this.prisma.workOrderOperation.count({
        where: { workOrderId: id },
      });
      if (ops === 0)
        throw new UnprocessableEntityException(
          "RN nema nijednu operaciju — ne može se odobriti.",
        );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workOrder.update({
        where: { id },
        data: {
          handoverStatusId: approve ? WO_STATUS.APPROVED : WO_STATUS.REJECTED,
        },
      });
      await tx.workOrderApproval.create({
        data: {
          workOrderId: id,
          isApproved: approve,
          enteredAt: new Date(),
          // TODO(auth): createdByWorkerId/Signature iz User↔Worker veze (RBAC §4).
          updatedByWorkerId: 0,
        },
      });
    });
    return this.findOne(id);
  }

  /**
   * Lansiraj RN. Preduslov: mora biti SAGLASAN (nikad obrnuto).
   * TODO(auth): permisija `rn.launch` (rola ∈ {ŠEF,TEHNOLOG,ADMIN} + Worker.definesLaunch).
   */
  async launch(id: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true, isLocked: true, handoverStatusId: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    if (wo.isLocked)
      throw new UnprocessableEntityException(
        "Zaključan RN se ne može menjati.",
      );
    if (wo.handoverStatusId !== WO_STATUS.APPROVED)
      throw new UnprocessableEntityException(
        "RN mora biti SAGLASAN pre lansiranja.",
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.workOrder.update({
        where: { id },
        data: { handoverStatusId: WO_STATUS.LAUNCHED },
      });
      await tx.workOrderLaunch.create({
        data: {
          workOrderId: id,
          isLaunched: true,
          enteredAt: new Date(),
          updatedByWorkerId: 0,
        },
      });
    });
    return this.findOne(id);
  }

  /** Zaključaj / otključaj RN (ŠEF/ADMIN — V2). */
  async setLock(id: number, locked: boolean) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    await this.prisma.workOrder.update({
      where: { id },
      data: { isLocked: locked },
    });
    return this.findOne(id);
  }
}
