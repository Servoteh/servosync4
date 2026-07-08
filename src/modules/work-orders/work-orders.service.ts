import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";

export interface ListWorkOrdersQuery {
  page?: string;
  pageSize?: string;
  /** Free-text over ident number / part name / drawing number. */
  q?: string;
  /** 'true' | 'false' — the legacy boolean `status`. */
  status?: string;
}

/**
 * Read-only access to work orders (`work_orders` / Radni nalozi).
 *
 * ServoSync-owned production data (from QBigTehn sync). READ ONLY for now.
 */
@Injectable()
export class WorkOrdersService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (query.status === "true") where.status = true;
    else if (query.status === "false") where.status = false;

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
          status: true,
          isLocked: true,
          enteredAt: true,
          productionDeadline: true,
          worker: { select: SAFE_WORKER_SELECT },
          qualityType: { select: { id: true, name: true } },
        },
      }),
      this.prisma.workOrder.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const row = await this.prisma.workOrder.findUnique({
      where: { id },
      include: {
        worker: { select: SAFE_WORKER_SELECT },
        handoverWorker: { select: SAFE_WORKER_SELECT },
        qualityType: true,
        handoverStatus: true,
        operations: {
          orderBy: { operationNumber: "asc" },
          include: {
            worker: { select: SAFE_WORKER_SELECT },
            operation: true,
          },
        },
      },
    });
    if (!row) throw new NotFoundException(`Radni nalog ${id} ne postoji`);
    return { data: row };
  }
}
