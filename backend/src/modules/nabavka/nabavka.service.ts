import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { PurchaseNumberingService } from "./purchase-numbering.service";
import { RfqPdfService } from "./rfq-pdf.service";
import { RobnoService } from "../robno/robno.service";
import { CalculationService } from "../robno/calculation.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreatePurchaseRequestDto,
  validateCreatePurchaseRequest,
} from "./dto/create-purchase-request.dto";
import {
  type CreatePurchaseOrderDto,
  validateCreatePurchaseOrder,
} from "./dto/create-purchase-order.dto";
import { type AcceptQuoteDto, validateAcceptQuote } from "./dto/accept-quote.dto";

/**
 * NACRT — servis modula Nabavka (Traka B §B). Status-mašina:
 *   zahtev(DRAFT→SUBMITTED→APPROVED) → upit(SENT) → ponuda(QUOTED)
 *     → narudžbenica(ORDERED→SIGNED→LOCKED) → prijem(RECEIVED) → faktura(Faza 5)
 *
 * Ključne poslovne odluke (doc 24):
 *   • projectId je kičma — NOT NULL na zahtevu
 *   • KreirajUpit flag na stavci → ide u auto-mail upit dobavljaču
 *   • cena tek u narudžbenici (ne u upitu)
 *   • prijem: receivedQuantity default = orderedQuantity; 3-way match anti-duplo guard
 *   • auto-mail RFQ preko MailService (Resend) — slanje NE obara radnju (DRY-RUN bez ključa)
 *
 * .nacrt = van build-a dok modeli nisu u schema.prisma. Poslovne greške = NestJS
 * ugrađeni exception-i (404/409/422), kao ostatak repoa (nema još BusinessException).
 */
@Injectable()
export class NabavkaService {
  private readonly logger = new Logger(NabavkaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly numbering: PurchaseNumberingService,
    private readonly robno: RobnoService,
    private readonly calculation: CalculationService,
    private readonly posting: PostingEngineService,
    private readonly rfqPdf: RfqPdfService,
  ) {}

  // ── ZAHTEV ────────────────────────────────────────────────────────────────

  /** Kreiraj zahtev za nabavku + stavke; broj NNNN/god generiše server. */
  async createRequest(dto: CreatePurchaseRequestDto, actor: AuthUser) {
    validateCreatePurchaseRequest(dto);

    // Predmet mora postojati (meki ref — validacija u servisu, nema DB FK).
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
      select: { id: true, projectNumber: true },
    });
    if (!project)
      throw new NotFoundException(`Predmet ${dto.projectId} ne postoji.`);

    return this.prisma.$transaction(async (tx) => {
      const requestNumber = await this.numbering.nextYearlyRequest(tx);
      return tx.purchaseRequest.create({
        data: {
          requestNumber,
          projectId: dto.projectId,
          workOrderId: dto.workOrderId ?? null,
          initiatorUserId: actor.userId,
          createdByUserId: actor.userId,
          status: "DRAFT",
          note: dto.note ?? null,
          items: {
            create: dto.items.map((it, idx) => ({
              articleId: it.articleId ?? null,
              description: it.description ?? null,
              quantity: it.quantity,
              unit: it.unit ?? null,
              createRfq: it.createRfq ?? false,
              suggestedSupplierId: it.suggestedSupplierId ?? null,
              lineNo: idx + 1,
            })),
          },
        },
        include: { items: true },
      });
    });
  }

  /** DRAFT → SUBMITTED (inženjer šalje na odobrenje nabavci). */
  async submitRequest(id: number, actor: AuthUser) {
    const req = await this.getRequestOrThrow(id);
    this.assertStatus(req.status, ["DRAFT"], "predaju");
    return this.prisma.purchaseRequest.update({
      where: { id },
      data: { status: "SUBMITTED", updatedByUserId: actor.userId },
    });
  }

  /** SUBMITTED → APPROVED (nabavka odobrava — operativni tok, Nenad). */
  async approveRequest(id: number, actor: AuthUser) {
    const req = await this.getRequestOrThrow(id);
    this.assertStatus(req.status, ["SUBMITTED"], "odobravanje");
    return this.prisma.purchaseRequest.update({
      where: { id },
      data: { status: "APPROVED", updatedByUserId: actor.userId },
    });
  }

  // ── UPIT DOBAVLJAČU (RFQ) + AUTO-MAIL ──────────────────────────────────────

  /**
   * Napravi upit dobavljaču iz odobrenog zahteva (samo stavke sa createRfq=true),
   * pošalji ga auto-mailom (PDF/HTML preko Resend) i zabeleži sentAt.
   * Quick-win MVP: zahtev → auto-mail RFQ (najveća vrednost, ne zavisi od GL).
   */
  async createAndSendRfq(
    requestId: number,
    supplierId: number,
    supplierEmail: string,
    actor: AuthUser,
  ) {
    const req = await this.prisma.purchaseRequest.findUnique({
      where: { id: requestId },
      include: { items: { where: { createRfq: true } } },
    });
    if (!req)
      throw new NotFoundException(`Zahtev ${requestId} ne postoji.`);
    if (req.status !== "APPROVED")
      throw new UnprocessableEntityException(
        "Upit se šalje samo iz odobrenog zahteva.",
      );
    if (req.items.length === 0)
      throw new UnprocessableEntityException(
        "Nema stavki označenih za upit (KreirajUpit).",
      );

    const project = await this.prisma.project.findUnique({
      where: { id: req.projectId },
      select: { projectNumber: true },
    });

    // 1) upit + stavke u transakciji (broj = predmet-N)
    const rfq = await this.prisma.$transaction(async (tx) => {
      const rfqNumber = await this.numbering.nextRfqForProject(
        tx,
        project?.projectNumber ?? String(req.projectId),
      );
      return tx.supplierRfq.create({
        data: {
          rfqNumber,
          requestId: req.id,
          supplierId,
          status: "DRAFT",
          createdByUserId: actor.userId,
          items: {
            create: req.items.map((it, idx) => ({
              requestItemId: it.id,
              articleId: it.articleId,
              description: it.description,
              quantity: it.quantity,
              unit: it.unit,
              lineNo: idx + 1,
            })),
          },
        },
        include: { items: true },
      });
    });

    // 2a) PDF prilog upita (upit-za-ponudu-<broj>.pdf). PDF NIJE obavezan — ako
    //     render padne, mejl svejedno ide sa istim HTML-om (bez priloga). Isti
    //     obrazac odbrane kao slanje: prilog ne sme da obori poslovnu radnju.
    let attachments:
      | Array<{ filename: string; content: Buffer }>
      | undefined;
    try {
      const { buffer, fileName } = await this.rfqPdf.buildRfqPdf(rfq.id);
      attachments = [{ filename: fileName, content: buffer }];
    } catch (e) {
      this.logger.error(
        `PDF upita ${rfq.rfqNumber} nije generisan (šaljem mejl bez priloga): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // 2b) auto-mail — NIKAD ne obara radnju (MailService ne baca; DRY-RUN bez ključa)
    const sent = await this.mail.send({
      to: supplierEmail,
      subject: `Upit za ponudu ${rfq.rfqNumber} — Servoteh`,
      html: this.buildRfqEmailHtml(rfq),
      ...(attachments ? { attachments } : {}),
    });

    // 3) log slanja (Poslato → sentAt); status SENT samo ako je stvarno poslato
    await this.prisma.supplierRfq.update({
      where: { id: rfq.id },
      data: sent
        ? { status: "SENT", sentAt: new Date() }
        : { status: "DRAFT" }, // DRY-RUN/greška: ostaje DRAFT, može ručno ponovo
    });

    return { rfq, emailSent: sent };
  }

  // ── UPIT DOBAVLJAČU: LISTE / DETALJ / PRIHVATANJE PONUDE ────────────────────

  /**
   * Lista upita dobavljačima (BigBit „Pregled upita") — poslati/prihvaćeni upiti.
   * Filteri: status (DRAFT/SENT/QUOTED/CLOSED) i dobavljač; server-side paginacija.
   * Naziv dobavljača (meki ref na šifarnik komitenata) se dorešava batch-om.
   */
  async listRfqs(params: {
    status?: string;
    supplierId?: number;
    skip?: number;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.supplierId != null) where.supplierId = params.supplierId;

    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.supplierRfq.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.supplierRfq.count({ where }),
    ]);

    // Naziv dobavljača — meki ref (bez required-relation JOIN-a); batch resolve.
    const supplierIds = [...new Set(rows.map((r) => r.supplierId))];
    const suppliers = supplierIds.length
      ? await this.prisma.customer.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : [];
    const nameById = new Map(suppliers.map((s) => [s.id, s.name]));

    return {
      data: rows.map((r) => ({
        ...r,
        supplierName: nameById.get(r.supplierId) ?? null,
      })),
      meta: { total, skip, take },
    };
  }

  /** Detalj upita (zaglavlje + stavke + naziv dobavljača, meki ref). Envelope { data }. */
  async getRfq(id: number) {
    const rfq = await this.prisma.supplierRfq.findUnique({
      where: { id },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!rfq) throw new NotFoundException(`Upit ${id} ne postoji.`);

    const supplier = await this.prisma.customer.findUnique({
      where: { id: rfq.supplierId },
      select: { id: true, name: true, city: true, taxId: true },
    });

    return { data: { ...rfq, supplier } };
  }

  /**
   * Prihvati ponudu po upitu: upiši rok isporuke i označi stavke prihvaćenim
   * (`isAccepted`), a upit → QUOTED. Cena se NE drži na upitu (šema `SupplierRfqItem`
   * je nema — BigBit pravilo: cena tek u narudžbenici) — ponuđena cena se vraća u
   * `createOrderDraft` spremnom za postojeći `createOrder` tok (offeredPrice →
   * unitPrice). Prihvatanje NE kreira narudžbenicu automatski. Ponovno prihvatanje
   * (QUOTED/CLOSED) → 409.
   */
  async acceptQuote(rfqId: number, dto: AcceptQuoteDto, actor: AuthUser) {
    validateAcceptQuote(dto);

    const rfq = await this.prisma.supplierRfq.findUnique({
      where: { id: rfqId },
      include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
    });
    if (!rfq) throw new NotFoundException(`Upit ${rfqId} ne postoji.`);
    if (rfq.status === "QUOTED" || rfq.status === "CLOSED")
      throw new ConflictException("Ponuda za ovaj upit je već prihvaćena.");
    if (rfq.items.length === 0)
      throw new UnprocessableEntityException(
        "Upit nema stavki za prihvatanje.",
      );

    // Ulaz po stavci (rfqItemId ili itemId alias) → rok + cena.
    const leadByItemId = new Map<number, number>();
    const priceByItemId = new Map<number, number>();
    for (const l of dto.items ?? []) {
      const key = l.rfqItemId ?? l.itemId;
      if (key == null) continue;
      if (l.offeredLeadTimeDays != null)
        leadByItemId.set(key, l.offeredLeadTimeDays);
      if (l.offeredPrice != null) priceByItemId.set(key, l.offeredPrice);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const item of rfq.items) {
        const lead = leadByItemId.get(item.id);
        await tx.supplierRfqItem.update({
          where: { id: item.id },
          data: {
            isAccepted: true,
            ...(lead != null ? { offeredLeadTimeDays: lead } : {}),
          },
        });
      }
      return tx.supplierRfq.update({
        where: { id: rfqId },
        data: { status: "QUOTED", updatedByUserId: actor.userId },
        include: { items: { orderBy: [{ lineNo: "asc" }, { id: "asc" }] } },
      });
    });

    // Predmet nasleđen iz zahteva (meki ref) — prefill narudžbenice.
    let projectId: number | null = null;
    if (rfq.requestId != null) {
      const req = await this.prisma.purchaseRequest.findUnique({
        where: { id: rfq.requestId },
        select: { projectId: true },
      });
      projectId = req?.projectId ?? null;
    }

    // createOrderDraft — spreman za postojeći createOrder tok (cena → unitPrice).
    const createOrderDraft: CreatePurchaseOrderDto = {
      supplierId: rfq.supplierId,
      rfqId: rfq.id,
      projectId,
      currency: "RSD",
      note: null,
      items: updated.items.map((it) => ({
        articleId: it.articleId ?? null,
        description: it.description ?? null,
        orderedQuantity: Number(it.quantity),
        unitPrice: priceByItemId.get(it.id) ?? null,
        unit: it.unit ?? null,
        rfqItemId: it.id,
        requestItemId: it.requestItemId ?? null,
      })),
    };

    return { data: { rfq: updated, createOrderDraft } };
  }

  // ── NARUDŽBENICA (kreiranje + status) ──────────────────────────────────────

  /**
   * Kreiraj narudžbenicu (BigBit „Naručivanje robe"): broj NNNN/god, status ORDERED
   * (kreiranje = poručeno), stavke sa cenom (unitPrice tek ovde). Iz upita (rfqId) ili
   * direktno. Dobavljač je meki ref — validacija postojanja u kešu komitenata.
   */
  async createOrder(dto: CreatePurchaseOrderDto, actor: AuthUser) {
    validateCreatePurchaseOrder(dto);

    const supplier = await this.prisma.customer.findUnique({
      where: { id: dto.supplierId },
      select: { id: true },
    });
    if (!supplier)
      throw new NotFoundException(`Dobavljač ${dto.supplierId} ne postoji.`);

    return this.prisma.$transaction(async (tx) => {
      const orderNumber = await this.numbering.nextYearlyOrder(tx);
      return tx.purchaseOrder.create({
        data: {
          orderNumber,
          rfqId: dto.rfqId ?? null,
          supplierId: dto.supplierId,
          projectId: dto.projectId ?? null,
          status: "ORDERED",
          orderedAt: new Date(),
          currency: dto.currency ?? "RSD",
          note: dto.note ?? null,
          createdByUserId: actor.userId,
          items: {
            create: dto.items.map((it, idx) => ({
              articleId: it.articleId ?? null,
              description: it.description ?? null,
              orderedQuantity: it.orderedQuantity,
              unitPrice: it.unitPrice ?? null,
              unit: it.unit ?? null,
              rfqItemId: it.rfqItemId ?? null,
              requestItemId: it.requestItemId ?? null,
              lineNo: idx + 1,
            })),
          },
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
    });
  }

  /** ORDERED → SIGNED (odobrena/potpisana narudžbenica). */
  async markOrderSigned(orderId: number, actor: AuthUser) {
    const order = await this.getOrderOrThrow(orderId);
    this.assertOrderStatus(order.status, ["ORDERED"], "potpisivanje");
    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: { status: "SIGNED", updatedByUserId: actor.userId },
    });
  }

  /** SIGNED → LOCKED (zaključana narudžbenica — sprečava izmene pre prijema). */
  async markOrderLocked(orderId: number, actor: AuthUser) {
    const order = await this.getOrderOrThrow(orderId);
    this.assertOrderStatus(order.status, ["SIGNED", "ORDERED"], "zaključavanje");
    return this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: { status: "LOCKED", updatedByUserId: actor.userId },
    });
  }

  /** Lista narudžbenica (pregled + filteri) — BigBit „Pregled trebovanja". */
  async listOrders(params: {
    status?: string;
    supplierId?: number;
    skip?: number;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.supplierId != null) where.supplierId = params.supplierId;

    const take = Math.min(params.take ?? 50, 200);
    const skip = params.skip ?? 0;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return { data: rows, meta: { total, skip, take } };
  }

  async getOrder(orderId: number) {
    return this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
  }

  private async getOrderOrThrow(orderId: number) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    });
    if (!order)
      throw new NotFoundException(`Narudžbenica ${orderId} ne postoji.`);
    return order;
  }

  private assertOrderStatus(
    current: string,
    allowed: string[],
    action: string,
  ): void {
    if (!allowed.includes(current))
      throw new ConflictException(
        `Narudžbenica je u statusu ${current}; ${action} je moguće samo iz ${allowed.join("/")}.`,
      );
  }

  // ── NARUDŽBENICA + PRIJEM (3-way match) ────────────────────────────────────

  /**
   * Prijem robe: receivedQuantity default = orderedQuantity (BigBit IsporucenaKolicina).
   * 3-way match anti-duplo: prijem se knjiži jednom po stavci (guard rfqItemId veza),
   * a veza sa robnim ulazom (Faza 3) i ulaznom fakturom (Faza 5) je meki ref.
   */
  async receiveOrder(
    orderId: number,
    lines: Array<{ itemId: number; receivedQuantity?: number }>,
    actor: AuthUser,
    opts?: { warehouseId?: number; documentTypeCode?: string; post?: boolean },
  ) {
    const order = await this.prisma.purchaseOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order)
      throw new NotFoundException(`Narudžbenica ${orderId} ne postoji.`);
    if (order.status === "RECEIVED" || order.status === "CLOSED")
      throw new ConflictException("Narudžbenica je već primljena/zatvorena.");
    if (!["ORDERED", "SIGNED", "LOCKED"].includes(order.status))
      throw new UnprocessableEntityException(
        "Prijem je moguć tek kada je narudžbenica poručena.",
      );

    // Anti-duplo (3-way match, BigBit „IDStavkeTrebovanja Is Null"): jedna narudžbenica
    // sme da napravi najviše JEDAN robni ulaz. Ako već postoji StockDocument sa ovim
    // purchaseOrderId — prijem je već izveden, odbij ponovno knjiženje.
    const existingInbound = await this.prisma.stockDocument.findFirst({
      where: { purchaseOrderId: orderId },
      select: { id: true, documentNumber: true },
    });
    if (existingInbound)
      throw new ConflictException(
        `Robni ulaz ${existingInbound.documentNumber} je već napravljen za ovu narudžbenicu.`,
      );

    // 1) Upiši primljene količine (BEZ statusa RECEIVED). Status se postavlja TEK na kraju,
    // posle uspešnog robnog ulaza + knjiženja (review VISOK — inače PO ostaje trajno
    // „primljen" bez ulaza ako korak 2/3 padne, a prijem se ne može ponoviti).
    const byId = new Map(lines.map((l) => [l.itemId, l]));
    await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        const line = byId.get(item.id);
        // default = naručena količina (BigBit); eksplicitno prosleđena ima prednost
        const qty = line?.receivedQuantity ?? Number(item.orderedQuantity);
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQuantity: qty },
        });
      }
    });

    // 2) Napravi robni ulaz (Faza 3) iz primljenih stavki (receivedQuantity > 0).
    //    Cena iz narudžbenice (unitPrice = fakturna). Magacin: eksplicitan ili default 1.
    const received = await this.prisma.purchaseOrderItem.findMany({
      where: { orderId, receivedQuantity: { gt: 0 }, articleId: { not: null } },
    });
    if (received.length === 0) {
      // Nema robnih stavki za ulaz — svejedno zaključi prijem (usluge/bez artikla).
      await this.prisma.purchaseOrder.update({
        where: { id: orderId },
        data: { status: "RECEIVED", updatedByUserId: actor.userId },
      });
      return { order: { id: orderId, status: "RECEIVED" }, stockDocument: null };
    }
    const warehouseId = opts?.warehouseId ?? 1;
    const documentTypeCode = opts?.documentTypeCode ?? "UFROB";
    const inboundRes = await this.robno.createStockDocument("UL", {
      documentTypeCode,
      warehouseId,
      supplierId: order.supplierId,
      purchaseOrderId: orderId,
      projectId: order.projectId ?? undefined,
      createdByUserId: actor.userId,
      items: received.map((it, idx) => ({
        itemId: it.articleId as number,
        warehouseId,
        quantity: Number(it.receivedQuantity),
        invoicePrice: it.unitPrice != null ? Number(it.unitPrice) : 0,
        lineNo: idx + 1,
      })),
    });
    const stockDoc = (inboundRes as { data?: { id: number } }).data ?? inboundRes;
    const stockDocId = (stockDoc as { id: number }).id;

    // 3) Kalkulacija (landed) → okida nivelaciju. Zatim (opciono) knjiženje u GK.
    await this.calculation.calculate(stockDocId);
    let journalEntry: unknown = null;
    if (opts?.post !== false) {
      // postFromStockDocument je idempotentan (guard po sourceGoodsDocId) — bezbedno.
      journalEntry = await this.posting.postFromStockDocument(stockDocId);
    }

    // 4) TEK SADA (posle uspešnog ulaza + kalkulacije + knjiženja) → RECEIVED. Ako je bilo
    // šta gore palo, PO ostaje ORDERED/SIGNED i prijem se može ponoviti (anti-duplo guard
    // + uq_stock_documents_po sprečavaju dupli ulaz ako je prvi uspeo).
    await this.prisma.purchaseOrder.update({
      where: { id: orderId },
      data: { status: "RECEIVED", updatedByUserId: actor.userId },
    });

    return {
      order: { id: orderId, status: "RECEIVED" },
      stockDocument: stockDoc,
      posted: journalEntry != null,
    };
  }

  // ── LISTE (radna lista nabavke) ────────────────────────────────────────────

  async listRequests(query: {
    status?: string;
    projectId?: number;
    skip?: number;
    take?: number;
  }) {
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.projectId ? { projectId: query.projectId } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.purchaseRequest.findMany({
        where,
        include: { items: true },
        orderBy: { createdAt: "desc" },
        skip: query.skip ?? 0,
        take: query.take ?? 50,
      }),
      this.prisma.purchaseRequest.count({ where }),
    ]);
    return { data, meta: { total } };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async getRequestOrThrow(id: number) {
    const req = await this.prisma.purchaseRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException(`Zahtev ${id} ne postoji.`);
    return req;
  }

  private assertStatus(current: string, allowed: string[], action: string) {
    if (!allowed.includes(current))
      throw new UnprocessableEntityException(
        `Nedozvoljen status "${current}" za ${action} (očekivano: ${allowed.join(", ")}).`,
      );
  }

  private buildRfqEmailHtml(rfq: {
    rfqNumber: string;
    items: Array<{ description: string | null; quantity: unknown; unit: string | null }>;
  }): string {
    const rows = rfq.items
      .map(
        (it) =>
          `<tr><td>${it.description ?? ""}</td><td style="text-align:right">${String(
            it.quantity,
          )} ${it.unit ?? ""}</td></tr>`,
      )
      .join("");
    return `
      <p>Poštovani,</p>
      <p>molimo Vas za ponudu po upitu <strong>${rfq.rfqNumber}</strong>:</p>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Stavka</th><th>Količina</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p>Hvala,<br/>Servoteh — nabavka</p>`;
  }
}
