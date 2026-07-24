import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { MontageNonconformity } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { parseDateParam } from "../../common/date-params";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import { resolveManagementWorkerIds } from "../../common/workers/management-criteria";
import type { AuthUser } from "../auth/jwt.strategy";
import { NotificationsService } from "../notifications/notifications.service";
import { MontazaNmNumberingService } from "./montaza-nm-numbering.service";
import { MontazaNmMailService } from "./montaza-nm-mail.service";
import {
  SEVERITIES,
  validateCreateNonconformity,
  type CreateNonconformityDto,
} from "./dto/create-nonconformity.dto";
import {
  validateUpdateInvestigation,
  type UpdateInvestigationDto,
} from "./dto/update-investigation.dto";
import {
  NC_STATUSES,
  validateChangeStatus,
  type ChangeStatusDto,
} from "./dto/change-status.dto";
import type { ListNonconformityQuery } from "./dto/list-query";

/** Foto: ≤6 fajlova po pozivu × ≤8 MB (MODULE_SPEC §3). Preko toga 413. */
const MAX_PHOTOS = 6;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
/** Ukupan cap fotki po prijavi (odbrana od gomilanja; review 004/26). */
const MAX_PHOTOS_TOTAL = 24;

/**
 * Status mašina (MODULE_SPEC §2): CEKA_ANALIZU → U_TOKU → ZAVRSENO; U_TOKU → CEKA_ANALIZU
 * (povratak) dozvoljen; ZAVRSENO je terminalan. Eksport radi testabilnosti.
 */
export const NC_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  CEKA_ANALIZU: ["U_TOKU"],
  U_TOKU: ["ZAVRSENO", "CEKA_ANALIZU"],
  ZAVRSENO: [],
};

/** Prijatna srpska labela ozbiljnosti (za in-app poruku). */
const SEVERITY_LABEL: Record<string, string> = {
  MALA: "mala",
  SREDNJA: "srednja",
  VISOKA: "visoka",
};

/**
 * Multipart fajl iz multer memory storage-a. `@types/multer` namerno NE postoji u repou
 * → lokalni interfejs (KOPIJA obrasca iz `kvalitet.service` — cross-module import se svesno
 * izbegava).
 */
export interface UploadedPhotoFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Trim + prazno → null + isecanje na dužinu kolone. */
function clip(value: string | null | undefined, max: number): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * Multer (busboy) latin1-dekodira `originalname` bez UTF-8 flag-a → mojibake za š/đ/č.
 * Re-dekodiranje latin1→utf8 vraća original (KOPIJA iz `kvalitet.service`).
 */
function decodeOriginalName(name: string): string {
  if (!/[-ÿ]/.test(name)) return name; // cist ASCII
  for (const ch of name) if (ch.codePointAt(0)! > 0xff) return name; // vec UTF-8
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("�") ? name : decoded;
}

/**
 * `content_type` iz MAGIC BYTES (klijentskom mimetype-u se NE veruje): PDF (`%PDF-`),
 * PNG (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`). Ostalo → null (pozivalac 422).
 * KOPIJA iz `kvalitet.service.detectDocContentType`.
 */
function detectPhotoContentType(buf: Buffer): string | null {
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

/** Razrešeni radnik (SAFE — bez lozinki). */
interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

/**
 * Neusaglašenosti na montaži (zahtev 004/26, MODULE_SPEC_montaza_neusaglasenosti).
 * App-owned 2.0-native tabele (`montage_nonconformities` + `_photos` + `_events`).
 * Prijava je immutable posle kreiranja; menjaju se samo istraga polja (manage) i status.
 * Svaka nova prijava obaveštava rolu `menadzment` (in-app + mail — best-effort, nikad
 * ne obara prijavu). Broj `NM-NNN/YY` dodeljuje server pri kreiranju.
 */
@Injectable()
export class MontazaNeusaglasenostiService {
  private readonly logger = new Logger(MontazaNeusaglasenostiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: MontazaNmNumberingService,
    private readonly notifications: NotificationsService,
    private readonly mail: MontazaNmMailService,
  ) {}

  // ------------------------------------------------------------------ LISTA

  /**
   * `GET /montaza/neusaglasenosti` — lista (server-side filter + paginacija),
   * `created_at desc, id desc`. Batch-resolve podnosioca (users) i odgovornog radnika (workers).
   */
  async list(query: ListNonconformityQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.MontageNonconformityWhereInput = {};
    if (
      query.status &&
      (NC_STATUSES as readonly string[]).includes(query.status)
    )
      where.status = query.status;
    if (
      query.severity &&
      (SEVERITIES as readonly string[]).includes(query.severity)
    )
      where.severity = query.severity;

    const from = parseDateParam(query.from, "from");
    let to = parseDateParam(query.to, "to");
    // „to" bez vremena (YYYY-MM-DD) obuhvata CEO dan — inače `lte: ponoć` izbaci ceo dan.
    if (to && /^\d{4}-\d{2}-\d{2}$/.test((query.to ?? "").trim())) {
      to = new Date(to);
      to.setUTCHours(23, 59, 59, 999);
    }
    if (from || to)
      where.createdAt = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };

    const q = query.q?.trim();
    if (q)
      where.OR = [
        { description: { contains: q, mode: "insensitive" } },
        { projectNumber: { contains: q, mode: "insensitive" } },
        { workOrderCode: { contains: q, mode: "insensitive" } },
        { responsibleDepartment: { contains: q, mode: "insensitive" } },
        { reportNumber: { contains: q, mode: "insensitive" } },
      ];

    const [rows, total] = await Promise.all([
      this.prisma.montageNonconformity.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.montageNonconformity.count({ where }),
    ]);

    const users = await this.resolveUsers(rows.map((r) => r.reportedByUserId));
    const workers = await this.resolveWorkers(
      rows.map((r) => r.responsibleWorkerId),
    );
    const data = rows.map((r) => this.mapRow(r, users, workers));
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  // ------------------------------------------------------------------ DETALJ

  /** `GET /montaza/neusaglasenosti/:id` — detalj + fotke meta + events. */
  async getOne(id: number) {
    const nc = await this.prisma.montageNonconformity.findUnique({
      where: { id },
    });
    if (!nc) throw new NotFoundException(`Neusaglašenost ${id} ne postoji.`);
    return this.buildDetail(nc);
  }

  // ------------------------------------------------------------------ CREATE (prijava)

  /**
   * `POST /montaza/neusaglasenosti` — prijava (event CREATED). Broj `NM-NNN/YY` se
   * dodeljuje u transakciji (advisory lock). Posle commita → obaveštenje menadžmentu
   * (in-app + mail), best-effort, NIKAD ne obara prijavu.
   */
  async create(dto: CreateNonconformityDto, actor: AuthUser) {
    validateCreateNonconformity(dto);

    const created = await this.prisma.$transaction(async (tx) => {
      const reportNumber = await this.numbering.nextReportNumber(tx);
      const nc = await tx.montageNonconformity.create({
        data: {
          reportNumber,
          projectNumber: clip(dto.projectNumber, 20),
          projectId: dto.projectId ?? null,
          description: dto.description.trim(),
          severity: dto.severity,
          locationKind: dto.locationKind,
          locationNote:
            dto.locationKind === "TEREN" ? clip(dto.locationNote, 200) : null,
          drawingNumber: clip(dto.drawingNumber, 60),
          workOrderCode: clip(dto.workOrderCode, 40),
          status: "CEKA_ANALIZU",
          reportedByUserId: actor.userId,
        },
      });
      await this.writeEvent(tx, nc.id, "CREATED", actor.userId);
      return nc;
    });

    // Obaveštenje menadžmentu (§2) — best-effort, nikad ne obara prijavu.
    await this.emitNewReportNotifications(created);

    return this.buildDetail(created);
  }

  // ------------------------------------------------------------------ FOTKE

  /**
   * `POST /montaza/neusaglasenosti/:id/photos` — upload fotki (multipart `files`).
   * Dozvoljeno PODNOSIOCU ili manage (istraga). Magic-byte validacija (PDF/PNG/JPG;
   * ostalo 422); ≤6 fajlova/poziv, > 8 MB → 413; ukupno ≤24 po prijavi. ZAVRSENO →
   * 422 (zatvorena prijava se ne dopunjuje). ATOMSKI: SVE se validira PRE upisa, pa
   * SVE fotke + PHOTO_ADDED event idu u JEDNOJ transakciji (all-or-nothing → nema
   * parcijalnog upisa ni duplikata na retry). Event PHOTO_ADDED.
   */
  async addPhotos(id: number, files: UploadedPhotoFile[], actor: AuthUser) {
    const nc = await this.prisma.montageNonconformity.findUnique({
      where: { id },
      select: { id: true, reportedByUserId: true, status: true },
    });
    if (!nc) throw new NotFoundException(`Neusaglašenost ${id} ne postoji.`);

    // V1 kompromis (isti kao zahtevi modul): manage se čita sa rola-sloja preko
    // `roleHasPermission` — per-user override (deny>grant) se OVDE ne konsultuje (redak
    // slučaj; guard je već propustio rutu na osnovu write). Puna override provera je V2.
    const isManager = roleHasPermission(
      actor.role,
      PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE,
    );
    if (nc.reportedByUserId !== actor.userId && !isManager)
      throw new ForbiddenException(
        "Fotografije dodaje podnosilac prijave ili osoba koja vodi istragu.",
      );

    // Zatvorena prijava se ne dopunjuje (review 004/26).
    if (nc.status === "ZAVRSENO")
      throw new UnprocessableEntityException(
        "Neusaglašenost je završena — fotografije se više ne dodaju.",
      );

    if (!files || files.length === 0)
      throw new BadRequestException(
        'Nije priložena nijedna fotografija (polje "files").',
      );
    if (files.length > MAX_PHOTOS)
      throw new UnprocessableEntityException(
        `Najviše ${MAX_PHOTOS} fotografija po pozivu.`,
      );

    const existing = await this.prisma.montageNonconformityPhoto.count({
      where: { nonconformityId: id },
    });
    if (existing + files.length > MAX_PHOTOS_TOTAL)
      throw new UnprocessableEntityException(
        `Najviše ${MAX_PHOTOS_TOTAL} fotografija po prijavi (trenutno ${existing}).`,
      );

    // 1) Validiraj SVE fajlove (magic bytes + veličina) i pripremi payload-e — PRE upisa.
    const payloads = files.map((file) => {
      if (!file?.buffer?.length)
        throw new BadRequestException("Prazna fotografija.");
      if (file.buffer.length > MAX_PHOTO_BYTES)
        throw new PayloadTooLargeException("Fotografija je veća od 8 MB.");
      const contentType = detectPhotoContentType(file.buffer);
      if (!contentType)
        throw new UnprocessableEntityException(
          "Dozvoljene su slike (JPG/PNG) i PDF.",
        );
      return {
        nonconformityId: id,
        fileName:
          clip(decodeOriginalName(file.originalname), 200) ?? "fotografija",
        contentType,
        // Prisma 6 Bytes traži ArrayBuffer-backed Uint8Array (kao quality_documents).
        content: new Uint8Array(file.buffer),
        createdByUserId: actor.userId,
      };
    });

    // 2) SVE fotke + event u JEDNOJ transakciji (all-or-nothing).
    const created = await this.prisma.$transaction(async (tx) => {
      const rows: Array<{ id: number; fileName: string }> = [];
      for (const data of payloads) {
        const row = await tx.montageNonconformityPhoto.create({
          data,
          select: { id: true, fileName: true },
        });
        rows.push(row);
      }
      await this.writeEvent(tx, id, "PHOTO_ADDED", actor.userId, {
        count: rows.length,
      });
      return rows;
    });

    return { data: created };
  }

  /** `GET /montaza/neusaglasenosti/:id/photos/:photoId` — bytea serve (Content-Type iz reda). */
  async getPhotoContent(id: number, photoId: number) {
    const photo = await this.prisma.montageNonconformityPhoto.findFirst({
      where: { id: photoId, nonconformityId: id },
      select: { fileName: true, contentType: true, content: true },
    });
    if (!photo)
      throw new NotFoundException(`Fotografija ${photoId} ne postoji.`);
    return {
      buffer: Buffer.from(photo.content),
      fileName: photo.fileName,
      contentType: photo.contentType,
    };
  }

  // ------------------------------------------------------------------ ISTRAGA

  /**
   * `PATCH /montaza/neusaglasenosti/:id/istraga` — polja istrage (manage).
   * Upisuje `investigatedByUserId` (ko vodi istragu) + event INVESTIGATION_UPDATED.
   */
  async updateInvestigation(
    id: number,
    dto: UpdateInvestigationDto,
    actor: AuthUser,
  ) {
    validateUpdateInvestigation(dto);
    const existing = await this.prisma.montageNonconformity.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing)
      throw new NotFoundException(`Neusaglašenost ${id} ne postoji.`);

    const data: Prisma.MontageNonconformityUncheckedUpdateInput = {
      investigatedByUserId: actor.userId,
    };
    const changed: string[] = [];
    if (dto.responsibleDepartment !== undefined) {
      data.responsibleDepartment = clip(dto.responsibleDepartment, 60);
      changed.push("responsibleDepartment");
    }
    if (dto.responsibleWorkerId !== undefined) {
      data.responsibleWorkerId = dto.responsibleWorkerId;
      changed.push("responsibleWorkerId");
    }
    if (dto.investigationReport !== undefined) {
      data.investigationReport = dto.investigationReport?.trim()
        ? dto.investigationReport.trim()
        : null;
      changed.push("investigationReport");
    }
    if (dto.preventiveMeasures !== undefined) {
      data.preventiveMeasures = dto.preventiveMeasures?.trim()
        ? dto.preventiveMeasures.trim()
        : null;
      changed.push("preventiveMeasures");
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.montageNonconformity.update({ where: { id }, data });
      await this.writeEvent(tx, id, "INVESTIGATION_UPDATED", actor.userId, {
        fields: changed,
      });
      return u;
    });
    return this.buildDetail(updated);
  }

  // ------------------------------------------------------------------ STATUS

  /**
   * `POST /montaza/neusaglasenosti/:id/status` — prelaz statusa (manage; §2 mašina).
   * ZAVRSENO → upisuje `closedAt` + mail podnosiocu. Event STATUS_CHANGED.
   */
  async changeStatus(id: number, dto: ChangeStatusDto, actor: AuthUser) {
    validateChangeStatus(dto);
    const existing = await this.prisma.montageNonconformity.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing)
      throw new NotFoundException(`Neusaglašenost ${id} ne postoji.`);

    const current = existing.status;
    const next = dto.status;
    if (current === next)
      throw new UnprocessableEntityException(
        `Neusaglašenost je već u statusu "${current}".`,
      );
    const allowed = NC_STATUS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next))
      throw new UnprocessableEntityException(
        `Nedozvoljen prelaz statusa "${current}" → "${next}" (dozvoljeno: ${
          allowed.length ? allowed.join(", ") : "—"
        }).`,
      );

    const note = dto.note?.trim() || null;
    const updated = await this.prisma.$transaction(async (tx) => {
      // TOCTOU: compare-and-set na pročitani status — dupli klik / dva menadžera /
      // izmena u međuvremenu → count 0 → 409, i event/mail se NE okidaju (obrazac
      // updateStatusGuarded iz zahtevi modula).
      const res = await tx.montageNonconformity.updateMany({
        where: { id, status: current },
        data: {
          status: next,
          closedAt: next === "ZAVRSENO" ? new Date() : null,
        },
      });
      if (res.count === 0)
        throw new ConflictException(
          "Neusaglašenost je u međuvremenu promenila status — osvežite stranicu.",
        );
      await this.writeEvent(tx, id, "STATUS_CHANGED", actor.userId, {
        from: current,
        to: next,
        ...(note ? { note } : {}),
      });
      const row = await tx.montageNonconformity.findUnique({ where: { id } });
      return row!;
    });

    // ZAVRSENO → mail podnosiocu (§2), best-effort, nikad ne obara radnju.
    if (next === "ZAVRSENO")
      void this.mail.notifyReporterClosed(id).catch(() => undefined);

    return this.buildDetail(updated);
  }

  // ------------------------------------------------------------------ HELPERI

  /** Upiši event u insert-only timeline (§1). */
  private async writeEvent(
    tx: Prisma.TransactionClient,
    nonconformityId: number,
    type: string,
    actorUserId: number | null,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.montageNonconformityEvent.create({
      data: {
        nonconformityId,
        type,
        actorUserId,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  /**
   * Obaveštenje menadžmentu na novu prijavu (§2): (1) in-app zvonce
   * (`NotificationsService.notifyWorkers` + `resolveManagementWorkerIds`); (2) mail
   * (best-effort, fire-and-forget). CELA metoda je try/catch — NIKAD ne baca (pad
   * obaveštenja ne sme oboriti prijavu, isti princip kao D8).
   */
  private async emitNewReportNotifications(
    nc: MontageNonconformity,
  ): Promise<void> {
    try {
      const workerIds = await resolveManagementWorkerIds(this.prisma);
      if (workerIds.length) {
        const sev = SEVERITY_LABEL[nc.severity] ?? nc.severity.toLowerCase();
        await this.notifications.notifyWorkers(workerIds, {
          type: "montaza.neusaglasenost.nova",
          message: `Nova neusaglašenost ${nc.reportNumber} (predmet ${
            nc.projectNumber ?? "—"
          }) — ozbiljnost ${sev}.`,
          refTable: "montage_nonconformities",
          refId: nc.id,
        });
      }
    } catch (err) {
      this.logger.warn(
        `In-app obaveštenje za neusaglašenost ${nc.id} nije upisano: ${
          (err as Error).message
        }`,
      );
    }
    // Mail je fire-and-forget (samostalno guarded, ne baca) — ne blokira odgovor;
    // .catch() je odbrana od nepredviđenog rejecta (prijava mora proći svejedno).
    void this.mail.notifyManagementNewReport(nc.id).catch(() => undefined);
  }

  /** Detalj jedne neusaglašenosti: fotke meta (bez sadržaja) + events + razrešena imena. */
  private async buildDetail(nc: MontageNonconformity) {
    const [photos, events] = await Promise.all([
      this.prisma.montageNonconformityPhoto.findMany({
        where: { nonconformityId: nc.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          fileName: true,
          contentType: true,
          createdByUserId: true,
          createdAt: true,
        },
      }),
      this.prisma.montageNonconformityEvent.findMany({
        where: { nonconformityId: nc.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    ]);

    const users = await this.resolveUsers([
      nc.reportedByUserId,
      nc.investigatedByUserId,
      ...events.map((e) => e.actorUserId),
    ]);
    const workers = await this.resolveWorkers([nc.responsibleWorkerId]);

    return {
      data: {
        ...this.mapRow(nc, users, workers),
        photos: photos.map((p) => ({
          id: p.id,
          fileName: p.fileName,
          contentType: p.contentType,
          createdAt: p.createdAt,
          createdBy: p.createdByUserId
            ? { fullName: users.get(p.createdByUserId)?.fullName ?? null }
            : null,
        })),
        events: events.map((e) => ({
          id: e.id,
          type: e.type,
          data: e.data,
          createdAt: e.createdAt,
          actorUserId: e.actorUserId,
          actorName:
            e.actorUserId != null
              ? (users.get(e.actorUserId)?.fullName ?? null)
              : null,
        })),
      },
    };
  }

  /** Serijalizacija jednog reda za envelope (+ razrešeni podnosilac / odgovorni radnik). */
  private mapRow(
    r: MontageNonconformity,
    users: Map<number, { id: number; fullName: string | null }>,
    workers: Map<number, WorkerRef>,
  ) {
    const worker =
      r.responsibleWorkerId != null
        ? {
            id: r.responsibleWorkerId,
            fullName: workers.get(r.responsibleWorkerId)?.fullName ?? null,
          }
        : null;
    return {
      id: r.id,
      reportNumber: r.reportNumber,
      projectNumber: r.projectNumber,
      projectId: r.projectId,
      description: r.description,
      severity: r.severity,
      locationKind: r.locationKind,
      locationNote: r.locationNote,
      drawingNumber: r.drawingNumber,
      workOrderCode: r.workOrderCode,
      status: r.status,
      reportedByUserId: r.reportedByUserId,
      reportedBy: {
        id: r.reportedByUserId,
        fullName: users.get(r.reportedByUserId)?.fullName ?? null,
      },
      responsibleDepartment: r.responsibleDepartment,
      responsibleWorkerId: r.responsibleWorkerId,
      responsibleWorker: worker,
      investigationReport: r.investigationReport,
      preventiveMeasures: r.preventiveMeasures,
      investigatedByUserId: r.investigatedByUserId,
      investigatedBy:
        r.investigatedByUserId != null
          ? {
              id: r.investigatedByUserId,
              fullName: users.get(r.investigatedByUserId)?.fullName ?? null,
            }
          : null,
      closedAt: r.closedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

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

  /** Batch-resolve `users` (podnosilac / istraga / akter events); prazna mapa za prazan ulaz. */
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
}
