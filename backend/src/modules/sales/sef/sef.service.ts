import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma, type SefOutbox } from "@prisma/client";

/** Red outbox liste — bez velikih tela (ublXml, pdfAttachmentBase64). */
export type SefOutboxListItem = Omit<SefOutbox, "ublXml" | "pdfAttachmentBase64">;
import { PrismaService } from "../../../prisma/prisma.service";
import { InvoicePdfService } from "../print/invoice-pdf.service";
import { SefClientService } from "./sef-client.service";
import {
  UblBuilderService,
  type UblCustomerParty,
  type UblInvoiceItemInput,
  type UblSupplierParty,
} from "./ubl-builder.service";

/**
 * SEF ORCHESTRATOR — životni ciklus izlazne e-fakture (doc 07 §8.5).
 * ==================================================================
 * Vezuje `Invoice` (Faza 5 §A), `UblBuilderService` (XML) i `SefClientService`
 * (mreža) u tok: enqueue → send → refreshStatus → cancel. Status i greške
 * perzistuje na `SefOutbox` (nikad ne obara poslovnu radnju na mrežnu grešku).
 *
 * IDEMPOTENCIJA: `requestId = crypto.randomUUID()` po outbox redu; SEF
 * deduplira slanje po njemu (`@@unique(requestId)` u šemi štiti od duplog reda).
 *
 * IZVOZ: `Invoice.isExport = true` NIJE na domaćem SEF-u (ExportInvoicePolicy) —
 * enqueue odbija izvoznu fakturu (BadRequest).
 *
 * STATUS MAPIRANJE (SEF → SefOutbox.status):
 *   Draft/New            → PENDING
 *   Sent/Seen/Approved…  → SENT/DELIVERED
 *   Rejected/Mistake     → REJECTED
 *   Cancelled/Storno     → CANCELLED
 */

/** SEF statusi nad kojima cancel/storno NIJE dozvoljen (guard). */
const CANCELLABLE_LOCAL_STATUSES = new Set(["PENDING", "SENT", "DELIVERED"]);

/** SEF limit priloga (25 MB) — veći PDF se preskače (prilog nije obavezan). */
const MAX_PDF_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Rezultat enqueue-a: outbox red + eventualno (ne-blokirajuće) upozorenje. */
export interface EnqueueResult {
  outbox: SefOutbox;
  warning: string | null;
}

@Injectable()
export class SefService {
  private readonly logger = new Logger(SefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SefClientService,
    private readonly ubl: UblBuilderService,
    private readonly invoicePdf: InvoicePdfService,
  ) {}

  /**
   * Kreiraj SefOutbox red za fakturu: gradi UBL (sa PDF prilogom + OrderReference),
   * upisuje PENDING + requestId. Ne šalje (to je `send`). Odbija izvoz (nije na
   * domaćem SEF-u) i draft (level != 0 / status DRAFT — samo knjižena faktura ide
   * na SEF). Vraća `{ outbox, warning }` — warning je ne-blokirajuće upozorenje
   * (npr. javni sektor bez broja narudžbenice), ne baca izuzetak.
   */
  async enqueue(invoiceId: number, userId?: number): Promise<EnqueueResult> {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { items: { orderBy: { lineNo: "asc" } } },
    });
    if (!invoice) throw new NotFoundException(`Faktura ${invoiceId} ne postoji.`);

    if (invoice.isExport) {
      throw new BadRequestException(
        "Izvozna faktura ne ide na domaći SEF (ExportInvoicePolicy).",
      );
    }
    if (invoice.level !== 0 || invoice.status === "DRAFT") {
      throw new BadRequestException(
        "Samo knjižena faktura (level 0) sme na SEF — dokument je još draft/predračun.",
      );
    }

    // Firma-izdavalac + kupac za UBL strane.
    const company = await this.prisma.company.findUnique({
      where: { id: invoice.companyId },
    });
    if (!company) {
      throw new BadRequestException(
        `Firma (companyId=${invoice.companyId}) nije nađena — nema izdavaoca za UBL.`,
      );
    }
    const customer = invoice.customerId
      ? await this.prisma.customer.findUnique({
          where: { id: invoice.customerId },
        })
      : null;
    if (!customer) {
      throw new BadRequestException(
        "Faktura nema kupca (customerId) — SEF zahteva primaoca.",
      );
    }

    const supplier: UblSupplierParty = {
      name: company.companyName,
      taxId: company.taxId ?? "",
      registrationNumber: company.registrationNumber,
      address: company.address,
      city: company.city,
      bankAccount: company.bankAccount,
    };
    const buyer: UblCustomerParty = {
      name: customer.name,
      taxId: customer.taxId,
      registrationNumber: customer.registrationNumber,
      address: customer.address,
      city: customer.city,
      publicSectorId: customer.publicSectorId,
    };

    const items: UblInvoiceItemInput[] = invoice.items.map((it) => ({
      lineNo: it.lineNo,
      description: it.description,
      itemId: it.itemId,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      discountPercent: it.discountPercent,
      vatRateCode: it.vatRateCode, // A5: stopa/kategorija po liniji (TaxSubtotal granularnost)
      vatBase: it.vatBase,
      vatAmount: it.vatAmount,
      lineTotal: it.lineTotal,
    }));

    // — D7: PDF prilog fakture kroz postojeći InvoicePdfService (cac:Attachment) —
    // Generisanje/veličina priloga NE ruši enqueue: PDF prilog je opciona pogodnost.
    let pdfBase64: string | null = null;
    let pdfFileName: string | null = null;
    try {
      const { buffer, fileName } = await this.invoicePdf.buildInvoicePdf(
        invoice.id,
      );
      if (buffer.length > MAX_PDF_ATTACHMENT_BYTES) {
        this.logger.warn(
          `PDF prilog fakture ${invoice.id} (${buffer.length} B) prelazi SEF limit ` +
            `(${MAX_PDF_ATTACHMENT_BYTES} B) — prilog se preskače.`,
        );
      } else {
        pdfBase64 = buffer.toString("base64");
        pdfFileName = fileName;
      }
    } catch (err) {
      this.logger.warn(
        `Generisanje PDF priloga za fakturu ${invoice.id} nije uspelo — ` +
          `enqueue se nastavlja bez priloga: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
    }

    // — Batch C §C1a: konačni račun na kome je odbijen avans nosi referencu AVR-a
    //   (cac:BillingReference) + PrepaidAmount, pa SEF PayableAmount pokazuje
    //   STVARNI ostatak za uplatu (grossTotal − avans), a ne uvek 0.
    const advanceInvoice =
      invoice.advanceInvoiceId != null
        ? await this.prisma.invoice.findUnique({
            where: { id: invoice.advanceInvoiceId },
            select: { documentNumber: true },
          })
        : null;
    const prepaidAmount =
      advanceInvoice && invoice.advanceAppliedAmount.greaterThan(0)
        ? invoice.advanceAppliedAmount
        : null;

    // — D6: upozorenje javni sektor bez broja narudžbenice (ne blokira) —
    let warning: string | null = null;
    const poNumber = invoice.poNumber?.trim();
    if (customer.publicSectorId && !poNumber) {
      warning =
        "Kupac je iz javnog sektora, a broj narudžbenice nije unet — SEF može odbiti fakturu.";
    }

    const ublXml = this.ubl.build({
      invoice: {
        documentType: invoice.documentType,
        documentNumber: invoice.documentNumber,
        documentDate: invoice.documentDate,
        dueDate: invoice.dueDate,
        // Datum prometa → cac:Delivery/cbc:ActualDeliveryDate. Knjižen račun ga uvek
        // ima (postInvoice ga podrazumeva na datum izdavanja ako nije unet), pa ovde
        // ostaje null samo za račune proknjižene PRE uvođenja polja — za njih builder
        // baca jasan 400 umesto da pošalje račun bez obaveznog elementa.
        deliveryDate: invoice.deliveryDate,
        currency: invoice.currency,
        isExport: invoice.isExport,
        netTotal: invoice.netTotal,
        vatTotal: invoice.vatTotal,
        grossTotal: invoice.grossTotal,
        note: invoice.note,
        poNumber: invoice.poNumber,
        isPrepayment: invoice.documentType === "AVR",
        prepaymentReference: advanceInvoice?.documentNumber ?? null,
        prepaidAmount,
      },
      items,
      supplier,
      customer: buyer,
      pdfBase64,
      pdfFileName,
    });

    const outbox = await this.prisma.sefOutbox.create({
      data: {
        invoiceId: invoice.id,
        requestId: randomUUID(),
        ublXml,
        pdfAttachmentBase64: pdfBase64,
        status: "PENDING",
      },
    });

    // T3/A8: SEF status-istorija — PENDING (u red).
    await this.logStatus({
      outboxId: outbox.id,
      status: "PENDING",
      note: warning,
      userId,
    });

    return { outbox, warning };
  }

  /**
   * Pošalji outbox red na SEF. Na uspeh: SENT + sefInvoiceId + sentAt.
   * Na (mrežnu) grešku: ostaje PENDING, upisuje errorMessage — NE baca.
   */
  async send(outboxId: number, userId?: number): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);
    if (outbox.status === "CANCELLED") {
      throw new ConflictException("Outbox je otkazan — ne može se slati.");
    }

    // Defense in depth (review Batch A F3): faktura je u međuvremenu mogla biti stornirana
    // dok outbox red još stoji PENDING (npr. red kreiran, pa storno pre lokalnog otkazivanja).
    // Storniran dokument NE sme da ode na SEF.
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: outbox.invoiceId },
      select: { status: true },
    });
    if (invoice?.status === "CANCELLED") {
      await this.logStatus({
        outboxId,
        status: "ERROR",
        note: "Slanje obustavljeno — faktura je stornirana.",
        userId,
      });
      throw new ConflictException(
        "Faktura je stornirana — slanje obustavljeno.",
      );
    }

    const res = await this.client.sendInvoice(outboxId);

    if (res.dryRun) {
      // DRY-RUN: ne menja status (ostaje PENDING), samo beleži da nije poslato.
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          errorMessage: "DRY-RUN: SEF_API_KEY nije podešen — nije poslato.",
        },
      });
      await this.logStatus({
        outboxId,
        status: "DRY_RUN",
        note: "Slanje: DRY-RUN (SEF_API_KEY nije podešen).",
        userId,
      });
      return row;
    }

    if (res.ok) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          status: "SENT",
          sefInvoiceId: res.sefInvoiceId ?? outbox.sefInvoiceId,
          errorMessage: null,
          sentAt: new Date(),
        },
      });
      await this.logStatus({
        outboxId,
        status: "SENT",
        note: row.sefInvoiceId ? `SEF ID ${row.sefInvoiceId}` : null,
        userId,
      });
      return row;
    }

    // Mrežna/HTTP greška: zabeleži, ostavi PENDING za retry.
    const row = await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { errorMessage: res.errorMessage ?? "Nepoznata SEF greška." },
    });
    await this.logStatus({
      outboxId,
      status: "ERROR",
      note: `Slanje nije uspelo: ${res.errorMessage ?? "nepoznata SEF greška."}`,
      userId,
    });
    return row;
  }

  /**
   * Osveži status outbox reda sa SEF-a (polling). Mapira SEF status u lokalni.
   * Ne baca na mrežnu grešku.
   */
  async refreshStatus(outboxId: number, userId?: number): Promise<SefOutbox> {
    const before = await this.getOutbox(outboxId);
    const res = await this.client.pollStatus(outboxId);

    if (res.dryRun) return before;

    if (!res.ok) {
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          statusPolledAt: new Date(),
          errorMessage: res.errorMessage ?? "Polling greška.",
        },
      });
    }

    const localStatus = mapSefStatus(res.sefStatus);
    const row = await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: {
        status: localStatus ?? undefined,
        statusPolledAt: new Date(),
        errorMessage: null,
      },
    });

    // T3/A8: log samo kad se status STVARNO promenio (izbegni šum od pollinga).
    if (localStatus && localStatus !== before.status) {
      await this.logStatus({
        outboxId,
        status: localStatus,
        note: res.sefStatus
          ? `Osveženo sa SEF-a (${res.sefStatus})`
          : "Osveženo sa SEF-a.",
        userId,
      });
    }
    return row;
  }

  /**
   * Otkaži/storniraj fakturu na SEF-u. GUARD (`MozeDaSeStornira/Otkaze`):
   * dozvoljeno samo iz PENDING/SENT/DELIVERED — REJECTED/CANCELLED se ne diraju.
   * `reason` (opciono) = razlog storna (npr. iz storna fakture A5); SEF cancel API
   * nema polje za slobodan tekst, pa se razlog loguje (traceback), ne šalje portalu.
   */
  async cancel(
    outboxId: number,
    reason?: string,
    userId?: number,
  ): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);

    if (!CANCELLABLE_LOCAL_STATUSES.has(outbox.status)) {
      throw new ConflictException(
        `Faktura u statusu "${outbox.status}" ne može da se otkaže/stornira.`,
      );
    }

    const trimmedReason = reason && reason.trim().length > 0 ? reason.trim() : null;
    if (trimmedReason) {
      this.logger.log(
        `SEF cancel outbox ${outboxId} (invoice ${outbox.invoiceId}) — razlog: ${trimmedReason}`,
      );
    }

    const res = await this.client.cancelInvoice(outboxId);

    if (res.dryRun) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          errorMessage: "DRY-RUN: SEF_API_KEY nije podešen — cancel nije poslat.",
        },
      });
      await this.logStatus({
        outboxId,
        status: "DRY_RUN",
        note: trimmedReason
          ? `Storno DRY-RUN — razlog: ${trimmedReason}`
          : "Storno: DRY-RUN (SEF_API_KEY nije podešen).",
        userId,
      });
      return row;
    }

    if (res.ok) {
      const row = await this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: { status: "CANCELLED", errorMessage: null },
      });
      await this.logStatus({
        outboxId,
        status: "CANCELLED",
        note: trimmedReason,
        userId,
      });
      return row;
    }

    const row = await this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { errorMessage: res.errorMessage ?? "Cancel greška." },
    });
    await this.logStatus({
      outboxId,
      status: "ERROR",
      note: `Storno nije uspeo: ${res.errorMessage ?? "cancel greška."}`,
      userId,
    });
    return row;
  }

  /**
   * Lokalno otkaži SVE PENDING outbox redove fakture (storno fakture — review Batch A F3).
   * SEF poziv NIJE potreban jer PENDING red nikada nije poslat: updateMany PENDING → CANCELLED
   * + status-log po redu. SENT/DELIVERED se ne diraju ovde (oni idu kroz `cancel()` = SEF API).
   * Vraća id-eve lokalno otkazanih redova.
   */
  async cancelPendingLocally(
    invoiceId: number,
    reason?: string,
    userId?: number,
  ): Promise<number[]> {
    const pending = await this.prisma.sefOutbox.findMany({
      where: { invoiceId, status: "PENDING" },
      select: { id: true },
    });
    if (pending.length === 0) return [];

    const trimmed = reason && reason.trim().length > 0 ? reason.trim() : null;
    const note = trimmed ? `storno fakture — ${trimmed}` : "storno fakture";

    await this.prisma.sefOutbox.updateMany({
      where: { invoiceId, status: "PENDING" },
      data: { status: "CANCELLED", errorMessage: null },
    });
    for (const row of pending) {
      await this.logStatus({ outboxId: row.id, status: "CANCELLED", note, userId });
    }
    return pending.map((r) => r.id);
  }

  /**
   * Lista outbox redova (opciono filter po statusu / invoiceId).
   * BEZ velikih tela (ublXml, pdfAttachmentBase64) — red nosi ceo UBL XML i
   * base64 PDF prilog, pa bi lista od 200 redova bila višedeset-MB odgovor.
   * Puna tela se čitaju samo na detalju (getOutbox).
   */
  listOutbox(params: {
    status?: string;
    invoiceId?: number;
    skip?: number;
    take?: number;
  }): Promise<SefOutboxListItem[]> {
    const take = Math.min(Math.max(params.take ?? 50, 1), 200);
    return this.prisma.sefOutbox.findMany({
      where: {
        status: params.status,
        invoiceId: params.invoiceId,
      },
      select: {
        id: true,
        invoiceId: true,
        requestId: true,
        status: true,
        sefInvoiceId: true,
        errorMessage: true,
        sentAt: true,
        statusPolledAt: true,
        createdAt: true,
      },
      orderBy: { id: "desc" },
      skip: params.skip && params.skip > 0 ? params.skip : undefined,
      take,
    });
  }

  private async getOutbox(outboxId: number): Promise<SefOutbox> {
    const outbox = await this.prisma.sefOutbox.findUnique({
      where: { id: outboxId },
    });
    if (!outbox) throw new NotFoundException(`SefOutbox ${outboxId} ne postoji.`);
    return outbox;
  }

  /**
   * Hronološki status-log za JEDAN outbox ILI incoming red (timeline na /sef).
   * Sortiran rastuće po vremenu (najstariji prvo). Vraća do 200 zapisa. Bez filtera
   * vraća prazno (uvek se traži po jednom redu — controller obezbeđuje parametar).
   */
  listStatusLog(params: { outboxId?: number; incomingId?: number }) {
    const where: Prisma.SefStatusLogWhereInput = {};
    if (params.outboxId != null) where.outboxId = params.outboxId;
    if (params.incomingId != null) where.incomingId = params.incomingId;
    return this.prisma.sefStatusLog.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 200,
    });
  }

  /**
   * Best-effort upis u SEF status-log (append-only istorija dokument-toka). Log NE
   * sme da obori poslovnu radnju (enqueue/send/refresh/cancel) — greška se samo
   * zabeleži u logger. note se kroti na 500 (VarChar limit šeme).
   */
  private async logStatus(entry: {
    outboxId?: number | null;
    incomingId?: number | null;
    status: string;
    note?: string | null;
    userId?: number | null;
  }): Promise<void> {
    try {
      await this.prisma.sefStatusLog.create({
        data: {
          outboxId: entry.outboxId ?? null,
          incomingId: entry.incomingId ?? null,
          status: entry.status,
          note: entry.note ? entry.note.slice(0, 500) : null,
          userId: entry.userId ?? null,
        },
      });
    } catch (err) {
      this.logger.warn(
        `SEF status-log upis nije uspeo (outbox=${entry.outboxId ?? "-"}, status=${entry.status}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Mapiranje SEF statusa (doc 07 §6.2) u lokalni SefOutbox.status.
 * Vraća undefined za nepoznat status (status se ne menja).
 */
function mapSefStatus(sef?: string): string | null {
  if (!sef) return null;
  const s = sef.toLowerCase();
  if (s.includes("draft") || s.includes("nacrt") || s === "new") return "PENDING";
  if (s.includes("reject") || s.includes("odbij") || s.includes("mistake"))
    return "REJECTED";
  if (s.includes("cancel") || s.includes("storno")) return "CANCELLED";
  if (
    s.includes("approv") ||
    s.includes("odobr") ||
    s.includes("seen") ||
    s.includes("delivered")
  )
    return "DELIVERED";
  if (s.includes("sent") || s.includes("posla")) return "SENT";
  return null;
}
