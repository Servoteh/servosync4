import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";

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
 * Relacije se razrešavaju batch upitima (ne Prisma required-relation JOIN) jer
 * legacy podaci imaju orphan FK-ove koji bi inače dali 500. READ ONLY (do §11/RBAC).
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
        },
      }),
      this.prisma.techProcess.count({ where }),
    ]);

    const workers = await this.resolveWorkers(rows.map((r) => r.workerId));
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const tp = await this.prisma.techProcess.findUnique({
      where: { id },
      include: { documents: true },
    });
    if (!tp)
      throw new NotFoundException(`Tehnološki postupak ${id} ne postoji`);

    const workers = await this.resolveWorkers([tp.workerId]);
    return { data: { ...tp, worker: workers.get(tp.workerId) ?? null } };
  }

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
}
