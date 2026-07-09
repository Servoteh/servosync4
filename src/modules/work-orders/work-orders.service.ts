import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, WorkOrder } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import {
  CreateWorkOrderDto,
  validateCreateWorkOrder,
} from "./dto/create-work-order.dto";
import {
  ReworkWorkOrderDto,
  validateReworkWorkOrder,
} from "./dto/rework-work-order.dto";
import {
  BulkCloneWorkOrdersDto,
  validateBulkCloneWorkOrders,
} from "./dto/bulk-clone-work-orders.dto";
import {
  UpdateWorkOrderDto,
  validateUpdateWorkOrder,
} from "./dto/update-work-order.dto";
import {
  CreateWorkOrderOperationDto,
  UpdateWorkOrderOperationDto,
  validateCreateOperation,
  validateUpdateOperation,
} from "./dto/work-order-operation.dto";
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

  // ------------------------------------------------- HEADER EDIT + TP AUTHORING
  // Izmena zaglavlja RN-a i CRUD operacija (`work_order_operations`) — legacy
  // `Form_UnosRN` edit mode + `Form_UnosStavkiRN`. Guard: zaključan RN se ne menja.

  /** Zaključan RN se ne sme menjati (legacy `AllowEdits/Deletions=false` kad `Zakljucano`). */
  private assertEditable(wo: { isLocked: boolean | null }): void {
    if (wo.isLocked)
      throw new UnprocessableEntityException("Zaključan RN se ne može menjati.");
  }

  /** Izmena zaglavlja RN-a (samo poslata polja). Identitet se ne menja. */
  async updateHeader(id: number, dto: UpdateWorkOrderDto) {
    validateUpdateWorkOrder(dto);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    this.assertEditable(wo);

    const data: Prisma.WorkOrderUncheckedUpdateInput = {};
    if (dto.partName !== undefined) data.partName = dto.partName.trim();
    if (dto.drawingNumber !== undefined)
      data.drawingNumber = dto.drawingNumber.trim();
    if (dto.material !== undefined) data.material = dto.material.trim();
    if (dto.materialDimension !== undefined)
      data.materialDimension = dto.materialDimension.trim();
    if (dto.unit !== undefined) data.unit = dto.unit.trim() || "kom";
    if (dto.product !== undefined) data.product = dto.product?.trim() || null;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.revision !== undefined) data.revision = dto.revision.trim() || "A";
    if (dto.qualityTypeId !== undefined) data.qualityTypeId = dto.qualityTypeId;
    if (dto.materialId !== undefined) data.materialId = dto.materialId;
    if (dto.workerId !== undefined) data.workerId = dto.workerId;
    if (dto.externalCustomerId !== undefined)
      data.externalCustomerId = dto.externalCustomerId;
    if (dto.externalProjectName !== undefined)
      data.externalProjectName = dto.externalProjectName?.trim() || null;
    if (dto.pieceCount !== undefined) data.pieceCount = dto.pieceCount;
    if (dto.productionDeadline !== undefined)
      data.productionDeadline = dto.productionDeadline
        ? new Date(dto.productionDeadline)
        : null;

    await this.prisma.workOrder.update({ where: { id }, data });
    return this.findOne(id);
  }

  /**
   * Dodaj operaciju na RN (`Form_UnosStavkiRN` „Nova stavka"). `workCenterCode` mora
   * postojati u šifarniku `operations`. `operationNumber` izostavljen → `MAX+10`.
   * `priority` izostavljen → iz `operations.usesPriority` (100/255).
   */
  async addOperation(workOrderId: number, dto: CreateWorkOrderOperationDto) {
    validateCreateOperation(dto);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
    this.assertEditable(wo);

    const code = dto.workCenterCode.trim();
    const op = await this.prisma.operation.findUnique({
      where: { workCenterCode: code },
      select: { workCenterCode: true, usesPriority: true },
    });
    if (!op)
      throw new UnprocessableEntityException(
        `Radni centar '${code}' ne postoji u šifarniku operacija.`,
      );

    await this.prisma.$transaction(async (tx) => {
      await this.alignItemSequences(tx);
      let operationNumber = dto.operationNumber;
      if (operationNumber === undefined) {
        const agg = await tx.workOrderOperation.aggregate({
          where: { workOrderId },
          _max: { operationNumber: true },
        });
        operationNumber = (agg._max.operationNumber ?? 0) + 10;
      }
      const priority = dto.priority ?? (op.usesPriority ? 100 : 255);
      await tx.workOrderOperation.create({
        data: {
          workOrderId,
          operationNumber,
          workCenterCode: code,
          workDescription: dto.workDescription.trim(),
          toolsFixtures: dto.toolsFixtures?.trim() || null,
          setupTime: dto.setupTime ?? 0,
          cycleTime: dto.cycleTime ?? 0,
          toolWeight: dto.toolWeight ?? 0,
          priority,
          workerId: dto.workerId ?? 0,
        },
      });
    });
    return this.findOne(workOrderId);
  }

  /** Izmena operacije RN-a (samo poslata polja). Promena RC re-izvodi prioritet ako nije zadat. */
  async updateOperation(
    workOrderId: number,
    operationId: number,
    dto: UpdateWorkOrderOperationDto,
  ) {
    validateUpdateOperation(dto);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
    this.assertEditable(wo);

    const existing = await this.prisma.workOrderOperation.findUnique({
      where: { id: operationId },
      select: { id: true, workOrderId: true },
    });
    if (!existing || existing.workOrderId !== workOrderId)
      throw new NotFoundException(
        `Operacija ${operationId} ne pripada radnom nalogu ${workOrderId}.`,
      );

    const data: Prisma.WorkOrderOperationUncheckedUpdateInput = {};
    if (dto.operationNumber !== undefined)
      data.operationNumber = dto.operationNumber;
    if (dto.workDescription !== undefined)
      data.workDescription = dto.workDescription.trim();
    if (dto.toolsFixtures !== undefined)
      data.toolsFixtures = dto.toolsFixtures?.trim() || null;
    if (dto.setupTime !== undefined) data.setupTime = dto.setupTime;
    if (dto.cycleTime !== undefined) data.cycleTime = dto.cycleTime;
    if (dto.toolWeight !== undefined) data.toolWeight = dto.toolWeight;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.workerId !== undefined) data.workerId = dto.workerId;
    if (dto.workCenterCode !== undefined) {
      const code = dto.workCenterCode.trim();
      const op = await this.prisma.operation.findUnique({
        where: { workCenterCode: code },
        select: { workCenterCode: true, usesPriority: true },
      });
      if (!op)
        throw new UnprocessableEntityException(
          `Radni centar '${code}' ne postoji u šifarniku operacija.`,
        );
      data.workCenterCode = code;
      if (dto.priority === undefined) data.priority = op.usesPriority ? 100 : 255;
    }

    await this.prisma.workOrderOperation.update({
      where: { id: operationId },
      data,
    });
    return this.findOne(workOrderId);
  }

  /** Brisanje operacije RN-a (+ eventualne skice te operacije). Guard: RN nije zaključan. */
  async deleteOperation(workOrderId: number, operationId: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
    this.assertEditable(wo);

    const existing = await this.prisma.workOrderOperation.findUnique({
      where: { id: operationId },
      select: { id: true, workOrderId: true },
    });
    if (!existing || existing.workOrderId !== workOrderId)
      throw new NotFoundException(
        `Operacija ${operationId} ne pripada radnom nalogu ${workOrderId}.`,
      );

    await this.prisma.$transaction(async (tx) => {
      // FK slika je NoAction → obriši skice operacije pre reda.
      await tx.workOrderOperationImage.deleteMany({
        where: { workOrderOperationId: operationId },
      });
      await tx.workOrderOperation.delete({ where: { id: operationId } });
    });
    return this.findOne(workOrderId);
  }

  /**
   * Brisanje kompletnog RN-a sa kaskadom (`spObrisiKompletanNalog`, §K). Sve FK relacije
   * su `NoAction` → brišemo eksplicitno, dubina prvo, u jednoj transakciji:
   * slike operacija → operacije → machined/blanks/nonstandard → komponente → itemKomponente
   * → odobravanja → lansiranja → RN. **NE dira `tech_processes`** (kao legacy).
   * 🔴 Guard: zaključan RN (422) i „proizvodnja započeta" — postoji ijedan `tech_processes`
   * red po trojci (422). Namerno bez varijante koja briše i evidenciju rada (legacy je to
   * imao samo u test-formi).
   */
  async remove(id: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: {
        id: true,
        isLocked: true,
        projectId: true,
        identNumber: true,
        variant: true,
      },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    if (wo.isLocked)
      throw new UnprocessableEntityException(
        "Zaključan RN se ne može obrisati.",
      );
    const started = await this.prisma.techProcess.count({
      where: {
        projectId: wo.projectId,
        identNumber: wo.identNumber,
        variant: wo.variant,
      },
    });
    if (started > 0)
      throw new UnprocessableEntityException(
        "Po ovom nalogu je započeta proizvodnja (postoje evidentirane operacije) — ne može se obrisati.",
      );

    await this.prisma.$transaction(async (tx) => {
      const ops = await tx.workOrderOperation.findMany({
        where: { workOrderId: id },
        select: { id: true },
      });
      if (ops.length)
        await tx.workOrderOperationImage.deleteMany({
          where: { workOrderOperationId: { in: ops.map((o) => o.id) } },
        });
      await tx.workOrderOperation.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderMachinedPart.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderBlank.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderNonstandardPart.deleteMany({
        where: { workOrderId: id },
      });
      await tx.workOrderComponent.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderItemComponent.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderApproval.deleteMany({ where: { workOrderId: id } });
      await tx.workOrderLaunch.deleteMany({ where: { workOrderId: id } });
      await tx.workOrder.delete({ where: { id } });
    });
    return { data: { id, deleted: true } };
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

  // ------------------------------------------------------- COPY / CLONE / REWORK

  /**
   * Kopiraj SVE 4 vrste stavki iz `sourceId` u prazan `targetId`
   * (`spRN_PrepisiStavkeIzNaloga`, MODULE_SPEC §3.6). Preduslovi:
   *   - cilj postoji, NIJE zaključan/lansiran (inače 409),
   *   - cilj je PRAZAN — nijedne stavke ni u jednoj od 4 tabele (inače 409).
   * Prioritet kopiranih operacija se REGENERIŠE: 100 ako operacija `usesPriority`,
   * inače 255 (§3.4). Atomično u jednoj transakciji.
   */
  async copyFrom(targetId: number, sourceId: number) {
    if (targetId === sourceId)
      throw new ConflictException(
        "Izvor i cilj kopiranja moraju biti različiti nalozi.",
      );

    await this.prisma.$transaction(async (tx) => {
      const [target, source] = await Promise.all([
        tx.workOrder.findUnique({
          where: { id: targetId },
          select: { id: true, isLocked: true, handoverStatusId: true },
        }),
        tx.workOrder.findUnique({
          where: { id: sourceId },
          select: { id: true },
        }),
      ]);
      if (!target)
        throw new NotFoundException(`Radni nalog ${targetId} ne postoji`);
      if (!source)
        throw new NotFoundException(
          `Izvorni radni nalog ${sourceId} ne postoji`,
        );

      if (target.isLocked || target.handoverStatusId === WO_STATUS.LAUNCHED)
        throw new ConflictException(
          "Zaključan/lansiran RN ne može biti cilj kopiranja.",
        );

      await this.assertTargetEmpty(tx, targetId);
      await this.alignItemSequences(tx);
      await this.cloneItems(tx, sourceId, targetId, {
        coefficient: 1,
        recomputePriority: true,
      });
    });

    return this.findOne(targetId);
  }

  /**
   * DORADA/ŠKART child nalog (`KreirajNalogDoradeIliSkarta`, §3.4). Iz `sourceId`
   * nastaje NOVI RN u istom predmetu: `identNumber` = izvor + sufiks `-D`n (dorada)
   * ili `-S`n (škart), gde je `n` prvi slobodan redni broj. Kopira zaglavlje + sve
   * 4 vrste stavki; `pieceCount` = zadata dorađena/škartirana količina;
   * `qualityTypeId` = 1/2; status = U OBRADI, otključan. Atomično.
   */
  async rework(sourceId: number, dto: ReworkWorkOrderDto) {
    validateReworkWorkOrder(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      const source = await tx.workOrder.findUnique({ where: { id: sourceId } });
      if (!source)
        throw new NotFoundException(`Radni nalog ${sourceId} ne postoji`);

      // Serijalizuj po predmetu (kao create/numbering) — child ostaje u istom
      // predmetu, pa je pretraga slobodnog sufiksa bez race-a.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${source.projectId})`;

      const letter = dto.qualityTypeId === 1 ? "D" : "S";
      const prefix = `${source.identNumber}-${letter}`;
      const siblings = await tx.workOrder.findMany({
        where: { projectId: source.projectId, identNumber: { startsWith: prefix } },
        select: { identNumber: true },
      });
      const used = new Set<number>();
      for (const s of siblings) {
        const suffix = s.identNumber.slice(prefix.length);
        const n = Number.parseInt(suffix, 10);
        // Broj samo čisto numeričke sufikse (npr. `-D1`, ne `-D1-S2`).
        if (!Number.isNaN(n) && String(n) === suffix) used.add(n);
      }
      let n = 1;
      while (used.has(n)) n++;
      const identNumber = `${prefix}${n}`;

      await this.alignWorkOrderSequence(tx);
      await this.alignItemSequences(tx);

      const child = await tx.workOrder.create({
        data: this.buildCloneHeader(source, {
          identNumber,
          qualityTypeId: dto.qualityTypeId,
          pieceCount: dto.pieceCount,
          note: dto.note?.trim() || source.note,
        }),
        select: { id: true },
      });

      await this.cloneItems(tx, sourceId, child.id, {
        coefficient: 1,
        recomputePriority: true,
      });
      return child;
    });

    return this.findOne(created.id);
  }

  /**
   * Bulk-clone svih (ili izabranih) naloga predmeta `sourceProjectId` u novi
   * predmet (`spKreirajSveStavkeRNZaNoviIDPredmet`, §3.5). Koeficijent množi
   * `Komada` (zaglavlje `pieceCount` + količine PND/PDM/PLP stavki); OPERACIJE se
   * prenose 1:1 (norme se NE skaliraju). Ciljni predmet mora biti PRAZAN.
   * `identNumber` zadržava redni broj (`/ordinal`), menja samo prefiks predmeta
   * (migration/05). Sve u jednoj transakciji — rollback svega pri bilo kojoj grešci.
   */
  async bulkClone(sourceProjectId: number, dto: BulkCloneWorkOrdersDto) {
    validateBulkCloneWorkOrders(dto);
    const { targetProjectId, coefficient } = dto;

    if (targetProjectId === sourceProjectId)
      throw new ConflictException(
        "Ciljni predmet mora biti različit od izvornog.",
      );

    const result = await this.prisma.$transaction(async (tx) => {
      const [sourceProject, targetProject] = await Promise.all([
        tx.project.findUnique({
          where: { id: sourceProjectId },
          select: { id: true },
        }),
        tx.project.findUnique({
          where: { id: targetProjectId },
          select: { id: true, projectNumber: true },
        }),
      ]);
      if (!sourceProject)
        throw new NotFoundException(`Predmet ${sourceProjectId} ne postoji`);
      if (!targetProject)
        throw new NotFoundException(
          `Ciljni predmet ${targetProjectId} ne postoji`,
        );

      // Serijalizuj upis u ciljni predmet (kao create/numbering).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${targetProjectId})`;

      const existingInTarget = await tx.workOrder.count({
        where: { projectId: targetProjectId },
      });
      if (existingInTarget > 0)
        throw new ConflictException(
          "Ciljni predmet već ima radne naloge — bulk-clone je dozvoljen samo u prazan predmet.",
        );

      const where: Prisma.WorkOrderWhereInput = { projectId: sourceProjectId };
      if (dto.workOrderIds?.length) where.id = { in: dto.workOrderIds };
      const sources = await tx.workOrder.findMany({
        where,
        orderBy: { id: "asc" },
      });

      if (dto.workOrderIds?.length) {
        const foundIds = new Set(sources.map((s) => s.id));
        const missing = dto.workOrderIds.filter((id) => !foundIds.has(id));
        if (missing.length)
          throw new UnprocessableEntityException(
            `Nalozi ne pripadaju predmetu ${sourceProjectId}: ${missing.join(", ")}.`,
          );
      }
      if (!sources.length)
        throw new UnprocessableEntityException(
          "Izvorni predmet nema naloge za kloniranje.",
        );

      await this.alignWorkOrderSequence(tx);
      await this.alignItemSequences(tx);

      const items: { sourceId: number; id: number; identNumber: string }[] = [];
      for (const src of sources) {
        // Zadrži redni broj (`/ordinal`), promeni prefiks na ciljni predmet.
        const slash = src.identNumber.indexOf("/");
        const tail =
          slash >= 0 ? src.identNumber.slice(slash + 1) : src.identNumber;
        const identNumber = `${targetProject.projectNumber}/${tail}`;

        const child = await tx.workOrder.create({
          data: this.buildCloneHeader(src, {
            projectId: targetProjectId,
            identNumber,
            pieceCount: Math.max(1, Math.round(src.pieceCount * coefficient)),
          }),
          select: { id: true },
        });
        await this.cloneItems(tx, src.id, child.id, {
          coefficient,
          recomputePriority: false,
        });
        items.push({ sourceId: src.id, id: child.id, identNumber });
      }
      return items;
    });

    return {
      data: {
        sourceProjectId,
        targetProjectId,
        coefficient,
        count: result.length,
        workOrders: result,
      },
    };
  }

  // --- copy/clone interni helperi ---

  /** 409 ako `targetId` već ima ijednu stavku (u bilo kojoj od 4 tabele). */
  private async assertTargetEmpty(
    tx: Prisma.TransactionClient,
    targetId: number,
  ) {
    const [ops, nonStd, machined, blanks] = await Promise.all([
      tx.workOrderOperation.count({ where: { workOrderId: targetId } }),
      tx.workOrderNonstandardPart.count({ where: { workOrderId: targetId } }),
      tx.workOrderMachinedPart.count({ where: { workOrderId: targetId } }),
      tx.workOrderBlank.count({ where: { workOrderId: targetId } }),
    ]);
    if (ops + nonStd + machined + blanks > 0)
      throw new ConflictException(
        "Nalog već ima stavke — kopiranje je dozvoljeno samo u prazan nalog.",
      );
  }

  /**
   * Zaglavlje kloniranog RN-a iz izvora + `overrides`. Status = U OBRADI, otključan.
   * 🔴 Mapiranje 1:1 tačno: `processedPartWeight`/`unprocessedPartWeight` idu svaki
   * u svoje polje — NIKAD `processedPartWeight` u `unprocessedPartWeight` (legacy
   * bug `PrepisiZaglavljePostupka`, §3.9 — NE reprodukovati).
   */
  private buildCloneHeader(
    src: WorkOrder,
    overrides: Partial<Prisma.WorkOrderUncheckedCreateInput> & {
      identNumber: string;
    },
  ): Prisma.WorkOrderUncheckedCreateInput {
    return {
      projectId: src.projectId,
      externalCustomerId: src.externalCustomerId,
      externalProjectName: src.externalProjectName,
      externalOpenedAt: src.externalOpenedAt,
      enteredAt: new Date(),
      pieceCount: src.pieceCount,
      drawingNumber: src.drawingNumber,
      product: src.product,
      unprocessedPartWeight: src.unprocessedPartWeight,
      processedPartWeight: src.processedPartWeight,
      partName: src.partName,
      materialId: src.materialId,
      material: src.material,
      materialDimension: src.materialDimension,
      unit: src.unit,
      note: src.note,
      status: false,
      productionDeadline: src.productionDeadline,
      workerId: src.workerId,
      isLocked: false,
      signature: src.signature,
      printTimer: src.printTimer,
      parentDrawingRef: src.parentDrawingRef,
      qualityTypeId: src.qualityTypeId,
      revision: src.revision,
      drawingHandoverId: src.drawingHandoverId,
      drawingId: src.drawingId,
      handoverStatusId: WO_STATUS.IN_PROGRESS,
      handoverWorkerId: src.handoverWorkerId,
      variant: src.variant,
      ...overrides,
    };
  }

  /**
   * Kopira 4 vrste stavki iz `sourceId` u `targetId`.
   *   - operacije: 1:1; `priority` = (recomputePriority ? usesPriority?100:255 :
   *     izvorni priority); norme (setup/cycle) se NE skaliraju,
   *   - PND/PDM/PLP: `quantity` × `coefficient` (PDM/PLP celobrojno → Math.round,
   *     PND Float ostaje decimalan).
   */
  private async cloneItems(
    tx: Prisma.TransactionClient,
    sourceId: number,
    targetId: number,
    opts: { coefficient: number; recomputePriority: boolean },
  ) {
    const { coefficient, recomputePriority } = opts;

    const [operations, nonStandardParts, machinedParts, blanks] =
      await Promise.all([
        tx.workOrderOperation.findMany({ where: { workOrderId: sourceId } }),
        tx.workOrderNonstandardPart.findMany({
          where: { workOrderId: sourceId },
        }),
        tx.workOrderMachinedPart.findMany({ where: { workOrderId: sourceId } }),
        tx.workOrderBlank.findMany({ where: { workOrderId: sourceId } }),
      ]);

    const priorityMap = recomputePriority
      ? await this.priorityByCode(
          tx,
          operations.map((o) => o.workCenterCode),
        )
      : null;

    const scaleInt = (q: number | null, coef: number) =>
      q === null ? null : Math.round(q * coef);
    const scaleFloat = (q: number | null, coef: number) =>
      q === null ? null : q * coef;

    if (operations.length) {
      await tx.workOrderOperation.createMany({
        data: operations.map((o) => ({
          workOrderId: targetId,
          operationNumber: o.operationNumber,
          workCenterCode: o.workCenterCode,
          workDescription: o.workDescription,
          toolsFixtures: o.toolsFixtures,
          setupTime: o.setupTime,
          cycleTime: o.cycleTime,
          toolWeight: o.toolWeight,
          workerId: o.workerId,
          priority: priorityMap
            ? priorityMap.get(o.workCenterCode)
              ? 100
              : 255
            : o.priority,
        })),
      });
    }

    if (nonStandardParts.length) {
      await tx.workOrderNonstandardPart.createMany({
        data: nonStandardParts.map((p) => ({
          workOrderId: targetId,
          position: p.position,
          operationId: p.operationId,
          workCenterCode: p.workCenterCode,
          partName: p.partName,
          quantity: scaleFloat(p.quantity, coefficient),
          note: p.note,
          workerId: p.workerId,
        })),
      });
    }

    if (machinedParts.length) {
      await tx.workOrderMachinedPart.createMany({
        data: machinedParts.map((p) => ({
          workOrderId: targetId,
          position: p.position,
          operationId: p.operationId,
          workCenterCode: p.workCenterCode,
          partName: p.partName,
          drawingNumber: p.drawingNumber,
          quantity: scaleInt(p.quantity, coefficient),
          workerId: p.workerId,
        })),
      });
    }

    if (blanks.length) {
      await tx.workOrderBlank.createMany({
        data: blanks.map((p) => ({
          workOrderId: targetId,
          position: p.position,
          workCenterCode: p.workCenterCode,
          material: p.material,
          materialDimension: p.materialDimension,
          unit: p.unit,
          unitWeight: p.unitWeight,
          quantity: scaleInt(p.quantity, coefficient),
          positionNumber: p.positionNumber,
          workerId: p.workerId,
        })),
      });
    }
  }

  /** Batch-resolve `Operation.usesPriority` po `workCenterCode` (za regen prioriteta). */
  private async priorityByCode(tx: Prisma.TransactionClient, codes: string[]) {
    const uniq = [...new Set(codes.filter(Boolean))];
    const map = new Map<string, boolean>();
    if (!uniq.length) return map;
    const rows = await tx.operation.findMany({
      where: { workCenterCode: { in: uniq } },
      select: { workCenterCode: true, usesPriority: true },
    });
    for (const r of rows) map.set(r.workCenterCode, r.usesPriority);
    return map;
  }

  /**
   * Poravnaj `work_orders` sekvencu sa MAX(id) — sync uvozi eksplicitne legacy
   * id-jeve, pa autoincrement inače kolidira (isti obrazac kao `create()`).
   */
  private async alignWorkOrderSequence(tx: Prisma.TransactionClient) {
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('work_orders','id'), (SELECT COALESCE(MAX(id),0) FROM work_orders))`,
    );
  }

  /** Poravnaj sekvence 4 tabela stavki sa MAX(id) (vidi `alignWorkOrderSequence`). */
  private async alignItemSequences(tx: Prisma.TransactionClient) {
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('work_order_operations','id'), (SELECT COALESCE(MAX(id),0) FROM work_order_operations))`,
    );
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('work_order_nonstandard_parts','id'), (SELECT COALESCE(MAX(id),0) FROM work_order_nonstandard_parts))`,
    );
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('work_order_machined_parts','id'), (SELECT COALESCE(MAX(id),0) FROM work_order_machined_parts))`,
    );
    await tx.$executeRawUnsafe(
      `SELECT setval(pg_get_serial_sequence('work_order_blanks','id'), (SELECT COALESCE(MAX(id),0) FROM work_order_blanks))`,
    );
  }
}
