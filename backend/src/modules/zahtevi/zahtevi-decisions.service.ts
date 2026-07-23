import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import { parsePagination, pageMeta } from "../../common/pagination";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreateDecisionLogDto,
  validateCreateDecisionLog,
  type UpdateDecisionLogDto,
  validateUpdateDecisionLog,
  type SupersedeDecisionLogDto,
  validateSupersedeDecisionLog,
} from "./dto/decision-log.dto";

/** "YYYY-MM-DD" → Date (ponoć UTC; @db.Date). */
function parseDateOnly(v?: string): Date {
  if (v) return new Date(`${v}T00:00:00.000Z`);
  const now = new Date();
  return new Date(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()),
  );
}

/**
 * Decision Log (MODULE_SPEC §6) — ADR-stil registar odluka, nezavisan od zahteva.
 * Čitanje: admin + menadzment (ZAHTEVI_DECISIONS_READ); upis: admin (ZAHTEVI_DECISIONS_WRITE).
 * Suštinska promena = supersede (nova odluka + stara SUPERSEDED/supersededById); sitne
 * ispravke = PATCH. Guard sloj već primenjuje permisije na ruti; servis ne pretpostavlja.
 */
@Injectable()
export class ZahteviDecisionsService {
  constructor(private readonly prisma: PrismaService) {}

  private assertWrite(actor: AuthUser): void {
    if (!roleHasPermission(actor.role, PERMISSIONS.ZAHTEVI_DECISIONS_WRITE))
      throw new ForbiddenException("Odluke unosi administrator.");
  }

  /**
   * GET /zahtevi/odluke — lista sa filterima q (naslov/odluka/kontekst), tag, status;
   * paginacija. Najnovije prvo (decidedOn desc, pa id desc).
   */
  async list(
    query: {
      q?: string;
      tag?: string;
      status?: string;
      page?: string;
      pageSize?: string;
    },
  ) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where: Prisma.DecisionLogEntryWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: "insensitive" } },
              { decision: { contains: query.q, mode: "insensitive" } },
              { context: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.decisionLogEntry.findMany({
        where,
        orderBy: [{ decidedOn: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.decisionLogEntry.count({ where }),
    ]);
    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /** GET /zahtevi/odluke/:id — detalj (uklj. odluka koja je zamenila ovu, ako postoji). */
  async getOne(id: number) {
    const entry = await this.prisma.decisionLogEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException(`Odluka ${id} ne postoji.`);
    return { data: entry };
  }

  /** POST /zahtevi/odluke — nova odluka (retroaktivan datum dozvoljen). */
  async create(dto: CreateDecisionLogDto, actor: AuthUser) {
    this.assertWrite(actor);
    validateCreateDecisionLog(dto);
    const entry = await this.prisma.decisionLogEntry.create({
      data: {
        title: dto.title.trim(),
        decision: dto.decision.trim(),
        context: dto.context?.trim() || null,
        consequences: dto.consequences?.trim() || null,
        tags: dto.tags ?? [],
        relatedRequestId: dto.relatedRequestId ?? null,
        decidedOn: parseDateOnly(dto.decidedOn),
        createdByUserId: actor.userId,
      },
    });
    return { data: entry };
  }

  /**
   * Prečica sa zahteva (§6): uz approve/reject odluku sa logDecision:true kreira zapis
   * prefilovan iz zahteva. Idempotencija: NE dupliramo isti zahtev+odluku (ako već postoji
   * ACTIVE zapis sa istim relatedRequestId i naslovom, preskačemo). Poziva je ZahteviService
   * unutar iste transakcije decision-a. Best-effort: pad NE obara odluku (pozivalac catch-uje).
   */
  async createFromRequest(
    tx: Prisma.TransactionClient,
    params: {
      requestId: number;
      reqNo: string;
      requestTitle: string;
      requestDescription: string;
      action: "approve" | "reject";
      note?: string;
      actorUserId: number;
    },
  ): Promise<void> {
    const outcome =
      params.action === "approve" ? "Odobreno za realizaciju" : "Odbijeno";
    const title = `Zahtev ${params.reqNo}: ${params.requestTitle}`.slice(0, 200);
    const contextParts = [
      `Poreklo: zahtev ${params.reqNo}.`,
      `Ishod: ${outcome}.`,
      params.note ? `Obrazloženje: ${params.note}` : "",
      `Sažetak zahteva: ${params.requestDescription.slice(0, 800)}`,
    ].filter(Boolean);

    const existing = await tx.decisionLogEntry.findFirst({
      where: {
        relatedRequestId: params.requestId,
        title,
        status: "ACTIVE",
      },
    });
    if (existing) return; // ne dupliraj prečicu za isti zahtev/naslov

    await tx.decisionLogEntry.create({
      data: {
        title,
        decision: `${outcome}${params.note ? ` — ${params.note}` : ""}`.slice(
          0,
          10000,
        ),
        context: contextParts.join("\n"),
        consequences: null,
        tags: ["zahtev"],
        relatedRequestId: params.requestId,
        decidedOn: parseDateOnly(),
        createdByUserId: params.actorUserId,
      },
    });
  }

  /** PATCH /zahtevi/odluke/:id — sitne ispravke (audit hvata; supersede za suštinske promene). */
  async update(id: number, dto: UpdateDecisionLogDto, actor: AuthUser) {
    this.assertWrite(actor);
    validateUpdateDecisionLog(dto);
    const entry = await this.prisma.decisionLogEntry.findUnique({
      where: { id },
    });
    if (!entry) throw new NotFoundException(`Odluka ${id} ne postoji.`);
    if (entry.status === "SUPERSEDED")
      throw new UnprocessableEntityException(
        "Zamenjena odluka se ne menja (unesite novu ili izmenite naslednicu).",
      );

    const data: Prisma.DecisionLogEntryUpdateInput = {};
    if (dto.title !== undefined) data.title = dto.title.trim();
    if (dto.decision !== undefined) data.decision = dto.decision.trim();
    if (dto.context !== undefined)
      data.context = dto.context?.trim() || null;
    if (dto.consequences !== undefined)
      data.consequences = dto.consequences?.trim() || null;
    if (dto.tags !== undefined) data.tags = dto.tags;
    if (dto.relatedRequestId !== undefined)
      data.relatedRequestId = dto.relatedRequestId;
    if (dto.decidedOn !== undefined)
      data.decidedOn = parseDateOnly(dto.decidedOn);

    const updated = await this.prisma.decisionLogEntry.update({
      where: { id },
      data,
    });
    return { data: updated };
  }

  /**
   * POST /zahtevi/odluke/:id/supersede — nova odluka zamenjuje staru: kreira novu (ACTIVE),
   * staroj postavlja status=SUPERSEDED + supersededById. Stara odluka mora biti ACTIVE.
   */
  async supersede(id: number, dto: SupersedeDecisionLogDto, actor: AuthUser) {
    this.assertWrite(actor);
    validateSupersedeDecisionLog(dto);
    const old = await this.prisma.decisionLogEntry.findUnique({
      where: { id },
    });
    if (!old) throw new NotFoundException(`Odluka ${id} ne postoji.`);
    if (old.status !== "ACTIVE")
      throw new UnprocessableEntityException(
        "Samo aktivna odluka se može zameniti (ova je već zamenjena).",
      );

    const result = await this.prisma.$transaction(async (tx) => {
      const created = await tx.decisionLogEntry.create({
        data: {
          title: dto.title.trim(),
          decision: dto.decision.trim(),
          context: dto.context?.trim() || null,
          consequences: dto.consequences?.trim() || null,
          tags: dto.tags ?? old.tags,
          relatedRequestId: dto.relatedRequestId ?? old.relatedRequestId,
          decidedOn: parseDateOnly(dto.decidedOn),
          createdByUserId: actor.userId,
        },
      });
      const superseded = await tx.decisionLogEntry.update({
        where: { id },
        data: { status: "SUPERSEDED", supersededById: created.id },
      });
      return { created, superseded };
    });
    return { data: result };
  }
}
