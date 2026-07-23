import { randomUUID } from "node:crypto";
import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import { parsePagination, pageMeta } from "../../common/pagination";
import type { AuthUser } from "../auth/jwt.strategy";
import { RequestNumberingService } from "./request-numbering.service";
import { ZahteviAiService } from "./zahtevi-ai.service";
import { ZahteviDecisionsService } from "./zahtevi-decisions.service";
import { ZahteviMailService } from "./zahtevi-mail.service";
import {
  type CreateChangeRequestDto,
  validateCreateChangeRequest,
} from "./dto/create-change-request.dto";
import {
  type UpdateChangeRequestDto,
  validateUpdateChangeRequest,
} from "./dto/update-change-request.dto";
import { type DecisionDto, validateDecision } from "./dto/decision.dto";
import { type StatusDto, validateStatus } from "./dto/status.dto";
import {
  type ReturnForInfoDto,
  validateReturnForInfo,
} from "./dto/return-for-info.dto";

/**
 * Status mašina (MODULE_SPEC_zahtevi §1.3) — dozvoljeni ciljni statusi po trenutnom.
 * Eksportovano radi testabilnosti (npr. F3 auto-reject grana REJECTED→SUBMITTED restore).
 */
export const STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  DRAFT: ["SUBMITTED"],
  SUBMITTED: [
    "ANALYSIS_APPROVED",
    "NEEDS_INFO",
    "REJECTED",
    "MERGED",
    "DEFERRED",
    "ARCHIVED",
    "APPROVED", // admin sme direktno (preskače detaljnu analizu, §1.3*)
  ],
  NEEDS_INFO: ["SUBMITTED", "ARCHIVED"],
  ANALYSIS_APPROVED: ["ANALYZED", "SUBMITTED"],
  ANALYZED: [
    "APPROVED",
    "REJECTED",
    "NEEDS_INFO",
    "MERGED",
    "DEFERRED",
    "ARCHIVED",
  ],
  APPROVED: ["PLANNED", "IN_PROGRESS"],
  PLANNED: ["IN_PROGRESS", "DEFERRED"],
  IN_PROGRESS: ["READY_FOR_TEST"],
  READY_FOR_TEST: ["TESTING", "DONE"],
  TESTING: ["DONE", "IN_PROGRESS"],
  DEFERRED: ["SUBMITTED", "ARCHIVED"],
  REJECTED: ["SUBMITTED", "ARCHIVED"], // SUBMITTED = restore (samo AI-odbačen ocenom 0, admin)
  MERGED: ["ARCHIVED"],
  DONE: ["ARCHIVED"],
  ARCHIVED: [],
};

/** Statusi u kojima owner sme da menja/priloži/povuče. */
const OWNER_EDITABLE_STATUSES: readonly string[] = [
  "DRAFT",
  "SUBMITTED",
  "NEEDS_INFO",
];
/** Statusi iz kojih owner sme withdraw (§1.3). */
const OWNER_WITHDRAW_STATUSES: readonly string[] = [
  "DRAFT",
  "SUBMITTED",
  "NEEDS_INFO",
];

const ATTACHMENT_BUCKET = "zahtevi-prilozi";
const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB hard cap (obrazac media-ai)
const MAX_AUDIO_BYTES = 15 * 1024 * 1024; // 15 MB (STT pravilo 1.0)
const MIN_FILE_BYTES = 200; // prazan/beznačajan fajl → 400
const IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const AUDIO_MIMES = [
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
];
const DOC_MIMES = ["application/pdf"];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
};

@Injectable()
export class ZahteviService {
  private readonly logger = new Logger(ZahteviService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: RequestNumberingService,
    private readonly storage: Sy15StorageService,
    private readonly ai: AiProviderService,
    private readonly zahteviAi: ZahteviAiService,
    private readonly decisions: ZahteviDecisionsService,
    private readonly mail: ZahteviMailService,
  ) {}

  // ── ROW-SCOPE / AUTHZ ──────────────────────────────────────────────────────

  /** Da li pozivalac ima zahtevi.admin (vidi/menja SVE zahteve). V1 kompromis:
   *  provera je na rola-sloju (roleHasPermission) — per-user override (deny>grant)
   *  se ne konsultuje ovde jer je redak; guard je već propustio rutu. */
  private isAdmin(actor: AuthUser): boolean {
    return roleHasPermission(actor.role, PERMISSIONS.ZAHTEVI_ADMIN);
  }

  /** WHERE filter za row-scope: ne-admin vidi SAMO svoje. */
  private scopeWhere(actor: AuthUser): Prisma.ChangeRequestWhereInput {
    return this.isAdmin(actor) ? {} : { createdByUserId: actor.userId };
  }

  /** Učitaj zahtev uz row-scope; ne-admin nad tuđim → 404 (ne otkrivamo postojanje). */
  private async getScopedOrThrow(id: number, actor: AuthUser) {
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req || (!this.isAdmin(actor) && req.createdByUserId !== actor.userId))
      throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    return req;
  }

  // ── STATUS MAŠINA ──────────────────────────────────────────────────────────

  /** Baci 422 ako prelaz current→next nije dozvoljen (MODULE_SPEC §1.3). */
  private assertTransition(current: string, next: string): void {
    const allowed = STATUS_TRANSITIONS[current] ?? [];
    if (!allowed.includes(next))
      throw new UnprocessableEntityException(
        `Nedozvoljen prelaz statusa "${current}" → "${next}" (dozvoljeno: ${
          allowed.length ? allowed.join(", ") : "—"
        }).`,
      );
  }

  private assertStatus(
    current: string,
    allowed: readonly string[],
    action: string,
  ): void {
    if (!allowed.includes(current))
      throw new UnprocessableEntityException(
        `Nedozvoljen status "${current}" za ${action} (očekivano: ${allowed.join(", ")}).`,
      );
  }

  /**
   * F1 (TOCTOU): uslovni status-update UNUTAR transakcije. Status je pročitan van
   * tx (za validaciju prelaza), ali sam upis mora biti atomsko „compare-and-set":
   * `updateMany({ where: { id, status: expected } })`. Ako je red u međuvremenu promenio
   * status (dupli klik, dva admina) → count === 0 → 409 i eventi/mejl/AI se NE okidaju.
   */
  private async updateStatusGuarded(
    tx: Prisma.TransactionClient,
    id: number,
    expectedStatus: string,
    data: Prisma.ChangeRequestUpdateInput,
  ): Promise<void> {
    const res = await tx.changeRequest.updateMany({
      where: { id, status: expectedStatus },
      data,
    });
    if (res.count === 0)
      throw new ConflictException(
        "Zahtev je u međuvremenu promenio status — osveži stranicu.",
      );
  }

  /** Upiši event u insert-only timeline (§3). */
  private async writeEvent(
    tx: Prisma.TransactionClient,
    requestId: number,
    type: string,
    actorUserId: number | null,
    data?: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.changeRequestEvent.create({
      data: {
        requestId,
        type,
        actorUserId,
        ...(data !== undefined ? { data } : {}),
      },
    });
  }

  // ── LISTE ──────────────────────────────────────────────────────────────────

  /** GET /zahtevi — lista; ne-admin vidi SAMO svoje; filteri status/module/kind/q/createdBy. */
  async list(
    actor: AuthUser,
    query: {
      status?: string;
      module?: string;
      kind?: string;
      q?: string;
      createdBy?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    // F7: createdBy je numerički filter — nevalidan („NaN", "abc") ne sme završiti kao
    // Number(...) → NaN u WHERE (Prisma bi bacio 500). Parsiramo i tražimo ceo broj → 400.
    let createdByFilter: number | undefined;
    if (this.isAdmin(actor) && query.createdBy) {
      const n = Number.parseInt(query.createdBy, 10);
      if (!Number.isInteger(n) || String(n) !== query.createdBy.trim())
        throw new BadRequestException(
          "Parametar createdBy mora biti ceo broj (ID korisnika).",
        );
      createdByFilter = n;
    }
    const where: Prisma.ChangeRequestWhereInput = {
      ...this.scopeWhere(actor),
      ...(query.status ? { status: query.status } : {}),
      ...(query.module ? { module: query.module } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" } },
              { description: { contains: query.q, mode: "insensitive" } },
              { reqNo: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
      // createdBy filter — samo admin (ne-admin je već sužen na svoje).
      ...(createdByFilter !== undefined
        ? { createdByUserId: createdByFilter }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.changeRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      this.prisma.changeRequest.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** GET /zahtevi/inbox-meta — brojači statusa koji čekaju admina (§7). */
  async inboxMeta() {
    const waiting = ["SUBMITTED", "ANALYZED", "TESTING"] as const;
    const counts = await this.prisma.changeRequest.groupBy({
      by: ["status"],
      where: { status: { in: [...waiting] } },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const s of waiting) byStatus[s] = 0;
    for (const c of counts) byStatus[c.status] = c._count._all;
    const total = waiting.reduce((sum, s) => sum + byStatus[s], 0);
    return { data: { byStatus, total } };
  }

  /**
   * GET /zahtevi/slicni?q= — brza pretraga sličnih (BEZ AI): ILIKE nad title+description.
   * Zove je forma novog zahteva (debounce) da korisnik PRE podnošenja vidi „možda već postoji".
   * pg_trgm se NE koristi (ekstenzija nije u postojećim migracijama) — običan ILIKE, V1 dovoljno.
   */
  async slicni(q: string | undefined) {
    const term = (q ?? "").trim();
    if (term.length < 3) return { data: [] };
    const rows = await this.prisma.changeRequest.findMany({
      where: {
        status: { notIn: ["ARCHIVED"] },
        OR: [
          { title: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        reqNo: true,
        title: true,
        status: true,
        module: true,
        kind: true,
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    return { data: rows };
  }

  // ── DETALJ ───────────────────────────────────────────────────────────────

  /** GET /zahtevi/:id — detalj + prilozi (živi) + analize + komentari + events; row-scope.
   *  Komentari i events se obogaćuju display imenom autora (meki ref na users — bez FK,
   *  jedan findMany za sve id-jeve; obrazac iz zahtevi-rewards payoutReport). Fallback #id. */
  async getDetail(id: number, actor: AuthUser) {
    await this.getScopedOrThrow(id, actor);
    const req = await this.prisma.changeRequest.findUnique({
      where: { id },
      include: {
        attachments: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
        },
        analyses: { orderBy: { createdAt: "desc" } },
        comments: { orderBy: { createdAt: "asc" } },
        events: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!req) return { data: req };

    // Imena autora komentara + aktera events (meki ref na users; jedan upit za sve).
    const comments = req.comments ?? [];
    const events = req.events ?? [];
    const userIds = Array.from(
      new Set<number>([
        ...comments.map((c) => c.authorUserId),
        ...events
          .map((e) => e.actorUserId)
          .filter((v): v is number => v != null),
      ]),
    );
    const nameById = await this.namesByUserId(userIds);

    return {
      data: {
        ...req,
        comments: comments.map((c) => ({
          ...c,
          authorName: nameById.get(c.authorUserId) ?? null,
        })),
        events: events.map((e) => ({
          ...e,
          actorName:
            e.actorUserId != null
              ? (nameById.get(e.actorUserId) ?? null)
              : null,
        })),
      },
    };
  }

  /** Mapa userId → prikazno ime (fullName || email || null). Prazan ulaz → prazna mapa. */
  private async namesByUserId(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, email: true },
    });
    return new Map(users.map((u) => [u.id, u.fullName || u.email || `#${u.id}`]));
  }

  // ── CREATE / UPDATE / DELETE ────────────────────────────────────────────────

  /** POST /zahtevi — kreira DRAFT (ili uz submit:true odmah podnosi + trijaža). */
  async create(dto: CreateChangeRequestDto, actor: AuthUser) {
    validateCreateChangeRequest(dto);
    const created = await this.prisma.$transaction(async (tx) => {
      const reqNo = await this.numbering.nextReqNo(tx);
      const req = await tx.changeRequest.create({
        data: {
          reqNo,
          title: dto.title.trim(),
          description: dto.description.trim(),
          expectedBehavior: dto.expectedBehavior ?? null,
          currentBehavior: dto.currentBehavior ?? null,
          kind: dto.kind || null,
          module: dto.module || null,
          areas: dto.areas ?? [],
          priorityUser: dto.priorityUser || null,
          status: "DRAFT",
          createdByUserId: actor.userId,
        },
      });
      await this.writeEvent(tx, req.id, "CREATED", actor.userId);
      return req;
    });

    if (dto.submit)
      return { data: await this.submitInternal(created.id, actor) };
    return { data: created };
  }

  /**
   * PATCH /zahtevi/:id — owner: sadržaj SAMO u DRAFT; admin: meta (module/kind/priorityFinal)
   * bilo kad → event META_CHANGED. Original je zaključan posle submit-a (§1.3, doktrina §10.3).
   */
  async update(id: number, dto: UpdateChangeRequestDto, actor: AuthUser) {
    validateUpdateChangeRequest(dto);
    const req = await this.getScopedOrThrow(id, actor);
    const admin = this.isAdmin(actor);

    // Polja sadržaja (original) — owner sme SAMO u DRAFT; posle submit-a niko ne prepisuje original.
    const contentKeys = [
      "title",
      "description",
      "expectedBehavior",
      "currentBehavior",
      "priorityUser",
    ] as const;
    const wantsContent =
      contentKeys.some((k) => dto[k] !== undefined) || dto.areas !== undefined;
    // Meta polja (admin bilo kad).
    const wantsMeta =
      dto.module !== undefined ||
      dto.kind !== undefined ||
      dto.priorityFinal !== undefined;

    if (wantsContent && req.status !== "DRAFT")
      throw new UnprocessableEntityException(
        "Sadržaj zahteva se menja samo u statusu Nacrt (posle podnošenja je original zaključan; dopune idu kao komentari).",
      );
    if (dto.priorityFinal !== undefined && !admin)
      throw new ForbiddenException(
        "Finalni prioritet postavlja samo administrator.",
      );
    // Ne-admin ne sme menjati module/kind posle DRAFT-a (to je admin meta).
    if (!admin && wantsMeta && req.status !== "DRAFT")
      throw new UnprocessableEntityException(
        "Meta polja (modul/tip) menja administrator ili vi u statusu Nacrt.",
      );

    const data: Prisma.ChangeRequestUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.description !== undefined)
      data.description = dto.description.trim();
    if (dto.expectedBehavior !== undefined)
      data.expectedBehavior = dto.expectedBehavior;
    if (dto.currentBehavior !== undefined)
      data.currentBehavior = dto.currentBehavior;
    if (dto.priorityUser !== undefined) data.priorityUser = dto.priorityUser;
    if (dto.areas !== undefined) data.areas = dto.areas;
    if (dto.module !== undefined) data.module = dto.module;
    if (dto.kind !== undefined) data.kind = dto.kind;
    if (dto.priorityFinal !== undefined) data.priorityFinal = dto.priorityFinal;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.changeRequest.update({ where: { id }, data });
      // Admin meta izmena posle DRAFT-a → event META_CHANGED (audit trag u timeline-u).
      if (admin && wantsMeta && req.status !== "DRAFT") {
        for (const field of ["module", "kind", "priorityFinal"] as const) {
          const oldValue = req[field];
          const newValue = dto[field];
          if (newValue !== undefined && newValue !== oldValue)
            await this.writeEvent(tx, id, "META_CHANGED", actor.userId, {
              field,
              old: oldValue ?? null,
              new: newValue ?? null,
            });
        }
      }
      return u;
    });
    return { data: updated };
  }

  /** DELETE /zahtevi/:id — hard delete SAMO owner + SAMO DRAFT (§7). */
  async remove(id: number, actor: AuthUser) {
    const req = await this.getScopedOrThrow(id, actor);
    if (req.createdByUserId !== actor.userId)
      throw new ForbiddenException(
        "Zahtev može obrisati samo njegov podnosilac.",
      );
    if (req.status !== "DRAFT")
      throw new UnprocessableEntityException(
        "Briše se samo nacrt (posle podnošenja koristite Povuci/Arhiviraj).",
      );
    await this.prisma.changeRequest.delete({ where: { id } });
    return { data: { id, deleted: true } };
  }

  // ── SUBMIT / WITHDRAW ───────────────────────────────────────────────────────

  /** POST /zahtevi/:id/submit — DRAFT→SUBMITTED (i re-submit iz NEEDS_INFO); okida trijažu (F3). */
  async submit(id: number, actor: AuthUser) {
    await this.getScopedOrThrow(id, actor);
    return { data: await this.submitInternal(id, actor) };
  }

  private async submitInternal(id: number, actor: AuthUser) {
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    // owner-only submit (ne-admin je već sužen; admin ne podnosi tuđe umesto korisnika u V1).
    if (req.createdByUserId !== actor.userId && !this.isAdmin(actor))
      throw new ForbiddenException("Zahtev podnosi njegov podnosilac.");
    this.assertStatus(req.status, ["DRAFT", "NEEDS_INFO"], "podnošenje");
    const isResubmit = req.status === "NEEDS_INFO";
    this.assertTransition(req.status, "SUBMITTED");

    const submittedAt = req.submittedAt ?? new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // F1 (TOCTOU): compare-and-set na pročitani status — dupli submit ne pravi dupli event/trijažu.
      // Resubmit iz NEEDS_INFO čisti stari decisionNote (razlog prethodnog vraćanja) — inače bi
      // se u headeru/baneru zadržala zastarela napomena posle dopune (23.07 review §3a).
      await this.updateStatusGuarded(tx, id, req.status, {
        status: "SUBMITTED",
        submittedAt,
        ...(isResubmit ? { decisionNote: null } : {}),
      });
      await this.writeEvent(
        tx,
        id,
        isResubmit ? "RESUBMITTED" : "SUBMITTED",
        actor.userId,
      );
      return {
        ...req,
        status: "SUBMITTED",
        submittedAt,
        ...(isResubmit ? { decisionNote: null } : {}),
      };
    });

    // AI trijaža (§4.1) — FIRE-AND-FORGET (nije await): upiše PENDING red analize i
    // pokrene AI klasifikaciju/duplikate/ocenu 0–5 u pozadini. Sav rad je u try/catch
    // unutar ZahteviAiService — submit ODMAH odgovara, AI nikad ne obara radnju (§10.4).
    // Trijaža je automatska (startedByUserId = null).
    this.zahteviAi.scheduleTriage(id, null);

    // Obaveštenje administratorima (MODULE_SPEC §9) — POSLE commita, FIRE-AND-FORGET,
    // u try/catch unutar servisa; nikad ne obara submit (§10.4). isResubmit menja
    // subject/telo („Dopunjen zahtev" umesto „Nova ideja").
    void this.mail.notifyAdminsNewRequest(id, isResubmit);
    return updated;
  }

  /** POST /zahtevi/:id/withdraw — owner povlači (→ ARCHIVED) iz DRAFT|SUBMITTED|NEEDS_INFO (§1.3). */
  async withdraw(id: number, actor: AuthUser) {
    const req = await this.getScopedOrThrow(id, actor);
    if (req.createdByUserId !== actor.userId && !this.isAdmin(actor))
      throw new ForbiddenException("Zahtev povlači njegov podnosilac.");
    this.assertStatus(req.status, OWNER_WITHDRAW_STATUSES, "povlačenje");
    const updated = await this.prisma.$transaction(async (tx) => {
      // F1 (TOCTOU): compare-and-set — dupli withdraw ne piše dupli WITHDRAWN event.
      await this.updateStatusGuarded(tx, id, req.status, {
        status: "ARCHIVED",
      });
      await this.writeEvent(tx, id, "WITHDRAWN", actor.userId, {
        from: req.status,
      });
      return { ...req, status: "ARCHIVED" };
    });
    return { data: updated };
  }

  // ── KOMENTARI ────────────────────────────────────────────────────────────

  /**
   * POST /zahtevi/:id/comments — owner + admin. Admin sme `isQuestion:true` (pitanje
   * podnosiocu). Komentar NIKAD sam ne menja status: prelaz u NEEDS_INFO radi ISKLJUČIVO
   * `decision needs-info` (čistije za status mašinu — jedan izvor prelaza; F3/23.07 revizija).
   * FE tok „Prosledi pitanja" i ručni admin checkbox pozovu decision odvojeno kad treba.
   */
  async addComment(
    id: number,
    body: { body?: string; isQuestion?: boolean },
    actor: AuthUser,
  ) {
    await this.getScopedOrThrow(id, actor);
    const text = (body?.body ?? "").trim();
    if (!text) throw new BadRequestException("Komentar ne može biti prazan.");
    const admin = this.isAdmin(actor);
    const isQuestion = admin && body?.isQuestion === true;

    const result = await this.prisma.$transaction(async (tx) => {
      const comment = await tx.changeRequestComment.create({
        data: {
          requestId: id,
          authorUserId: actor.userId,
          body: text,
          isQuestion,
        },
      });
      await this.writeEvent(tx, id, "COMMENT", actor.userId, {
        isQuestion,
      });
      return comment;
    });
    return { data: result };
  }

  /**
   * POST /zahtevi/:id/return-for-info — ATOMSKO vraćanje na dopunu (admin). U JEDNOJ
   * transakciji: N pitanja (komentari isQuestion=true) + CAS prelaz u NEEDS_INFO +
   * event + decisionNote (stvarna napomena ili null). Zamena za krhki dvokorak
   * (komentar pa decision): ako CAS padne (dupli klik / AI auto-reject u pozadini),
   * ROLLBACK — nijedno pitanje se ne upiše, podnosilac ne dobija pola-toka (23.07 review).
   * Mejl podnosiocu (needs-info) ide POSLE commita, fire-and-forget (§10.4).
   *
   * Event NEEDS_INFO se piše PRE komentara: PostgreSQL `now()` je transaction_timestamp
   * (isti za sve redove u tx) pa banner filter „komentari >= poslednji NEEDS_INFO event"
   * (round-scope) pouzdano hvata pitanja ove runde.
   */
  async returnForInfo(id: number, dto: ReturnForInfoDto, actor: AuthUser) {
    validateReturnForInfo(dto);
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    this.assertTransition(req.status, "NEEDS_INFO");

    const note = dto.note?.trim() || null;
    const questions = dto.questions.map((q) => q.trim()).filter(Boolean);

    const updated = await this.prisma.$transaction(async (tx) => {
      // F1 (TOCTOU): compare-and-set na pročitani status — dupli klik / dva admina /
      // AI auto-reject u međuvremenu → count 0 → 409 i CELA tx (pitanja) se poništi.
      await this.updateStatusGuarded(tx, id, req.status, {
        status: "NEEDS_INFO",
        decisionNote: note,
      });
      await this.writeEvent(tx, id, "NEEDS_INFO", actor.userId, {
        from: req.status,
        to: "NEEDS_INFO",
        questionCount: questions.length,
        ...(note ? { note } : {}),
      });
      for (const body of questions) {
        await tx.changeRequestComment.create({
          data: { requestId: id, authorUserId: actor.userId, body, isQuestion: true },
        });
      }
      return { ...req, status: "NEEDS_INFO", decisionNote: note };
    });

    // Mejl podnosiocu (§9) — kao decision needs-info. NIKAD ne obara radnju (§10.4).
    void this.mail.notifySubmitter({
      requestId: id,
      outcome: "needs-info",
      note,
    });
    return { data: updated };
  }

  // ── ADMIN DECISION (odobrenje #2 i ostale presude) ──────────────────────────

  /** POST /zahtevi/:id/decision — admin presuda (approve/reject/needs-info/merge/defer/archive). */
  async decision(id: number, dto: DecisionDto, actor: AuthUser) {
    validateDecision(dto);
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);

    const nextByAction: Record<string, string> = {
      approve: "APPROVED",
      reject: "REJECTED",
      "needs-info": "NEEDS_INFO",
      merge: "MERGED",
      defer: "DEFERRED",
      archive: "ARCHIVED",
    };
    const next = nextByAction[dto.action];
    this.assertTransition(req.status, next);

    if (dto.action === "merge") {
      const target = await this.prisma.changeRequest.findUnique({
        where: { id: dto.mergeIntoId! },
        select: { id: true, status: true, mergedIntoId: true },
      });
      if (!target)
        throw new NotFoundException(
          `Kanonski zahtev ${dto.mergeIntoId} ne postoji.`,
        );
      if (dto.mergeIntoId === id)
        throw new BadRequestException(
          "Zahtev se ne može spojiti sam sa sobom.",
        );
      // F6: kanonski cilj mora biti „živ" — ne MERGED/ARCHIVED i sam ne spojen u drugi.
      // Time se sprečavaju lanci/ciklusi spajanja (A→B→C ili A→B, B→A).
      if (
        target.status === "MERGED" ||
        target.status === "ARCHIVED" ||
        target.mergedIntoId != null
      )
        throw new UnprocessableEntityException(
          `Kanonski zahtev ${dto.mergeIntoId} nije važeći cilj spajanja (arhiviran/spojen). Izaberite aktivan zahtev.`,
        );
    }

    const eventByAction: Record<string, string> = {
      approve: "APPROVED",
      reject: "REJECTED",
      "needs-info": "NEEDS_INFO",
      merge: "MERGED",
      defer: "DEFERRED",
      archive: "STATUS_CHANGED",
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.ChangeRequestUpdateInput = { status: next };
      if (dto.note !== undefined) data.decisionNote = dto.note;
      if (dto.action === "approve" || dto.action === "reject") {
        data.decidedAt = new Date();
        data.decidedByUserId = actor.userId;
      }
      if (dto.action === "merge") data.mergedIntoId = dto.mergeIntoId!;
      // F1 (TOCTOU): compare-and-set na pročitani status — dupli klik / dva admina
      // ne prave dupli event/mejl niti duplu Decision Log prečicu.
      await this.updateStatusGuarded(tx, id, req.status, data);
      const u = { ...req, ...(data as Record<string, unknown>) };
      await this.writeEvent(tx, id, eventByAction[dto.action], actor.userId, {
        from: req.status,
        to: next,
        ...(dto.note ? { note: dto.note } : {}),
        ...(dto.action === "merge" ? { mergeIntoId: dto.mergeIntoId } : {}),
      });
      // logDecision prečica (§6): uz approve/reject → prefilovan zapis u Decision Log.
      // Best-effort UNUTAR iste transakcije — pad ne obara odluku (catch loguje).
      if (
        dto.logDecision === true &&
        (dto.action === "approve" || dto.action === "reject")
      ) {
        try {
          await this.decisions.createFromRequest(tx, {
            requestId: id,
            reqNo: req.reqNo,
            requestTitle: req.title,
            requestDescription: req.description,
            action: dto.action,
            note: dto.note,
            actorUserId: actor.userId,
          });
        } catch (err) {
          this.logger.warn(
            `Decision Log prečica za zahtev ${id} nije upisana: ${(err as Error).message}`,
          );
        }
      }
      return u;
    });

    // Mejl podnosiocu (§9) — approve/reject/needs-info. NIKAD ne obara radnju (§10.4).
    if (
      dto.action === "approve" ||
      dto.action === "reject" ||
      dto.action === "needs-info"
    ) {
      void this.mail.notifySubmitter({
        requestId: id,
        outcome: dto.action,
        note: dto.note ?? null,
      });
    }
    return { data: updated };
  }

  /** POST /zahtevi/:id/status — realizacioni prelazi + link polja (admin, §7). */
  async setStatus(id: number, dto: StatusDto, actor: AuthUser) {
    validateStatus(dto);
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    const nextByAction: Record<string, string> = {
      planned: "PLANNED",
      "in-progress": "IN_PROGRESS",
      "ready-for-test": "READY_FOR_TEST",
      testing: "TESTING",
      done: "DONE",
    };
    const next = nextByAction[dto.action];
    this.assertTransition(req.status, next);

    const link: Prisma.ChangeRequestUpdateInput = {};
    let linkAdded = false;
    if (dto.branchName !== undefined) {
      link.branchName = dto.branchName;
      linkAdded = true;
    }
    if (dto.prUrl !== undefined) {
      link.prUrl = dto.prUrl;
      linkAdded = true;
    }
    if (dto.commitSha !== undefined) {
      link.commitSha = dto.commitSha;
      linkAdded = true;
    }
    if (dto.deliveredVersion !== undefined) {
      link.deliveredVersion = dto.deliveredVersion;
      linkAdded = true;
    }
    if (dto.implementedBy !== undefined) {
      link.implementedBy = dto.implementedBy;
      linkAdded = true;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      // F1 (TOCTOU): compare-and-set na pročitani status — dupli prelaz ne piše dupli event/mejl.
      await this.updateStatusGuarded(tx, id, req.status, {
        status: next,
        ...link,
      });
      const u = { ...req, status: next, ...(link as Record<string, unknown>) };
      await this.writeEvent(tx, id, "STATUS_CHANGED", actor.userId, {
        from: req.status,
        to: next,
      });
      if (linkAdded) await this.writeEvent(tx, id, "LINK_ADDED", actor.userId);
      return u;
    });
    // Mejl podnosiocu na završetak (§9) — best-effort, nikad ne obara radnju (§10.4).
    if (next === "DONE") {
      void this.mail.notifySubmitter({ requestId: id, outcome: "done" });
    }
    return { data: updated };
  }

  // ── PRILOZI (§5) ────────────────────────────────────────────────────────────

  /**
   * POST /zahtevi/:id/attachments — multipart upload (do 10 fajlova/zahtev, 25MB/fajl).
   * Dozvoljeno owner-u u DRAFT|SUBMITTED|NEEDS_INFO, adminu uvek. AUDIO → auto STT (try/catch).
   */
  async addAttachments(
    id: number,
    files: Express.Multer.File[],
    actor: AuthUser,
  ) {
    const req = await this.getScopedOrThrow(id, actor);
    this.assertAttachMutationAllowed(req, actor);
    if (!files || files.length === 0)
      throw new BadRequestException(
        "Nije priložen nijedan fajl (polje `files`).",
      );

    const existing = await this.prisma.changeRequestAttachment.count({
      where: { requestId: id, deletedAt: null },
    });
    if (existing + files.length > MAX_ATTACHMENTS)
      throw new UnprocessableEntityException(
        `Najviše ${MAX_ATTACHMENTS} priloga po zahtevu (trenutno ${existing}).`,
      );

    const created: unknown[] = [];
    for (const file of files) {
      const kind = this.classifyMime(file.mimetype);
      this.validateFile(file, kind);
      const ext =
        EXT_BY_MIME[file.mimetype.split(";")[0].toLowerCase()] ?? "bin";
      const storagePath = `req/${id}/${randomUUID()}.${ext}`;

      await this.storage.upload(
        ATTACHMENT_BUCKET,
        storagePath,
        new Uint8Array(file.buffer),
        file.mimetype,
      );

      // AUDIO → auto STT (best-effort; pad = transcript null). NIKAD ne obara upload.
      let transcript: string | null = null;
      let transcriptModel: string | null = null;
      if (kind === "AUDIO") {
        try {
          const res = await this.ai.transcribe({
            bytes: new Uint8Array(file.buffer),
            mime: file.mimetype,
          });
          transcript = res.text;
          transcriptModel = res.model;
        } catch (err) {
          this.logger.warn(
            `STT nije uspeo za prilog zahteva ${id}: ${(err as Error).message}`,
          );
        }
      }

      const row = await this.prisma.changeRequestAttachment.create({
        data: {
          requestId: id,
          kind,
          bucket: ATTACHMENT_BUCKET,
          storagePath,
          originalName: file.originalname?.slice(0, 200) ?? "prilog",
          contentType: file.mimetype,
          sizeBytes: file.size,
          transcript,
          transcriptModel,
          createdByUserId: actor.userId,
        },
      });
      created.push(row);
    }
    return { data: created };
  }

  /** GET /zahtevi/:id/attachments/:attId/url — signed URL (row-scope kroz getScopedOrThrow). */
  async getAttachmentUrl(id: number, attId: number, actor: AuthUser) {
    await this.getScopedOrThrow(id, actor); // row-scope: tuđ zahtev → 404
    const att = await this.prisma.changeRequestAttachment.findFirst({
      where: { id: attId, requestId: id, deletedAt: null },
    });
    if (!att) throw new NotFoundException(`Prilog ${attId} ne postoji.`);
    const signed = await this.storage.signUrl(
      att.bucket,
      att.storagePath,
      3600,
    );
    return { data: { url: signed.url, expiresIn: signed.expiresIn } };
  }

  /** DELETE /zahtevi/:id/attachments/:attId — soft-delete + best-effort remove. */
  async removeAttachment(id: number, attId: number, actor: AuthUser) {
    const req = await this.getScopedOrThrow(id, actor);
    this.assertAttachMutationAllowed(req, actor);
    const att = await this.prisma.changeRequestAttachment.findFirst({
      where: { id: attId, requestId: id, deletedAt: null },
    });
    if (!att) throw new NotFoundException(`Prilog ${attId} ne postoji.`);
    await this.prisma.changeRequestAttachment.update({
      where: { id: attId },
      data: { deletedAt: new Date() },
    });
    // fajl je propratni — best-effort brisanje (meta-red je izvor istine).
    await this.storage.remove(att.bucket, att.storagePath);
    return { data: { id: attId, deleted: true } };
  }

  /** POST /zahtevi/:id/attachments/:attId/transcribe — retry STT ako je pao (audio). */
  async transcribeAttachment(id: number, attId: number, actor: AuthUser) {
    const req = await this.getScopedOrThrow(id, actor);
    this.assertAttachMutationAllowed(req, actor);
    const att = await this.prisma.changeRequestAttachment.findFirst({
      where: { id: attId, requestId: id, deletedAt: null },
    });
    if (!att) throw new NotFoundException(`Prilog ${attId} ne postoji.`);
    if (att.kind !== "AUDIO")
      throw new UnprocessableEntityException(
        "Transkripcija je moguća samo za audio prilog.",
      );
    // F3: pun retry — dohvati bajtove iz bucket-a, pozovi STT, upiši transcript.
    // Immutable guard (postojeći ne-null transcript) je i u AI servisu, ali proveravamo
    // rano radi jasne poruke. NE pregazuje postojeći transkript.
    return this.zahteviAi.retryTranscribe({
      id: att.id,
      bucket: att.bucket,
      storagePath: att.storagePath,
      contentType: att.contentType,
      transcript: att.transcript,
    });
  }

  // ── helpers (prilozi) ──────────────────────────────────────────────────────

  private assertAttachMutationAllowed(
    req: { status: string; createdByUserId: number },
    actor: AuthUser,
  ): void {
    if (this.isAdmin(actor)) return; // admin uvek
    if (req.createdByUserId !== actor.userId)
      throw new ForbiddenException("Priloge menja podnosilac zahteva.");
    if (!OWNER_EDITABLE_STATUSES.includes(req.status))
      throw new UnprocessableEntityException(
        "Prilozi se menjaju u statusima Nacrt / Podnet / Vraćen na dopunu.",
      );
  }

  private classifyMime(mime: string): "IMAGE" | "AUDIO" | "FILE" {
    const m = mime.split(";")[0].toLowerCase();
    if (IMAGE_MIMES.includes(m)) return "IMAGE";
    if (AUDIO_MIMES.includes(m)) return "AUDIO";
    if (DOC_MIMES.includes(m)) return "FILE";
    throw new UnprocessableEntityException(
      `Nepodržan tip fajla "${mime}". Dozvoljeno: slike (jpeg/png/webp/heic), audio (webm/mp4/mpeg/ogg/wav), pdf.`,
    );
  }

  private validateFile(
    file: Express.Multer.File,
    kind: "IMAGE" | "AUDIO" | "FILE",
  ): void {
    if (!file.buffer || file.size < MIN_FILE_BYTES)
      throw new BadRequestException(
        `Fajl "${file.originalname ?? ""}" je prazan ili premali.`,
      );
    if (file.size > MAX_FILE_BYTES)
      throw new UnprocessableEntityException(
        `Fajl "${file.originalname ?? ""}" prelazi 25 MB.`,
      );
    if (kind === "AUDIO" && file.size > MAX_AUDIO_BYTES)
      throw new UnprocessableEntityException(
        `Audio prilog prelazi 15 MB (STT limit).`,
      );
  }
}
