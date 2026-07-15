import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { NonconformityReport } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseDateParam } from "../../common/date-params";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  validateCreateNonconformityReport,
  type CreateNonconformityReportDto,
} from "./dto/create-nonconformity-report.dto";
import {
  validateUpdateNonconformityReport,
  type UpdateNonconformityReportDto,
} from "./dto/update-nonconformity-report.dto";
import type {
  ListNonconformityReportsQuery,
  SummaryMiniQuery,
} from "./dto/nonconformity-report.query";

/** Tip izveštaja — poklapa se sa part_quality (1=dorada/REWORK, 2=škart/SCRAP). */
const NONCONFORMITY_TYPE = { DORADA: 1, SKART: 2 } as const;
/** Status izveštaja. */
const STATUS = { DRAFT: 0, CONFIRMED: 1 } as const;

/** Razrešeni radnik (SAFE podskup — bez lozinki). */
interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

/** Izvršilac izveštaja u odgovoru (izlaže se kroz javni return → mora biti export). */
export interface CulpritRef {
  workerId: number;
  fullName: string | null;
}

/**
 * Ulaz za auto-draft iz kucanja kontrole (`control()` u tech-processes zove OVO
 * POSLE transakcije, best-effort — kao D8; MODULE_SPEC_kontrola_kvaliteta §5).
 * `qualityTypeId` 1/2 → tip izveštaja (§5: „type iz qualityTypeId"); 0/drugo →
 * metoda vraća `null` (ignoriše). Servis mapira qualityTypeId → nonconformity type.
 * Svi ostali podaci su predlog koji kontrolor dopunjuje/potvrđuje u kartici.
 */
export interface CreateDraftFromControlInput {
  /** Vrsta kvaliteta iz kioska: 1 = dorada, 2 = škart (0/drugo → bez izveštaja). */
  qualityTypeId: number;
  /** Otkucana količina tog kvaliteta. */
  quantity: number;
  /** Datum izveštaja; default = sada. */
  reportDate?: Date;
  workOrderId?: number | null;
  identNumber?: string | null;
  drawingNumber?: string | null;
  partName?: string | null;
  customerName?: string | null;
  /** `tech_processes.id` reda kontrole iz kog je draft nastao. */
  sourceTechProcessId?: number | null;
  /** Radna jedinica = radni centar operacije. */
  workUnit?: string | null;
  /** Napomena kontrolora → prefill „Opis greške". */
  defectDescription?: string | null;
  /** Kontrolor (istakao neusaglašenost). */
  raisedByWorkerId?: number | null;
  /** Predlog izvršilaca (radnici sa poslednjih kucanja te operacije). */
  culpritWorkerIds?: number[];
  createdByUserId?: number | null;
}

/**
 * Kontrola kvaliteta — evidencija neusaglašenosti (škart + dorada), digitalizacija
 * Excel evidencija (MODULE_SPEC_kontrola_kvaliteta §4–§7). App-owned 2.0 tabele
 * (`nonconformity_reports` + `nonconformity_workers`).
 *
 * Ključno pravilo numeracije: broj `NNN/YY` se dodeljuje TEK pri potvrdi (draft nema
 * broj → obrisan lažni draft ne pravi rupu u sekvenci). Sekvenca je nezavisna po
 * (tip, godina) i NASTAVLJA Excel istoriju (uvoz starih zapisa radi Nenad naknadno;
 * `MAX(broj)+1` radi i pre i posle uvoza).
 */
@Injectable()
export class QualityService {
  private readonly logger = new Logger(QualityService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------ LISTA

  /**
   * `GET /kvalitet/reports` — lista izveštaja (server-side filter + paginacija),
   * `report_date desc, id desc`. Batch-resolve izvršilaca (M:N) i kontrolora
   * (`raisedByWorkerId`) preko `workers` (SAFE_WORKER_SELECT — bez lozinki).
   */
  async listReports(query: ListNonconformityReportsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.NonconformityReportWhereInput = {};
    const type = Number(query.type);
    if (type === NONCONFORMITY_TYPE.DORADA || type === NONCONFORMITY_TYPE.SKART)
      where.type = type;
    const status = Number(query.status);
    if (query.status !== undefined && query.status !== "" &&
      (status === STATUS.DRAFT || status === STATUS.CONFIRMED))
      where.status = status;

    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to)
      where.reportDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { identNumber: { contains: q, mode: "insensitive" } },
        { drawingNumber: { contains: q, mode: "insensitive" } },
        { partName: { contains: q, mode: "insensitive" } },
        { reportNumber: { contains: q, mode: "insensitive" } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.prisma.nonconformityReport.findMany({
        where,
        orderBy: [{ reportDate: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.nonconformityReport.count({ where }),
    ]);

    const culpritRows = rows.length
      ? await this.prisma.nonconformityWorker.findMany({
          where: { reportId: { in: rows.map((r) => r.id) } },
          select: { reportId: true, workerId: true },
        })
      : [];

    const workers = await this.resolveWorkers([
      ...culpritRows.map((c) => c.workerId),
      ...rows.map((r) => r.raisedByWorkerId),
    ]);

    const culpritsByReport = new Map<number, CulpritRef[]>();
    for (const c of culpritRows) {
      const arr = culpritsByReport.get(c.reportId) ?? [];
      arr.push({
        workerId: c.workerId,
        fullName: workers.get(c.workerId)?.fullName ?? null,
      });
      culpritsByReport.set(c.reportId, arr);
    }

    const data = rows.map((r) =>
      this.mapReport(
        r,
        culpritsByReport.get(r.id) ?? [],
        this.raisedByFrom(r.raisedByWorkerId, workers),
      ),
    );
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ------------------------------------------------------------------ DETALJ

  /** `GET /kvalitet/reports/:id` — detalj + `culpritWorkers[]`. */
  async getReport(id: number) {
    const report = await this.prisma.nonconformityReport.findUnique({
      where: { id },
    });
    if (!report) throw new NotFoundException(`Izveštaj ${id} ne postoji.`);
    return this.buildDetail(report);
  }

  // ------------------------------------------------------------------ CREATE (ručni draft)

  /**
   * `POST /kvalitet/reports` — ručni draft (status=0, bez broja). `culpritWorkerIds`
   * → M:N redovi. `createdByUserId` iz JWT-a (ne iz body-ja).
   */
  async createReport(dto: CreateNonconformityReportDto, actor?: AuthUser) {
    validateCreateNonconformityReport(dto);
    const reportDate = dto.reportDate ? new Date(dto.reportDate) : new Date();
    const culpritIds = uniqueIds(dto.culpritWorkerIds ?? []);

    const created = await this.prisma.$transaction(async (tx) => {
      const report = await tx.nonconformityReport.create({
        data: {
          type: dto.type,
          reportNumber: null,
          // report_year iz report_date (isti prostor kao sekvenca pri potvrdi).
          reportYear: reportDate.getFullYear(),
          reportDate,
          status: STATUS.DRAFT,
          quantity: dto.quantity,
          defectDescription: dto.defectDescription.trim(),
          workOrderId: dto.workOrderId ?? null,
          identNumber: dto.identNumber ?? null,
          sourceTechProcessId: dto.sourceTechProcessId ?? null,
          drawingNumber: dto.drawingNumber ?? null,
          partName: dto.partName ?? null,
          customerName: dto.customerName ?? null,
          cause: dto.cause ?? null,
          workUnit: dto.workUnit ?? null,
          culpritText: dto.culpritText ?? null,
          materialCostNote: dto.materialCostNote ?? null,
          coopCostNote: dto.coopCostNote ?? null,
          spentHoursText: dto.spentHoursText ?? null,
          spentHours: dto.spentHours ?? null,
          note: dto.note ?? null,
          preventiveMeasures: dto.preventiveMeasures ?? null,
          extra: dto.extra ?? null,
          raisedByWorkerId: dto.raisedByWorkerId ?? null,
          createdByUserId: actor?.userId ?? null,
        },
      });
      if (culpritIds.length)
        await tx.nonconformityWorker.createMany({
          data: culpritIds.map((workerId) => ({ reportId: report.id, workerId })),
          skipDuplicates: true,
        });
      return report;
    });

    return this.buildDetail(created);
  }

  // ------------------------------------------------------------------ PATCH

  /**
   * `PATCH /kvalitet/reports/:id` — izmena poslovnih polja + `culpritWorkerIds`
   * (replace set u transakciji). Dozvoljeno i za POTVRĐENE (naknadna dopuna
   * troškova/sati); jedino se `type` potvrđenog ne sme menjati (menja prostor
   * numeracije, može da kolidira sa dodeljenim brojem).
   */
  async updateReport(id: number, dto: UpdateNonconformityReportDto) {
    validateUpdateNonconformityReport(dto);
    const existing = await this.prisma.nonconformityReport.findUnique({
      where: { id },
      select: { id: true, status: true, type: true },
    });
    if (!existing) throw new NotFoundException(`Izveštaj ${id} ne postoji.`);
    if (
      dto.type !== undefined &&
      dto.type !== existing.type &&
      existing.status === STATUS.CONFIRMED
    )
      throw new UnprocessableEntityException(
        "Tip potvrđenog izveštaja se ne može menjati (menja prostor numeracije).",
      );

    const data: Prisma.NonconformityReportUncheckedUpdateInput = {};
    if (dto.type !== undefined) data.type = dto.type;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;
    if (dto.defectDescription !== undefined)
      data.defectDescription = dto.defectDescription.trim();
    if (dto.reportDate !== undefined) {
      const d = new Date(dto.reportDate);
      data.reportDate = d;
      data.reportYear = d.getFullYear();
    }
    if (dto.workOrderId !== undefined) data.workOrderId = dto.workOrderId;
    if (dto.identNumber !== undefined) data.identNumber = dto.identNumber;
    if (dto.sourceTechProcessId !== undefined)
      data.sourceTechProcessId = dto.sourceTechProcessId;
    if (dto.drawingNumber !== undefined) data.drawingNumber = dto.drawingNumber;
    if (dto.partName !== undefined) data.partName = dto.partName;
    if (dto.customerName !== undefined) data.customerName = dto.customerName;
    if (dto.cause !== undefined) data.cause = dto.cause;
    if (dto.workUnit !== undefined) data.workUnit = dto.workUnit;
    if (dto.culpritText !== undefined) data.culpritText = dto.culpritText;
    if (dto.materialCostNote !== undefined)
      data.materialCostNote = dto.materialCostNote;
    if (dto.coopCostNote !== undefined) data.coopCostNote = dto.coopCostNote;
    if (dto.spentHoursText !== undefined)
      data.spentHoursText = dto.spentHoursText;
    if (dto.spentHours !== undefined) data.spentHours = dto.spentHours;
    if (dto.note !== undefined) data.note = dto.note;
    if (dto.preventiveMeasures !== undefined)
      data.preventiveMeasures = dto.preventiveMeasures;
    if (dto.extra !== undefined) data.extra = dto.extra;
    if (dto.raisedByWorkerId !== undefined)
      data.raisedByWorkerId = dto.raisedByWorkerId;

    await this.prisma.$transaction(async (tx) => {
      await tx.nonconformityReport.update({ where: { id }, data });
      if (dto.culpritWorkerIds !== undefined) {
        // Replace set: obriši postojeće pa upiši nove (dozvoljeno i za potvrđene —
        // korekcija/dopuna izvršilaca).
        await tx.nonconformityWorker.deleteMany({ where: { reportId: id } });
        const ids = uniqueIds(dto.culpritWorkerIds);
        if (ids.length)
          await tx.nonconformityWorker.createMany({
            data: ids.map((workerId) => ({ reportId: id, workerId })),
            skipDuplicates: true,
          });
      }
    });

    return this.getReport(id);
  }

  // ------------------------------------------------------------------ CONFIRM (dodela broja)

  /**
   * `POST /kvalitet/reports/:id/confirm` — dodela broja `NNN/YY` i `status=1`.
   * Advisory lock po (tip, godina) serijalizuje dodelu u istom prostoru (obrazac:
   * `draft-numbering` / handover submit). Sledeći broj = `MAX(numerički deo pre '/')`
   * po (tip, godina) + 1 (`split_part` parsira '027/26' → 27). NAPOMENA: Excel
   * istorija se uvozi naknadno — `MAX` radi i pre i posle uvoza. Već potvrđen → 409.
   */
  async confirmReport(id: number) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.nonconformityReport.findUnique({
        where: { id },
        select: { id: true, type: true, status: true, reportYear: true },
      });
      if (!existing) throw new NotFoundException(`Izveštaj ${id} ne postoji.`);
      if (existing.status === STATUS.CONFIRMED)
        throw new ConflictException(`Izveštaj ${id} je već potvrđen.`);

      const year = existing.reportYear;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`nonconformity_confirm:${existing.type}:${year}`}))`;

      const rows = await tx.$queryRaw<Array<{ next: number }>>(Prisma.sql`
        SELECT COALESCE(MAX(split_part(report_number, '/', 1)::int), 0) + 1 AS next
        FROM nonconformity_reports
        WHERE type = ${existing.type}
          AND report_year = ${year}
          AND report_number IS NOT NULL
      `);
      const seq = Number(rows[0]?.next ?? 1);
      const yy = String(year % 100).padStart(2, "0");
      const reportNumber = `${String(seq).padStart(3, "0")}/${yy}`;

      return tx.nonconformityReport.update({
        where: { id },
        data: { status: STATUS.CONFIRMED, reportNumber },
      });
    });

    return this.buildDetail(updated);
  }

  // ------------------------------------------------------------------ DELETE (samo draft)

  /** `DELETE /kvalitet/reports/:id` — SAMO draft (status=0); potvrđen → 422. */
  async deleteReport(id: number) {
    const existing = await this.prisma.nonconformityReport.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw new NotFoundException(`Izveštaj ${id} ne postoji.`);
    if (existing.status !== STATUS.DRAFT)
      throw new UnprocessableEntityException(
        `Samo draft izveštaj se može obrisati; potvrđen izveštaj (${id}) se ne briše.`,
      );
    // Cascade briše i nonconformity_workers (FK ON DELETE CASCADE).
    await this.prisma.nonconformityReport.delete({ where: { id } });
    return { data: { id, deleted: true } };
  }

  // ------------------------------------------------------------------ SUMMARY MINI (bedževi)

  /**
   * `GET /kvalitet/summary-mini` — mali agregat za bedževe (broj draftova/potvrđenih
   * i komada) po tipu. Pun izveštajni tab je K3 (NE gradi se ovde).
   */
  async summaryMini(query: SummaryMiniQuery) {
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    const where: Prisma.NonconformityReportWhereInput = {};
    if (from || to)
      where.reportDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };

    const grouped = await this.prisma.nonconformityReport.groupBy({
      by: ["type", "status"],
      where,
      _count: { _all: true },
      _sum: { quantity: true },
    });

    const build = (type: number) => {
      let drafts = 0;
      let confirmed = 0;
      let pieces = 0;
      for (const g of grouped) {
        if (g.type !== type) continue;
        const count = g._count._all;
        pieces += g._sum.quantity ?? 0;
        if (g.status === STATUS.DRAFT) drafts += count;
        else if (g.status === STATUS.CONFIRMED) confirmed += count;
      }
      return { drafts, confirmed, pieces };
    };

    return {
      data: {
        skart: build(NONCONFORMITY_TYPE.SKART),
        dorada: build(NONCONFORMITY_TYPE.DORADA),
      },
    };
  }

  // ------------------------------------------------------------------ AUTO-DRAFT IZ KIOSKA

  /**
   * Kreira DRAFT izveštaj iz kucanja kontrole (poziva `control()` u tech-processes
   * POSLE transakcije, best-effort — MODULE_SPEC_kontrola_kvaliteta §5). CELA metoda
   * je u try/catch sa `logger.error` — NIKAD ne baca (pad drafta ne sme oboriti
   * kucanje kontrole, isti princip kao D8 notifikacija). Vraća `{ id }` kreiranog
   * drafta ili `null` (kvalitet != dorada/škart, ili greška).
   */
  async createDraftFromControl(
    input: CreateDraftFromControlInput,
  ): Promise<{ id: number } | null> {
    try {
      const type =
        input.qualityTypeId === NONCONFORMITY_TYPE.DORADA
          ? NONCONFORMITY_TYPE.DORADA
          : input.qualityTypeId === NONCONFORMITY_TYPE.SKART
            ? NONCONFORMITY_TYPE.SKART
            : null;
      // Dobar kvalitet (0) ili nepoznat → nema izveštaja (pozivalac ionako zove
      // samo za dorada/škart; ovo je odbrana).
      if (type === null) return null;

      const reportDate = input.reportDate ?? new Date();
      const culpritIds = uniqueIds(input.culpritWorkerIds ?? []);

      const created = await this.prisma.$transaction(async (tx) => {
        const report = await tx.nonconformityReport.create({
          data: {
            type,
            reportNumber: null,
            reportYear: reportDate.getFullYear(),
            reportDate,
            status: STATUS.DRAFT,
            quantity: input.quantity,
            defectDescription: input.defectDescription?.trim() || "",
            workOrderId: input.workOrderId ?? null,
            identNumber: input.identNumber ?? null,
            sourceTechProcessId: input.sourceTechProcessId ?? null,
            drawingNumber: input.drawingNumber ?? null,
            partName: input.partName ?? null,
            customerName: input.customerName ?? null,
            workUnit: input.workUnit ?? null,
            raisedByWorkerId: input.raisedByWorkerId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          },
        });
        if (culpritIds.length)
          await tx.nonconformityWorker.createMany({
            data: culpritIds.map((workerId) => ({
              reportId: report.id,
              workerId,
            })),
            skipDuplicates: true,
          });
        return report;
      });

      return { id: created.id };
    } catch (err) {
      this.logger.error(
        `Auto-draft neusaglašenosti nije kreiran (kontrola TP ${input.sourceTechProcessId ?? "?"}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  // ------------------------------------------------------------------ HELPERI

  /** Batch-resolve radnika (SAFE — bez lozinki); prazna mapa za prazan ulaz. */
  private async resolveWorkers(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, WorkerRef>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, WorkerRef>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  /** Kontrolor („Neusaglašenost ističe") razrešen iz mape (id ostaje i za orphan). */
  private raisedByFrom(
    workerId: number | null,
    workers: Map<number, WorkerRef>,
  ): { id: number; fullName: string | null } | null {
    if (!workerId) return null;
    const w = workers.get(workerId);
    return { id: workerId, fullName: w?.fullName ?? null };
  }

  /** Detalj jednog izveštaja: razreši izvršioce (M:N) + kontrolora, pa mapiraj. */
  private async buildDetail(report: NonconformityReport) {
    const culpritRows = await this.prisma.nonconformityWorker.findMany({
      where: { reportId: report.id },
      select: { workerId: true },
    });
    const workers = await this.resolveWorkers([
      ...culpritRows.map((c) => c.workerId),
      report.raisedByWorkerId,
    ]);
    const culprits: CulpritRef[] = culpritRows.map((c) => ({
      workerId: c.workerId,
      fullName: workers.get(c.workerId)?.fullName ?? null,
    }));
    return {
      data: this.mapReport(
        report,
        culprits,
        this.raisedByFrom(report.raisedByWorkerId, workers),
      ),
    };
  }

  /** Serijalizacija izveštaja za envelope (Decimal → string, BACKEND_RULES §5). */
  private mapReport(
    r: NonconformityReport,
    culpritWorkers: CulpritRef[],
    raisedByWorker: { id: number; fullName: string | null } | null,
  ) {
    return {
      id: r.id,
      type: r.type,
      reportNumber: r.reportNumber,
      reportYear: r.reportYear,
      reportDate: r.reportDate,
      status: r.status,
      workOrderId: r.workOrderId,
      identNumber: r.identNumber,
      sourceTechProcessId: r.sourceTechProcessId,
      drawingNumber: r.drawingNumber,
      partName: r.partName,
      customerName: r.customerName,
      quantity: r.quantity,
      defectDescription: r.defectDescription,
      cause: r.cause,
      workUnit: r.workUnit,
      culpritText: r.culpritText,
      materialCostNote: r.materialCostNote,
      coopCostNote: r.coopCostNote,
      spentHoursText: r.spentHoursText,
      spentHours: r.spentHours != null ? r.spentHours.toString() : null,
      note: r.note,
      preventiveMeasures: r.preventiveMeasures,
      extra: r.extra,
      raisedByWorkerId: r.raisedByWorkerId,
      raisedByWorker,
      createdByUserId: r.createdByUserId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      culpritWorkers,
    };
  }
}
