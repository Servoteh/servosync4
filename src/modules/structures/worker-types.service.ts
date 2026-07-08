import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  CreateWorkerTypeDto,
  UpdateWorkerTypeDto,
  validateCreateWorkerType,
} from "./dto/worker-type.dto";

export interface ListWorkerTypesQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po nazivu. */
  q?: string;
}

@Injectable()
export class WorkerTypesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListWorkerTypesQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.WorkerTypeWhereInput = {};
    if (query.q) where.name = { contains: query.q, mode: "insensitive" };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workerType.findMany({
        where,
        orderBy: [{ id: "asc" }],
        skip,
        take,
      }),
      this.prisma.workerType.count({ where }),
    ]);
    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  async create(dto: CreateWorkerTypeDto) {
    validateCreateWorkerType(dto);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('worker_types','id'), (SELECT COALESCE(MAX(id),0) FROM worker_types))`,
      );
      return tx.workerType.create({
        data: {
          name: dto.name.trim(),
          additionalPrivileges: dto.additionalPrivileges ?? false,
        },
      });
    });
    return { data: created };
  }

  async update(id: number, dto: UpdateWorkerTypeDto) {
    const existing = await this.prisma.workerType.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Vrsta posla ${id} ne postoji.`);
    const data: Prisma.WorkerTypeUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.additionalPrivileges !== undefined)
      data.additionalPrivileges = dto.additionalPrivileges;
    const updated = await this.prisma.workerType.update({
      where: { id },
      data,
    });
    return { data: updated };
  }
}
