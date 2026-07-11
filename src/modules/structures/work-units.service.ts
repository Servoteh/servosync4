import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  CreateWorkUnitDto,
  UpdateWorkUnitDto,
  validateCreateWorkUnit,
} from "./dto/work-unit.dto";

export interface ListWorkUnitsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po šifri / nazivu. */
  q?: string;
}

@Injectable()
export class WorkUnitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListWorkUnitsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.WorkUnitWhereInput = {};
    if (query.q) {
      where.OR = [
        { code: { contains: query.q, mode: "insensitive" } },
        { name: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.workUnit.findMany({
        where,
        orderBy: [{ code: "asc" }],
        skip,
        take,
      }),
      this.prisma.workUnit.count({ where }),
    ]);
    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  async create(dto: CreateWorkUnitDto) {
    validateCreateWorkUnit(dto);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('work_units','id'), (SELECT COALESCE(MAX(id),0) FROM work_units))`,
      );
      return tx.workUnit.create({
        data: { code: dto.code.trim(), name: dto.name.trim() },
      });
    });
    return { data: created };
  }

  async update(id: number, dto: UpdateWorkUnitDto) {
    const existing = await this.prisma.workUnit.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Radna jedinica ${id} ne postoji.`);
    const data: Prisma.WorkUnitUpdateInput = {};
    if (dto.code !== undefined) data.code = dto.code.trim();
    if (dto.name !== undefined) data.name = dto.name.trim();
    const updated = await this.prisma.workUnit.update({ where: { id }, data });
    return { data: updated };
  }

  /**
   * Brisanje radne jedinice (PLAN_dorade_2026-07-10 D1 t.3):
   *   - code="0" je sistemski default (`workers.workUnitCode @default("0")`) — 409;
   *   - 409 ako je referišu `operations.workUnitCode` ili `workers.workUnitCode` —
   *     ta polja NEMAJU FK ka work_units, pa je count pre-check jedini guard
   *     protiv orphan-ovanja.
   */
  async remove(id: number) {
    const existing = await this.prisma.workUnit.findUnique({
      where: { id },
      select: { id: true, code: true },
    });
    if (!existing)
      throw new NotFoundException(`Radna jedinica ${id} ne postoji.`);
    if (existing.code.trim() === "0")
      throw new ConflictException(
        "Radna jedinica '0' je sistemski zapis i ne može se obrisati.",
      );

    const [inOperations, inWorkers] = await Promise.all([
      this.prisma.operation.count({ where: { workUnitCode: existing.code } }),
      this.prisma.worker.count({ where: { workUnitCode: existing.code } }),
    ]);
    if (inOperations > 0 || inWorkers > 0)
      throw new ConflictException(
        `Radna jedinica '${existing.code}' se ne može obrisati jer je referencirana (operacije: ${inOperations}, radnici: ${inWorkers}).`,
      );

    await this.prisma.workUnit.delete({ where: { id } });
    return { data: { id, deleted: true } };
  }
}
