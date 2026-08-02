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
 *   • pricePolicy = keep (cene se prenose 1:1 iz predračuna — ne pre-računavaju);
 *     uz cene ide i KOEFICIJENT dokumenta, jer su cene u stavci upisane u dve razmere
 *     (pre i posle koeficijenta) — v. `priceCoefficient` niže,
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

/** Skala kolone `base_unit_price` (`Decimal(19,4)`) — deljenje se zaokružuje na nju. */
const BASE_PRICE_SCALE = 4;
const ROUND_HALF_UP = Prisma.Decimal.ROUND_HALF_UP;

/**
 * BAZNA CENA PRI PREPISU — rezerva mora da poštuje KOEFICIJENT, inače ruši istu
 * invarijantu koju čuva.
 * ───────────────────────────────────────────────────────────────────────────────
 * Stavka drži dve razmere: `baseUnitPrice` je PRE koeficijenta, `unitPrice` POSLE
 * (`unitPrice = baseUnitPrice × priceCoefficient`, v. `sales.service.deriveFromBase`).
 * Kolona `base_unit_price` je `NOT NULL DEFAULT 0`, pa stavka koju je napisao pisac
 * stariji od kolone (ili uvoz) nosi 0 — zato rezerva uopšte postoji
 * (v. `sales.service.resolveBaseUnitPrice`).
 *
 * NALAZ (treći krug pregleda, 02.08.2026): otkad prepis prenosi i `priceCoefficient`
 * (v. niže), rezerva `base := unitPrice` više nije neutralna. Za izvor sa bazom 0 i
 * koeficijentom 0,5 cilj je dobijao `baseUnitPrice = unitPrice = 450` UZ koeficijent
 * 0,5 — pa bi prva izmena stavke izvela `450 × 0,5 = 225` i tiho PREPOLOVILA cenu.
 * Ranije (koeficijent na cilju uvek 1) je ista rezerva bila tačna; kvar je nastao tek
 * spajanjem dve ispravke.
 *
 * TAČNA REZERVA je zato `unitPrice ÷ koeficijent`: vraća `unitPrice` u razmeru PRE
 * koeficijenta, pa `base × koeficijent` opet daje polaznu cenu.
 *
 * DELJENJE NULOM: DB CHECK `chk_invoices_price_coefficient` traži > 0, ali legacy i
 * uvezeni redovi tu garanciju nemaju — 0, negativan ili neupisan koeficijent znači
 * razmeru 1:1, ne `Infinity` u novčanoj koloni.
 */
export function carryBaseUnitPrice(
  baseUnitPrice: Prisma.Decimal | null | undefined,
  unitPrice: Prisma.Decimal,
  coefficient: Prisma.Decimal | null | undefined,
): Prisma.Decimal {
  if (baseUnitPrice?.greaterThan(0)) return baseUnitPrice;
  if (!unitPrice) return unitPrice;
  if (!coefficient || !coefficient.greaterThan(0) || coefficient.equals(1)) {
    return unitPrice;
  }
  return unitPrice
    .div(coefficient)
    .toDecimalPlaces(BASE_PRICE_SCALE, ROUND_HALF_UP);
}

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
          // ── KOEFICIJENT CENE SE PRENOSI (§8/O1) ──────────────────────────────────
          // U jednoj stavci žive DVE RAZMERE: `baseUnitPrice` i `unitPriceBeforeDiscount`
          // su na nivou PRE koeficijenta, a `unitPrice`/`vatBase` POSLE njega
          // (`sales.service.deriveFromBase`). Prepis nosi obe kolone doslovno, pa cilj
          // MORA da nasledi i množilac — bez njega padne na `@default(1)` i dve razmere
          // se pomešaju u istom redu.
          //
          // SCENARIO (izmereno): predračun sa koeficijentom 0,5, cena 1.000, rabat 10 % →
          // `unitPriceBeforeDiscount=1.000`, `baseUnitPrice=900`, `unitPrice=450`,
          // `vatBase=450`. Sa koeficijentom 1 na cilju:
          //   • ŠTAMPA: puna cena se množi koeficijentom CILJA (1) → bruto 1.000, pa red
          //     „Rabat" kaže 550,00 uz kolonu „R% 10" — papir sam sebe poriče, a kupcu
          //     pokazuje rabat koji nije odobren (stvarni je 50,00).
          //   • PRVA IZMENA STAVKE: `unitPrice = baseUnitPrice × koeficijent` više ne važi
          //     (900 × 1 ≠ 450), pa bi obična ispravka količine (`SalesService.updateItem`,
          //     grana bez preračuna cene) tiho podigla cenu sa 450 na 900.
          //
          // ZAŠTO SE PRENOSI MNOŽILAC, A NE „UPEČE" U CENE: druga mogućnost je bila da
          // cilj dobije koeficijent 1 uz `baseUnitPrice := unitPrice` i
          // `unitPriceBeforeDiscount := unitPriceBeforeDiscount × koeficijent_izvora`.
          // Račun bi se i tako zatvorio, ali NEPOVRATNO: vraćanje koeficijenta na 1 na
          // računu više ne bi vratilo polaznu cenu (900), jer je množilac ugrađen u baznu
          // cenu. To je tačno BigBitovo „primeni pa upiši" koje §8/O1 odbacuje. Ovako
          // prepis ne dira nijedan iznos (novac je identičan izvoru), a koeficijent na
          // računu ostaje ponovljiv i može da se ispravi ili poništi.
          priceCoefficient: proforma.priceCoefficient,
          // Audit primene ide uz vrednost — inače bi račun nosio koeficijent 0,5 bez ijednog
          // traga ko ga je i kada primenio, a to je jedini zapis o odobrenoj korekciji cene.
          priceCoefficientAppliedAt: proforma.priceCoefficientAppliedAt,
          priceCoefficientAppliedBy: proforma.priceCoefficientAppliedBy,
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
              // Osnovica za koeficijent (§8/O1) se PRENOSI sa izvorne stavke; ako je
              // izvor stariji od kolone, pada na cenu VRAĆENU U RAZMERU PRE KOEFICIJENTA
              // (v. `carryBaseUnitPrice`). Bez rezerve bi prepisan dokument imao baznu
              // cenu 0 i prvi dodir bi ga nulirao; bez deljenja koeficijentom bi ga prvi
              // dodir umanjio za taj isti koeficijent.
              baseUnitPrice: carryBaseUnitPrice(
                it.baseUnitPrice,
                it.unitPrice,
                proforma.priceCoefficient,
              ),
              // Cena PRE rabata se PRENOSI kakva jeste — i kad je null. Račun nastao
              // prepisom nosi isti rabat kao predračun, pa mora da nosi i istu punu cenu;
              // bez prenosa bi red „Rabat" bio tačan na predračunu, a nedokaziv na računu.
              // Za izvore starije od kolone ostaje null i štampa ide na obračun unazad.
              unitPriceBeforeDiscount: it.unitPriceBeforeDiscount,
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
          OR: [
            { linkedInvoiceDocId: null },
            { linkedInvoiceDocId: { lte: 0 } },
          ],
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
