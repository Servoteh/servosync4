import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import {
  BatchMachineAccessDto,
  CreateMachineAccessDto,
  validateBatchMachineAccess,
  validateCreateMachineAccess,
} from "./dto/machine-access.dto";

const ACCESS_SELECT = {
  id: true,
  workerId: true,
  workCenterCode: true,
  note: true,
} satisfies Prisma.MachineAccessSelect;

export interface ListMachineAccessQuery {
  page?: string;
  pageSize?: string;
  /** Sve operacije koje sme jedan radnik. */
  workerId?: string;
  /** Svi radnici koji smiju jednu operaciju. */
  workCenterCode?: string;
}

@Injectable()
export class MachineAccessService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListMachineAccessQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.MachineAccessWhereInput = {};
    const workerId = Number.parseInt(query.workerId ?? "", 10);
    if (!Number.isNaN(workerId)) where.workerId = workerId;
    if (query.workCenterCode) where.workCenterCode = query.workCenterCode;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.machineAccess.findMany({
        where,
        orderBy: [{ workerId: "asc" }, { workCenterCode: "asc" }],
        skip,
        take,
        select: ACCESS_SELECT,
      }),
      this.prisma.machineAccess.count({ where }),
    ]);

    const [workers, ops] = await Promise.all([
      this.resolveWorkers(rows.map((r) => r.workerId)),
      this.resolveOperations(rows.map((r) => r.workCenterCode)),
    ]);
    const data = rows.map((r) => ({
      ...r,
      worker: workers.get(r.workerId) ?? null,
      operation: ops.get(r.workCenterCode) ?? null,
    }));
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const row = await this.prisma.machineAccess.findUnique({
      where: { id },
      select: ACCESS_SELECT,
    });
    if (!row) throw new NotFoundException(`Pristup mašini ${id} ne postoji.`);
    const [workers, ops] = await Promise.all([
      this.resolveWorkers([row.workerId]),
      this.resolveOperations([row.workCenterCode]),
    ]);
    return {
      data: {
        ...row,
        worker: workers.get(row.workerId) ?? null,
        operation: ops.get(row.workCenterCode) ?? null,
      },
    };
  }

  // ---------------------------------------------------------------- CREATE / DELETE / BATCH

  async create(dto: CreateMachineAccessDto) {
    validateCreateMachineAccess(dto);
    const code = dto.workCenterCode.trim();

    // Proveri postojanje FK-ova unapred (izbegava DB FK grešku / 500).
    const [worker, op] = await Promise.all([
      this.prisma.worker.findUnique({
        where: { id: dto.workerId },
        select: { id: true },
      }),
      this.prisma.operation.findUnique({
        where: { workCenterCode: code },
        select: { workCenterCode: true },
      }),
    ]);
    if (!worker)
      throw new NotFoundException(`Radnik ${dto.workerId} ne postoji.`);
    if (!op)
      throw new UnprocessableEntityException(`Operacija '${code}' ne postoji.`);

    const dup = await this.prisma.machineAccess.findFirst({
      where: { workerId: dto.workerId, workCenterCode: code },
      select: { id: true },
    });
    if (dup)
      throw new ConflictException(
        `Radnik ${dto.workerId} već ima pristup operaciji '${code}'.`,
      );

    const created = await this.prisma.$transaction(async (tx) => {
      await alignIdSequence(tx, "machine_access");
      return tx.machineAccess.create({
        data: {
          workerId: dto.workerId,
          workCenterCode: code,
          note: dto.note?.trim() || null,
        },
        select: { id: true },
      });
    });
    return this.findOne(created.id);
  }

  async remove(id: number) {
    const existing = await this.prisma.machineAccess.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Pristup mašini ${id} ne postoji.`);
    await this.prisma.machineAccess.delete({ where: { id } });
    return { data: { id, deleted: true } };
  }

  /**
   * Atomarno dodavanje/oduzimanje operacija jednom radniku (UI matrica).
   * Sve u jednoj transakciji; add-kodovi se validiraju (moraju postojati u
   * `operations`), postojeći parovi se ne dupliraju.
   */
  async batch(dto: BatchMachineAccessDto) {
    validateBatchMachineAccess(dto);

    const worker = await this.prisma.worker.findUnique({
      where: { id: dto.workerId },
      select: { id: true },
    });
    if (!worker)
      throw new NotFoundException(`Radnik ${dto.workerId} ne postoji.`);

    const add = [
      ...new Set((dto.add ?? []).map((c) => c.trim()).filter(Boolean)),
    ];
    const remove = [
      ...new Set((dto.remove ?? []).map((c) => c.trim()).filter(Boolean)),
    ];

    if (add.length) {
      const existingOps = await this.prisma.operation.findMany({
        where: { workCenterCode: { in: add } },
        select: { workCenterCode: true },
      });
      const have = new Set(existingOps.map((o) => o.workCenterCode));
      const missing = add.filter((c) => !have.has(c));
      if (missing.length)
        throw new UnprocessableEntityException(
          `Sledeće operacije ne postoje: ${missing.join(", ")}.`,
        );
    }

    await this.prisma.$transaction(async (tx) => {
      if (remove.length)
        await tx.machineAccess.deleteMany({
          where: { workerId: dto.workerId, workCenterCode: { in: remove } },
        });
      if (add.length) {
        const already = await tx.machineAccess.findMany({
          where: { workerId: dto.workerId, workCenterCode: { in: add } },
          select: { workCenterCode: true },
        });
        const haveNow = new Set(already.map((a) => a.workCenterCode));
        const toCreate = add
          .filter((c) => !haveNow.has(c))
          .map((c) => ({ workerId: dto.workerId, workCenterCode: c }));
        if (toCreate.length) {
          await alignIdSequence(tx, "machine_access");
          await tx.machineAccess.createMany({ data: toCreate });
        }
      }
    });

    return this.listForWorker(dto.workerId);
  }

  // ---------------------------------------------------------------- helpers

  private async listForWorker(workerId: number) {
    const rows = await this.prisma.machineAccess.findMany({
      where: { workerId },
      orderBy: { workCenterCode: "asc" },
      select: ACCESS_SELECT,
    });
    const ops = await this.resolveOperations(rows.map((r) => r.workCenterCode));
    const data = rows.map((r) => ({
      ...r,
      operation: ops.get(r.workCenterCode) ?? null,
    }));
    return { data };
  }

  private async resolveWorkers(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length)
      return new Map<
        number,
        { id: number; fullName: string | null; username: string }
      >();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  private async resolveOperations(codes: string[]) {
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
}
