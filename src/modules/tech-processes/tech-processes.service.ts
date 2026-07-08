import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";

export interface ListTechProcessesQuery {
  page?: string;
  pageSize?: string;
  /** Filter by ident number (substring, case-insensitive). */
  identNumber?: string;
  /** Filter by project id. */
  projectId?: string;
}

/**
 * Read-only access to technological processes (`tech_processes`).
 *
 * Data is owned by ServoSync (production/tech tables) and populated by the
 * QBigTehn sync. This service is READ ONLY — no writes until §11 / RBAC land.
 */
@Injectable()
export class TechProcessesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListTechProcessesQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.TechProcessWhereInput = {};
    if (query.identNumber) {
      where.identNumber = { contains: query.identNumber, mode: "insensitive" };
    }
    const projectId = Number.parseInt(query.projectId ?? "", 10);
    if (!Number.isNaN(projectId)) where.projectId = projectId;

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
          signature: true,
          note: true,
          worker: { select: SAFE_WORKER_SELECT },
        },
      }),
      this.prisma.techProcess.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const row = await this.prisma.techProcess.findUnique({
      where: { id },
      include: {
        worker: { select: SAFE_WORKER_SELECT },
        documents: true,
      },
    });
    if (!row)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);
    return { data: row };
  }
}
