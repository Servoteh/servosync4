import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  CreateOperationDto,
  UpdateOperationDto,
  validateCreateOperation,
} from "./dto/operation.dto";

const OPERATION_SELECT = {
  id: true,
  workCenterCode: true,
  workCenterName: true,
  note: true,
  workUnitCode: true,
  withoutProcess: true,
  significantForFinishing: true,
  usesPriority: true,
  isSkippable: true,
  _count: { select: { machineAccess: true } },
} satisfies Prisma.OperationSelect;

export interface ListOperationsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po šifri / nazivu operacije. */
  q?: string;
  /** Filter po radnoj jedinici. */
  workUnitCode?: string;
}

@Injectable()
export class OperationsService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListOperationsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.OperationWhereInput = {};
    if (query.q) {
      where.OR = [
        { workCenterCode: { contains: query.q, mode: "insensitive" } },
        { workCenterName: { contains: query.q, mode: "insensitive" } },
      ];
    }
    if (query.workUnitCode) where.workUnitCode = query.workUnitCode;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.operation.findMany({
        where,
        orderBy: [{ workCenterCode: "asc" }],
        skip,
        take,
        select: OPERATION_SELECT,
      }),
      this.prisma.operation.count({ where }),
    ]);

    const units = await this.resolveWorkUnits(rows.map((r) => r.workUnitCode));
    const data = rows.map((r) => {
      const { _count, ...rest } = r;
      return {
        ...rest,
        workUnit: units.get(r.workUnitCode) ?? null,
        workersWithAccess: _count.machineAccess,
      };
    });
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ---------------------------------------------------------------- CREATE / UPDATE / DELETE

  async create(dto: CreateOperationDto) {
    validateCreateOperation(dto);
    const code = dto.workCenterCode.trim();
    const dup = await this.prisma.operation.findUnique({
      where: { workCenterCode: code },
      select: { id: true },
    });
    if (dup)
      throw new ConflictException(`Operacija sa šifrom '${code}' već postoji.`);

    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('operations','id'), (SELECT COALESCE(MAX(id),0) FROM operations))`,
      );
      return tx.operation.create({
        data: {
          workCenterCode: code,
          workCenterName: dto.workCenterName.trim(),
          note: dto.note?.trim() || null,
          workUnitCode: dto.workUnitCode.trim(),
          withoutProcess: dto.withoutProcess ?? false,
          significantForFinishing: dto.significantForFinishing ?? false,
          usesPriority: dto.usesPriority ?? false,
          isSkippable: dto.isSkippable ?? false,
        },
        select: { workCenterCode: true },
      });
    });
    return this.findByCode(created.workCenterCode);
  }

  async update(code: string, dto: UpdateOperationDto) {
    const existing = await this.prisma.operation.findUnique({
      where: { workCenterCode: code },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Operacija '${code}' ne postoji.`);

    const data: Prisma.OperationUpdateInput = {};
    if (dto.workCenterName !== undefined)
      data.workCenterName = dto.workCenterName.trim();
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.workUnitCode !== undefined)
      data.workUnitCode = dto.workUnitCode.trim();
    if (dto.withoutProcess !== undefined)
      data.withoutProcess = dto.withoutProcess;
    if (dto.significantForFinishing !== undefined)
      data.significantForFinishing = dto.significantForFinishing;
    if (dto.usesPriority !== undefined) data.usesPriority = dto.usesPriority;
    if (dto.isSkippable !== undefined) data.isSkippable = dto.isSkippable;

    await this.prisma.operation.update({
      where: { workCenterCode: code },
      data,
    });
    return this.findByCode(code);
  }

  /**
   * Brisanje je blokirano ako je operacija referencirana u `work_order_operations`
   * ili `machine_access` (spec §2.2 — RN-ovi referenciraju operacije), kao i u
   * `tech_processes` / `work_time_entries` — te dve tabele NEMAJU FK ka
   * operations, pa bi se istorija kucanja orphan-ovala bez count pre-checka
   * (PLAN_dorade_2026-07-10 D1 t.2). 409 sa srpskom porukom koja nabraja sve
   * brojače. P2003 (bilo koja druga FK referenca) se mapira u isti 409.
   */
  async remove(code: string) {
    const existing = await this.prisma.operation.findUnique({
      where: { workCenterCode: code },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Operacija '${code}' ne postoji.`);

    const [inWorkOrders, inAccess, inTechProcesses, inTimeEntries] =
      await Promise.all([
        this.prisma.workOrderOperation.count({
          where: { workCenterCode: code },
        }),
        this.prisma.machineAccess.count({ where: { workCenterCode: code } }),
        this.prisma.techProcess.count({ where: { workCenterCode: code } }),
        this.prisma.workTimeEntry.count({ where: { workCenterCode: code } }),
      ]);
    if (
      inWorkOrders > 0 ||
      inAccess > 0 ||
      inTechProcesses > 0 ||
      inTimeEntries > 0
    )
      throw new ConflictException(
        `Operacija '${code}' se ne može obrisati jer je referencirana (radni nalozi: ${inWorkOrders}, pristup mašinama: ${inAccess}, kucanja: ${inTechProcesses}, evidencija vremena: ${inTimeEntries}).`,
      );

    try {
      await this.prisma.operation.delete({ where: { workCenterCode: code } });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2003"
      )
        throw new ConflictException(
          `Operacija '${code}' se ne može obrisati jer je referencirana u drugim tabelama.`,
        );
      throw e;
    }
    return { data: { workCenterCode: code, deleted: true } };
  }

  // ---------------------------------------------------------------- helpers

  private async findByCode(code: string) {
    const op = await this.prisma.operation.findUnique({
      where: { workCenterCode: code },
      select: OPERATION_SELECT,
    });
    if (!op) throw new NotFoundException(`Operacija '${code}' ne postoji.`);
    const units = await this.resolveWorkUnits([op.workUnitCode]);
    const { _count, ...rest } = op;
    return {
      data: {
        ...rest,
        workUnit: units.get(op.workUnitCode) ?? null,
        workersWithAccess: _count.machineAccess,
      },
    };
  }

  private async resolveWorkUnits(codes: string[]) {
    const uniq = [...new Set(codes.filter(Boolean))];
    const map = new Map<string, { code: string; name: string }>();
    if (!uniq.length) return map;
    const rows = await this.prisma.workUnit.findMany({
      where: { code: { in: uniq } },
      select: { code: true, name: true },
    });
    for (const r of rows) map.set(r.code, r);
    return map;
  }
}
