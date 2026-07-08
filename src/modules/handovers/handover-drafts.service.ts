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
import {
  CreateHandoverDraftDto,
  validateCreateHandoverDraft,
} from "./dto/create-handover-draft.dto";
import {
  UpdateHandoverDraftDto,
  validateUpdateHandoverDraft,
} from "./dto/update-handover-draft.dto";
import { DraftNumberingService } from "./draft-numbering.service";
import { HANDOVER_STATUS } from "./handovers.service";

/** Podskup polja crteža bezbedan za izlaz — koristi se za mainDrawing/drawing na stavkama. */
const DRAWING_SELECT = {
  id: true,
  drawingNumber: true,
  revision: true,
  name: true,
  material: true,
  dimensions: true,
  weight: true,
} satisfies Prisma.DrawingSelect;

/**
 * `handover_draft_statuses.id` za "Predat" (§3.2). Seed je nepotvrđen (isti
 * razlog zbog kog `create()` upisuje `statusId: 0` bez lookup provere), pa se u
 * `submit()` postavlja SAMO ako taj lookup red postoji — inače se nacrt samo
 * zaključa (`isLocked`), bez FK 500 na nepostojeći status.
 */
const DRAFT_STATUS_SUBMITTED = 2;

const DRAFT_SELECT = {
  id: true,
  draftNumber: true,
  draftDate: true,
  draftType: true,
  designerId: true,
  projectId: true,
  mainDrawingId: true,
  pieceCount: true,
  statusId: true,
  note: true,
  isLocked: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.HandoverDraftSelect;

export interface ListHandoverDraftsQuery {
  page?: string;
  pageSize?: string;
  /** Pretraga po broju nacrta / napomeni. */
  q?: string;
  statusId?: string;
  designerId?: string;
  projectId?: string;
  /** `true` | `false` — filter po zaključanosti. */
  isLocked?: string;
  /** Opseg po `draftDate` (ISO). */
  from?: string;
  to?: string;
}

/**
 * Nacrti primopredaje (`handover_drafts` + `handover_draft_items`) —
 * MODULE_SPEC_nacrti_primopredaje §6.1/§6.2/§6.3. Osnovni unos (zaglavlje +
 * stavke pri kreiranju) + `submit()` (predaja u primopredaju — §6.3, kreira
 * `drawing_handovers` redove i zaključava nacrt). BEZ BOM auto-populate wizarda
 * i BEZ pre-check-duplicate logike (§7.2) — van skopa ovog talasa.
 *
 * 🔴 `deleted_at` NE POSTOJI u šemi za `handover_drafts` (za razliku od
 * pretpostavke u spec §6.1 "Soft delete"). Bez izmene šeme (zabranjeno ovog
 * talasa) DELETE je zato pravo (hard) brisanje, dozvoljeno samo dok nacrt
 * nije zaključan — vidi `remove()`.
 */
@Injectable()
export class HandoverDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: DraftNumberingService,
  ) {}

  // ---------------------------------------------------------------- READ

  async list(query: ListHandoverDraftsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.HandoverDraftWhereInput = {};
    if (query.q) {
      where.OR = [
        { draftNumber: { contains: query.q, mode: "insensitive" } },
        { note: { contains: query.q, mode: "insensitive" } },
      ];
    }
    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    where.statusId = intEq(query.statusId);
    where.designerId = intEq(query.designerId);
    where.projectId = intEq(query.projectId);
    if (query.isLocked === "true") where.isLocked = true;
    else if (query.isLocked === "false") where.isLocked = false;
    if (query.from || query.to) {
      const range: Prisma.DateTimeFilter = {};
      if (query.from) range.gte = new Date(query.from);
      if (query.to) range.lte = new Date(query.to);
      where.draftDate = range;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.handoverDraft.findMany({
        where,
        orderBy: [{ draftDate: "desc" }, { id: "desc" }],
        skip,
        take,
        select: DRAFT_SELECT,
      }),
      this.prisma.handoverDraft.count({ where }),
    ]);

    const [designers, projects, drawings, statuses, itemCounts] =
      await Promise.all([
        this.resolveWorkers(rows.map((r) => r.designerId)),
        this.resolveProjects(rows.map((r) => r.projectId)),
        this.resolveDrawings(rows.map((r) => r.mainDrawingId)),
        this.resolveDraftStatuses(rows.map((r) => r.statusId)),
        this.resolveItemCounts(rows.map((r) => r.id)),
      ]);

    const data = rows.map((r) => ({
      ...r,
      designer: designers.get(r.designerId) ?? null,
      project: projects.get(r.projectId) ?? null,
      mainDrawing: r.mainDrawingId
        ? (drawings.get(r.mainDrawingId) ?? null)
        : null,
      status: statuses.get(r.statusId) ?? null,
      itemsCount: itemCounts.get(r.id) ?? 0,
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  async findOne(id: number) {
    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id },
      select: DRAFT_SELECT,
    });
    if (!draft) throw new NotFoundException(`Nacrt ${id} ne postoji.`);

    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId: id },
      orderBy: { id: "asc" },
    });

    const drawingIds = uniqueIds([
      draft.mainDrawingId,
      ...items.map((i) => i.drawingId),
      ...items.map((i) => i.mainDrawingId),
    ]);
    const [drawings, designer, project, status] = await Promise.all([
      this.resolveDrawingsByIds(drawingIds),
      this.prisma.worker.findUnique({
        where: { id: draft.designerId },
        select: SAFE_WORKER_SELECT,
      }),
      this.prisma.project.findUnique({
        where: { id: draft.projectId },
        select: {
          id: true,
          projectNumber: true,
          projectName: true,
          customerId: true,
        },
      }),
      this.prisma.handoverDraftStatus.findUnique({
        where: { id: draft.statusId },
        select: { id: true, name: true },
      }),
    ]);

    const data = {
      ...draft,
      designer: designer ?? null,
      project: project ?? null,
      mainDrawing: draft.mainDrawingId
        ? (drawings.get(draft.mainDrawingId) ?? null)
        : null,
      status: status ?? null,
      items: items.map((i) => ({
        ...i,
        drawing: drawings.get(i.drawingId) ?? null,
        mainDrawing: i.mainDrawingId
          ? (drawings.get(i.mainDrawingId) ?? null)
          : null,
      })),
    };
    return { data };
  }

  async listItems(draftId: number) {
    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id: draftId },
      select: { id: true },
    });
    if (!draft) throw new NotFoundException(`Nacrt ${draftId} ne postoji.`);

    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId },
      orderBy: { id: "asc" },
    });
    const drawingIds = uniqueIds([
      ...items.map((i) => i.drawingId),
      ...items.map((i) => i.mainDrawingId),
    ]);
    const drawings = await this.resolveDrawingsByIds(drawingIds);

    const data = items.map((i) => ({
      ...i,
      drawing: drawings.get(i.drawingId) ?? null,
      mainDrawing: i.mainDrawingId
        ? (drawings.get(i.mainDrawingId) ?? null)
        : null,
    }));
    return { data };
  }

  // -------------------------------------------------------------- CREATE

  async create(dto: CreateHandoverDraftDto) {
    validateCreateHandoverDraft(dto);
    const items = dto.items ?? [];

    const designer = await this.prisma.worker.findUnique({
      where: { id: dto.designerId },
      select: { id: true },
    });
    if (!designer)
      throw new UnprocessableEntityException(
        `Projektant ${dto.designerId} ne postoji.`,
      );

    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { id: true },
    });
    if (!project)
      throw new UnprocessableEntityException(
        `Predmet ${dto.projectId} ne postoji.`,
      );

    // `handover_draft_items.drawing_id` NEMA DB FK (legacy obrazac) — validiraj
    // ovde da se ne kreiraju orphan reference (§6.1/§6.2).
    const drawingIds = uniqueIds([
      dto.mainDrawingId,
      ...items.map((i) => i.drawingId),
      ...items.map((i) => i.mainDrawingId),
    ]);
    if (drawingIds.length) {
      const found = await this.prisma.drawing.findMany({
        where: { id: { in: drawingIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((f) => f.id));
      const missing = drawingIds.filter((id) => !foundIds.has(id));
      if (missing.length)
        throw new UnprocessableEntityException(
          `Crtež(i) ne postoje: ${missing.join(", ")}.`,
        );
    }

    const created = await this.prisma.$transaction(async (tx) => {
      // App-owned tabele (nema sync/legacy import ovog talasa) — setval je
      // jeftina odbrana ako se ikad uveze istorijski batch sa eksplicitnim id.
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('handover_drafts','id'), (SELECT COALESCE(MAX(id),0) FROM handover_drafts))`,
      );
      if (items.length) {
        await tx.$executeRawUnsafe(
          `SELECT setval(pg_get_serial_sequence('handover_draft_items','id'), (SELECT COALESCE(MAX(id),0) FROM handover_draft_items))`,
        );
      }

      const draftNumber = await this.numbering.next(tx);

      return tx.handoverDraft.create({
        data: {
          designerId: dto.designerId,
          projectId: dto.projectId,
          mainDrawingId: dto.mainDrawingId ?? null,
          draftType: dto.draftType ?? 0,
          pieceCount: dto.pieceCount,
          note: dto.note?.trim() || null,
          draftNumber,
          statusId: 0, // Za Kreiranje (§3.2, nepotvrđen seed — vidi lookups)
          isLocked: false,
          items: items.length
            ? {
                create: items.map((i) => ({
                  drawingId: i.drawingId,
                  quantityToProduce: i.quantityToProduce ?? 1,
                  mainDrawingId: i.mainDrawingId ?? null,
                  isMain: i.isMain ?? false,
                  note: i.note?.trim() || null,
                  quantityDefinedInDrawing: i.quantityDefinedInDrawing ?? 0,
                })),
              }
            : undefined,
        },
        select: { id: true },
      });
    });

    return this.findOne(created.id);
  }

  // ------------------------------------------------------------- UPDATE

  async update(id: number, dto: UpdateHandoverDraftDto) {
    validateUpdateHandoverDraft(dto);

    const existing = await this.prisma.handoverDraft.findUnique({
      where: { id },
      select: { id: true, isLocked: true, projectId: true },
    });
    if (!existing) throw new NotFoundException(`Nacrt ${id} ne postoji.`);
    if (existing.isLocked)
      throw new UnprocessableEntityException(
        "Nacrt je zaključan (predat) — ne može se menjati.",
      );

    if (dto.projectId !== undefined && dto.projectId !== existing.projectId) {
      const itemCount = await this.prisma.handoverDraftItem.count({
        where: { draftId: id },
      });
      if (itemCount > 0)
        throw new UnprocessableEntityException(
          "Predmet nacrta se ne može menjati kad nacrt već ima stavke — obrišite nacrt i napravite novi (§6.1).",
        );
      const project = await this.prisma.project.findUnique({
        where: { id: dto.projectId },
        select: { id: true },
      });
      if (!project)
        throw new UnprocessableEntityException(
          `Predmet ${dto.projectId} ne postoji.`,
        );
    }

    if (dto.mainDrawingId !== undefined && dto.mainDrawingId !== null) {
      const drawing = await this.prisma.drawing.findUnique({
        where: { id: dto.mainDrawingId },
        select: { id: true },
      });
      if (!drawing)
        throw new UnprocessableEntityException(
          `Crtež ${dto.mainDrawingId} ne postoji.`,
        );
    }

    if (dto.statusId !== undefined) {
      const status = await this.prisma.handoverDraftStatus.findUnique({
        where: { id: dto.statusId },
        select: { id: true },
      });
      if (!status)
        throw new UnprocessableEntityException(
          `Nepoznat status nacrta (${dto.statusId}).`,
        );
    }

    // UncheckedUpdateInput dozvoljava direktno postavljanje skalarnih FK-ova
    // (projectId/mainDrawingId/statusId) umesto relacione `connect` forme.
    const data: Prisma.HandoverDraftUncheckedUpdateInput = {};
    if (dto.projectId !== undefined) data.projectId = dto.projectId;
    if (dto.mainDrawingId !== undefined) data.mainDrawingId = dto.mainDrawingId;
    if (dto.draftType !== undefined) data.draftType = dto.draftType;
    if (dto.pieceCount !== undefined) data.pieceCount = dto.pieceCount;
    if (dto.note !== undefined) data.note = dto.note?.trim() || null;
    if (dto.statusId !== undefined) data.statusId = dto.statusId;

    await this.prisma.handoverDraft.update({ where: { id }, data });
    return this.findOne(id);
  }

  // ------------------------------------------------------------- DELETE

  /**
   * Hard delete (nema `deleted_at` u šemi — vidi napomenu na vrhu fajla).
   * Dozvoljeno samo dok nacrt nije zaključan; briše stavke pa zaglavlje u
   * transakciji (FK `fk_handover_draft_items_draft` je `onDelete: NoAction`,
   * pa DB odbija brisanje zaglavlja dok stavke postoje).
   */
  async remove(id: number) {
    const existing = await this.prisma.handoverDraft.findUnique({
      where: { id },
      select: { id: true, isLocked: true },
    });
    if (!existing) throw new NotFoundException(`Nacrt ${id} ne postoji.`);
    if (existing.isLocked)
      throw new UnprocessableEntityException(
        "Nacrt je zaključan (predat) — ne može se obrisati.",
      );

    await this.prisma.$transaction(async (tx) => {
      await tx.handoverDraftItem.deleteMany({ where: { draftId: id } });
      await tx.handoverDraft.delete({ where: { id } });
    });
    return { data: { id, deleted: true } };
  }

  // ------------------------------------------------------------- SUBMIT

  /**
   * Predaja nacrta u primopredaju (§6.3) — kompletira lanac nacrt→primopredaja.
   * U JEDNOJ transakciji: zaključa nacrt i kreira po jedan `drawing_handovers`
   * red za svaku ne-isključenu (`exclude_from_handover = false`) stavku, u
   * statusu U OBRADI (na čekanju odobravanja).
   *
   * `drawing_handovers.handover_worker_id` je NOT NULL u šemi (i nema FK na
   * `workers`), pa broadcast (spec §6.3 "NULL za sve tehnologe") nije moguć —
   * po instrukciji zadatka koristi se `designerId` nacrta (fallback `0`); izbor
   * konkretnog tehnologa (dijalog "Izbor tehnologa", §8.3) dolazi kasnijim
   * talasom. Za razliku od `handover_draft_items.drawing_id`,
   * `drawing_handovers.drawing_id` IMA DB FK, pa se crteži validiraju pre
   * insert-a (orphan → 422, ne sirova FK greška 500 — BACKEND_RULES §7).
   */
  async submit(id: number) {
    const existing = await this.prisma.handoverDraft.findUnique({
      where: { id },
      select: { id: true, isLocked: true, designerId: true },
    });
    if (!existing) throw new NotFoundException(`Nacrt ${id} ne postoji.`);
    if (existing.isLocked)
      throw new ConflictException(
        "Nacrt je već predat (zaključan) — ne može se ponovo predati.",
      );

    const items = await this.prisma.handoverDraftItem.findMany({
      where: { draftId: id, excludeFromHandover: false },
      select: { id: true, drawingId: true },
      orderBy: { id: "asc" },
    });
    if (!items.length)
      throw new UnprocessableEntityException("Nacrt nema stavki za predaju.");

    const drawingIds = uniqueIds(items.map((i) => i.drawingId));
    const foundDrawings = await this.prisma.drawing.findMany({
      where: { id: { in: drawingIds } },
      select: { id: true },
    });
    const foundIds = new Set(foundDrawings.map((d) => d.id));
    const missing = drawingIds.filter((d) => !foundIds.has(d));
    if (missing.length)
      throw new UnprocessableEntityException(
        `Crtež(i) ne postoje: ${missing.join(", ")}.`,
      );

    const createdIds = await this.prisma.$transaction(async (tx) => {
      // Serijalizuj konkurentne submit-ove istog nacrta — bez ovoga bi dva
      // paralelna poziva oba prošla proveru `isLocked` i duplirala primopredaje
      // (isti obrazac advisory lock-a kao draft-numbering.service.ts).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`handover_draft_submit:${id}`}))`;

      const fresh = await tx.handoverDraft.findUnique({
        where: { id },
        select: { isLocked: true },
      });
      if (!fresh) throw new NotFoundException(`Nacrt ${id} ne postoji.`);
      if (fresh.isLocked)
        throw new ConflictException(
          "Nacrt je već predat (zaključan) — ne može se ponovo predati.",
        );

      // `drawing_handovers.id` jeste autoincrement, ali sync/import mogu da
      // ubace eksplicitne id-jeve — poravnaj sekvencu pre insert-a (isti obrazac
      // kao create()/launch()).
      await tx.$executeRawUnsafe(
        `SELECT setval(pg_get_serial_sequence('drawing_handovers','id'), (SELECT COALESCE(MAX(id),0) FROM drawing_handovers))`,
      );

      const now = new Date();
      const handoverWorkerId = existing.designerId ?? 0;
      const ids: number[] = [];
      for (const item of items) {
        const created = await tx.drawingHandover.create({
          data: {
            drawingId: item.drawingId,
            handoverDate: now,
            handoverWorkerId,
            statusId: HANDOVER_STATUS.PENDING, // 0 — U OBRADI (na čekanju)
            isLocked: false,
          },
          select: { id: true },
        });
        ids.push(created.id);
      }

      // Zaključaj nacrt; status "Predat" postavi SAMO ako taj lookup postoji
      // (seed §3.2 nepotvrđen — vidi DRAFT_STATUS_SUBMITTED). UncheckedUpdateInput
      // dozvoljava direktnu skalarno-FK dodelu (isti obrazac kao update()).
      const submittedStatus = await tx.handoverDraftStatus.findUnique({
        where: { id: DRAFT_STATUS_SUBMITTED },
        select: { id: true },
      });
      const draftUpdate: Prisma.HandoverDraftUncheckedUpdateInput = {
        isLocked: true,
      };
      if (submittedStatus) draftUpdate.statusId = DRAFT_STATUS_SUBMITTED;
      await tx.handoverDraft.update({ where: { id }, data: draftUpdate });

      return ids;
    });

    const createdRows = await this.prisma.drawingHandover.findMany({
      where: { id: { in: createdIds } },
      select: {
        id: true,
        drawingId: true,
        handoverDate: true,
        handoverWorkerId: true,
        statusId: true,
        isLocked: true,
        createdAt: true,
      },
      orderBy: { id: "asc" },
    });
    const drawings = await this.resolveDrawingsByIds(
      uniqueIds(createdRows.map((r) => r.drawingId)),
    );
    const handovers = createdRows.map((r) => ({
      ...r,
      drawing: drawings.get(r.drawingId) ?? null,
    }));

    const draft = (await this.findOne(id)).data;
    return { data: { draft, handoversCreated: handovers.length, handovers } };
  }

  // --- batch resolveri (izbegavaju required-relation JOIN nad orphan FK-om) ---

  private async resolveWorkers(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.worker.findMany({
        where: { id: { in: uniq } },
        select: SAFE_WORKER_SELECT,
      }),
    );
  }

  private async resolveProjects(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.project.findMany({
        where: { id: { in: uniq } },
        select: {
          id: true,
          projectNumber: true,
          projectName: true,
          customerId: true,
        },
      }),
    );
  }

  private async resolveDrawings(ids: (number | null | undefined)[]) {
    return this.resolveDrawingsByIds(uniqueIds(ids));
  }

  private async resolveDrawingsByIds(uniq: number[]) {
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.drawing.findMany({
        where: { id: { in: uniq } },
        select: DRAWING_SELECT,
      }),
    );
  }

  private async resolveDraftStatuses(ids: number[]) {
    const uniq = uniqueIds(ids);
    if (!uniq.length) return new Map<number, never>();
    return byId(
      await this.prisma.handoverDraftStatus.findMany({
        where: { id: { in: uniq } },
        select: { id: true, name: true },
      }),
    );
  }

  private async resolveItemCounts(draftIds: number[]) {
    const uniq = uniqueIds(draftIds);
    const map = new Map<number, number>();
    if (!uniq.length) return map;
    const grouped = await this.prisma.handoverDraftItem.groupBy({
      by: ["draftId"],
      where: { draftId: { in: uniq } },
      _count: { _all: true },
    });
    for (const g of grouped) map.set(g.draftId, g._count._all);
    return map;
  }
}
