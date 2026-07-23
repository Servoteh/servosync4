import {
  Injectable,
  NotFoundException,
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * DocumentCarryOverService — prepis predračuna u račun (par PROF → IFR/IFGP/IFUSL/…).
 *
 * PLAN_FAZA_5 §A + doc 27 (carry-over):
 *   • izvor = PROF (ili PON) na level 250; cilj = NOV level-0 dokument (IFR/…),
 *   • pricePolicy = keep (cene se prenose 1:1 iz predračuna — ne pre-računavaju),
 *   • qtyPolicy = full (cela količina),
 *   • dedup po copiedFromItemId — stavka koja je već prepisana se NE prepisuje ponovo,
 *   • upis linkedInvoiceDocId na izvor + copiedFromDocId na cilj (traceback),
 *   • ANTI-DUPLO GUARD: ako izvor.linkedInvoiceDocId > 0 → ConflictException,
 *   • NOVA numeracija se NE dodeljuje ovde — broj se rezerviše tek pri knjiženju
 *     (postInvoice, level 0). Cilj se kreira kao DRAFT bez definitivnog broja
 *     (privremeni „DRAFT-" broj), knjiženje mu dodeljuje pravi broj.
 *
 * Idempotentno: ponovni poziv na već-prepisanom predračunu baca ConflictException
 * (guard), ne pravi drugi dokument.
 */

/** Ciljne vrste level-0 računa (domaći + izvoz). */
const TARGET_TYPES = new Set([
  "IFR",
  "IFGP",
  "IFUSL",
  "IZVRO",
  "IZVGP",
  "IZVUS",
  "REV",
]);

const EXPORT_TYPES = new Set(["IZVRO", "IZVGP", "IZVUS"]);

@Injectable()
export class DocumentCarryOverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kreiraj level-0 račun iz predračuna. @returns kreirani Invoice (sa stavkama).
   */
  async createInvoiceFromProforma(proformaId: number, targetType: string) {
    if (!TARGET_TYPES.has(targetType)) {
      throw new UnprocessableEntityException(
        `Nepoznata ciljna vrsta računa: ${targetType}.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const proforma = await tx.invoice.findUnique({
        where: { id: proformaId },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });
      if (!proforma) {
        throw new NotFoundException(`Predračun ${proformaId} ne postoji.`);
      }
      if (proforma.level !== 250) {
        throw new UnprocessableEntityException(
          `Dokument ${proformaId} nije predračun (level ${proforma.level}, očekivano 250).`,
        );
      }

      // ── ANTI-DUPLO GUARD ──
      if (proforma.linkedInvoiceDocId && proforma.linkedInvoiceDocId > 0) {
        throw new ConflictException(
          `Predračun ${proformaId} je već prepisan u račun ${proforma.linkedInvoiceDocId}.`,
        );
      }

      // ── D8: zaključan izvor se ne prepisuje (mutira mu se linkedInvoiceDocId) ──
      if (proforma.isLocked) {
        throw new ConflictException("Dokument je zaključan (proknjižen).");
      }

      const isExport = EXPORT_TYPES.has(targetType) || proforma.isExport;

      // ── Kreiraj cilj (DRAFT, level 0, privremeni broj) ──
      // Definitivan broj dodeljuje postInvoice (numeracija) — ovde placeholder.
      const draftNumber = `DRAFT-${proformaId}`;

      const invoice = await tx.invoice.create({
        data: {
          documentType: targetType,
          documentNumber: draftNumber,
          level: 0,
          companyId: proforma.companyId,
          customerId: proforma.customerId,
          documentDate: new Date(),
          dueDate: proforma.dueDate,
          currency: proforma.currency,
          exchangeRate: proforma.exchangeRate,
          accountingExchangeRate: proforma.accountingExchangeRate,
          fxInvoiceValue: proforma.fxInvoiceValue,
          netTotal: proforma.netTotal,
          vatTotal: proforma.vatTotal,
          grossTotal: proforma.grossTotal,
          copiedFromDocId: proforma.id,
          status: "DRAFT",
          isExport,
          poNumber: proforma.poNumber, // D6: broj narudžbenice se prenosi PROF → račun (UBL OrderReference)
          note: proforma.note,
          items: {
            create: proforma.items.map((it) => ({
              lineNo: it.lineNo,
              itemId: it.itemId,
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              discountPercent: it.discountPercent,
              cashDiscountPercent: it.cashDiscountPercent,
              vatRateCode: it.vatRateCode,
              vatBase: it.vatBase,
              vatAmount: it.vatAmount,
              lineTotal: it.lineTotal,
              copiedFromItemId: it.id, // dedup ključ (par PROF-stavka → IFR-stavka)
            })),
          },
        },
        include: { items: { orderBy: { lineNo: "asc" } } },
      });

      // ── Upiši link nazad na izvor (zatvara anti-duplo guard) ──
      await tx.invoice.update({
        where: { id: proforma.id },
        data: { linkedInvoiceDocId: invoice.id },
      });

      return invoice;
    });
  }
}

// eslint referenca da Prisma import ostane iskorišćen ako se ubuduće koristi tip.
export type CarryOverTx = Prisma.TransactionClient;
