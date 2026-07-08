import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

export interface ListPartLocationsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga: broj RN / naziv dela / crtež (WorkOrder), broj/naziv predmeta (Project), šifra/opis pozicije (Position). */
  q?: string;
  /** Radni nalog (tačan id). */
  workOrderId?: string;
  /** Predmet (tačan id). */
  projectId?: string;
  /** Pozicija/polica (tačan id). */
  positionId?: string;
  /** Radnik koji je uneo zapis (tačan id). */
  workerId?: string;
  /** Vrsta kvaliteta dela (tačan id — 0=OK,1=dorada,2=škart). */
  qualityTypeId?: string;
}

const intEq = (v: string | undefined) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isNaN(n) ? undefined : n;
};

/** Zajednički oblik reda čiji se FK-ovi razrešavaju. */
interface PartLocationRow {
  workOrderId: number;
  projectId: number;
  positionId: number;
  workerId: number;
  qualityTypeId: number;
}

/**
 * Lokacije napravljenih delova (MODULE_SPEC_lokacije §1/§5, Was: tLokacijeDelova) —
 * READ-ONLY ovog talasa. `part_locations` je LEDGER (svaki zapis = jedan unos
 * količine), ali Prisma model NEMA polje smera (postavljeno/uklonjeno) — nema
 * eksplicitnog `part_location_movements` (van obima, spec §7.1/§11 + preklapanje
 * sa ServoSync 1.0 §8). Zato se `quantity` sabira kao bruto zbir zapisa, uz
 * napomenu u `meta` — NIJE izračunato neto stanje SUM(postavljeno)-SUM(uklonjeno).
 *
 * Transfer/trebovanje (ledger-WRITE) je van ovog talasa — nema mutacija ovde.
 */
@Injectable()
export class PartLocationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListPartLocationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.PartLocationWhereInput = {
      workOrderId: intEq(query.workOrderId),
      projectId: intEq(query.projectId),
      positionId: intEq(query.positionId),
      workerId: intEq(query.workerId),
      qualityTypeId: intEq(query.qualityTypeId),
    };

    if (query.q) {
      const q = query.q;
      const [woMatches, projMatches, posMatches] = await Promise.all([
        this.prisma.workOrder.findMany({
          where: {
            OR: [
              { identNumber: { contains: q, mode: "insensitive" } },
              { partName: { contains: q, mode: "insensitive" } },
              { drawingNumber: { contains: q, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        }),
        this.prisma.project.findMany({
          where: {
            OR: [
              { projectNumber: { contains: q, mode: "insensitive" } },
              { projectName: { contains: q, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        }),
        this.prisma.position.findMany({
          where: {
            OR: [
              { positionCode: { contains: q, mode: "insensitive" } },
              { description: { contains: q, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        }),
      ]);
      const orClauses: Prisma.PartLocationWhereInput[] = [];
      if (woMatches.length)
        orClauses.push({ workOrderId: { in: woMatches.map((r) => r.id) } });
      if (projMatches.length)
        orClauses.push({ projectId: { in: projMatches.map((r) => r.id) } });
      if (posMatches.length)
        orClauses.push({ positionId: { in: posMatches.map((r) => r.id) } });
      // q je zadat, ali ništa nigde ne odgovara -> prazan rezultat (id: -1 nikad ne postoji).
      where.OR = orClauses.length ? orClauses : [{ id: -1 }];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.partLocation.findMany({
        where,
        orderBy: [{ recordDate: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.partLocation.count({ where }),
    ]);

    const data = await this.attachRelations(rows);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Kartica lokacije dela za dati RN: ledger istorija svih zapisa + zbir po poziciji
   * i ukupno. Model nema polje smera -> `quantity` je bruto zbir, ne neto stanje
   * (SUM(postavljeno)-SUM(uklonjeno)) — vidi napomenu u `meta.note`.
   */
  async card(workOrderId: number) {
    const records = await this.prisma.partLocation.findMany({
      where: { workOrderId },
      orderBy: [{ recordDate: "asc" }, { id: "asc" }],
    });

    const workOrders = await this.resolveWorkOrders([workOrderId]);
    const workOrder = workOrders.get(workOrderId) ?? null;
    if (!workOrder && records.length === 0) {
      throw new NotFoundException(
        `Radni nalog ${workOrderId} ne postoji i nema zapisa lokacija.`,
      );
    }

    const enrichedRecords = await this.attachRelations(records);

    const totalQuantity = records.reduce((sum, r) => sum + r.quantity, 0);
    const byPosition = new Map<number, number>();
    for (const r of records) {
      byPosition.set(
        r.positionId,
        (byPosition.get(r.positionId) ?? 0) + r.quantity,
      );
    }
    const positions = await this.resolvePositions([...byPosition.keys()]);
    const totalsByPosition = [...byPosition.entries()].map(
      ([positionId, quantity]) => ({
        positionId,
        position: positions.get(positionId) ?? null,
        quantity,
      }),
    );

    return {
      data: {
        workOrderId,
        workOrder,
        records: enrichedRecords,
        totalsByPosition,
        totalQuantity,
      },
      meta: {
        note:
          "part_locations nema polje smera (postavljeno/uklonjeno) — quantity je " +
          "prikazan kao bruto zbir svih zapisa za ovaj RN, NE kao izračunato neto " +
          "stanje SUM(postavljeno)-SUM(uklonjeno) (MODULE_SPEC_lokacije §1). " +
          "Ledger-write (prenos/trebovanje) je van ovog talasa.",
      },
    };
  }

  // --- batch resolveri (orphan-safe: FK skalar -> poseban upit, NIKAD include/select
  //     na obaveznoj to-one relaciji — vidi work-orders.service.ts) ---

  private async attachRelations<T extends PartLocationRow>(rows: T[]) {
    const [workOrders, projects, positions, workers, qualityTypes] =
      await Promise.all([
        this.resolveWorkOrders(rows.map((r) => r.workOrderId)),
        this.resolveProjects(rows.map((r) => r.projectId)),
        this.resolvePositions(rows.map((r) => r.positionId)),
        this.resolveWorkers(rows.map((r) => r.workerId)),
        this.resolveQualityTypes(rows.map((r) => r.qualityTypeId)),
      ]);
    return rows.map((r) => ({
      ...r,
      workOrder: workOrders.get(r.workOrderId) ?? null,
      project: projects.get(r.projectId) ?? null,
      position: positions.get(r.positionId) ?? null,
      worker: workers.get(r.workerId) ?? null,
      qualityType: qualityTypes.get(r.qualityTypeId) ?? null,
    }));
  }

  private async resolveWorkOrders(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.workOrder.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          identNumber: true,
          partName: true,
          drawingNumber: true,
          projectId: true,
        },
      }),
    );
  }

  private async resolveProjects(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.project.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          projectNumber: true,
          projectName: true,
          customerId: true,
        },
      }),
    );
  }

  private async resolvePositions(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.position.findMany({
        where: { id: { in: uniq } },
        select: { id: true, positionCode: true, description: true },
      }),
    );
  }

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
}
