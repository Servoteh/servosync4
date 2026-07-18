import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
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
  NonconformitySummaryQuery,
  SummaryMiniQuery,
} from "./dto/nonconformity-report.query";
import type { ListQualityDocsQuery } from "./dto/quality-document.query";
import {
  computeScrapHours,
  computeMaterialKg,
  type ScrapHoursOp,
} from "./nonconformity-calc";

/** Tip izveštaja — poklapa se sa part_quality (1=dorada/REWORK, 2=škart/SCRAP). */
const NONCONFORMITY_TYPE = { DORADA: 1, SKART: 2 } as const;
/** Status izveštaja. */
const STATUS = { DRAFT: 0, CONFIRMED: 1 } as const;

/** Maksimalna veličina QC dokumenta (25 MB) — preko toga 413 (K4-UPLOAD). */
const MAX_DOC_BYTES = 25 * 1024 * 1024;

/** Dozvoljene `groupBy` vrednosti za K3.1 summary. */
const SUMMARY_GROUP_BY = new Set([
  "day",
  "week",
  "month",
  "year",
  "worker",
  "workUnit",
  "cause",
  "customer",
]);

/**
 * `date_trunc` jedinica + `to_char` format po vremenskom `groupBy` (whitelist —
 * vrednosti su fiksne, ne stižu iz korisničkog unosa → nema injekcije; svejedno
 * se prosleđuju kao bound parametri).
 */
const TEMPORAL_BUCKET: Record<string, { unit: string; fmt: string }> = {
  day: { unit: "day", fmt: "YYYY-MM-DD" },
  week: { unit: "week", fmt: "YYYY-MM-DD" },
  month: { unit: "month", fmt: "YYYY-MM" },
  year: { unit: "year", fmt: "YYYY" },
};

/** Kolona `nonconformity_reports` po tekstualnom `groupBy` (whitelist identifikatora). */
const TEXT_GROUP_COLUMN: Record<string, string> = {
  cause: "cause",
  workUnit: "work_unit",
  customer: "customer_name",
};

/**
 * Multipart fajl iz multer memory storage-a (@nestjs/platform-express).
 * `@types/multer` namerno NE postoji u repou → lokalni interfejs. KOPIJA obrasca
 * iz `pdm-import.service` — cross-module import se svesno izbegava (TVOJ SKUP).
 */
export interface UploadedMultipartFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Trim + prazno → null + isecanje na dužinu kolone (KOPIJA iz `pdm-import.service`). */
function clip(value: string | null | undefined, max: number): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * Multer (busboy) latin1-dekodira `originalname` bez UTF-8 flag-a → mojibake za
 * š/đ/č. Re-dekodiranje latin1→utf8 vraća original; čist ASCII i već ispravan
 * UTF-8 prolaze netaknuti. KOPIJA iz `pdm-import.service` (K4-UPLOAD).
 */
function decodeOriginalName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name; // čist ASCII
  for (const ch of name) if (ch.codePointAt(0)! > 0xff) return name; // već UTF-8
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded;
}

/**
 * `content_type` iz MAGIC BYTES (ne veruje se klijentskom mimetype-u): dozvoljeni
 * su PDF (`%PDF`), PNG (`89 50 4E 47 0D 0A 1A 0A`) i JPEG (`FF D8 FF`). Ostalo →
 * `null` (pozivalac baca 422).
 */
function detectDocContentType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-")
    return "application/pdf";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "image/jpeg";
  return null;
}

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
          responsibleParty: dto.responsibleParty ?? null,
          materialCostNote: dto.materialCostNote ?? null,
          coopCostNote: dto.coopCostNote ?? null,
          spentHoursText: dto.spentHoursText ?? null,
          spentHours: dto.spentHours ?? null,
          materialKg: dto.materialKg ?? null,
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
    if (dto.responsibleParty !== undefined)
      data.responsibleParty = dto.responsibleParty;
    if (dto.materialCostNote !== undefined)
      data.materialCostNote = dto.materialCostNote;
    if (dto.coopCostNote !== undefined) data.coopCostNote = dto.coopCostNote;
    if (dto.spentHoursText !== undefined)
      data.spentHoursText = dto.spentHoursText;
    if (dto.spentHours !== undefined) data.spentHours = dto.spentHours;
    if (dto.materialKg !== undefined) data.materialKg = dto.materialKg;
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

  // ------------------------------------------------------------------ RECOMPUTE (auto sati + kg)

  /**
   * `POST /kvalitet/reports/:id/recompute` — ponovo izračuna „Utrošeni radni sati" i
   * „Trošak materijala (kg)" iz TEKUĆEG routinga/crteža i upiše ih (formula vlasnika).
   * Vraća ceo mapirani izveštaj + `meta` sa izvorima. SAMO za ŠKART (type=2) — dorada
   * (type=1) → 400 (formule važe samo za škart; dorada se unosi ručno).
   *
   * `spentHours` se prepisuje SAMO kad se može odrediti operacija škarta (tp iz
   * `sourceTechProcessId`) I postoji `workOrderId` (izvor routinga); inače OSTAJE
   * netaknut (računa se samo `materialKg`). `materialKg` se uvek prepisuje (null kad
   * je masa nepoznata).
   */
  async recomputeReport(id: number) {
    const report = await this.prisma.nonconformityReport.findUnique({
      where: { id },
    });
    if (!report) throw new NotFoundException(`Izveštaj ${id} ne postoji.`);
    if (report.type !== NONCONFORMITY_TYPE.SKART)
      throw new BadRequestException(
        "Auto-računica (utrošeni sati, kg materijala) važi samo za škart; dorada se unosi ručno.",
      );

    const scrapOperationNumber = await this.resolveScrapOperationNumber(
      report.sourceTechProcessId,
    );
    const comp = await this.computeScrapMetrics({
      workOrderId: report.workOrderId,
      scrapOperationNumber,
      quantity: report.quantity,
    });

    const data: Prisma.NonconformityReportUncheckedUpdateInput = {
      materialKg: comp.materialKg,
    };
    // spentHours prepisujemo samo ako je zbir sati zaista pokrenut (op + routing);
    // bez operacije/RN-a ostaje ono što je već upisano (ručno ili prethodno).
    if (comp.hoursComputed) data.spentHours = comp.spentHours;

    const updated = await this.prisma.nonconformityReport.update({
      where: { id },
      data,
    });
    const detail = await this.buildDetail(updated);
    return {
      data: detail.data,
      meta: {
        scrapOperationNumber,
        hoursOps: comp.meta.hoursOps,
        hoursComputed: comp.hoursComputed,
        spentHours: comp.hoursComputed ? comp.spentHours : null,
        massSource: comp.meta.massSource,
        unitWeightKg: comp.meta.unitWeightKg,
        materialKg: comp.materialKg,
      },
    };
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

      // ŠKART: auto-računanje „Utrošeni radni sati" + „Trošak materijala (kg)" po
      // formuli vlasnika. BEST-EFFORT u zasebnom try/catch — pad/nedostatak podataka
      // NE sme oboriti kreiranje drafta (polja ostaju null). Dorada se unosi ručno.
      let spentHours: number | null = null;
      let materialKg: number | null = null;
      if (type === NONCONFORMITY_TYPE.SKART) {
        try {
          const scrapOperationNumber = await this.resolveScrapOperationNumber(
            input.sourceTechProcessId ?? null,
          );
          const comp = await this.computeScrapMetrics({
            workOrderId: input.workOrderId ?? null,
            scrapOperationNumber,
            quantity: input.quantity,
          });
          spentHours = comp.spentHours;
          materialKg = comp.materialKg;
        } catch (e) {
          this.logger.warn(
            `Auto-računica škarta preskočena (TP ${input.sourceTechProcessId ?? "?"}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }

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
            spentHours,
            materialKg,
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

  // ------------------------------------------------------------------ SUMMARY (K3.1)

  /**
   * `GET /kvalitet/summary` — izveštajni agregat nad POTVRĐENIM izveštajima
   * (status=1). `groupBy` = day|week|month|year (vremenski, sort rastuće) ILI
   * worker|workUnit|cause|customer (sort pieces desc). `pieces` = SUM(quantity),
   * `hours` = SUM(spent_hours) null-safe. `meta.draftCount` = broj draftova (status=0)
   * u istom type+period filteru („na čekanju"). `meta.totals` = negrupisan ukupan
   * zbir (kartice ne sabiraju grupe). MODULE_SPEC_kontrola_kvaliteta §K3.1.
   */
  async summary(query: NonconformitySummaryQuery) {
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    const type =
      query.type === "1"
        ? NONCONFORMITY_TYPE.DORADA
        : query.type === "2"
          ? NONCONFORMITY_TYPE.SKART
          : undefined;
    const groupBy = query.groupBy?.trim() || "month";
    if (!SUMMARY_GROUP_BY.has(groupBy))
      throw new BadRequestException(
        "Parametar 'groupBy' mora biti: day, week, month, year, worker, workUnit, cause ili customer.",
      );

    // draftCount = „na čekanju" radna lista (isti type+period filter, status=0).
    const draftWhere: Prisma.NonconformityReportWhereInput = {
      status: STATUS.DRAFT,
    };
    if (type !== undefined) draftWhere.type = type;
    if (from || to)
      draftWhere.reportDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    const draftCount = await this.prisma.nonconformityReport.count({
      where: draftWhere,
    });

    let data: Array<{
      key: string;
      label: string;
      count: number;
      pieces: number;
      hours: number;
    }>;
    if (groupBy in TEMPORAL_BUCKET)
      data = await this.summaryTemporal(groupBy, type, from, to);
    else if (groupBy === "worker")
      data = await this.summaryByWorker(type, from, to);
    else data = await this.summaryByText(TEXT_GROUP_COLUMN[groupBy], type, from, to);

    // Negrupisan ukupan zbir (isti reportWhere kao redovi): kartice ga čitaju
    // umesto sabiranja grupa — groupBy=worker pripisuje izveštaj SVAKOM krivcu,
    // pa bi klijentska redukcija naduvala komade/sate i „izgubila" izveštaje bez
    // krivca. `totals` je stvarni COUNT/SUM nad potvrđenim izveštajima.
    const totals = await this.summaryTotals(type, from, to);

    return {
      data,
      meta: { from: from ?? null, to: to ?? null, groupBy, draftCount, totals },
    };
  }

  /** Negrupisan COUNT/SUM nad potvrđenim izveštajima (kartice u tabu „Izveštaji"). */
  private async summaryTotals(
    type: number | undefined,
    from?: Date,
    to?: Date,
  ): Promise<{ count: number; pieces: number; hours: number }> {
    const where = this.reportWhere({
      status: STATUS.CONFIRMED,
      type,
      from,
      to,
    });
    const rows = await this.prisma.$queryRaw<
      Array<{ count: number; pieces: number; hours: number }>
    >(Prisma.sql`
      SELECT COUNT(*)::int AS count,
             COALESCE(SUM(quantity), 0)::int AS pieces,
             ROUND(COALESCE(SUM(spent_hours), 0), 3)::float8 AS hours
      FROM nonconformity_reports
      ${where}
    `);
    const row = rows[0];
    return {
      count: Number(row?.count ?? 0),
      pieces: Number(row?.pieces ?? 0),
      hours: Number(row?.hours ?? 0),
    };
  }

  /** Vremenski agregat (date_trunc) — sort rastuće po ključu. */
  private async summaryTemporal(
    groupBy: string,
    type: number | undefined,
    from?: Date,
    to?: Date,
  ) {
    const { unit, fmt } = TEMPORAL_BUCKET[groupBy];
    const where = this.reportWhere({ status: STATUS.CONFIRMED, type, from, to });
    const rows = await this.prisma.$queryRaw<
      Array<{ key: string; count: number; pieces: number; hours: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc(${unit}, report_date), ${fmt}) AS key,
             COUNT(*)::int AS count,
             COALESCE(SUM(quantity), 0)::int AS pieces,
             ROUND(COALESCE(SUM(spent_hours), 0), 3)::float8 AS hours
      FROM nonconformity_reports
      ${where}
      GROUP BY key
      ORDER BY key ASC
    `);
    return rows.map((r) => ({
      key: r.key,
      label: r.key,
      count: Number(r.count),
      pieces: Number(r.pieces),
      hours: Number(r.hours),
    }));
  }

  /** Tekstualni agregat (cause/workUnit/customer) — prazno → 'Bez unosa', sort pieces desc. */
  private async summaryByText(
    column: string,
    type: number | undefined,
    from?: Date,
    to?: Date,
  ) {
    const where = this.reportWhere({ status: STATUS.CONFIRMED, type, from, to });
    const rows = await this.prisma.$queryRaw<
      Array<{ key: string; count: number; pieces: number; hours: number }>
    >(Prisma.sql`
      SELECT COALESCE(NULLIF(TRIM(${Prisma.raw(column)}), ''), 'Bez unosa') AS key,
             COUNT(*)::int AS count,
             COALESCE(SUM(quantity), 0)::int AS pieces,
             ROUND(COALESCE(SUM(spent_hours), 0), 3)::float8 AS hours
      FROM nonconformity_reports
      ${where}
      GROUP BY key
      ORDER BY pieces DESC, count DESC, key ASC
    `);
    return rows.map((r) => ({
      key: r.key,
      label: r.key,
      count: Number(r.count),
      pieces: Number(r.pieces),
      hours: Number(r.hours),
    }));
  }

  /**
   * Agregat po radniku preko `nonconformity_workers` (M:N). NAPOMENA: `count` =
   * broj (report, worker) parova = broj izveštaja u kojima radnik učestvuje (unique
   * (report,worker) → bez duplih); `pieces`/`hours` SUMiraju vrednost izveštaja PO
   * radniku, pa izveštaj sa VIŠE izvršilaca doprinosi SVAKOM (namerno — „pripisani
   * komadi po radniku", ne globalni zbir). Sort pieces desc. Imena batch-resolve.
   */
  private async summaryByWorker(
    type: number | undefined,
    from?: Date,
    to?: Date,
  ) {
    const where = this.reportWhere({
      alias: "r",
      status: STATUS.CONFIRMED,
      type,
      from,
      to,
    });
    const rows = await this.prisma.$queryRaw<
      Array<{ worker_id: number; count: number; pieces: number; hours: number }>
    >(Prisma.sql`
      SELECT nw.worker_id AS worker_id,
             COUNT(*)::int AS count,
             COALESCE(SUM(r.quantity), 0)::int AS pieces,
             ROUND(COALESCE(SUM(r.spent_hours), 0), 3)::float8 AS hours
      FROM nonconformity_workers nw
      JOIN nonconformity_reports r ON r.id = nw.report_id
      ${where}
      GROUP BY nw.worker_id
      ORDER BY pieces DESC, count DESC, nw.worker_id ASC
    `);
    const workers = await this.resolveWorkers(rows.map((r) => r.worker_id));
    return rows.map((r) => ({
      key: String(r.worker_id),
      label: workers.get(r.worker_id)?.fullName ?? `Radnik #${r.worker_id}`,
      count: Number(r.count),
      pieces: Number(r.pieces),
      hours: Number(r.hours),
    }));
  }

  // ------------------------------------------------------------------ MOJ PROFIL (K3.2)

  /**
   * `GET /kvalitet/mine` — „Moje neusaglašenosti" za prijavljenog radnika
   * (@RequirePermission PROFILE_SELF na handleru — proizvodni radnik ima
   * profile.self, ne kvalitet.read). Radnik iz JWT-a razrešava se SVEŽIM lookup-om
   * `users.worker_id` (obrazac worker-me iz tech-processes). Bez veze →
   * `{ linked: false, reports: [], monthly: [] }`. Inače: poslednjih 50 izveštaja
   * (potvrđeni + draft) gde je radnik izvršilac + zbir po mesecu (12 meseci).
   */
  async mine(actor?: AuthUser) {
    const account = actor?.userId
      ? await this.prisma.user.findUnique({
          where: { id: actor.userId },
          select: { workerId: true },
        })
      : null;
    if (!account?.workerId)
      return { data: { linked: false, reports: [], monthly: [] } };
    const workerId = account.workerId;

    const links = await this.prisma.nonconformityWorker.findMany({
      where: { workerId },
      select: { reportId: true },
    });
    const reportIds = [...new Set(links.map((l) => l.reportId))];

    const rows = reportIds.length
      ? await this.prisma.nonconformityReport.findMany({
          where: { id: { in: reportIds } },
          orderBy: [{ reportDate: "desc" }, { id: "desc" }],
          take: 50,
          select: {
            id: true,
            type: true,
            reportNumber: true,
            reportDate: true,
            identNumber: true,
            drawingNumber: true,
            partName: true,
            quantity: true,
            defectDescription: true,
            status: true,
          },
        })
      : [];

    // Poslednjih 12 meseci: prvi dan meseca 11 meseci unazad → 12 „kanti"
    // (UTC radi determinizma; date_trunc grupiše po DB sesijskoj zoni).
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
    );
    const monthly = await this.prisma.$queryRaw<
      Array<{ month: string; type: number; count: number; pieces: number }>
    >(Prisma.sql`
      SELECT to_char(date_trunc('month', r.report_date), 'YYYY-MM') AS month,
             r.type AS type,
             COUNT(*)::int AS count,
             COALESCE(SUM(r.quantity), 0)::int AS pieces
      FROM nonconformity_workers nw
      JOIN nonconformity_reports r ON r.id = nw.report_id
      WHERE nw.worker_id = ${workerId}
        AND r.report_date >= ${start}
      GROUP BY month, r.type
      ORDER BY month ASC, r.type ASC
    `);

    return {
      data: {
        linked: true,
        reports: rows.map((r) => ({
          id: r.id,
          type: r.type,
          reportNumber: r.reportNumber,
          reportDate: r.reportDate,
          identNumber: r.identNumber,
          drawingNumber: r.drawingNumber,
          partName: r.partName,
          quantity: r.quantity,
          defectDescription: r.defectDescription,
          status: r.status,
        })),
        monthly: monthly.map((m) => ({
          month: m.month,
          type: Number(m.type),
          count: Number(m.count),
          pieces: Number(m.pieces),
        })),
      },
    };
  }

  // ------------------------------------------------------------------ DOKUMENTI (K4-UPLOAD)

  /**
   * `POST /kvalitet/docs` — upload QC dokumenta (skenirani nalog / kontrolna
   * dokumentacija / foto). Validacija: fajl obavezan (400); > 25 MB (413);
   * `content_type` iz MAGIC BYTES — PDF/PNG/JPG, ostalo 422 (klijentskom mimetype-u
   * se NE veruje). Vezivna polja (reportId/techProcessId/workOrderId/identNumber) su
   * SVA opciona — dokument sme biti i NEVEZAN (arhivski). `reportId`/`techProcessId`
   * ako su zadati moraju postojati (404). MODULE_SPEC_kontrola_kvaliteta §K4-UPLOAD.
   */
  async uploadDocument(
    file: UploadedMultipartFile | undefined,
    fields: {
      reportId?: string;
      techProcessId?: string;
      workOrderId?: string;
      identNumber?: string;
    },
    actor?: AuthUser,
  ) {
    if (!file?.buffer?.length)
      throw new BadRequestException('Nedostaje fajl (multipart polje "file").');
    // 25 MB i na servisu (interceptor limit hvata isto na HTTP sloju; ovo pokriva
    // direktan poziv/unit test i služi kao defanziva).
    if (file.buffer.length > MAX_DOC_BYTES)
      throw new PayloadTooLargeException("Dokument je veći od 25 MB.");
    const contentType = detectDocContentType(file.buffer);
    if (!contentType)
      throw new UnprocessableEntityException(
        "Dozvoljeni su PDF i slike (JPG/PNG).",
      );

    const reportId = this.parseOptId(fields.reportId, "reportId");
    const techProcessId = this.parseOptId(fields.techProcessId, "techProcessId");
    const workOrderId = this.parseOptId(fields.workOrderId, "workOrderId");
    const identNumber = clip(fields.identNumber, 50);

    if (reportId !== null) {
      const report = await this.prisma.nonconformityReport.findUnique({
        where: { id: reportId },
        select: { id: true },
      });
      if (!report)
        throw new NotFoundException(`Izveštaj ${reportId} ne postoji.`);
    }
    if (techProcessId !== null) {
      const tp = await this.prisma.techProcess.findUnique({
        where: { id: techProcessId },
        select: { id: true },
      });
      if (!tp)
        throw new NotFoundException(
          `Tehnološki postupak ${techProcessId} ne postoji.`,
        );
    }

    const fileName = clip(decodeOriginalName(file.originalname), 255) ?? "dokument";
    const sizeKb = Math.round(file.buffer.length / 1024);
    // Prisma 6 Bytes traži ArrayBuffer-backed Uint8Array (kao drawing_pdfs upload).
    const content = new Uint8Array(file.buffer);

    const created = await this.prisma.qualityDocument.create({
      data: {
        reportId,
        techProcessId,
        workOrderId,
        identNumber,
        fileName,
        contentType,
        sizeKb,
        content,
        uploadedByUserId: actor?.userId ?? null,
      },
      select: { id: true, fileName: true, sizeKb: true },
    });
    return {
      data: { id: created.id, fileName: created.fileName, sizeKb: created.sizeKb },
    };
  }

  /**
   * `GET /kvalitet/docs` — lista dokumenata BEZ sadržaja (server-side filter +
   * paginacija, `created_at desc`). `q` po `file_name`/`ident_number` (ILIKE).
   * `uploadedBy` batch-resolve preko `users`.
   */
  async listDocuments(query: ListQualityDocsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.QualityDocumentWhereInput = {};
    const reportId = this.parseOptId(query.reportId, "reportId");
    const techProcessId = this.parseOptId(query.techProcessId, "techProcessId");
    if (reportId !== null) where.reportId = reportId;
    if (techProcessId !== null) where.techProcessId = techProcessId;
    const identNumber = query.identNumber?.trim();
    if (identNumber) where.identNumber = identNumber;

    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to)
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };

    const q = query.q?.trim();
    if (q)
      where.OR = [
        { fileName: { contains: q, mode: "insensitive" } },
        { identNumber: { contains: q, mode: "insensitive" } },
      ];

    const [rows, total] = await Promise.all([
      this.prisma.qualityDocument.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        select: {
          id: true,
          fileName: true,
          contentType: true,
          sizeKb: true,
          identNumber: true,
          reportId: true,
          techProcessId: true,
          workOrderId: true,
          createdAt: true,
          uploadedByUserId: true,
        },
      }),
      this.prisma.qualityDocument.count({ where }),
    ]);

    const users = await this.resolveUsers(rows.map((r) => r.uploadedByUserId));
    const data = rows.map((r) => ({
      id: r.id,
      fileName: r.fileName,
      contentType: r.contentType,
      sizeKb: r.sizeKb,
      identNumber: r.identNumber,
      reportId: r.reportId,
      techProcessId: r.techProcessId,
      workOrderId: r.workOrderId,
      createdAt: r.createdAt,
      uploadedBy: r.uploadedByUserId
        ? { fullName: users.get(r.uploadedByUserId)?.fullName ?? null }
        : null,
    }));
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * `GET /kvalitet/docs/:id/content` — sadržaj dokumenta (stream). Kontroler
   * postavlja Content-Disposition (inline / attachment). 404 ako ne postoji.
   */
  async getDocumentContent(id: number) {
    const doc = await this.prisma.qualityDocument.findUnique({
      where: { id },
      select: { fileName: true, contentType: true, content: true },
    });
    if (!doc) throw new NotFoundException(`Dokument ${id} ne postoji.`);
    return {
      buffer: Buffer.from(doc.content),
      fileName: doc.fileName,
      contentType: doc.contentType,
    };
  }

  /** `DELETE /kvalitet/docs/:id` — briše red (blob ide s njim). 404 ako ne postoji. */
  async deleteDocument(id: number) {
    const existing = await this.prisma.qualityDocument.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException(`Dokument ${id} ne postoji.`);
    await this.prisma.qualityDocument.delete({ where: { id } });
    return { data: { id, deleted: true } };
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

  /** Batch-resolve `users` (za „uploadedBy" QC dokumenata); prazna mapa za prazan ulaz. */
  private async resolveUsers(
    ids: (number | null | undefined)[],
  ): Promise<Map<number, { id: number; fullName: string | null }>> {
    const uniq = uniqueIds(ids);
    if (!uniq.length)
      return new Map<number, { id: number; fullName: string | null }>();
    return byId(
      await this.prisma.user.findMany({
        where: { id: { in: uniq } },
        select: { id: true, fullName: true },
      }),
    );
  }

  /**
   * Parsiraj opcioni id (query filter ili multipart form polje): odsutan/prazan
   * → `null`; nevalidan (ne-ceo, < 1) → 400. Bez ovoga bi `Number("x")` (NaN)
   * ušao u Prisma filter/insert i pao goli 500 (nema globalnog exception filtera).
   */
  private parseOptId(value: string | undefined, name: string): number | null {
    const v = (value ?? "").trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1)
      throw new BadRequestException(`Polje '${name}' mora biti ceo broj ≥ 1.`);
    return n;
  }

  // --------------------------------------------------------- AUTO-RAČUNICA (helperi)

  /**
   * Redni broj operacije na kojoj je komad škartiran — iz `tech_processes` reda
   * (`sourceTechProcessId`). Bez id-ja ili reda → null (računica sati se preskače).
   */
  private async resolveScrapOperationNumber(
    sourceTechProcessId: number | null | undefined,
  ): Promise<number | null> {
    if (!sourceTechProcessId) return null;
    const tp = await this.prisma.techProcess.findUnique({
      where: { id: sourceTechProcessId },
      select: { operationNumber: true },
    });
    return tp?.operationNumber ?? null;
  }

  /**
   * Masa jednog dela (kg) za RN: crtež po `drawing_number` = RN broj — prvo revizija
   * RN-a, pa NAJVIŠA revizija (konvencija: najviša = tekuća). `drawing.weight > 0` →
   * koristi (izvor `drawing`); inače `unprocessed_part_weight > 0` (masa pripremka,
   * fallback `workOrder`); inače null. Obična findFirst (bez required JOIN-a).
   */
  private async resolveUnitWeightKg(wo: {
    drawingNumber: string | null;
    revision: string | null;
    unprocessedPartWeight: number | null;
  }): Promise<{
    unitWeightKg: number | null;
    massSource: "drawing" | "workOrder" | null;
  }> {
    let weight: number | null = null;
    if (wo.drawingNumber) {
      let drawing = await this.prisma.drawing.findFirst({
        where: {
          drawingNumber: wo.drawingNumber,
          ...(wo.revision ? { revision: wo.revision } : {}),
        },
        select: { weight: true },
      });
      if (!drawing)
        drawing = await this.prisma.drawing.findFirst({
          where: { drawingNumber: wo.drawingNumber },
          orderBy: { revision: "desc" },
          select: { weight: true },
        });
      weight = drawing?.weight ?? null;
    }
    if (weight != null && weight > 0)
      return { unitWeightKg: weight, massSource: "drawing" };
    if (wo.unprocessedPartWeight != null && wo.unprocessedPartWeight > 0)
      return { unitWeightKg: wo.unprocessedPartWeight, massSource: "workOrder" };
    return { unitWeightKg: null, massSource: null };
  }

  /**
   * Objedinjena auto-računica škarta (sati + kg) za dati RN i operaciju škarta.
   * `hoursComputed` = true kad je zbir sati zaista pokrenut (postoje i `workOrderId`
   * i `scrapOperationNumber`) — pozivalac tada sme da prepiše `spentHours`.
   * `materialKg` se uvek pokušava (null kad je masa nepoznata / nema RN-a).
   */
  private async computeScrapMetrics(args: {
    workOrderId: number | null;
    scrapOperationNumber: number | null;
    quantity: number;
  }): Promise<{
    spentHours: number | null;
    materialKg: number | null;
    hoursComputed: boolean;
    meta: {
      hoursOps: number;
      massSource: "drawing" | "workOrder" | null;
      unitWeightKg: number | null;
    };
  }> {
    let spentHours: number | null = null;
    let materialKg: number | null = null;
    let hoursComputed = false;
    let hoursOps = 0;
    let massSource: "drawing" | "workOrder" | null = null;
    let unitWeightKg: number | null = null;

    if (args.workOrderId) {
      const wo = await this.prisma.workOrder.findUnique({
        where: { id: args.workOrderId },
        select: {
          drawingNumber: true,
          revision: true,
          unprocessedPartWeight: true,
        },
      });
      if (wo) {
        const mass = await this.resolveUnitWeightKg(wo);
        massSource = mass.massSource;
        unitWeightKg = mass.unitWeightKg;
        materialKg = computeMaterialKg(args.quantity, mass.unitWeightKg);

        if (args.scrapOperationNumber != null) {
          const scrapOp = args.scrapOperationNumber;
          const ops = await this.prisma.workOrderOperation.findMany({
            where: { workOrderId: args.workOrderId },
            select: {
              operationNumber: true,
              setupTime: true,
              cycleTime: true,
            },
          });
          const rows: ScrapHoursOp[] = ops.map((o) => ({
            operationNumber: o.operationNumber,
            setupTime: o.setupTime,
            cycleTime: o.cycleTime,
          }));
          hoursOps = rows.filter((o) => o.operationNumber <= scrapOp).length;
          spentHours = computeScrapHours(rows, scrapOp, args.quantity);
          hoursComputed = true;
        }
      }
    }

    return {
      spentHours,
      materialKg,
      hoursComputed,
      meta: { hoursOps, massSource, unitWeightKg },
    };
  }

  /**
   * WHERE fragment za raw upite nad `nonconformity_reports` (K3.1). Kolone su
   * fiksni literali (`col()` kroz `Prisma.raw` — nema injekcije); vrednosti idu
   * kao bound parametri. `alias` prefiksuje kolone kad se JOIN-uje (worker grana).
   */
  private reportWhere(opts: {
    alias?: string;
    status?: number;
    type?: number;
    from?: Date;
    to?: Date;
  }): Prisma.Sql {
    const prefix = opts.alias ? `${opts.alias}.` : "";
    const col = (c: string) => Prisma.raw(`${prefix}${c}`);
    const conds: Prisma.Sql[] = [];
    if (opts.status !== undefined)
      conds.push(Prisma.sql`${col("status")} = ${opts.status}`);
    if (opts.type !== undefined)
      conds.push(Prisma.sql`${col("type")} = ${opts.type}`);
    if (opts.from)
      conds.push(Prisma.sql`${col("report_date")} >= ${opts.from}`);
    if (opts.to) conds.push(Prisma.sql`${col("report_date")} <= ${opts.to}`);
    return conds.length
      ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
      : Prisma.empty;
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

  /**
   * Detalj jednog izveštaja: razreši izvršioce (M:N) + kontrolora, pa mapiraj.
   * Nosi i `documents` (jeftin findMany BEZ sadržaja — K4-UPLOAD veza sa izveštajem);
   * jednako za create/update/confirm (freshly kreiran draft → prazna lista).
   */
  private async buildDetail(report: NonconformityReport) {
    const [culpritRows, documents] = await Promise.all([
      this.prisma.nonconformityWorker.findMany({
        where: { reportId: report.id },
        select: { workerId: true },
      }),
      this.prisma.qualityDocument.findMany({
        where: { reportId: report.id },
        orderBy: { createdAt: "desc" },
        select: { id: true, fileName: true, sizeKb: true, createdAt: true },
      }),
    ]);
    const workers = await this.resolveWorkers([
      ...culpritRows.map((c) => c.workerId),
      report.raisedByWorkerId,
    ]);
    const culprits: CulpritRef[] = culpritRows.map((c) => ({
      workerId: c.workerId,
      fullName: workers.get(c.workerId)?.fullName ?? null,
    }));
    return {
      data: {
        ...this.mapReport(
          report,
          culprits,
          this.raisedByFrom(report.raisedByWorkerId, workers),
        ),
        documents,
      },
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
      responsibleParty: r.responsibleParty,
      materialCostNote: r.materialCostNote,
      coopCostNote: r.coopCostNote,
      spentHoursText: r.spentHoursText,
      spentHours: r.spentHours != null ? r.spentHours.toString() : null,
      materialKg: r.materialKg != null ? r.materialKg.toString() : null,
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
