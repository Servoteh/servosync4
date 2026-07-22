import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15StorageService } from "../../common/sy15/sy15-storage.service";
import { AiProviderService } from "../../common/ai/ai-provider.service";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { ZAHTEVI_SYSTEM_CONTEXT } from "./zahtevi-ai-context";
import {
  TRIAGE_SYSTEM_PROMPT,
  TRIAGE_TOOL,
  TRIAGE_DEFAULT_MODEL,
  TRIAGE_MAX_DESC_CHARS,
  TRIAGE_MAX_IMAGES,
  TRIAGE_DUP_SUMMARY_CHARS,
  ANALYSIS_SYSTEM_PROMPT,
  ANALYSIS_TOOL,
  ANALYSIS_DEFAULT_MODEL,
  normalizeTriage,
  normalizeAnalysis,
  usageTokens,
  classifyAiError,
  type TriageResult,
  type AnalysisResult,
} from "./zahtevi-ai";

/** Vision MIME allowlist za base64 slike u trijaži (Anthropic image blokovi). */
const VISION_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
/** Preko ovoliko postojećih zahteva → pre-filter duplikata (§4.1). */
const DUP_PREFILTER_THRESHOLD = 500;

/**
 * Zahtevi AI cevovod (MODULE_SPEC_zahtevi §4) — poseban servis u modulu.
 * Sve ide kroz `AiProviderService` (jedini izlaz ka LLM-ovima). DOKTRINE §10:
 *  - AI pad NIKAD ne obara tok (sve u try/catch; FAILED + errorCode + event).
 *  - bez ključa → analiza FAILED not_configured, modul radi normalno.
 *  - AI menja status SAMO u dva izuzetka: ANALYSIS_APPROVED→ANALYZED i ocena 0→REJECTED.
 *  - original polja se NE prepisuju; predlozi module/kind/priority idu SAMO u prazna.
 */
@Injectable()
export class ZahteviAiService {
  private readonly logger = new Logger(ZahteviAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: Sy15StorageService,
    private readonly ai: AiProviderService,
  ) {}

  private isAdmin(actor: AuthUser): boolean {
    return roleHasPermission(actor.role, PERMISSIONS.ZAHTEVI_ADMIN);
  }

  private triageModel(): string {
    return process.env.ZAHTEVI_TRIAGE_MODEL || TRIAGE_DEFAULT_MODEL;
  }
  private analysisModel(): string {
    return process.env.ZAHTEVI_ANALYSIS_MODEL || ANALYSIS_DEFAULT_MODEL;
  }

  // ── TRIJAŽA (§4.1) ──────────────────────────────────────────────────────────

  /**
   * Okidač trijaže — pozива se FIRE-AND-FORGET iz submit toka (ZahteviService).
   * Upiše PENDING red i zakaže async prolaz; NE await-uje se (submit odgovara odmah).
   * Sav rad je u try/catch — AI pad ostaje unutra (doktrina §10.4).
   *
   * `void` povratna vrednost + interni catch: pozivalac radi `void this.scheduleTriage(id)`.
   */
  scheduleTriage(requestId: number, startedByUserId: number | null): void {
    // Ne vraćamo promise pozivaocu; sve greške ostaju ovde (nikad ne obaraju submit).
    void this.runTriage(requestId, startedByUserId).catch((err) => {
      this.logger.error(
        `Trijaža zahteva ${requestId} pukla van try/catch: ${(err as Error).message}`,
      );
    });
  }

  /** POST /:id/retriage — admin ponavlja trijažu (nov red analize). Sinhroni deo je upis PENDING. */
  async retriage(id: number, actor: AuthUser) {
    if (!this.isAdmin(actor))
      throw new ForbiddenException("Trijažu ponavlja administrator.");
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    this.scheduleTriage(id, actor.userId);
    return { data: { id, triage: "scheduled" } };
  }

  /** Ceo trijažni prolaz: PENDING red → AI → primena rezultata → DONE/FAILED. */
  private async runTriage(
    requestId: number,
    startedByUserId: number | null,
  ): Promise<void> {
    const analysis = await this.prisma.changeRequestAiAnalysis.create({
      data: {
        requestId,
        kind: "TRIAGE",
        status: "PENDING",
        startedByUserId,
      },
    });

    try {
      const req = await this.prisma.changeRequest.findUnique({
        where: { id: requestId },
      });
      if (!req) throw new NotFoundException(`Zahtev ${requestId} ne postoji.`);

      const content = await this.buildTriageContent(requestId, req);
      const res = await this.ai.extractWithTool({
        model: this.triageModel(),
        system: TRIAGE_SYSTEM_PROMPT,
        tool: TRIAGE_TOOL,
        content,
        maxTokens: 2000,
      });
      const triage = normalizeTriage(res.toolInput);
      const { tokensIn, tokensOut } = usageTokens(res.usage);

      await this.applyTriage(
        requestId,
        triage,
        analysis.id,
        res.model,
        tokensIn,
        tokensOut,
      );
    } catch (err) {
      await this.failTriage(requestId, analysis.id, err);
    }
  }

  /** Sastavi Anthropic `content` za trijažu: tekst + transkripti + slike + lista postojećih. */
  private async buildTriageContent(
    requestId: number,
    req: {
      title: string;
      description: string;
      expectedBehavior: string | null;
      currentBehavior: string | null;
    },
  ): Promise<unknown[]> {
    const attachments = await this.prisma.changeRequestAttachment.findMany({
      where: { requestId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    const transcripts = attachments
      .filter((a) => a.kind === "AUDIO" && a.transcript)
      .map((a, i) => `Glasovna poruka ${i + 1}: ${a.transcript}`);

    const candidates = await this.duplicateCandidates(requestId, req.title);

    const innerBlock = [
      `NASLOV: ${req.title}`,
      `OPIS:\n${req.description.slice(0, TRIAGE_MAX_DESC_CHARS)}`,
      req.expectedBehavior
        ? `OČEKIVANO PONAŠANJE:\n${req.expectedBehavior}`
        : "",
      req.currentBehavior ? `TRENUTNO PONAŠANJE:\n${req.currentBehavior}` : "",
      transcripts.length
        ? `TRANSKRIPTI GLASOVNIH PORUKA:\n${transcripts.join("\n")}`
        : "",
      "",
      "POSTOJEĆI ZAHTEVI (kandidati za duplikate — proveri da li ovaj ponavlja neki od njih):",
      candidates.length
        ? candidates
            .map(
              (c) =>
                `- id=${c.id} [${c.reqNo}] (${c.status}) ${c.title} — ${c.snippet}`,
            )
            .join("\n")
        : "(nema drugih zahteva u sistemu)",
    ]
      .filter(Boolean)
      .join("\n\n");

    // F3: obmotaj sav korisnički (nepouzdan) unos jasnim markerima. System prompt nalaže
    // modelu da instrukcije unutar markera tretira kao podatke, nikad kao naredbe.
    const textBlock = `<<<KORISNICKI_UNOS>>>\n${innerBlock}\n<<<KRAJ_UNOSA>>>`;

    const content: unknown[] = [{ type: "text", text: textBlock }];

    // Slike (best-effort: ako dohvat padne, nastavi bez slika — doktrina §10.4).
    const images = attachments
      .filter((a) => a.kind === "IMAGE")
      .slice(0, TRIAGE_MAX_IMAGES);
    for (const img of images) {
      try {
        const bytes = await this.storage.download(img.bucket, img.storagePath);
        const mime = VISION_MIME.includes(img.contentType)
          ? img.contentType
          : "image/jpeg";
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mime,
            data: Buffer.from(bytes).toString("base64"),
          },
        });
      } catch (err) {
        this.logger.warn(
          `Slika ${img.id} (zahtev ${requestId}) nije dohvaćena za trijažu: ${(err as Error).message}`,
        );
      }
    }
    return content;
  }

  /**
   * Kandidati za duplikate (§4.1, presuda §13.13): KOMPLETNA lista postojećih zahteva
   * (id, reqNo, naslov, sažetak ≤200, status) sem ARCHIVED starijih od godinu dana.
   * Preko 500 → pre-filter ILIKE sličnošću po naslovu (jeftino).
   */
  private async duplicateCandidates(
    requestId: number,
    title: string,
  ): Promise<
    {
      id: number;
      reqNo: string;
      title: string;
      status: string;
      snippet: string;
    }[]
  > {
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);

    const baseWhere: Prisma.ChangeRequestWhereInput = {
      id: { not: requestId },
      // Isključi samo DAVNO arhivirane; sve ostalo je jeftino po tokenima (naslovi).
      NOT: { status: "ARCHIVED", updatedAt: { lt: yearAgo } },
    };

    const total = await this.prisma.changeRequest.count({ where: baseWhere });
    let where = baseWhere;
    if (total > DUP_PREFILTER_THRESHOLD) {
      // Pre-filter: reč-po-reč ILIKE nad naslovom (najduže reči; slabo, ali dovoljno V1).
      const terms = title
        .split(/\s+/)
        .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((w) => w.length >= 4)
        .slice(0, 6);
      if (terms.length) {
        where = {
          ...baseWhere,
          OR: terms.map((t) => ({
            title: { contains: t, mode: "insensitive" as const },
          })),
        };
      }
    }

    const rows = await this.prisma.changeRequest.findMany({
      where,
      select: {
        id: true,
        reqNo: true,
        title: true,
        status: true,
        description: true,
      },
      orderBy: { createdAt: "desc" },
      take: DUP_PREFILTER_THRESHOLD,
    });
    return rows.map((r) => ({
      id: r.id,
      reqNo: r.reqNo,
      title: r.title,
      status: r.status,
      snippet: r.description.slice(0, TRIAGE_DUP_SUMMARY_CHARS),
    }));
  }

  /**
   * Primena trijažnog rezultata (§4.1): predlozi module/kind/priority SAMO u prazna
   * polja (podnosiočev izbor se ne pregazi); aiScore+aiScoreReason UVEK; score ≥1 →
   * rewardStatus=PROPOSED; score 0 → status REJECTED + event AI_REJECTED (duplicates u data).
   * Sve u jednoj transakciji sa upisom rezultata na red analize.
   */
  private async applyTriage(
    requestId: number,
    triage: TriageResult,
    analysisId: number,
    model: string,
    tokensIn: number | null,
    tokensOut: number | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const req = await tx.changeRequest.findUnique({
        where: { id: requestId },
      });
      if (!req) return; // zahtev obrisan u međuvremenu — nema šta da se primeni

      const update: Prisma.ChangeRequestUpdateInput = {};
      // Predlozi SAMO u prazna polja (doktrina §10 — ne pregazi podnosioca).
      if (!req.module && triage.module) update.module = triage.module;
      if (!req.kind && triage.kind) update.kind = triage.kind;
      if (!req.priorityFinal && triage.priorityProposal)
        update.priorityFinal = triage.priorityProposal;
      // Ocena se UVEK upisuje (AI predlog).
      if (triage.score !== null) update.aiScore = triage.score;
      if (triage.scoreReason) update.aiScoreReason = triage.scoreReason;

      const autoReject = triage.score === 0 && req.status === "SUBMITTED";
      if (autoReject) {
        // Jedina AI izmena statusa iz trijaže (§10.1, §12.1) — uz admin restore ventil.
        update.status = "REJECTED";
        update.rewardStatus = "NONE";
      } else if (triage.score !== null && triage.score >= 1) {
        update.rewardStatus = "PROPOSED";
      }

      if (Object.keys(update).length > 0)
        await tx.changeRequest.update({
          where: { id: requestId },
          data: update,
        });

      await tx.changeRequestAiAnalysis.update({
        where: { id: analysisId },
        data: {
          status: "DONE",
          model,
          result: triage as unknown as Prisma.InputJsonValue,
          tokensIn,
          tokensOut,
          finishedAt: new Date(),
        },
      });

      await this.writeEvent(tx, requestId, "TRIAGED", null, {
        score: triage.score ?? undefined,
        duplicates: triage.duplicates,
      } as unknown as Prisma.InputJsonValue);
      if (autoReject)
        await this.writeEvent(tx, requestId, "AI_REJECTED", null, {
          score: 0,
          reason: triage.scoreReason ?? undefined,
          duplicates: triage.duplicates,
        } as unknown as Prisma.InputJsonValue);
    });
  }

  /** Trijaža pala: FAILED + errorCode na redu analize + event TRIAGE_FAILED (status ostaje). */
  private async failTriage(
    requestId: number,
    analysisId: number,
    err: unknown,
  ): Promise<void> {
    const errorCode = classifyAiError(err);
    this.logger.warn(
      `Trijaža zahteva ${requestId} nije uspela (${errorCode}): ${(err as Error).message}`,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.changeRequestAiAnalysis.update({
          where: { id: analysisId },
          data: { status: "FAILED", errorCode, finishedAt: new Date() },
        });
        await this.writeEvent(tx, requestId, "TRIAGE_FAILED", null, {
          errorCode,
        });
      });
    } catch (dbErr) {
      this.logger.error(
        `Ne mogu da upišem TRIAGE_FAILED za ${requestId}: ${(dbErr as Error).message}`,
      );
      // F8a: ako i tx padne, red analize bi ostao zombie-PENDING. Poslednji best-effort:
      // ne-transakcioni update reda na FAILED (event može izostati; makar se ne poluje beskrajno).
      await this.markAnalysisFailedBestEffort(analysisId, errorCode);
    }
  }

  /**
   * F8a: poslednja odbrana od zombie-PENDING reda analize — ne-transakcioni update na FAILED.
   * Poziva se SAMO kad glavni (transakcioni) upis FAILED-a padne. Sopstveni try/catch: ako i
   * ovo padne, samo se loguje (red ostaje PENDING, ali FE polling ima svoj tajmaut — F8b).
   */
  private async markAnalysisFailedBestEffort(
    analysisId: number,
    errorCode: string,
  ): Promise<void> {
    try {
      await this.prisma.changeRequestAiAnalysis.update({
        where: { id: analysisId },
        data: { status: "FAILED", errorCode, finishedAt: new Date() },
      });
    } catch (err2) {
      this.logger.error(
        `Best-effort FAILED update reda analize ${analysisId} pao: ${(err2 as Error).message}`,
      );
    }
  }

  // ── DETALJNA ANALIZA (§4.2) ─────────────────────────────────────────────────

  /**
   * POST /:id/approve-analysis — odobrenje #1 (admin): SUBMITTED→ANALYSIS_APPROVED +
   * event, pa FIRE-AND-FORGET detaljna analiza. Sinhroni deo je samo prelaz statusa;
   * AI se pokreće pozadinski (front polluje do ANALYZED/SUBMITTED).
   */
  async approveAnalysis(id: number, actor: AuthUser) {
    if (!this.isAdmin(actor))
      throw new ForbiddenException("AI analizu odobrava administrator.");
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    if (req.status !== "SUBMITTED")
      throw new UnprocessableEntityException(
        `AI analiza se odobrava iz statusa Podnet (trenutno: ${req.status}).`,
      );

    const updated = await this.prisma.$transaction(async (tx) => {
      // F1 (TOCTOU): compare-and-set na SUBMITTED — dupli klik „odobri analizu"
      // ne sme upisati dupli event niti pokrenuti dva AI run-a.
      const res = await tx.changeRequest.updateMany({
        where: { id, status: "SUBMITTED" },
        data: { status: "ANALYSIS_APPROVED" },
      });
      if (res.count === 0)
        throw new ConflictException(
          "Zahtev je u međuvremenu promenio status — osveži stranicu.",
        );
      const u = { ...req, status: "ANALYSIS_APPROVED" };
      await this.writeEvent(tx, id, "ANALYSIS_APPROVED", actor.userId, {
        from: req.status,
      });
      return u;
    });

    void this.runAnalysis(id, actor.userId).catch((err) => {
      this.logger.error(
        `Detaljna analiza zahteva ${id} pukla van try/catch: ${(err as Error).message}`,
      );
    });
    return { data: updated };
  }

  /** Ceo prolaz detaljne analize: PENDING red → AI → DONE (ANALYZED) / FAILED (→ SUBMITTED). */
  private async runAnalysis(
    requestId: number,
    startedByUserId: number,
  ): Promise<void> {
    const analysis = await this.prisma.changeRequestAiAnalysis.create({
      data: {
        requestId,
        kind: "DETAILED",
        status: "PENDING",
        startedByUserId,
      },
    });

    try {
      const content = await this.buildAnalysisContent(requestId);
      const res = await this.ai.extractWithTool({
        model: this.analysisModel(),
        system: `${ANALYSIS_SYSTEM_PROMPT}\n\n---\nSISTEMSKI KONTEKST:\n${ZAHTEVI_SYSTEM_CONTEXT}`,
        tool: ANALYSIS_TOOL,
        content,
        maxTokens: 8000,
      });
      const analysisResult = normalizeAnalysis(res.toolInput);
      const { tokensIn, tokensOut } = usageTokens(res.usage);
      await this.applyAnalysis(
        requestId,
        analysisResult,
        analysis.id,
        res.model,
        tokensIn,
        tokensOut,
      );
    } catch (err) {
      await this.failAnalysis(requestId, analysis.id, err);
    }
  }

  /** Sastavi content za detaljnu: zahtev + transkripti + slike + komentari + trijaža. */
  private async buildAnalysisContent(requestId: number): Promise<unknown[]> {
    const req = await this.prisma.changeRequest.findUnique({
      where: { id: requestId },
    });
    if (!req) throw new NotFoundException(`Zahtev ${requestId} ne postoji.`);

    const content = await this.buildTriageContent(requestId, req);

    const comments = await this.prisma.changeRequestComment.findMany({
      where: { requestId },
      orderBy: { createdAt: "asc" },
    });
    const lastTriage = await this.prisma.changeRequestAiAnalysis.findFirst({
      where: { requestId, kind: "TRIAGE", status: "DONE" },
      orderBy: { createdAt: "desc" },
    });

    const extraInner = [
      `REQ_NO: ${req.reqNo}`,
      comments.length
        ? `KOMENTARI / ODGOVORI:\n${comments
            .map(
              (c) =>
                `- ${c.isQuestion ? "[pitanje] " : ""}#${c.authorUserId}: ${c.body}`,
            )
            .join("\n")}`
        : "",
      lastTriage?.result
        ? `TRIJAŽNI REZULTAT (JSON):\n${JSON.stringify(lastTriage.result)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    // F3: komentari i trijažni JSON su takođe nepouzdan unos → markeri.
    const extra = `<<<KORISNICKI_UNOS>>>\n${extraInner}\n<<<KRAJ_UNOSA>>>`;
    content.push({ type: "text", text: extra });
    return content;
  }

  /** DONE: status ANALYZED + event ANALYZED; rezultat i claudePackage na red analize. */
  private async applyAnalysis(
    requestId: number,
    result: AnalysisResult,
    analysisId: number,
    model: string,
    tokensIn: number | null,
    tokensOut: number | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const req = await tx.changeRequest.findUnique({
        where: { id: requestId },
      });
      // Status prelazi u ANALYZED SAMO ako je i dalje ANALYSIS_APPROVED (nije admin
      // u međuvremenu odlučio nešto drugo). Ovo je drugi dozvoljeni AI status-prelaz.
      if (req && req.status === "ANALYSIS_APPROVED") {
        await tx.changeRequest.update({
          where: { id: requestId },
          data: { status: "ANALYZED" },
        });
      }
      await tx.changeRequestAiAnalysis.update({
        where: { id: analysisId },
        data: {
          status: "DONE",
          model,
          result: result as unknown as Prisma.InputJsonValue,
          claudePackage: result.claudePackage || null,
          tokensIn,
          tokensOut,
          finishedAt: new Date(),
        },
      });
      await this.writeEvent(tx, requestId, "ANALYZED", null);
    });
  }

  /** FAILED: red analize FAILED + errorCode; zahtev VRAĆEN na SUBMITTED + event ANALYSIS_FAILED. */
  private async failAnalysis(
    requestId: number,
    analysisId: number,
    err: unknown,
  ): Promise<void> {
    const errorCode = classifyAiError(err);
    this.logger.warn(
      `Detaljna analiza zahteva ${requestId} nije uspela (${errorCode}): ${(err as Error).message}`,
    );
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.changeRequestAiAnalysis.update({
          where: { id: analysisId },
          data: { status: "FAILED", errorCode, finishedAt: new Date() },
        });
        const req = await tx.changeRequest.findUnique({
          where: { id: requestId },
        });
        if (req && req.status === "ANALYSIS_APPROVED") {
          await tx.changeRequest.update({
            where: { id: requestId },
            data: { status: "SUBMITTED" },
          });
        }
        await this.writeEvent(tx, requestId, "ANALYSIS_FAILED", null, {
          errorCode,
        });
      });
    } catch (dbErr) {
      this.logger.error(
        `Ne mogu da upišem ANALYSIS_FAILED za ${requestId}: ${(dbErr as Error).message}`,
      );
      // F8a: best-effort ne-transakcioni FAILED update (izbegava zombie-PENDING red).
      await this.markAnalysisFailedBestEffort(analysisId, errorCode);
    }
  }

  // ── PATCH claudePackage (§4.3) ──────────────────────────────────────────────

  /** PATCH /:id/analyses/:analysisId — admin dorada claudePackage-a. */
  async patchAnalysis(
    id: number,
    analysisId: number,
    body: { claudePackage?: string },
    actor: AuthUser,
  ) {
    if (!this.isAdmin(actor))
      throw new ForbiddenException("Claude paket menja administrator.");
    const analysis = await this.prisma.changeRequestAiAnalysis.findFirst({
      where: { id: analysisId, requestId: id },
    });
    if (!analysis)
      throw new NotFoundException(`Analiza ${analysisId} ne postoji.`);
    if (analysis.kind !== "DETAILED")
      throw new UnprocessableEntityException(
        "Claude paket ima samo detaljna analiza.",
      );
    if (typeof body?.claudePackage !== "string")
      throw new UnprocessableEntityException(
        "Nedostaje `claudePackage` (tekst).",
      );
    const updated = await this.prisma.changeRequestAiAnalysis.update({
      where: { id: analysisId },
      data: { claudePackage: body.claudePackage },
    });
    return { data: updated };
  }

  // ── RESTORE (§12.1 sigurnosni ventil auto-reject-a) ─────────────────────────

  /**
   * POST /:id/restore — admin vraća AI-odbačen (ocena 0) zahtev u SUBMITTED.
   * Guard: samo REJECTED koji je AI odbacio (postoji event AI_REJECTED) i nije spojen.
   */
  async restore(id: number, actor: AuthUser) {
    if (!this.isAdmin(actor))
      throw new ForbiddenException("Vraćanje u obradu radi administrator.");
    const req = await this.prisma.changeRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    if (req.status !== "REJECTED")
      throw new UnprocessableEntityException(
        `Vraća se samo odbijen zahtev (trenutno: ${req.status}).`,
      );
    if (req.mergedIntoId)
      throw new UnprocessableEntityException(
        "Spojeni zahtev se ne vraća u obradu.",
      );
    const aiReject = await this.prisma.changeRequestEvent.findFirst({
      where: { requestId: id, type: "AI_REJECTED" },
    });
    if (!aiReject)
      throw new UnprocessableEntityException(
        "Vraćanje je moguće samo za AI-odbačen zahtev (ocena 0).",
      );

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.changeRequest.update({
        where: { id },
        // F2: očisti AI ocenu pri restore-u. Inače bi jedan klik „potvrdi ocenu" bez
        // izmene ponovo video aiScore=0 i auto-odbacio zahtev. Trag ostaje netaknut u
        // redu analize i AI_REJECTED event-u — ništa se ne gubi, samo se ventil resetuje.
        data: {
          status: "SUBMITTED",
          rewardStatus: "NONE",
          aiScore: null,
          aiScoreReason: null,
          finalScore: null,
        },
      });
      await this.writeEvent(tx, id, "STATUS_CHANGED", actor.userId, {
        from: "REJECTED",
        to: "SUBMITTED",
        reason: "restore (AI-odbačen)",
      });
      return u;
    });
    return { data: updated };
  }

  // ── PUN RETRY TRANSKRIPCIJE (§5, dovršava F1 stub) ──────────────────────────

  /**
   * POST /:id/attachments/:attId/transcribe — pun retry STT-a: dohvati bajtove iz
   * bucket-a, pozovi transcribe, upiši transcript. Immutable: ne prepisuje postojeći.
   * Pozива se iz ZahteviService.transcribeAttachment posle row-scope/allow provera.
   */
  async retryTranscribe(attachment: {
    id: number;
    bucket: string;
    storagePath: string;
    contentType: string;
    transcript: string | null;
  }) {
    if (attachment.transcript)
      throw new UnprocessableEntityException(
        "Prilog već ima transkript (immutable od nastanka).",
      );
    const bytes = await this.storage.download(
      attachment.bucket,
      attachment.storagePath,
    );
    const res = await this.ai.transcribe({
      bytes,
      mime: attachment.contentType,
    });
    const updated = await this.prisma.changeRequestAttachment.update({
      where: { id: attachment.id },
      data: { transcript: res.text, transcriptModel: res.model },
    });
    return { data: updated };
  }

  // ── helpers ─────────────────────────────────────────────────────────────────

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
}
