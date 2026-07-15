import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma, WorkOrder } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import { parseDateParam } from "../../common/date-params";
import { resolveActorWorkerId } from "../../common/workers/resolve-actor-worker";
import type { AuthUser } from "../auth/jwt.strategy";
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
  /** RN završen (`work_orders.status`): '' = svi, 'true' = završeni, 'false' = u radu. */
  completed?: string;
  /** '1'/'true' = samo dorada/škart nalozi (poreklo != 0), pregled t.2. */
  reworkOnly?: string;
}

/** Filteri za plansku tablu operacija po prioritetu (QBigTehn „Prioritet"). */
export interface ListOperationQueueQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po identu / nazivu pozicije / crtežu RN-a. */
  q?: string;
  /** Radni centar (Operation.workCenterCode). */
  workCenterCode?: string;
  /** '1'/'true' = samo operacije sa dodeljenim prioritetom (priority < 255). */
  onlyPrioritized?: string;
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
    if (query.completed === "true") where.status = true;
    else if (query.completed === "false") where.status = { not: true };
    if (query.reworkOnly === "true" || query.reworkOnly === "1")
      where.parentWorkOrderId = { gt: 0 };
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
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
          status: true,
          handoverStatusId: true,
          workerId: true,
          qualityTypeId: true,
          enteredAt: true,
          productionDeadline: true,
          parentWorkOrderId: true,
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    const [workers, quals, statuses, parents, locations] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      this.resolveStatuses(rows.map((r) => r.handoverStatusId)),
      // t.2: izvorni RN za dorada/škart naloge (poreklo).
      this.resolveParentRefs(rows.map((r) => r.parentWorkOrderId)),
      // t.5: neto lokacije po pozicijama (relevantno za završene naloge).
      this.resolveLocations(rows.map((r) => r.id)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      qualityType: quals.get(r.qualityTypeId) ?? null,
      handoverStatus: statuses.get(r.handoverStatusId) ?? null,
      parentWorkOrder:
        r.parentWorkOrderId > 0
          ? (parents.get(r.parentWorkOrderId) ?? null)
          : null,
      locations: locations.get(r.id) ?? [],
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

    // Efektivni crtež: kad RN nema drawing_id (legacy), razreši po broju (proba
    // 14.07 — „PDF crteža" na CAM detalju/RN kartici radi i za legacy RN-ove).
    const effectiveDrawingId =
      wo.drawingId > 0
        ? wo.drawingId
        : await this.resolveDrawingIdByNumber(wo.drawingNumber);

    const [
      workers,
      quals,
      statuses,
      ops,
      parents,
      children,
      locations,
      draft,
      revisionStatus,
    ] = await Promise.all([
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
      // t.2 poreklo: izvorni RN (ako je ovo dorada/škart child).
      this.resolveParentRefs([wo.parentWorkOrderId]),
      // t.2 reverse: dorada/škart naslednici ovog RN-a.
      this.reworkChildren(wo.id),
      // t.5: neto lokacije po pozicijama.
      this.resolveLocations([wo.id]),
      // Nacrt iz kog RN potiče — za „PDF cela primopredaja" (svi crteži nacrta).
      this.resolveDraftRef(effectiveDrawingId),
      // Verzioni status crteža — UPOZORENJE kad RN koristi stariju reviziju (Nenad 15.07).
      this.resolveDrawingRevisionStatus(wo.drawingNumber, wo.revision),
    ]);
    const w = (wid: number) => workers.get(wid) ?? null;

    const data = {
      ...wo,
      // Override: efektivni crtež (razrešen po broju za legacy RN bez drawing_id)
      // — FE „PDF crteža" (CAM detalj + RN kartica) čita baš `drawingId`.
      drawingId: effectiveDrawingId,
      worker: w(wo.workerId),
      handoverWorker: w(wo.handoverWorkerId),
      qualityType: quals.get(wo.qualityTypeId) ?? null,
      handoverStatus: statuses.get(wo.handoverStatusId) ?? null,
      parentWorkOrder:
        wo.parentWorkOrderId > 0
          ? (parents.get(wo.parentWorkOrderId) ?? null)
          : null,
      reworkChildren: children,
      locations: locations.get(wo.id) ?? [],
      // Nacrt iz kog RN potiče (za „PDF cela primopredaja"); null za ručne/
      // dorada RN-ove bez razrešivog nacrta.
      draftContext: draft,
      // Verzioni status crteža: current (RN) vs latest (najnovija u bazi);
      // stale=true → FE prikaže UPOZORENJE (ne blokira). null kad nema crteža.
      drawingRevision: revisionStatus,
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

  /**
   * Batch: id → kratki ref izvornog RN-a (t.2 poreklo). 0-ovi se preskaču.
   * Orphan/obrisani izvor → nema unosa (UI prikaže samo id ako želi).
   */
  private async resolveParentRefs(ids: number[]) {
    const uniq = uniqueIds(ids.filter((id) => id > 0));
    const map = new Map<
      number,
      { id: number; identNumber: string; variant: number }
    >();
    if (!uniq.length) return map;
    const rows = await this.prisma.workOrder.findMany({
      where: { id: { in: uniq } },
      select: { id: true, identNumber: true, variant: true },
    });
    for (const r of rows) map.set(r.id, r);
    return map;
  }

  /**
   * Nacrt (handover_draft) iz kog crtež RN-a potiče — za „PDF cela primopredaja"
   * (svi crteži nacrta preko `/handover-drafts/:draftId/print-bundle`). Ista
   * drawing→draft heuristika kao `HandoversService.resolveDraftContext` (najskorija
   * ne-isključena stavka istog crteža). `null` za ručne/dorada RN-ove bez nacrta.
   */
  /**
   * Efektivni id crteža za „PDF crteža": kad RN NEMA `drawing_id` (legacy RN
   * nosi samo `drawing_number`, proba 14.07 — 74% CAM pozicija ima drawing_id=0),
   * razreši crtež po BROJU. Vrati id SAMO crteža koji ima SERVABILAN PDF po
   * ISTOM ključu koji `PdmService.getPdfContent` koristi — tačan
   * `(drawingNumber, revision)` + `pdfBinary` != null — inače bi dugme iskočilo
   * pa dalo 404 (review nalaz 14.07). Ako nijedna revizija nema PDF → 0 (dugme
   * se opravdano skriva; ne nudimo prazno). Kandidati po broju case-insensitive,
   * najviša revizija prva.
   */
  private async resolveDrawingIdByNumber(
    drawingNumber: string | null,
  ): Promise<number> {
    const num = (drawingNumber ?? "").trim();
    if (!num) return 0;
    const rows = await this.prisma.drawing.findMany({
      where: { drawingNumber: { equals: num, mode: "insensitive" } },
      select: { id: true, drawingNumber: true, revision: true },
      orderBy: { revision: "desc" },
    });
    for (const r of rows) {
      // Tačan ključ kao getPdfContent (drawingNumber_revision), + sadržaj postoji.
      const pdf = await this.prisma.drawingPdf.findFirst({
        where: {
          drawingNumber: r.drawingNumber,
          revision: r.revision,
          NOT: { pdfBinary: null },
        },
        select: { drawingNumber: true },
      });
      if (pdf) return r.id;
    }
    return 0;
  }

  /**
   * Verzioni status crteža RN-a: da li RN koristi STARIJU reviziju nego što je
   * najnovija u `drawings` za taj broj (npr. stigla nova revizija XML-om/izmenom
   * a RN nije re-izdat). `current` = RN-ova revizija; `latest` = MAX(revision) tog
   * crteža (`findFirst orderBy revision desc` — string MAX kao PDM; broj
   * case-insensitive kao `resolveDrawingIdByNumber`); `stale` = current ima
   * vrednost && norm(latest) > norm(current) (norm: trim/uppercase, prazno→"A").
   * `null` kad RN nema broj crteža ili taj crtež nema reda u `drawings`. Jedan
   * skalarni upit (bez required JOIN-a) — UPOZORENJE, ne blokira rad (Nenad 15.07).
   */
  private async resolveDrawingRevisionStatus(
    drawingNumber: string | null,
    revision: string | null,
  ): Promise<{
    current: string | null;
    latest: string | null;
    stale: boolean;
  } | null> {
    const num = (drawingNumber ?? "").trim();
    if (!num) return null;
    const latest = await this.prisma.drawing.findFirst({
      where: { drawingNumber: { equals: num, mode: "insensitive" } },
      orderBy: { revision: "desc" },
      select: { revision: true },
    });
    if (!latest) return null;
    const current = (revision ?? "").trim() || null;
    const norm = (r: string | null) => (r ?? "").trim().toUpperCase() || "A";
    const stale = current != null && norm(latest.revision) > norm(current);
    return { current, latest: latest.revision ?? null, stale };
  }

  private async resolveDraftRef(
    drawingId: number,
  ): Promise<{ draftId: number; draftNumber: string } | null> {
    if (!drawingId || drawingId <= 0) return null;
    const item = await this.prisma.handoverDraftItem.findFirst({
      where: { drawingId, excludeFromHandover: false },
      select: { draftId: true },
      orderBy: [{ draftId: "desc" }, { id: "desc" }],
    });
    if (!item) return null;
    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id: item.draftId },
      select: { id: true, draftNumber: true },
    });
    return draft ? { draftId: draft.id, draftNumber: draft.draftNumber } : null;
  }

  /** Dorada/škart naslednici RN-a (reverse od parentWorkOrderId), t.2. */
  private async reworkChildren(workOrderId: number) {
    return this.prisma.workOrder.findMany({
      where: { parentWorkOrderId: workOrderId },
      select: {
        id: true,
        identNumber: true,
        variant: true,
        qualityTypeId: true,
        pieceCount: true,
      },
      orderBy: { id: "asc" },
    });
  }

  /**
   * Batch: workOrderId → neto lokacije [{ positionCode, quantity }] (t.5).
   * `part_locations` je signed ledger — neto = SUM(quantity) po (RN, pozicija);
   * prikazuju se samo pozicije sa pozitivnim neto stanjem. Prazno kad RN nema
   * evidentiranu lokaciju (nezavršeni / kontrola još nije lokovala delove).
   */
  private async resolveLocations(workOrderIds: number[]) {
    const uniq = uniqueIds(workOrderIds);
    const map = new Map<number, { positionCode: string; quantity: number }[]>();
    if (!uniq.length) return map;
    const grouped = await this.prisma.partLocation.groupBy({
      by: ["workOrderId", "positionId"],
      where: { workOrderId: { in: uniq } },
      _sum: { quantity: true },
    });
    const positive = grouped.filter((g) => (g._sum.quantity ?? 0) > 0);
    const positions = byId(
      await this.prisma.position.findMany({
        where: { id: { in: uniqueIds(positive.map((g) => g.positionId)) } },
        select: { id: true, positionCode: true },
      }),
    );
    for (const g of positive) {
      const code = positions.get(g.positionId)?.positionCode;
      if (!code) continue;
      const list = map.get(g.workOrderId) ?? [];
      list.push({ positionCode: code, quantity: g._sum.quantity ?? 0 });
      map.set(g.workOrderId, list);
    }
    return map;
  }

  /**
   * Planska tabla operacija po prioritetu (QBigTehn „Prioritet") — operacije
   * NEZAVRŠENIH radnih naloga, sortirane po prioritetu (manji broj = hitnije),
   * pa po roku isporuke i broju operacije. Filteri: RC (`workCenterCode`), pretraga
   * (`q`), `onlyPrioritized` (samo priority < 255). Enrichment batch-resolverima
   * (bez required-JOIN-a; WHERE-relacija samo isključuje orphan-e, ne puca 500).
   */
  async operationQueue(query: ListOperationQueueQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    // WHERE-relacija na workOrder je INNER JOIN filter (orphan operacije samo ispadaju).
    const woFilter: Prisma.WorkOrderWhereInput = {
      status: { not: true }, // nezavršeni RN
    };
    if (query.q) {
      woFilter.OR = [
        { identNumber: { contains: query.q, mode: "insensitive" } },
        { partName: { contains: query.q, mode: "insensitive" } },
        { drawingNumber: { contains: query.q, mode: "insensitive" } },
      ];
    }

    const where: Prisma.WorkOrderOperationWhereInput = {
      workOrder: { is: woFilter },
    };
    if (query.workCenterCode) where.workCenterCode = query.workCenterCode;
    if (query.onlyPrioritized === "1" || query.onlyPrioritized === "true") {
      where.priority = { lt: 255 };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workOrderOperation.findMany({
        where,
        orderBy: [
          { priority: "asc" },
          { workOrderId: "asc" },
          { operationNumber: "asc" },
        ],
        skip,
        take,
        select: {
          id: true,
          workOrderId: true,
          operationNumber: true,
          workCenterCode: true,
          workDescription: true,
          priority: true,
          setupTime: true,
          cycleTime: true,
          workerId: true,
        },
      }),
      this.prisma.workOrderOperation.count({ where }),
    ]);

    const [orders, ops, workers] = await Promise.all([
      this.resolveWorkOrderHeaders(rows.map((r) => r.workOrderId)),
      this.resolveOperationsByCode(rows.map((r) => r.workCenterCode)),
      this.resolveWorkers(rows.map((r) => r.workerId)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      workOrder: orders.get(r.workOrderId) ?? null,
      operation: ops.get(r.workCenterCode) ?? null,
      worker: workers.get(r.workerId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** Batch-resolve zaglavlja RN-ova (za plansku tablu i sl.) — bez required-JOIN-a. */
  private async resolveWorkOrderHeaders(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          identNumber: true,
          variant: true,
          projectId: true,
          partName: true,
          drawingNumber: true,
          revision: true,
          pieceCount: true,
          productionDeadline: true,
          handoverStatusId: true,
          status: true,
        },
      }),
    );
  }

  // ---------------------------------------------------------------- CREATE

  async create(dto: CreateWorkOrderDto, actor?: AuthUser) {
    validateCreateWorkOrder(dto);

    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik) — inače
    // se autor TP-a tiho upisuje kao radnik 0. Vidi resolve-actor-worker.ts.
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);

    const created = await this.prisma.$transaction(async (tx) => {
      // Sync postavlja eksplicitne legacy id-jeve; poravnaj sekvencu pre insert-a
      // da autoincrement ne kolidira sa uvezenim redovima.
      await this.alignSeq(tx, "work_orders");
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
          // workerId = TEHNOLOG autor TP-a; kod ručnog unosa to je po pravilu
          // sam prijavljeni tehnolog (svež worker) ako DTO ne kaže drugačije.
          workerId: dto.workerId ?? actorWorkerId ?? 0,
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
      throw new UnprocessableEntityException(
        "Zaključan RN se ne može menjati.",
      );
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
   * `workerId` = autor stavke: DTO ako je poslat, inače SVEŽ radnik naloga
   * (isti obrazac kao `create()` zaglavlja) — UI ga ne šalje, pa bi bez
   * fallback-a sve nove operacije imale workerId=0.
   */
  async addOperation(
    workOrderId: number,
    dto: CreateWorkOrderOperationDto,
    actor?: AuthUser,
  ) {
    validateCreateOperation(dto);
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, isLocked: true },
    });
    if (!wo)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
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
          workerId: dto.workerId ?? actorWorkerId ?? 0,
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
    if (!wo)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
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
      if (dto.priority === undefined)
        data.priority = op.usesPriority ? 100 : 255;
    }

    await this.prisma.workOrderOperation.update({
      where: { id: operationId },
      data,
    });
    return this.findOne(workOrderId);
  }

  /**
   * CAM prioritet operacije (legacy grid-unos u `PregledOperacijaPoPrioritetima`).
   * Namenski endpoint iza `tehnologija.write` — CNC programer NEMA `rn.write`,
   * pa ne sme kroz `updateOperation`. Dozvoljeno i na LANSIRANOM RN-u (prioritet
   * je pogonska odluka, ne izmena TP-a); zaključan RN → 422. Opseg 0–255
   * (255 = bez prioriteta / dno planske table).
   */
  async setOperationPriority(operationId: number, priority: number) {
    if (
      typeof priority !== "number" ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 255
    )
      throw new BadRequestException("Prioritet mora biti ceo broj 0–255.");

    const op = await this.prisma.workOrderOperation.findUnique({
      where: { id: operationId },
      select: { id: true, workOrderId: true },
    });
    if (!op) throw new NotFoundException(`Operacija ${operationId} ne postoji`);

    // Batch-resolve umesto required-JOIN (orphan FK ne sme da obori 500);
    // orphan operacija (RN ne postoji) nema lock guard — izmena prolazi.
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: op.workOrderId },
      select: { isLocked: true },
    });
    if (wo?.isLocked)
      throw new UnprocessableEntityException(
        "Zaključan RN — prioritet operacije se ne može menjati.",
      );

    const updated = await this.prisma.workOrderOperation.update({
      where: { id: operationId },
      data: { priority },
      select: { id: true, workOrderId: true, priority: true },
    });
    return { data: updated };
  }

  /** Brisanje operacije RN-a (+ eventualne skice te operacije). Guard: RN nije zaključan. */
  async deleteOperation(workOrderId: number, operationId: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id: workOrderId },
      select: { id: true, isLocked: true },
    });
    if (!wo)
      throw new NotFoundException(`Radni nalog ${workOrderId} ne postoji`);
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
   * Kaskadno brisanje RN-a (`spObrisiKompletanNalog`, §K) unutar prosleđene
   * transakcije. Sve FK relacije su `NoAction` → brišemo eksplicitno, dubina
   * prvo. Redosled: PRVO evidencija rada vezana za `tech_processes` ovog RN-a
   * (tech_process_documents → work_time_entries → tech_processes), PA postojeća
   * RN kaskada (slike operacija → operacije → machined/blanks/nonstandard →
   * komponente → itemKomponente → odobravanja → lansiranja → RN).
   */
  private async deleteWorkOrderCascade(
    tx: Prisma.TransactionClient,
    id: number,
  ): Promise<void> {
    // Evidencija rada (prijave/kucanja) vezana za tech_processes ovog RN-a.
    const techProcesses = await tx.techProcess.findMany({
      where: { workOrderId: id },
      select: { id: true },
    });
    const tpIds = techProcesses.map((t) => t.id);
    if (tpIds.length) {
      await tx.techProcessDocument.deleteMany({
        where: { techProcessId: { in: tpIds } },
      });
      await tx.workTimeEntry.deleteMany({
        where: { techProcessId: { in: tpIds } },
      });
    }
    await tx.techProcess.deleteMany({ where: { workOrderId: id } });

    // Postojeća RN kaskada.
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
  }

  /**
   * Brisanje RN-a sa kaskadom (`spObrisiKompletanNalog`, §K). Guard:
   *   - zaključan RN (422),
   *   - postoji evidentiran rad — neki `tech_processes` red ima `pieceCount > 0`
   *     ILI `isProcessFinished` ILI postoji `work_time_entries` zapis (422).
   * Placeholder redovi od test-skena (`pieceCount 0`, create-on-scan, bez
   * vremena) se NE računaju kao proizvodnja — brišu se zajedno sa RN-om preko
   * `deleteWorkOrderCascade` (inače tehnolog ne bi mogao da obriše test RN).
   * Za prinudno brisanje uz evidenciju rada postoji `forceRemove` (admin/sef).
   */
  async remove(id: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true, isLocked: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    if (wo.isLocked)
      throw new UnprocessableEntityException(
        "Zaključan RN se ne može obrisati.",
      );

    const techProcesses = await this.prisma.techProcess.findMany({
      where: { workOrderId: id },
      select: { id: true, pieceCount: true, isProcessFinished: true },
    });
    const ids = techProcesses.map((t) => t.id);
    const timeEntries = ids.length
      ? await this.prisma.workTimeEntry.count({
          where: { techProcessId: { in: ids } },
        })
      : 0;
    const hasRealWork =
      timeEntries > 0 ||
      techProcesses.some((t) => t.pieceCount > 0 || t.isProcessFinished === true);
    if (hasRealWork)
      throw new UnprocessableEntityException(
        "Po ovom nalogu postoji evidentiran rad (prijave/kucanja) — ne može se obrisati. Prinudno brisanje je dostupno administratoru/šefu.",
      );

    await this.prisma.$transaction((tx) => this.deleteWorkOrderCascade(tx, id));
    return { data: { id, deleted: true } };
  }

  /**
   * Prinudno brisanje RN-a (admin/sef, `rn.delete.force`). Briše RN I SVU
   * evidenciju rada (tech_processes, prijave/kucanja, work_time_entries) bez
   * obzira na `pieceCount`/završenost/evidentirano vreme i ZAOBILAZI lock guard
   * (ne čita `isLocked`). Audit se beleži automatski (globalni interceptor).
   */
  async forceRemove(id: number) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!wo) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    await this.prisma.$transaction((tx) => this.deleteWorkOrderCascade(tx, id));
    return { data: { id, deleted: true } };
  }

  // ---------------------------------------------------------------- WORKFLOW

  /**
   * Odobri / odbij RN. Autor odobravanja = JWT-vezan radnik (`users.worker_id`).
   * TODO(auth): drugi gate `Worker.definesApproval` (workerType ∈ {Tehnolog,
   * Inženjeri}) — aktivira se uz RBAC (V2).
   */
  async approve(id: number, approve: boolean, actor?: AuthUser) {
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

    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik) — inače
    // se createdBy/updatedBy audit tiho beleži kao radnik 0.
    const actorWorkerId = (await resolveActorWorkerId(this.prisma, actor)) ?? 0;
    await this.prisma.$transaction(async (tx) => {
      await tx.workOrder.update({
        where: { id },
        data: {
          handoverStatusId: approve ? WO_STATUS.APPROVED : WO_STATUS.REJECTED,
        },
      });
      // Sync (§5.3 tSaglasanRN uvoz) upisuje eksplicitne legacy id-jeve —
      // poravnaj sekvencu pre insert-a (isti obrazac kao create()/alignSeq),
      // inače prvi approve posle uvoza pada na P2002 duplikat PK.
      await this.alignSeq(tx, "work_order_approvals");
      await tx.workOrderApproval.create({
        data: {
          workOrderId: id,
          isApproved: approve,
          enteredAt: new Date(),
          // TODO(auth): *Signature polja iz User↔Worker veze (RBAC §4).
          createdByWorkerId: actorWorkerId,
          updatedByWorkerId: actorWorkerId,
        },
      });
    });
    return this.findOne(id);
  }

  /**
   * Lansiraj RN. Preduslov: mora biti SAGLASAN (nikad obrnuto). Ako je RN
   * nastao iz primopredaje (`drawing_handover_id > 0`) i "original" je za nju
   * (najmanji id — klonovi dele FK), u ISTOJ transakciji se i primopredaja
   * podiže na LANSIRAN + zaključava — lansiranje sa RN strane sklanja stavku
   * iz taba "Odobrene" (prepare-work-order tok, P1).
   * TODO(auth): drugi gate `Worker.definesLaunch` — V2.
   */
  async launch(id: number, actor?: AuthUser) {
    const wo = await this.prisma.workOrder.findUnique({
      where: { id },
      select: {
        id: true,
        isLocked: true,
        handoverStatusId: true,
        drawingHandoverId: true,
      },
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

    // Svež users.worker_id kad JWT nema workerId (naknadno vezan radnik) — inače
    // se launch audit (statusChangedById/launchedById) tiho beleži kao radnik 0.
    const actorWorkerId = await resolveActorWorkerId(this.prisma, actor);
    await this.prisma.$transaction(async (tx) => {
      if (wo.drawingHandoverId > 0) {
        // Isti advisory lock kao handovers prepare/launch
        // (`lockHandoverWorkOrder`): serijalizuje RN-level i handover-level
        // launch za istu primopredaju. Bez njega handover-strana pročita
        // stanje PRE našeg komita (READ COMMITTED), odblokira se na row-locku
        // i bezuslovno prođe → dupli launch red + pregažen launch audit.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`drawing_handover_wo:${wo.drawingHandoverId}`}))`;
      }
      // Uslovni update: dva konkurentna launch-a (dva taba / paralelni
      // handover-level launch) — samo prvi prolazi, drugi dobija 409 umesto
      // duplog launch reda. `is_locked` je Boolean? (legacy sync iz
      // tRN.Zakljucano ostavlja NULL) — spoljna provera `!wo.isLocked` NULL
      // tretira kao otključan, pa i where mora da uhvati NULL (eksplicitni OR;
      // `isLocked: false` NE matchuje NULL → trajni lažni 409).
      const updated = await tx.workOrder.updateMany({
        where: {
          id,
          handoverStatusId: WO_STATUS.APPROVED,
          OR: [{ isLocked: false }, { isLocked: null }],
        },
        data: { handoverStatusId: WO_STATUS.LAUNCHED },
      });
      if (updated.count === 0)
        throw new ConflictException(
          "RN je u međuvremenu promenjen (lansiran/zaključan) — osvežite pregled.",
        );
      // Sync (tLansiranRN mapiranje) upisuje eksplicitne legacy id-jeve —
      // poravnaj sekvencu pre insert-a (isti obrazac kao approve gore).
      await this.alignSeq(tx, "work_order_launches");
      await tx.workOrderLaunch.create({
        data: {
          workOrderId: id,
          isLaunched: true,
          enteredAt: new Date(),
          createdByWorkerId: actorWorkerId ?? 0,
          updatedByWorkerId: actorWorkerId ?? 0,
        },
      });
      if (wo.drawingHandoverId > 0) {
        // Klonovi (rework/bulk-clone) dele isti drawing_handover_id — na
        // primopredaju propagira SAMO "original" (najmanji id, isti kriterijum
        // kao findHandoverWorkOrder u handovers servisu); lansiranje škart/
        // dorada child-a ne sme da prepiše launchedAt/By primopredaje.
        const original = await tx.workOrder.findFirst({
          where: { drawingHandoverId: wo.drawingHandoverId },
          orderBy: { id: "asc" },
          select: { id: true },
        });
        if (original?.id === id) {
          // updateMany (ne update): FK nema DB constraint, orphan referenca ne
          // sme da obori lansiranje RN-a (isti razlog kao batch-resolve čitanja);
          // guard `statusId != LANSIRAN` čuva postojeći launch audit.
          // HANDOVER_LEGACY_GUARD (paritet handovers.assertNotLegacyGuarded):
          // dok je guard aktivan, derivirani legacy redovi (legacyRnId != null)
          // se NE diraju — QBigTehn ih i dalje vodi, a naša mutacija bi bila
          // pregažena sledećim derivacionim run-om (uz rizik da remap FK-a još
          // nije prošao pa bi update pogodio NEPOVEZAN red). Launch RN-a
          // prolazi; propagacija se tiho preskače kroz updateMany filter.
          const legacyGuardActive =
            process.env.HANDOVER_LEGACY_GUARD !== "false";
          const now = new Date();
          await tx.drawingHandover.updateMany({
            where: {
              id: wo.drawingHandoverId,
              statusId: { not: WO_STATUS.LAUNCHED },
              ...(legacyGuardActive ? { legacyRnId: null } : {}),
            },
            data: {
              statusId: WO_STATUS.LAUNCHED,
              statusChangedAt: now,
              statusChangedById: actorWorkerId,
              launchedAt: now,
              launchedById: actorWorkerId,
              isLocked: true,
            },
          });
        }
      }
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
   * „Prepiši isti postupak" (legacy `PrepisiZaglavljePostupka`,
   * QBigTehn_APL/modules/RN_Modul.bas:179): klon RN-a kao NOVI red sa ISTIM
   * `identNumber` i `variant = MAX(variant)+1` — legacy
   * `fsSledecaVrednostVarijante` gleda (projectId, drawingNumber, revision), ali
   * `updateHeader` sme da promeni crtež/reviziju postojećoj varijanti pa bi MAX
   * samo po trojci vratio zauzetu varijantu za isti ident → uzima se VEĆI od dva
   * MAX-a: po legacy trojci i po (projectId, identNumber). Advisory lock po
   * predmetu (isti ključ kao numbering/rework) serijalizuje konkurentne klonove;
   * DB mreža je `uq_work_orders_project_ident_variant` (trojka na koju se vezuju
   * `tech_processes` kucanja i RNZ barkod mora biti jedinstvena).
   * Zaglavlje kroz `buildCloneHeader` (status = U OBRADI,
   * otključan — launch stanje se NE kopira); `drawingHandoverId` se NE kopira:
   * nova varijanta nije vezana za staru primopredaju (rework klonovi ga dele jer
   * su remedijacija ISTE varijante, a launch propagacija ionako gađa samo
   * "original" — najmanji id po FK). Stavke: sve 4 vrste kroz `cloneItems`
   * (coefficient 1, prioritet regen §3.4). Kiosk staleWorkOrder guard ovim
   * oživljava za native naloge: scan otiska sa starom varijantom → upozorenje.
   */
  async cloneVariant(sourceId: number) {
    const created = await this.prisma.$transaction(async (tx) => {
      const source = await tx.workOrder.findUnique({ where: { id: sourceId } });
      if (!source)
        throw new NotFoundException(`Radni nalog ${sourceId} ne postoji`);

      // Serijalizuj po predmetu — MAX(variant) račun i insert bez race-a.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${source.projectId})`;

      // MAX po OBA ključa (vidi docstring) — veći od dva + 1.
      const [byDrawing, byIdent] = await Promise.all([
        tx.workOrder.aggregate({
          where: {
            projectId: source.projectId,
            drawingNumber: source.drawingNumber,
            revision: source.revision,
          },
          _max: { variant: true },
        }),
        tx.workOrder.aggregate({
          where: {
            projectId: source.projectId,
            identNumber: source.identNumber,
          },
          _max: { variant: true },
        }),
      ]);
      const variant =
        Math.max(
          byDrawing._max.variant ?? source.variant,
          byIdent._max.variant ?? source.variant,
        ) + 1;

      await this.alignWorkOrderSequence(tx);
      await this.alignItemSequences(tx);

      const clone = await tx.workOrder.create({
        data: this.buildCloneHeader(source, {
          identNumber: source.identNumber,
          variant,
          drawingHandoverId: 0,
        }),
        select: { id: true, identNumber: true, variant: true },
      });

      await this.cloneItems(tx, sourceId, clone.id, {
        coefficient: 1,
        recomputePriority: true,
      });
      return clone;
    });

    return {
      data: {
        workOrderId: created.id,
        identNumber: created.identNumber,
        variant: created.variant,
      },
    };
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
        where: {
          projectId: source.projectId,
          identNumber: { startsWith: prefix },
        },
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
          // Strukturisano poreklo (t.2): child dorada/škart RN pamti izvorni RN.
          parentWorkOrderId: sourceId,
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
            // Klon u DRUGOM predmetu nije vezan za izvornu primopredaju (isto
            // kao cloneVariant): nasleđen FK bi posle brisanja izvora učinio
            // klon "originalom" (najmanji id) za tuđu primopredaju — launch
            // klona bi lansirao nepovezanu primopredaju. (rework NAMERNO deli
            // FK — remedijacija iste varijante, vidi docstring rework-a.)
            drawingHandoverId: 0,
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
      // Poreklo se NE nasleđuje po defaultu (clone-variant/bulk-clone su nezavisni
      // nalozi); rework() ga eksplicitno override-uje na izvorni RN.
      parentWorkOrderId: 0,
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
   * Poravnaj identity sekvencu tabele sa MAX(id) — delegira na zajednički
   * `alignIdSequence` (src/common/db-sequences.ts, 3-arg `setval` bezbedan i
   * na praznoj tabeli). Sync uvozi eksplicitne legacy id-jeve → autoincrement
   * inače kolidira sa uvezenim redovima.
   */
  private async alignSeq(tx: Prisma.TransactionClient, table: string) {
    await alignIdSequence(tx, table);
  }

  /** Poravnaj `work_orders` sekvencu (vidi `alignSeq`). */
  private async alignWorkOrderSequence(tx: Prisma.TransactionClient) {
    await this.alignSeq(tx, "work_orders");
  }

  /** Poravnaj sekvence 4 tabela stavki (vidi `alignSeq`). */
  private async alignItemSequences(tx: Prisma.TransactionClient) {
    await this.alignSeq(tx, "work_order_operations");
    await this.alignSeq(tx, "work_order_nonstandard_parts");
    await this.alignSeq(tx, "work_order_machined_parts");
    await this.alignSeq(tx, "work_order_blanks");
  }
}
