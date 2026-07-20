import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { MailService } from "../../../common/mail/mail.service";
import {
  InvoicePdfService,
  type InvoicePrintVariant,
} from "./invoice-pdf.service";

/**
 * Slanje PDF fakture kupcu mejlom (Faza 5 §C — zamena BigBit OSSMTP).
 *
 * Tok: generiši PDF (`InvoicePdfService`) → priloži ga uz Resend mejl
 * (`MailService.send` sa `attachments`). `MailService` nikad ne baca i vraća
 * boolean uspeha (DRY-RUN kad `RESEND_API_KEY` fali) — slanje NE sme da obori
 * poslovnu radnju (isto pravilo kao notifikacije).
 *
 * Primalac: eksplicitni `toEmail` ILI, kad se ne prosledi, `customers.email`
 * računa; bez ijedne adrese → `NotFoundException` (poziv je namerno tražio
 * slanje, pa je odsustvo adrese greška ulaza, ne tiho preskakanje).
 */
@Injectable()
export class InvoiceMailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly invoicePdf: InvoicePdfService,
  ) {}

  /**
   * Pošalji fakturu `invoiceId` na `toEmail` (ili na email kupca ako `toEmail`
   * nije dat) sa PDF prilogom. Vraća `{ sent, to, fileName }` — `sent=false` je
   * DRY-RUN ili neuspeh slanja (ne baca; PDF je svakako generisan).
   *
   * `variant` bira šablon PDF-a (default = po dokumentu: izvoz → ino faktura).
   */
  async sendInvoice(
    invoiceId: number,
    toEmail?: string,
    variant?: InvoicePrintVariant,
  ): Promise<{ sent: boolean; to: string; fileName: string }> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        documentNumber: true,
        documentType: true,
        customerId: true,
        isExport: true,
      },
    });
    if (!invoice) throw new NotFoundException(`Račun ${invoiceId} ne postoji.`);

    const recipient = (toEmail ?? "").trim() || (await this.customerEmail(invoice.customerId));
    if (!recipient)
      throw new NotFoundException(
        `Nije prosleđena adresa, a kupac računa ${invoiceId} nema email — nema kome da se pošalje.`,
      );

    const { buffer, fileName } = await this.invoicePdf.buildInvoicePdf(
      invoiceId,
      variant,
    );

    const english = invoice.isExport;
    const subject = english
      ? `Invoice ${invoice.documentNumber}`
      : `Račun ${invoice.documentNumber}`;
    const html = english
      ? `<p>Dear customer,</p><p>Please find attached invoice <strong>${escapeHtml(
          invoice.documentNumber,
        )}</strong>.</p><p>Best regards,<br/>Servoteh</p>`
      : `<p>Poštovani,</p><p>U prilogu Vam dostavljamo račun <strong>${escapeHtml(
          invoice.documentNumber,
        )}</strong>.</p><p>Srdačan pozdrav,<br/>Servoteh</p>`;

    const sent = await this.mail.send({
      to: recipient,
      subject,
      html,
      attachments: [{ filename: fileName, content: buffer }],
    });

    return { sent, to: recipient, fileName };
  }

  /** Email kupca (`customers.email`) — prazan string kad kupac/email fali. */
  private async customerEmail(customerId: number | null): Promise<string> {
    if (customerId == null || customerId <= 0) return "";
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { email: true },
    });
    return customer?.email?.trim() ?? "";
  }
}

/** Minimalni HTML escape za ubacivanje broja dokumenta u telo mejla. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
