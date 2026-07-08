import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

/**
 * MRP / Nabavka — SAMO UVID (MODULE_SPEC_mrp.md, BACKEND_RULES §11.3).
 * BOM eksplozija i planiranje (mrp_plans/_items, purchase_requests) NISU u šemi
 * još i NE implementiraju se ovde — čekaju dizajn BOM/MRP logike (§11.3, otvoreno).
 * Ovaj servis samo čita `mrp_demands` / `mrp_demand_items` / `mrp_item_stock`.
 *
 * Legacy tabele — sync ih tek uvodi, mogu biti prazne; svi upiti/mape rade i sa
 * 0 redova (batch-resolveri vraćaju prazan Map, `.get()` → null).
 */

const PROJECT_REF_SELECT = {
  id: true,
  projectNumber: true,
  projectName: true,
  customerId: true,
} satisfies Prisma.ProjectSelect;

const DRAWING_REF_SELECT = {
  id: true,
  drawingNumber: true,
  name: true,
  catalogNumber: true,
  revision: true,
} satisfies Prisma.DrawingSelect;

const ITEM_REF_SELECT = {
  id: true,
  catalogNumber: true,
  name: true,
  unit: true,
} satisfies Prisma.ItemSelect;

/**
 * `mrp_demand_items.supplier_id` / `items.supplier_id` nemaju posebnu Supplier
 * tabelu u šemi — BigBit (Komitenti) drži i komitente i dobavljače u istom
 * ID prostoru kao `customers`. Rešavamo preko Customer-a; orphan-safe (null ako
 * ne postoji). Ako se ovo pokaže netačno, integrator treba da potvrdi sa domenom.
 */
const SUPPLIER_REF_SELECT = {
  id: true,
  name: true,
  city: true,
} satisfies Prisma.CustomerSelect;

const DEMAND_SELECT = {
  id: true,
  projectId: true,
  rootDrawingId: true,
  workerId: true,
  source: true,
  explosionType: true,
  status: true,
  demandDate: true,
  note: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  plannedQuantity: true,
  planId: true,
} satisfies Prisma.MrpDemandSelect;

const DEMAND_ITEM_SELECT = {
  id: true,
  demandId: true,
  sourceDrawingId: true,
  procurementDrawingId: true,
  itemId: true,
  itemCatalogNumber: true,
  itemName: true,
  itemUnit: true,
  itemSource: true,
  requiredQuantity: true,
  demandDate: true,
  leadTimeDays: true,
  procurementDate: true,
  note: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  supplierId: true,
  itemStatus: true,
  reservedQuantity: true,
  toProcureQuantity: true,
} satisfies Prisma.MrpDemandItemSelect;

const STOCK_SELECT = {
  itemId: true,
  inStock: true,
  reserved: true,
  name: true,
  catalogNumber: true,
  unit: true,
  updatedAt: true,
} satisfies Prisma.MrpItemStockSelect;

function parseIntParam(v?: string): number | undefined {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isNaN(n) ? undefined : n;
}

export interface ListDemandsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po napomeni. */
  q?: string;
  /** MrpDemand.status (legacy `MRP_Potrebe.Status`, small int; nema enum tabelu). */
  status?: string;
  /** Predmet. */
  projectId?: string;
  workerId?: string;
  /** Datum potrebe od (ISO). */
  from?: string;
  /** Datum potrebe do (ISO). */
  to?: string;
}

export interface ListStockQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: katalog broj / naziv artikla. */
  q?: string;
  itemId?: string;
}

export interface ListDemandItemsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: katalog broj / naziv stavke. */
  q?: string;
  demandId?: string;
  /** Predmet (preko `demand.projectId`). */
  projectId?: string;
  itemId?: string;
  /** MrpDemandItem.itemStatus (small int). */
  itemStatus?: string;
}

@Injectable()
export class MrpService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- DEMANDS

  async listDemands(query: ListDemandsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.MrpDemandWhereInput = {};
    if (query.q) where.note = { contains: query.q, mode: "insensitive" };
    where.status = parseIntParam(query.status);
    where.projectId = parseIntParam(query.projectId);
    where.workerId = parseIntParam(query.workerId);
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
      where.demandDate = range;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mrpDemand.findMany({
        where,
        orderBy: [{ demandDate: "desc" }, { id: "desc" }],
        skip,
        take,
        select: { ...DEMAND_SELECT, _count: { select: { items: true } } },
      }),
      this.prisma.mrpDemand.count({ where }),
    ]);

    const [projects, drawings, workers] = await Promise.all([
      this.resolveProjects(rows.map((r) => r.projectId)),
      this.resolveDrawings(rows.map((r) => r.rootDrawingId)),
      this.resolveWorkers(rows.map((r) => r.workerId)),
    ]);

    const data = rows.map(({ _count, ...r }) => ({
      ...r,
      itemsCount: _count.items,
      project: projects.get(r.projectId) ?? null,
      rootDrawing: drawings.get(r.rootDrawingId ?? 0) ?? null,
      worker: workers.get(r.workerId ?? 0) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOneDemand(id: number) {
    const demand = await this.prisma.mrpDemand.findUnique({
      where: { id },
      select: {
        ...DEMAND_SELECT,
        items: { orderBy: { id: "asc" }, select: DEMAND_ITEM_SELECT },
      },
    });
    if (!demand) throw new NotFoundException(`MRP potreba ${id} ne postoji`);
    const { items, ...header } = demand;

    const [projects, drawings, workers, itemsRef, suppliers, stock] =
      await Promise.all([
        this.resolveProjects([header.projectId]),
        this.resolveDrawings([
          header.rootDrawingId,
          ...items.map((i) => i.sourceDrawingId),
          ...items.map((i) => i.procurementDrawingId),
        ]),
        this.resolveWorkers([header.workerId]),
        this.resolveItems(items.map((i) => i.itemId)),
        this.resolveSuppliers(items.map((i) => i.supplierId)),
        this.resolveStock(items.map((i) => i.itemId)),
      ]);

    const data = {
      ...header,
      project: projects.get(header.projectId) ?? null,
      rootDrawing: drawings.get(header.rootDrawingId ?? 0) ?? null,
      worker: workers.get(header.workerId ?? 0) ?? null,
      items: items.map((it) => {
        const s = it.itemId ? stock.get(it.itemId) : undefined;
        return {
          ...it,
          sourceDrawing: drawings.get(it.sourceDrawingId ?? 0) ?? null,
          procurementDrawing:
            drawings.get(it.procurementDrawingId ?? 0) ?? null,
          item: itemsRef.get(it.itemId ?? 0) ?? null,
          supplier: suppliers.get(it.supplierId ?? 0) ?? null,
          // §3.1: SlobodneZalihe = Zalihe − Rezervisano; null ako nema snapshot reda.
          freeStock: s ? s.inStock.minus(s.reserved) : null,
        };
      }),
    };
    return { data };
  }

  // ---------------------------------------------------------------- STOCK

  async listStock(query: ListStockQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.MrpItemStockWhereInput = {};
    where.itemId = parseIntParam(query.itemId);
    if (query.q) {
      where.OR = [
        { catalogNumber: { contains: query.q, mode: "insensitive" } },
        { name: { contains: query.q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mrpItemStock.findMany({
        where,
        orderBy: [{ itemId: "asc" }],
        skip,
        take,
        select: STOCK_SELECT,
      }),
      this.prisma.mrpItemStock.count({ where }),
    ]);

    const items = await this.resolveItems(rows.map((r) => r.itemId));

    const data = rows.map((r) => ({
      ...r,
      // §3.1: SlobodneZalihe = Zalihe − Rezervisano (polja postoje, uvek Decimal).
      freeStock: r.inStock.minus(r.reserved),
      item: items.get(r.itemId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- DEMAND ITEMS (agregat)

  async listDemandItems(query: ListDemandItemsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.MrpDemandItemWhereInput = {};
    where.demandId = parseIntParam(query.demandId);
    where.itemId = parseIntParam(query.itemId);
    where.itemStatus = parseIntParam(query.itemStatus);
    const projectId = parseIntParam(query.projectId);
    if (projectId !== undefined) where.demand = { projectId };
    if (query.q) {
      where.OR = [
        { itemCatalogNumber: { contains: query.q, mode: "insensitive" } },
        { itemName: { contains: query.q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mrpDemandItem.findMany({
        where,
        orderBy: [{ demandId: "desc" }, { id: "asc" }],
        skip,
        take,
        select: DEMAND_ITEM_SELECT,
      }),
      this.prisma.mrpDemandItem.count({ where }),
    ]);

    const [demands, items, suppliers, stock] = await Promise.all([
      this.resolveDemandSummaries(rows.map((r) => r.demandId)),
      this.resolveItems(rows.map((r) => r.itemId)),
      this.resolveSuppliers(rows.map((r) => r.supplierId)),
      this.resolveStock(rows.map((r) => r.itemId)),
    ]);

    const data = rows.map((r) => {
      const s = r.itemId ? stock.get(r.itemId) : undefined;
      return {
        ...r,
        demand: demands.get(r.demandId) ?? null,
        item: items.get(r.itemId ?? 0) ?? null,
        supplier: suppliers.get(r.supplierId ?? 0) ?? null,
        freeStock: s ? s.inStock.minus(s.reserved) : null,
      };
    });

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // --- batch resolveri (izbegavaju required-relation JOIN koji puca na orphan FK) ---

  private async resolveProjects(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.project.findMany({
        where: { id: { in: uniq } },
        select: PROJECT_REF_SELECT,
      }),
    );
  }

  private async resolveDrawings(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.drawing.findMany({
        where: { id: { in: uniq } },
        select: DRAWING_REF_SELECT,
      }),
    );
  }

  /** NIKAD ne vraćati workers.password / workerPassword. */
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

  private async resolveItems(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.item.findMany({
        where: { id: { in: uniq } },
        select: ITEM_REF_SELECT,
      }),
    );
  }

  /** Vidi napomenu uz SUPPLIER_REF_SELECT — resolvuje se preko Customer (Komitenti). */
  private async resolveSuppliers(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.customer.findMany({
        where: { id: { in: uniq } },
        select: SUPPLIER_REF_SELECT,
      }),
    );
  }

  /** `mrp_item_stock` PK je `itemId`, ne `id` — mapira se ručno (ne `byId`). */
  private async resolveStock(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    const empty = new Map<
      number,
      { inStock: Prisma.Decimal; reserved: Prisma.Decimal }
    >();
    if (!uniq.length) return empty;
    const rows = await this.prisma.mrpItemStock.findMany({
      where: { itemId: { in: uniq } },
      select: { itemId: true, inStock: true, reserved: true },
    });
    for (const r of rows) empty.set(r.itemId, r);
    return empty;
  }

  private async resolveDemandSummaries(ids: (number | null | undefined)[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.mrpDemand.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          projectId: true,
          status: true,
          demandDate: true,
          planId: true,
        },
      }),
    );
  }
}
