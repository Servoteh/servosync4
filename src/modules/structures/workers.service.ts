import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { byId } from "../../common/relations";
import {
  CreateWorkerDto,
  UpdateWorkerDto,
  validateCreateWorker,
} from "./dto/worker.dto";

/**
 * Podskup polja radnika bezbedan za izlaz — NIKAD `password` / `workerPassword`
 * (spec §5.5). Isti select se koristi i za listu i za detalj.
 */
const WORKER_SELECT = {
  id: true,
  username: true,
  fullName: true,
  idNumber: true,
  active: true,
  workUnitCode: true,
  cardId: true,
  loginAccount: true,
  workerTypeId: true,
  signatureImage: true,
  definesApproval: true,
  definesLaunch: true,
  multiAccount: true,
  commissionPercent: true,
} satisfies Prisma.WorkerSelect;

/** Jedinstveni nenegativni id-jevi — vrsta posla može imati legitiman id 0 (NN). */
const typeIds = (ids: number[]): number[] => [
  ...new Set(ids.filter((n) => Number.isInteger(n) && n >= 0)),
];

export interface ListWorkersQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po imenu / korisničkom imenu / ID kartice. */
  q?: string;
  /** Filter po radnoj jedinici. */
  workUnitCode?: string;
  /** Filter po vrsti posla. */
  workerTypeId?: string;
  /** `true` (default) | `false` | `all`. */
  active?: string;
}

@Injectable()
export class WorkersService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListWorkersQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.WorkerWhereInput = {};
    if (query.q) {
      where.OR = [
        { fullName: { contains: query.q, mode: "insensitive" } },
        { username: { contains: query.q, mode: "insensitive" } },
        { cardId: { contains: query.q, mode: "insensitive" } },
      ];
    }
    if (query.workUnitCode) where.workUnitCode = query.workUnitCode;
    const typeId = Number.parseInt(query.workerTypeId ?? "", 10);
    if (!Number.isNaN(typeId)) where.workerTypeId = typeId;
    // active: default = samo aktivni (spec §7.1); `false` = neaktivni; `all` = svi
    if (query.active === "false") where.active = false;
    else if (query.active !== "all") where.active = true;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.worker.findMany({
        where,
        orderBy: [{ fullName: "asc" }, { id: "asc" }],
        skip,
        take,
        select: WORKER_SELECT,
      }),
      this.prisma.worker.count({ where }),
    ]);

    const [types, units] = await Promise.all([
      this.resolveWorkerTypes(rows.map((r) => r.workerTypeId)),
      this.resolveWorkUnits(rows.map((r) => r.workUnitCode)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      workUnit: units.get(r.workUnitCode) ?? null,
      workerType: types.get(r.workerTypeId) ?? null,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const worker = await this.prisma.worker.findUnique({
      where: { id },
      select: {
        ...WORKER_SELECT,
        // to-many relacija je bezbedna; operaciju svakog entry-ja razrešavamo batch-om
        // (Operation je OBAVEZNA to-one relacija — include bi pukao na orphan FK).
        machineAccess: {
          select: { id: true, workCenterCode: true, note: true },
          orderBy: { workCenterCode: "asc" },
        },
      },
    });
    if (!worker) throw new NotFoundException(`Radnik ${id} ne postoji.`);

    const [types, units, ops] = await Promise.all([
      this.resolveWorkerTypes([worker.workerTypeId]),
      this.resolveWorkUnits([worker.workUnitCode]),
      this.resolveOperations(worker.machineAccess.map((m) => m.workCenterCode)),
    ]);

    const data = {
      ...worker,
      workUnit: units.get(worker.workUnitCode) ?? null,
      workerType: types.get(worker.workerTypeId) ?? null,
      machineAccess: worker.machineAccess.map((m) => ({
        ...m,
        operation: ops.get(m.workCenterCode) ?? null,
      })),
    };
    return { data };
  }

  // ---------------------------------------------------------------- CREATE / UPDATE

  async create(dto: CreateWorkerDto) {
    validateCreateWorker(dto);

    const definesApproval = dto.definesApproval ?? false;
    const definesLaunch = dto.definesLaunch ?? false;
    const workerTypeId = dto.workerTypeId ?? 0;
    await this.validateFlags(workerTypeId, definesApproval, definesLaunch);

    const created = await this.prisma.$transaction(async (tx) => {
      // Sync ubacuje eksplicitne legacy id-jeve; poravnaj sekvencu pre insert-a.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('workers','id'), (SELECT COALESCE(MAX(id),0) FROM workers))`,
      );
      return tx.worker.create({
        data: {
          username: dto.username.trim(),
          fullName: dto.fullName?.trim() || null,
          idNumber: dto.idNumber?.trim() || null,
          cardId: dto.cardId?.trim() || "",
          loginAccount: dto.loginAccount?.trim() || null,
          workUnitCode: dto.workUnitCode?.trim() || "0",
          workerTypeId,
          signatureImage: dto.signatureImage?.trim() || null,
          definesApproval,
          definesLaunch,
          multiAccount: dto.multiAccount ?? false,
          commissionPercent: dto.commissionPercent ?? 0,
          active: dto.active ?? true,
          // Legacy lozinke se NIKAD ne primaju (spec §5.5). `workerPassword` je
          // NOT NULL bez default-a → postavljamo prazan string; `password` je null.
          password: null,
          workerPassword: "",
        },
        select: { id: true },
      });
    });
    return this.findOne(created.id);
  }

  async update(id: number, dto: UpdateWorkerDto) {
    const existing = await this.prisma.worker.findUnique({
      where: { id },
      select: {
        id: true,
        workerTypeId: true,
        definesApproval: true,
        definesLaunch: true,
      },
    });
    if (!existing) throw new NotFoundException(`Radnik ${id} ne postoji.`);

    const workerTypeId = dto.workerTypeId ?? existing.workerTypeId;
    const definesApproval =
      dto.definesApproval ?? existing.definesApproval ?? false;
    const definesLaunch = dto.definesLaunch ?? existing.definesLaunch ?? false;
    await this.validateFlags(workerTypeId, definesApproval, definesLaunch);

    const data: Prisma.WorkerUpdateInput = {};
    if (dto.username !== undefined) data.username = dto.username.trim();
    if (dto.fullName !== undefined)
      data.fullName = dto.fullName?.trim() || null;
    if (dto.idNumber !== undefined)
      data.idNumber = dto.idNumber?.trim() || null;
    if (dto.cardId !== undefined) data.cardId = dto.cardId?.trim() || "";
    if (dto.loginAccount !== undefined)
      data.loginAccount = dto.loginAccount?.trim() || null;
    if (dto.workUnitCode !== undefined)
      data.workUnitCode = dto.workUnitCode?.trim() || "0";
    if (dto.workerTypeId !== undefined) data.workerTypeId = dto.workerTypeId;
    if (dto.signatureImage !== undefined)
      data.signatureImage = dto.signatureImage?.trim() || null;
    if (dto.definesApproval !== undefined)
      data.definesApproval = dto.definesApproval;
    if (dto.definesLaunch !== undefined) data.definesLaunch = dto.definesLaunch;
    if (dto.multiAccount !== undefined) data.multiAccount = dto.multiAccount;
    if (dto.commissionPercent !== undefined)
      data.commissionPercent = dto.commissionPercent;
    if (dto.active !== undefined) data.active = dto.active;
    // password / workerPassword se NIKAD ne ažuriraju (spec §5.5).

    await this.prisma.worker.update({ where: { id }, data });
    return this.findOne(id);
  }

  /** Soft delete — samo `active=false`, nikad hard delete (spec §2.2 / §7.1). */
  async deactivate(id: number) {
    const existing = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Radnik ${id} ne postoji.`);
    await this.prisma.worker.update({
      where: { id },
      data: { active: false },
    });
    return this.findOne(id);
  }

  /**
   * Tvrdo brisanje SAMO za radnika bez IJEDNE reference — čišćenje typo unosa
   * (PLAN_dorade_2026-07-10, odluka #7). Spec §2.2 inače kaže „nikad hard
   * delete": svaka referenca → 409 „deaktiviraj umesto brisanja".
   * Pre-check je iscrpan i namerno preko count-ova (deo referenci ima FK pa bi
   * delete pukao P2003, ali istoriju bez FK-a niko drugi ne čuva). Izuzetak:
   * `app_notifications` (recipient bez FK-a) se NE broji nego se BRIŠE u istoj
   * transakciji — istorija notifikacija nije poslovna istorija, a orphan inbox
   * bi nasledio sledeći radnik sa istim id-em (create poravnava sekvencu na MAX).
   */
  async remove(id: number) {
    const existing = await this.prisma.worker.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Radnik ${id} ne postoji.`);

    const counts = await Promise.all([
      this.prisma.techProcess.count({ where: { workerId: id } }),
      this.prisma.workTimeEntry.count({ where: { workerId: id } }),
      this.prisma.workOrderOperation.count({ where: { workerId: id } }),
      // Obe relacije RN-a: autor (workerId) i primopredaja (handoverWorkerId).
      this.prisma.workOrder.count({
        where: { OR: [{ workerId: id }, { handoverWorkerId: id }] },
      }),
      this.prisma.machineAccess.count({ where: { workerId: id } }),
      this.prisma.partLocation.count({ where: { workerId: id } }),
      this.prisma.workOrderMachinedPart.count({ where: { workerId: id } }),
      this.prisma.workOrderBlank.count({ where: { workerId: id } }),
      this.prisma.workOrderNonstandardPart.count({ where: { workerId: id } }),
      this.prisma.handoverDraft.count({ where: { designerId: id } }),
      this.prisma.user.count({ where: { workerId: id } }),
      // No-FK reference (radnik kao izvršilac/učesnik u istoriji drugih tabela):
      this.prisma.drawingHandover.count({
        where: {
          OR: [
            { handoverWorkerId: id },
            { technologistId: id },
            { statusChangedById: id },
            { launchedById: id },
          ],
        },
      }),
      this.prisma.workOrderLaunch.count({
        where: { OR: [{ createdByWorkerId: id }, { updatedByWorkerId: id }] },
      }),
      this.prisma.workOrderApproval.count({
        where: { OR: [{ createdByWorkerId: id }, { updatedByWorkerId: id }] },
      }),
      this.prisma.drawingPlan.count({ where: { planningWorkerId: id } }),
      this.prisma.mrpDemand.count({ where: { workerId: id } }),
    ]);
    if (counts.some((c) => c > 0))
      throw new ConflictException(
        "Radnik ima istoriju — deaktiviraj umesto brisanja.",
      );

    try {
      // Notifikacije radnika (bez FK-a) se čiste zajedno sa radnikom — vidi docstring.
      await this.prisma.$transaction([
        this.prisma.appNotification.deleteMany({
          where: { recipientWorkerId: id },
        }),
        this.prisma.worker.delete({ where: { id } }),
      ]);
    } catch (e) {
      // Trka (referenca nastala posle pre-checka) ili nepokrivena FK referenca.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2003"
      )
        throw new ConflictException(
          "Radnik ima istoriju — deaktiviraj umesto brisanja.",
        );
      throw e;
    }
    return { data: { id, deleted: true } };
  }

  // ---------------------------------------------------------------- RULES

  /**
   * Poslovna pravila permission flag-ova (spec §7.3):
   *   - `definesLaunch=true` zahteva `definesApproval=true`.
   *   - `definesApproval=true` dozvoljen samo za vrste posla čiji naziv sadrži
   *     "Tehnolog" ili "Inžinjer"/"Inženjer".
   */
  private async validateFlags(
    workerTypeId: number,
    definesApproval: boolean,
    definesLaunch: boolean,
  ) {
    if (definesLaunch && !definesApproval)
      throw new UnprocessableEntityException(
        "Radnik ne može definisati lansiranje bez definisanja saglasnosti (definesApproval).",
      );
    if (definesApproval) {
      const wt = await this.prisma.workerType.findUnique({
        where: { id: workerTypeId },
        select: { name: true },
      });
      const name = (wt?.name ?? "").toLowerCase();
      const eligible =
        name.includes("tehnolog") ||
        name.includes("inžinjer") ||
        name.includes("inženjer");
      if (!eligible)
        throw new UnprocessableEntityException(
          "Saglasnost (definesApproval) mogu imati samo radnici vrste 'Tehnolog' ili 'Inžinjer'.",
        );
    }
  }

  // --- batch resolveri (izbegavaju required-relation JOIN nad orphan FK-om) ---

  private async resolveWorkerTypes(ids: number[]) {
    const uniq = typeIds(ids);
    if (!uniq.length)
      return new Map<
        number,
        { id: number; name: string; additionalPrivileges: boolean }
      >();
    return byId(
      await this.prisma.workerType.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true, additionalPrivileges: true },
      }),
    );
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
