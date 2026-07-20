import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { SefOutbox } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";
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

@Injectable()
export class SefService {
  private readonly logger = new Logger(SefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: SefClientService,
    private readonly ubl: UblBuilderService,
  ) {}

  /**
   * Kreiraj SefOutbox red za fakturu: gradi UBL, upisuje PENDING + requestId.
   * Ne šalje (to je `send`). Odbija izvoz (nije na domaćem SEF-u) i draft
   * (level != 0 / status DRAFT — samo knjižena faktura ide na SEF).
   */
  async enqueue(invoiceId: number): Promise<SefOutbox> {
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
      vatBase: it.vatBase,
      vatAmount: it.vatAmount,
      lineTotal: it.lineTotal,
    }));

    const ublXml = this.ubl.build({
      invoice: {
        documentType: invoice.documentType,
        documentNumber: invoice.documentNumber,
        documentDate: invoice.documentDate,
        dueDate: invoice.dueDate,
        currency: invoice.currency,
        isExport: invoice.isExport,
        netTotal: invoice.netTotal,
        vatTotal: invoice.vatTotal,
        grossTotal: invoice.grossTotal,
        note: invoice.note,
        isPrepayment: invoice.documentType === "AVR",
      },
      items,
      supplier,
      customer: buyer,
    });

    return this.prisma.sefOutbox.create({
      data: {
        invoiceId: invoice.id,
        requestId: randomUUID(),
        ublXml,
        status: "PENDING",
      },
    });
  }

  /**
   * Pošalji outbox red na SEF. Na uspeh: SENT + sefInvoiceId + sentAt.
   * Na (mrežnu) grešku: ostaje PENDING, upisuje errorMessage — NE baca.
   */
  async send(outboxId: number): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);
    if (outbox.status === "CANCELLED") {
      throw new ConflictException("Outbox je otkazan — ne može se slati.");
    }

    const res = await this.client.sendInvoice(outboxId);

    if (res.dryRun) {
      // DRY-RUN: ne menja status (ostaje PENDING), samo beleži da nije poslato.
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          errorMessage: "DRY-RUN: SEF_API_KEY nije podešen — nije poslato.",
        },
      });
    }

    if (res.ok) {
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          status: "SENT",
          sefInvoiceId: res.sefInvoiceId ?? outbox.sefInvoiceId,
          errorMessage: null,
          sentAt: new Date(),
        },
      });
    }

    // Mrežna/HTTP greška: zabeleži, ostavi PENDING za retry.
    return this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { errorMessage: res.errorMessage ?? "Nepoznata SEF greška." },
    });
  }

  /**
   * Osveži status outbox reda sa SEF-a (polling). Mapira SEF status u lokalni.
   * Ne baca na mrežnu grešku.
   */
  async refreshStatus(outboxId: number): Promise<SefOutbox> {
    await this.getOutbox(outboxId);
    const res = await this.client.pollStatus(outboxId);

    if (res.dryRun) return this.getOutbox(outboxId);

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
    return this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: {
        status: localStatus ?? undefined,
        statusPolledAt: new Date(),
        errorMessage: null,
      },
    });
  }

  /**
   * Otkaži/storniraj fakturu na SEF-u. GUARD (`MozeDaSeStornira/Otkaze`):
   * dozvoljeno samo iz PENDING/SENT/DELIVERED — REJECTED/CANCELLED se ne diraju.
   */
  async cancel(outboxId: number): Promise<SefOutbox> {
    const outbox = await this.getOutbox(outboxId);

    if (!CANCELLABLE_LOCAL_STATUSES.has(outbox.status)) {
      throw new ConflictException(
        `Faktura u statusu "${outbox.status}" ne može da se otkaže/stornira.`,
      );
    }

    const res = await this.client.cancelInvoice(outboxId);

    if (res.dryRun) {
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: {
          errorMessage: "DRY-RUN: SEF_API_KEY nije podešen — cancel nije poslat.",
        },
      });
    }

    if (res.ok) {
      return this.prisma.sefOutbox.update({
        where: { id: outboxId },
        data: { status: "CANCELLED", errorMessage: null },
      });
    }

    return this.prisma.sefOutbox.update({
      where: { id: outboxId },
      data: { errorMessage: res.errorMessage ?? "Cancel greška." },
    });
  }

  /** Lista outbox redova (opciono filter po statusu / invoiceId). */
  listOutbox(params: {
    status?: string;
    invoiceId?: number;
    skip?: number;
    take?: number;
  }): Promise<SefOutbox[]> {
    const take = Math.min(Math.max(params.take ?? 50, 1), 200);
    return this.prisma.sefOutbox.findMany({
      where: {
        status: params.status,
        invoiceId: params.invoiceId,
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
