import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * PricingService — cena stavke izlaznog računa (deljeno predračun/račun).
 *
 * TOK (PLAN_FAZA_5 §A):
 *   baza cena (PriceListEntry ILI Item.wholesalePrice fallback)
 *     → rabat iz CustomerDiscount (customerId + itemGroupCode; fallback Customer.customerDiscount)
 *       → KAP na Item.maxDiscountPercent (uz upozorenje ako se seče)
 *         → kasa (cashDiscountPercent)
 *           → actualWholesalePrice (unitPrice) + vatBase + vatAmount po vatRateCode
 *
 * Novac je Prisma.Decimal na svakoj granici (Float izvori — Item.wholesalePrice,
 * Customer.customerDiscount, Item.maxDiscountPercent — konvertuju se u Decimal ODMAH).
 *
 * RuC (razlika u ceni) = 0 za IFR (fakturisanje ne dira maržu — kalkulacija je robna).
 */

const D = Prisma.Decimal;
const ZERO = new D(0);
const HUNDRED = new D(100);

/** Stope PDV po `vatRateCode` (isto kao posting VAT_RATE_BY_CODE, doc 43 §4). */
const VAT_RATE_BY_CODE: Readonly<Record<string, Prisma.Decimal>> = {
  "3": new D("0.20"), // Osnovna / VISA (20%) — default stavke
  "1": new D("0.20"), // Osnovna (alt kod)
  "2": new D("0.10"), // Zeleznica / NIZA (10%)
  "4": new D("0.08"), // Posebna / POLJO (8%)
  "0": ZERO, // bez PDV (izvoz / oslobođeno)
};

export interface PricedItem {
  /** actualWholesalePrice — transakciona VP cena po JM (posle rabata/kase). */
  unitPrice: Prisma.Decimal;
  /** bazna VP cena pre rabata (za prikaz/print). */
  basePrice: Prisma.Decimal;
  discountPercent: Prisma.Decimal;
  cashDiscountPercent: Prisma.Decimal;
  quantity: Prisma.Decimal;
  vatRateCode: string;
  /** poreska osnovica = qty × unitPrice (posle rabata i kase). */
  vatBase: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  /** za plaćanje = vatBase + vatAmount. */
  lineTotal: Prisma.Decimal;
  /** true ako je traženi rabat premašio Item.maxDiscountPercent i bio odsečen. */
  discountCapped: boolean;
}

interface PriceItemArgs {
  customerId?: number | null;
  itemId?: number | null;
  itemGroupCode?: string | null;
  quantity: number | Prisma.Decimal;
  /** documentTypeCode (npr. "IFR") — za izbor cenovnika i RuC pravilo. */
  documentType?: string;
  /** eksplicitni rabat/kasa iz unosa (ako je zadat, ima prioritet nad rabatnom politikom). */
  requestedDiscountPercent?: number | Prisma.Decimal;
  cashDiscountPercent?: number | Prisma.Decimal;
  /** eksplicitna VP cena iz unosa (za slobodne uslužne stavke; preskače cenovnik). */
  overrideUnitPrice?: number | Prisma.Decimal;
  /** eksplicitna PDV šifra (fallback Item.goodsTaxRateCode). */
  vatRateCode?: string;
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  private toDecimal(v: number | Prisma.Decimal | null | undefined): Prisma.Decimal {
    if (v === null || v === undefined) return ZERO;
    return v instanceof D ? v : new D(v);
  }

  /**
   * Izračunaj cenu jedne stavke. Bez side-effekata (čist read).
   */
  async priceItem(args: PriceItemArgs): Promise<PricedItem> {
    const quantity = this.toDecimal(args.quantity);

    // ── Artikal (za fallback cenu, kap rabata, PDV šifru, grupu) ──
    const item =
      args.itemId != null
        ? await this.prisma.item.findUnique({
            where: { id: args.itemId },
            select: {
              wholesalePrice: true,
              maxDiscountPercent: true,
              goodsTaxRateCode: true,
              groupCode: true,
            },
          })
        : null;

    const itemGroupCode = args.itemGroupCode ?? item?.groupCode ?? null;
    const vatRateCode = args.vatRateCode ?? item?.goodsTaxRateCode ?? "3";

    // ── 1) Baza cena ──
    const basePrice =
      args.overrideUnitPrice != null
        ? this.toDecimal(args.overrideUnitPrice)
        : await this.resolveBasePrice(args.itemId, args.documentType, item);

    // ── 2) Rabat: eksplicitni > rabatna politika > flat Customer.customerDiscount ──
    let discountPercent: Prisma.Decimal;
    if (args.requestedDiscountPercent != null) {
      discountPercent = this.toDecimal(args.requestedDiscountPercent);
    } else {
      discountPercent = await this.resolveDiscount(
        args.customerId,
        itemGroupCode,
      );
    }

    // ── 3) KAP na Item.maxDiscountPercent ──
    let discountCapped = false;
    const maxDiscount = this.toDecimal(item?.maxDiscountPercent ?? 100);
    if (discountPercent.greaterThan(maxDiscount)) {
      discountPercent = maxDiscount;
      discountCapped = true;
    }
    if (discountPercent.lessThan(ZERO)) discountPercent = ZERO;

    // ── 4) Kasa ──
    const cashDiscountPercent = this.toDecimal(args.cashDiscountPercent);

    // ── 5) actualWholesalePrice = base × (1 − rabat%) × (1 − kasa%) ──
    const afterDiscount = basePrice.mul(
      HUNDRED.sub(discountPercent).div(HUNDRED),
    );
    const unitPrice = afterDiscount.mul(
      HUNDRED.sub(cashDiscountPercent).div(HUNDRED),
    );

    // ── 6) Osnovica + PDV ──
    const vatBase = quantity.mul(unitPrice);
    const rate = VAT_RATE_BY_CODE[vatRateCode] ?? ZERO;
    const vatAmount = vatBase.mul(rate);
    const lineTotal = vatBase.add(vatAmount);

    return {
      unitPrice,
      basePrice,
      discountPercent,
      cashDiscountPercent,
      quantity,
      vatRateCode,
      vatBase,
      vatAmount,
      lineTotal,
      discountCapped,
    };
  }

  /**
   * Baza cena: PriceListEntry.priceWithoutVat po (itemId, documentTypeCode) →
   * fallback Item.wholesalePrice (Float → Decimal na granici) → 0.
   */
  private async resolveBasePrice(
    itemId: number | null | undefined,
    documentType: string | undefined,
    item: { wholesalePrice: number | null } | null,
  ): Promise<Prisma.Decimal> {
    if (itemId != null) {
      const entry = await this.prisma.priceListEntry.findFirst({
        where: {
          itemId,
          ...(documentType ? { documentTypeId: documentType } : {}),
        },
        select: { priceWithoutVat: true },
      });
      if (entry?.priceWithoutVat != null && !entry.priceWithoutVat.equals(ZERO)) {
        return entry.priceWithoutVat;
      }
    }
    return this.toDecimal(item?.wholesalePrice ?? 0);
  }

  /**
   * Rabat: CustomerDiscount (customerId + itemGroupCode, u važnosti danas) →
   * flat CustomerDiscount (itemGroupCode = null) → Customer.customerDiscount (Float).
   */
  private async resolveDiscount(
    customerId: number | null | undefined,
    itemGroupCode: string | null,
  ): Promise<Prisma.Decimal> {
    if (customerId == null) return ZERO;

    const now = new Date();
    // Preferiraj rabat vezan za grupu; ako nema, uzmi flat (group = null).
    // Povuci sve u važnosti danas (za kupca), pa u JS-u izaberi grupa > flat.
    const discounts = await this.prisma.customerDiscount.findMany({
      where: {
        customerId,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gte: now } }],
      },
      select: { itemGroupCode: true, discountPercent: true, validFrom: true },
      orderBy: { validFrom: "desc" },
    });

    if (discounts.length > 0) {
      const byGroup = itemGroupCode
        ? discounts.find((d) => d.itemGroupCode === itemGroupCode)
        : undefined;
      const flat = discounts.find((d) => d.itemGroupCode == null);
      const chosen = byGroup ?? flat;
      if (chosen) return chosen.discountPercent;
    }

    // Fallback: flat rabat sa kartona kupca (Float izvor).
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { customerDiscount: true },
    });
    return this.toDecimal(customer?.customerDiscount ?? 0);
  }
}
