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
          // Podaci koje traži štampa (STAMPA_FAKTURA_GAP.md §3): bez prepisa bi ostali na
          // predračunu, a papir se štampa sa RAČUNA — „Odgovorno lice" i „Način plaćanja" bi bili
          // prazni na svakom računu nastalom prepisom.
          salespersonId: proforma.salespersonId,
          paymentMethod: proforma.paymentMethod,
          // DATUM PROMETA (obavezan element računa, Zakon o PDV): isti razlog kao gore —
          // unosi se na predračunu, a štampa i SEF ga čitaju sa RAČUNA. Bez prepisa bi
          // svaki račun nastao iz predračuna gubio već unet podatak i pao na podrazumevanu
          // vrednost pri knjiženju (datum izdavanja), iako je stvaran datum bio poznat.
          // Ako ga predračun nema (nije ni morao — izdaje se pre prometa), ostaje null i
          // postInvoice ga podrazumeva.
          supplyDate: proforma.supplyDate,
          note: proforma.note,
          items: {
            create: proforma.items.map((it) => ({
              lineNo: it.lineNo,
              itemId: it.itemId,
              description: it.description,
              unit: it.unit,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              // Osnovica za koeficijent (§8/O1) se PRENOSI sa izvorne stavke; ako
              // je izvor stariji od kolone, pada na njegovu cenu. Bez ovoga bi
              // prepisan dokument imao baznu cenu 0 i prvi dodir bi ga nulirao.
              baseUnitPrice: it.baseUnitPrice?.greaterThan(0)
                ? it.baseUnitPrice
                : it.unitPrice,
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

      // ── Upiši link nazad na izvor (zatvara anti-duplo guard) — CAS: uslov
      // „link još prazan" mora biti U SAMOM update-u; read-then-check guard gore
      // propušta dva KONKURENTNA prepisa (npr. IFR i IFGP iz istog predračuna),
      // pa bi bez ovoga nastala dva knjiživa računa. count=0 → rollback cilja.
      const linked = await tx.invoice.updateMany({
        where: {
          id: proforma.id,
          OR: [{ linkedInvoiceDocId: null }, { linkedInvoiceDocId: { lte: 0 } }],
        },
        data: { linkedInvoiceDocId: invoice.id },
      });
      if (linked.count === 0) {
        throw new ConflictException(
          `Predračun ${proformaId} je u međuvremenu već prepisan u drugi račun.`,
        );
      }

      return invoice;
    });
  }
}

// eslint referenca da Prisma import ostane iskorišćen ako se ubuduće koristi tip.
export type CarryOverTx = Prisma.TransactionClient;
