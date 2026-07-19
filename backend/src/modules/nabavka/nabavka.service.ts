import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { MailService } from "../../common/mail/mail.service";
import { PurchaseNumberingService } from "./purchase-numbering.service";
import type { AuthUser } from "../auth/jwt.strategy";
import {
  type CreatePurchaseRequestDto,
  validateCreatePurchaseRequest,
} from "./dto/create-purchase-request.dto";

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly numbering: PurchaseNumberingService,
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

    // 2) auto-mail — NIKAD ne obara radnju (MailService ne baca; DRY-RUN bez ključa)
    const sent = await this.mail.send({
      to: supplierEmail,
      subject: `Upit za ponudu ${rfq.rfqNumber} — Servoteh`,
      html: this.buildRfqEmailHtml(rfq),
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

    const byId = new Map(lines.map((l) => [l.itemId, l]));
    return this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        const line = byId.get(item.id);
        // default = naručena količina (BigBit); eksplicitno prosleđena ima prednost
        const qty = line?.receivedQuantity ?? Number(item.orderedQuantity);
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { receivedQuantity: qty },
        });
      }
      return tx.purchaseOrder.update({
        where: { id: orderId },
        data: { status: "RECEIVED", updatedByUserId: actor.userId },
      });
    });
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
