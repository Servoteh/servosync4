import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import {
  pageMeta,
  parsePagination,
  SAFE_WORKER_SELECT,
} from "../../common/pagination";
import { byId, uniqueIds } from "../../common/relations";
import { alignIdSequence } from "../../common/db-sequences";
import { parseDateParam } from "../../common/date-params";
import {
  CreateHandoverDraftDto,
  CreateHandoverDraftItemInput,
  validateCreateHandoverDraft,
} from "./dto/create-handover-draft.dto";
import {
  UpdateHandoverDraftDto,
  validateUpdateHandoverDraft,
} from "./dto/update-handover-draft.dto";
import {
  DecideDraftItemDto,
  DRAFT_ITEM_DECISION,
  validateDecideDraftItem,
} from "./dto/decide-draft-item.dto";
import { DraftNumberingService } from "./draft-numbering.service";
import { HANDOVER_STATUS } from "./handovers.service";
import type { AuthUser } from "../auth/jwt.strategy";
import { isApprovedPdmState, normalizeRevision } from "../pdm/pdm-xml-parser";

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

/**
 * SOFT upozorenje uz `create()` (P4_SPEC §6.5.3 + §6.5.4) — vraća se u
 * `meta.warnings` BEZ blokade (hard blokada je samo ne-odobren `pdm_status`).
 */
export interface DraftItemWarning {
  type: "missing_pdf" | "not_latest_revision" | "duplicate";
  drawingId: number;
  drawingNumber: string;
  revision: string;
  message: string;
}

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
 * `drawing_handovers` redove i zaključava nacrt). BEZ BOM auto-populate
 * wizarda (van skopa).
 *
 * P4_SPEC_pdm_intake_PREDLOG §0 t.3+t.4 (odluka Nenad 11.07):
 *  - §6.5.3 preduslovi stavke pri `create()`: ne-odobren `pdm_status` = HARD
 *    422 (isti kriterijum kao XML uvoz — `isApprovedPdmState`); nedostajući
 *    PDF i ne-poslednja revizija = SOFT upozorenja u `meta.warnings`;
 *  - §6.5.4 pre-check duplikata (legacy `viewOdlukePredProvera` /
 *    MODULE_SPEC §7.2): ranije puštanje istog crteža na ISTOM predmetu →
 *    `pre_check_*` kolone + upozorenje; odluka projektanta preko
 *    `decideItem()` (1=Isključi, 2=Predaj ponovo, 3=Dopuni); `submit()` gate
 *    odbija dok postoji sporna stavka bez odluke.
 * Svaki budući add-item put MORA proći kroz iste helpere
 * (`checkItemPreconditions` + `preCheckItems`).
 *
 * 🔴 `deleted_at` NE POSTOJI u šemi za `handover_drafts` (za razliku od
 * pretpostavke u spec §6.1 "Soft delete"). Bez izmene šeme (zabranjeno ovog
 * talasa) DELETE je zato pravo (hard) brisanje, dozvoljeno samo dok nacrt
 * nije zaključan — vidi `remove()`.
 */
@Injectable()
export class HandoverDraftsService {
  private readonly logger = new Logger(HandoverDraftsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: DraftNumberingService,
    private readonly notifications: NotificationsService,
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
    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
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

  async create(dto: CreateHandoverDraftDto, actor?: AuthUser) {
    validateCreateHandoverDraft(dto);
    const items = dto.items ?? [];

    // Proba 13.07: designerId je opcion — default je ULOGOVANI korisnik (JWT
    // workerId), po nameri spec-a (P4 §: designer = current user). Eksplicitan
    // izbor ostaje moguć (vođa unosi za kolegu), ali radnik mora biti AKTIVAN
    // (slobodan unos šifre je propuštao stare/neaktivne operatere).
    //
    // Zamka (proba 13.07, Igor): JWT nosi workerId iz trenutka izdavanja tokena.
    // Ako se users.worker_id VEŽE naknadno (SSO-JIT nalog dobio radnika posle
    // prvog logina), stari token i dalje ima workerId=null → create pada 422 dok
    // se korisnik ne re-loguje. Zato: kad token nema workerId, čitaj SVEŽ
    // users.worker_id iz baze po userId-u umesto da se oslanjamo na token.
    let actorWorkerId = actor?.workerId ?? null;
    if (!actorWorkerId && actor?.userId) {
      const freshUser = await this.prisma.user.findUnique({
        where: { id: actor.userId },
        select: { workerId: true },
      });
      actorWorkerId = freshUser?.workerId ?? null;
    }
    const designerId = dto.designerId ?? actorWorkerId ?? 0;
    if (!designerId || designerId <= 0)
      throw new UnprocessableEntityException(
        "Projektant je obavezan — izaberite projektanta ili vežite nalog za radnika (users.worker_id).",
      );
    const designer = await this.prisma.worker.findUnique({
      where: { id: designerId },
      select: { id: true, active: true },
    });
    if (!designer)
      throw new UnprocessableEntityException(
        `Projektant ${designerId} ne postoji.`,
      );
    if (designer.active !== true)
      throw new UnprocessableEntityException(
        `Radnik ${designerId} nije aktivan — projektant nacrta mora biti aktivan zaposleni.`,
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

    // §6.5.3 preduslovi stavke (P4_SPEC §0 t.3): ODOBREN pdm_status = hard
    // 422; PDF + poslednja revizija = soft upozorenja (meta.warnings).
    const warnings = await this.checkItemPreconditions(
      items.map((i) => i.drawingId),
    );

    // §6.5.4 pre-check duplikata (P4_SPEC §0 t.4): ranije puštanje istog
    // crteža na ISTOM predmetu → pre_check_* kolone + upozorenje u meta.
    const preCheck = await this.preCheckItems(
      {
        projectId: dto.projectId,
        pieceCount: dto.pieceCount,
        mainDrawingId: dto.mainDrawingId ?? null,
      },
      items,
    );
    warnings.push(...preCheck.warnings);

    const created = await this.prisma.$transaction(async (tx) => {
      // App-owned tabele (nema sync/legacy import ovog talasa) — setval je
      // jeftina odbrana ako se ikad uveze istorijski batch sa eksplicitnim id.
      await alignIdSequence(tx, "handover_drafts");
      if (items.length) {
        await alignIdSequence(tx, "handover_draft_items");
      }

      const draftNumber = await this.numbering.next(tx);

      return tx.handoverDraft.create({
        data: {
          designerId,
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
                create: items.map((i, idx) => {
                  const flag = preCheck.flags.get(idx);
                  return {
                    drawingId: i.drawingId,
                    quantityToProduce: i.quantityToProduce ?? 1,
                    mainDrawingId: i.mainDrawingId ?? null,
                    isMain: i.isMain ?? false,
                    note: i.note?.trim() || null,
                    quantityDefinedInDrawing: i.quantityDefinedInDrawing ?? 0,
                    // §6.5.4: sporna stavka nosi pre_check_* provenance;
                    // odluka (decision_action) kreće od 0 = nerešeno.
                    preCheckDuplicate: flag !== undefined,
                    preCheckDraftId: flag?.preCheckDraftId ?? null,
                    preCheckWorkOrderId: flag?.preCheckWorkOrderId ?? null,
                  };
                }),
              }
            : undefined,
        },
        select: { id: true },
      });
    });

    // Envelope: soft upozorenja NE blokiraju (§6.5.3/§6.5.4 — meta.warnings).
    return { ...(await this.findOne(created.id)), meta: { warnings } };
  }

  // ------------------------- §6.5.3 / §6.5.4 preduslovi i pre-check stavki

  /**
   * §6.5.3 preduslovi stavke (P4_SPEC §0 t.3, legacy pravilo biroa): u nacrt
   * ulazi samo crtež koji je ODOBREN, ima PDF i poslednja je revizija.
   *  - ne-odobren `pdm_status` → HARD 422 (isti kriterijum kao XML uvoz:
   *    case-insensitive „odobreno" / „izmena bez revizije");
   *  - nedostajući PDF / ne-poslednja revizija → SOFT upozorenje (PDF ume da
   *    kasni za XML-om; ručni izuzeci postoje — §8 #9 default).
   * PDF exists ide po (broj, revizija) BEZ učitavanja bloba; „poslednja
   * revizija" = MAX(revision) po drawing_number (SQL string MAX semantika,
   * poređenje normalizovano prazan→"A").
   */
  private async checkItemPreconditions(
    itemDrawingIds: number[],
  ): Promise<DraftItemWarning[]> {
    const uniq = uniqueIds(itemDrawingIds);
    if (!uniq.length) return [];

    const drawings = await this.prisma.drawing.findMany({
      where: { id: { in: uniq } },
      select: {
        id: true,
        drawingNumber: true,
        revision: true,
        pdmStatus: true,
      },
    });

    const notApproved = drawings.filter(
      (d) => !isApprovedPdmState(d.pdmStatus),
    );
    if (notApproved.length)
      throw new UnprocessableEntityException(
        `Crtež(i) nisu ODOBRENI u PDM-u: ${notApproved
          .map(
            (d) =>
              `${d.drawingNumber} rev ${d.revision} (status "${d.pdmStatus}")`,
          )
          .join(", ")} — u nacrt ulaze samo odobreni crteži (§6.5.3).`,
      );

    const warnings: DraftItemWarning[] = [];

    const pdfKey = (n: string, r: string) => `${n} ${r}`;
    const pdfs = await this.prisma.drawingPdf.findMany({
      where: {
        OR: drawings.map((d) => ({
          drawingNumber: d.drawingNumber,
          revision: d.revision,
        })),
        pdfBinary: { not: null },
      },
      select: { drawingNumber: true, revision: true },
    });
    const pdfKeys = new Set(
      pdfs.map((p) => pdfKey(p.drawingNumber, p.revision)),
    );

    const maxRevs = await this.prisma.drawing.groupBy({
      by: ["drawingNumber"],
      where: {
        drawingNumber: {
          in: [...new Set(drawings.map((d) => d.drawingNumber))],
        },
      },
      _max: { revision: true },
    });
    const maxByNumber = new Map(
      maxRevs.map((g) => [g.drawingNumber, g._max.revision]),
    );

    for (const d of drawings) {
      if (!pdfKeys.has(pdfKey(d.drawingNumber, d.revision)))
        warnings.push({
          type: "missing_pdf",
          drawingId: d.id,
          drawingNumber: d.drawingNumber,
          revision: d.revision,
          message: `Crtež ${d.drawingNumber} rev ${d.revision} nema PDF — proverite pre predaje (PDF ume da kasni za XML-om).`,
        });
      const max = maxByNumber.get(d.drawingNumber);
      if (
        max != null &&
        normalizeRevision(max) !== normalizeRevision(d.revision)
      )
        warnings.push({
          type: "not_latest_revision",
          drawingId: d.id,
          drawingNumber: d.drawingNumber,
          revision: d.revision,
          message: `Crtež ${d.drawingNumber} rev ${d.revision} nije poslednja revizija (poslednja: ${max}).`,
        });
    }
    return warnings;
  }

  /**
   * §6.5.4 pre-check duplikata (P4_SPEC §0 t.4; legacy `viewOdlukePredProvera`
   * + MODULE_SPEC §7.2): za svaku stavku traži RANIJE puštanje istog crteža na
   * ISTOM predmetu — `work_orders` po (projectId + drawingId, fallback
   * drawingNumber jer synced RN-ovi umeju imati drawing_id=0) i stavke drugih
   * nacrta istog predmeta (dva batch upita, bez required JOIN-a — legacy-read
   * pravilo). Pogodak → `pre_check_duplicate=true` + provenance kolone +
   * upozorenje; uz to se tražena količina poredi sa PDM sastavnicom
   * (`drawing_components.required_quantity × pieceCount` za parent iz nacrta)
   * i neslaganje ulazi u razlog. Nabavni crteži (`is_procurement`) su izuzeti
   * — paritet legacy `WHERE ISNULL(pc.Nabavka,0)=0`.
   *
   * `flags` je mapa po INDEKSU stavke u ulaznom nizu (ista stavka može da se
   * ponovi). `excludeDraftId` služi budućem add-item putu (isključi tekući
   * nacrt iz pretrage ranijih stavki).
   */
  private async preCheckItems(
    ctx: {
      projectId: number;
      pieceCount: number;
      mainDrawingId?: number | null;
      excludeDraftId?: number;
    },
    items: CreateHandoverDraftItemInput[],
  ): Promise<{
    flags: Map<
      number,
      { preCheckDraftId: number | null; preCheckWorkOrderId: number | null }
    >;
    warnings: DraftItemWarning[];
  }> {
    const flags = new Map<
      number,
      { preCheckDraftId: number | null; preCheckWorkOrderId: number | null }
    >();
    const warnings: DraftItemWarning[] = [];
    if (!items.length) return { flags, warnings };

    const drawings = await this.prisma.drawing.findMany({
      where: { id: { in: uniqueIds(items.map((i) => i.drawingId)) } },
      select: {
        id: true,
        drawingNumber: true,
        revision: true,
        isProcurement: true,
      },
    });
    const drawingById = byId(drawings);
    const checkDrawings = drawings.filter((d) => !d.isProcurement);
    if (!checkDrawings.length) return { flags, warnings };
    const checkIds = checkDrawings.map((d) => d.id);
    const checkNumbers = [
      ...new Set(checkDrawings.map((d) => d.drawingNumber)),
    ];

    // (1) Raniji RN istog crteža na istom predmetu (legacy: tRN po
    // IDPredmet+IDCrtez). orderBy id desc → prvi pogodak = najnoviji RN.
    const workOrders = await this.prisma.workOrder.findMany({
      where: {
        projectId: ctx.projectId,
        OR: [
          { drawingId: { in: checkIds } },
          { drawingNumber: { in: checkNumbers } },
        ],
      },
      select: { id: true, drawingId: true, drawingNumber: true },
      orderBy: { id: "desc" },
    });

    // (2) Stavke RANIJIH nacrta istog predmeta (isključene stavke ne broje —
    // paritet legacy zbira ISNULL(IskljuciPrimopredaju,0)=0).
    const projectDraftIds = (
      await this.prisma.handoverDraft.findMany({
        where: { projectId: ctx.projectId },
        select: { id: true },
      })
    )
      .map((d) => d.id)
      .filter((id) => id !== ctx.excludeDraftId);
    const priorItems = projectDraftIds.length
      ? await this.prisma.handoverDraftItem.findMany({
          where: {
            draftId: { in: projectDraftIds },
            drawingId: { in: checkIds },
            excludeFromHandover: false,
          },
          select: { id: true, draftId: true, drawingId: true },
          orderBy: { draftId: "desc" },
        })
      : [];

    // (3) PDM sastavnica za poređenje količine: parent = stavkin
    // mainDrawingId, fallback zaglavlje nacrta.
    const parentIds = uniqueIds(
      items.map((i) => i.mainDrawingId ?? ctx.mainDrawingId),
    );
    const bomEdges = parentIds.length
      ? await this.prisma.drawingComponent.findMany({
          where: {
            parentDrawingId: { in: parentIds },
            childDrawingId: { in: checkIds },
          },
          select: {
            parentDrawingId: true,
            childDrawingId: true,
            requiredQuantity: true,
          },
        })
      : [];

    items.forEach((item, idx) => {
      const d = drawingById.get(item.drawingId);
      if (!d || d.isProcurement) return;
      const wo = workOrders.find(
        (w) =>
          w.drawingId === item.drawingId || w.drawingNumber === d.drawingNumber,
      );
      const prior = priorItems.find((p) => p.drawingId === item.drawingId);
      if (!wo && !prior) return;

      flags.set(idx, {
        preCheckDraftId: prior?.draftId ?? null,
        preCheckWorkOrderId: wo?.id ?? null,
      });

      const reasons: string[] = [];
      if (wo) reasons.push(`već pušten na RN #${wo.id} istog predmeta`);
      if (prior) reasons.push(`već u nacrtu #${prior.draftId} istog predmeta`);

      const parentId = item.mainDrawingId ?? ctx.mainDrawingId ?? null;
      const edge =
        parentId !== null
          ? bomEdges.find(
              (e) =>
                e.parentDrawingId === parentId &&
                e.childDrawingId === item.drawingId,
            )
          : undefined;
      if (edge) {
        const expected = edge.requiredQuantity * ctx.pieceCount;
        const requested = item.quantityToProduce ?? 1;
        if (requested !== expected)
          reasons.push(
            `tražena količina ${requested} ≠ količina po PDM sastavnici ${expected} (${edge.requiredQuantity} × ${ctx.pieceCount} kom sklopa)`,
          );
      }

      warnings.push({
        type: "duplicate",
        drawingId: d.id,
        drawingNumber: d.drawingNumber,
        revision: d.revision,
        message: `Sporna stavka — crtež ${d.drawingNumber} rev ${d.revision}: ${reasons.join("; ")}. Potrebna odluka projektanta pre predaje (Isključi / Predaj ponovo / Dopuni).`,
      });
    });

    return { flags, warnings };
  }

  // ----------------------------------------------------- ITEM DECISION §6.5.4

  /**
   * Odluka projektanta nad SPORNOM stavkom (P4_SPEC §0 t.4 + §6.5.4; legacy
   * `OdlukaAkcija`): 1=Isključi (`exclude_from_handover=true`), 2=Predaj
   * ponovo (prihvata duplikat), 3=Dopuni (koriguje `quantity_to_produce` na
   * `newQuantity` — razlika po legacy semantici „dopuni razliku"). Upisuje
   * `decision_action` + `decision_date_time`. Re-odluka je dozvoljena dok
   * nacrt nije zaključan; akcije 2/3 vraćaju ranije isključenu stavku u
   * predaju (`exclude_from_handover=false`).
   */
  async decideItem(draftId: number, itemId: number, dto: DecideDraftItemDto) {
    validateDecideDraftItem(dto);

    const draft = await this.prisma.handoverDraft.findUnique({
      where: { id: draftId },
      select: { id: true, isLocked: true },
    });
    if (!draft) throw new NotFoundException(`Nacrt ${draftId} ne postoji.`);
    if (draft.isLocked)
      throw new UnprocessableEntityException(
        "Nacrt je zaključan (predat) — odluka nad stavkom više nije moguća.",
      );

    const item = await this.prisma.handoverDraftItem.findUnique({
      where: { id: itemId },
      select: { id: true, draftId: true, preCheckDuplicate: true },
    });
    if (!item || item.draftId !== draftId)
      throw new NotFoundException(
        `Stavka ${itemId} ne postoji na nacrtu ${draftId}.`,
      );
    if (!item.preCheckDuplicate)
      throw new UnprocessableEntityException(
        "Stavka nije sporna (nema pre-check duplikata) — odluka nije primenljiva (§6.5.4).",
      );

    const data: Prisma.HandoverDraftItemUncheckedUpdateInput = {
      decisionAction: dto.action,
      decisionDateTime: new Date(),
      excludeFromHandover: dto.action === DRAFT_ITEM_DECISION.EXCLUDE,
    };
    if (dto.action === DRAFT_ITEM_DECISION.ADJUST)
      data.quantityToProduce = dto.newQuantity;

    const updated = await this.prisma.handoverDraftItem.update({
      where: { id: itemId },
      data,
    });

    const drawings = await this.resolveDrawingsByIds(
      uniqueIds([updated.drawingId, updated.mainDrawingId]),
    );
    return {
      data: {
        ...updated,
        drawing: drawings.get(updated.drawingId) ?? null,
        mainDrawing: updated.mainDrawingId
          ? (drawings.get(updated.mainDrawingId) ?? null)
          : null,
      },
    };
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
      select: {
        id: true,
        drawingId: true,
        preCheckDuplicate: true,
        decisionAction: true,
      },
      orderBy: { id: "asc" },
    });
    if (!items.length)
      throw new UnprocessableEntityException("Nacrt nema stavki za predaju.");

    // §6.5.4 gate (P4_SPEC §0 t.4; legacy: dugme „Predaj" blokirano dok
    // postoji nerešena sporna stavka): pre_check_duplicate bez odluke → 422.
    // Isključene stavke (odluka 1) su već van `excludeFromHandover` filtera.
    const undecided = items.filter(
      (i) =>
        i.preCheckDuplicate && i.decisionAction === DRAFT_ITEM_DECISION.NONE,
    );
    if (undecided.length)
      throw new UnprocessableEntityException(
        `Nacrt ima sporne stavke bez odluke projektanta (stavke: ${undecided
          .map((i) => i.id)
          .join(
            ", ",
          )}) — pre predaje izaberite odluku: Isključi (1), Predaj ponovo (2) ili Dopuni (3).`,
      );

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

      // `drawing_handovers.id` mora preskočiti i LEGACY reference: sync upisuje
      // u `work_orders.drawing_handover_id` ID NACRTA iz tRN (opseg 1..~3446,
      // memorija/spec §5.3 — remapuje se tek cutover backfill-om). Native
      // primopredaja sa id-jem u tom opsegu bi se „zakačila" za tuđe legacy
      // RN-ove (prepare/launch nađu strani RN → 409 ili pogrešan reuse) —
      // nađeno E2E probom 13.07.2026. Zato pod = GREATEST(MAX(id) tabele,
      // MAX(legacy referenci), 9999): native redovi žive od 10000 naviše dok
      // cutover ne razreši semantiku. Običan alignIdSequence NIJE dovoljan —
      // na praznoj tabeli resetuje sekvencu na 1.
      await tx.$executeRaw`SELECT setval(pg_get_serial_sequence('drawing_handovers','id'),
        GREATEST(
          COALESCE((SELECT MAX(id) FROM drawing_handovers), 0),
          COALESCE((SELECT MAX(drawing_handover_id) FROM work_orders), 0),
          9999
        ), true)`;

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

    // D8 emit 2 (PLAN_dorade §D8): nova primopredaja → in-app notifikacija grupi
    // TEHNOLOG. POSLE uspešne transakcije, best-effort — helper je ceo u try/catch,
    // pad notifikacije NE obara predaju nacrta.
    await this.notifySubmitted(draft, handovers.length);

    return { data: { draft, handoversCreated: handovers.length, handovers } };
  }

  /**
   * D8 emit 2: „Kreirana nova primopredaja {draftNumber} — {N} stavki
   * (projektant {ime})" → grupa TEHNOLOG (aktivni radnici vrste 'Tehnolog').
   * Best-effort: svaka greška se loguje i guta — submit() je već uspeo.
   */
  private async notifySubmitted(
    draft: {
      id: number;
      draftNumber: string;
      designerId: number;
      designer: { fullName: string | null; username: string } | null;
    },
    itemCount: number,
  ): Promise<void> {
    try {
      const technologists =
        await this.notifications.resolveTechnologistWorkerIds();
      const designerName =
        draft.designer?.fullName ||
        draft.designer?.username ||
        `#${draft.designerId}`;
      const created = await this.notifications.notifyWorkers(technologists, {
        type: "primopredaja.nova",
        message: `Kreirana nova primopredaja ${draft.draftNumber} — ${itemCount} stavki (projektant ${designerName})`,
        refTable: "handover_drafts",
        refId: draft.id,
      });
      this.logger.log(
        `D8 notifikacija primopredaja.nova (${draft.draftNumber}): ${created} primalaca`,
      );
    } catch (e) {
      this.logger.error(
        `D8 notifikacija FAIL (nacrt ${draft.id}): ${(e as Error).message}`,
      );
    }
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
