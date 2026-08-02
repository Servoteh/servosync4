import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * PricingService — cena stavke izlaznog računa (deljeno predračun/račun/pregled cene).
 *
 * TOK (PLAN_FAZA_5 §A + PLAN_UNOS_DOKUMENATA §4.2/§4.4/§8/O2):
 *   fakturna cena F (cenovnik ILI Item.wholesalePrice fallback ILI prekucana „CENA")
 *     → rabat iz CustomerDiscount (customerId + itemGroupCode; fallback Customer.customerDiscount)
 *       → KAP na Item.maxDiscountPercent (uz upozorenje ako se seče)
 *         → kasa (cashDiscountPercent)
 *           → neto cena (unitPrice) + vatBase + vatAmount po vatRateCode
 *
 * INVARIJANTA (§4.2, važi na SVAKOM izlazu ovog servisa):
 *   `unitPrice == basePrice × (1 − discountPercent/100) × (1 − cashDiscountPercent/100)`
 *   (do zaokruženja rabata na 4 decimale, koliko nosi i kolona).
 *
 * ── DVA ODVOJENA ULAZA ZA PREKUCANU CENU (§4.4 „Zamka u našem kodu" + §8/O2) ──
 * Do 28.07. je postojao samo `overrideUnitPrice`, dokumentovan kao „eksplicitna VP cena",
 * ali korišćen kao BAZNA cena — posle njega se i dalje primenjivao rabat kupca. Ekran koji
 * je poslao dogovorenu KRAJNJU cenu kroz to polje dobijao je umanjenje DRUGI put
 * (85 din + rabat 10% → 76,50 i niko to ne primeti do reklamacije).
 *
 *   `overrideUnitPrice` — kanal „CENA": cena PRE rabata; rabat OSTAJE (odluka vlasnika §8/O2).
 *   `netUnitPrice`      — kanal „NETO": cena POSLE rabata i kase; rabat se računa UNAZAD
 *                          tako da neto bude tačno otkucan iznos.
 *   Oba zajedno → greška. Neto + eksplicitan rabat → greška (neto sam određuje rabat).
 * Tako se rabat primenjuje TAČNO JEDNOM, ma koji kanal ekran koristio.
 *
 * Novac je Prisma.Decimal na svakoj granici (Float izvori — Item.wholesalePrice,
 * Customer.customerDiscount, Item.maxDiscountPercent — konvertuju se u Decimal ODMAH).
 */

const D = Prisma.Decimal;
const ZERO = new D(0);
const HUNDRED = new D(100);

/** Skale kolona: novac Decimal(19,4), procenat Decimal(19,4), količina Decimal(19,6). */
const MONEY_DP = 4;
const PCT_DP = 4;

/** Stope PDV po `vatRateCode` (isto kao posting VAT_RATE_BY_CODE, doc 43 §4). */
const VAT_RATE_BY_CODE: Readonly<Record<string, Prisma.Decimal>> = {
  "3": new D("0.20"), // Osnovna / VISA (20%) — default stavke
  "1": new D("0.20"), // Osnovna (alt kod)
  "2": new D("0.10"), // Zeleznica / NIZA (10%)
  "4": new D("0.08"), // Posebna / POLJO (8%)
  "0": ZERO, // bez PDV (izvoz / oslobođeno)
};

/** Odakle je došla bazna (fakturna) cena — ekran to prikazuje uz cenu (§4.3). */
export type PriceSource =
  /** cenovnik (PriceListEntry.priceWithoutVat) */
  | "PRICE_LIST"
  /** fallback: Item.wholesalePrice (BigBit je ovaj put ugasio — v. §4.3) */
  | "ITEM_WHOLESALE"
  /** nema cene ni u cenovniku ni na artiklu → 0 */
  | "NONE"
  /** operater prekucao cenu PRE rabata (kanal „CENA") */
  | "OVERRIDE"
  /** operater prekucao NETO cenu (kanal „NETO"); rabat izveden unazad */
  | "OVERRIDE_NET";

export interface PricedItem {
  /** actualWholesalePrice — transakciona VP cena po JM (posle rabata/kase). */
  unitPrice: Prisma.Decimal;
  /** bazna (fakturna) VP cena pre rabata (za prikaz/print). */
  basePrice: Prisma.Decimal;
  /**
   * CENA PRE RABATA, spremna za upis u `InvoiceItem.unitPriceBeforeDiscount`:
   * `basePrice × (1 − kasa/100)`, dakle na istoj razmeri kao `unitPrice` samo bez rabata.
   *
   * ZAŠTO NIJE PROSTO `basePrice`: kolona `R%` na papiru tvrdi SAMO rabat. Kad bi štampa
   * bruto računala iz čiste fakturne cene, u red „Rabat" bi upala i kasa — iznos koji taj
   * red ne opisuje. Ovako važi tačno `unitPrice = unitPriceBeforeDiscount × (1 − rabat/100)`,
   * pa je razlika između bruta i osnovice čist rabat.
   *
   * ZAŠTO OVDE, A NE U POZIVAOCIMA: rabat i kasa se primenjuju na jednom mestu
   * (`applyChain`); da svaki pisac sam množi `basePrice` sa kasom, prvi koji to zaboravi
   * proizveo bi tih, nedokaziv rabat na papiru.
   */
  unitPriceBeforeDiscount: Prisma.Decimal;
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

  // ── Dodato uz price-preview rutu (§5.7) ──
  /** PDV stopa kao procenat (20 / 10 / 8 / 0) — za prikaz na ekranu. */
  vatRatePercent: Prisma.Decimal;
  /** najveći dozvoljeni rabat za artikal (Item.maxDiscountPercent, default 100). */
  maxDiscountPercent: Prisma.Decimal;
  /** poreklo bazne cene. */
  priceSource: PriceSource;
  /** true kad je cena prekucana (bilo kojim kanalom) — ekran je vizuelno obeležava (§8/O2). */
  priceOverridden: boolean;
  /** nabavna neto iz zaliha magacina (za RUC); null kad magacin nije zadat ili nema zaliha. */
  purchasePriceNet: Prisma.Decimal | null;
  /** RUC % = (unitPrice − nabavna)/nabavna × 100; null kad nabavna nije poznata ili je 0. */
  markupPercent: Prisma.Decimal | null;
  /** meka upozorenja na srpskom (kap rabata, nepoznata poreska šifra, cena ispod nabavne…). */
  warnings: string[];
}

export interface PriceItemArgs {
  customerId?: number | null;
  itemId?: number | null;
  itemGroupCode?: string | null;
  quantity: number | Prisma.Decimal;
  /** documentTypeCode (npr. "IFR") — fallback ključ cenovnika kad `priceListCode` nije zadat. */
  documentType?: string;
  /**
   * Šifra cenovnika (BigBit `ComboCenovnik`, kolona `price_list_entries.document_type_code`).
   * Ima prioritet nad `documentType` — §4.3: cenovnik se vezuje za dokument, ne za vrstu.
   */
  priceListCode?: string | null;
  /** magacin — za nabavnu neto i RUC (§4.3); bez njega su oba null. */
  warehouseId?: number | null;
  /** eksplicitan rabat/kasa iz unosa (ako je zadat, ima prioritet nad rabatnom politikom). */
  requestedDiscountPercent?: number | Prisma.Decimal | null;
  cashDiscountPercent?: number | Prisma.Decimal | null;
  /**
   * Kanal „CENA" — prekucana FAKTURNA cena (PRE rabata). Preskače cenovnik,
   * ali rabat i kasa se i dalje primenjuju (odluka vlasnika §8/O2).
   */
  overrideUnitPrice?: number | Prisma.Decimal | null;
  /**
   * Kanal „NETO" — prekucana NETO cena (POSLE rabata i kase, „pade na 85 dinara").
   * Rabat se izvodi unazad da neto bude tačno ovaj iznos; NE sme uz `overrideUnitPrice`
   * ni uz `requestedDiscountPercent`.
   */
  netUnitPrice?: number | Prisma.Decimal | null;
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

  private round(v: Prisma.Decimal, dp: number): Prisma.Decimal {
    return v.toDecimalPlaces(dp, D.ROUND_HALF_UP);
  }

  /**
   * Lanac cene — JEDINO mesto gde se rabat i kasa primenjuju. Sve grane prolaze
   * ovuda, pa dvostruko umanjenje nije moguće ni jednim ulazom.
   */
  private applyChain(
    basePrice: Prisma.Decimal,
    discountPercent: Prisma.Decimal,
    cashDiscountPercent: Prisma.Decimal,
  ): Prisma.Decimal {
    const afterDiscount = basePrice.mul(
      HUNDRED.sub(discountPercent).div(HUNDRED),
    );
    return afterDiscount.mul(HUNDRED.sub(cashDiscountPercent).div(HUNDRED));
  }

  /**
   * Izračunaj cenu jedne stavke. Bez side-effekata (čist read).
   *
   * Baca 400 na protivrečan unos (oba kanala cene; neto + rabat; negativna cena) —
   * tiho „razrešavanje" protivrečnosti je upravo ono što je pravilo dvostruko umanjenje.
   */
  async priceItem(args: PriceItemArgs): Promise<PricedItem> {
    const hasOverride =
      args.overrideUnitPrice !== null && args.overrideUnitPrice !== undefined;
    const hasNet = args.netUnitPrice !== null && args.netUnitPrice !== undefined;
    const hasRequestedDiscount =
      args.requestedDiscountPercent !== null &&
      args.requestedDiscountPercent !== undefined;

    // ── BRANA 1 (§4.4): dva kanala prekucane cene se ISKLJUČUJU ──────────────
    if (hasOverride && hasNet) {
      throw new BadRequestException(
        "Pošaljite ili cenu (pre rabata) ili neto cenu (posle rabata), ne obe.",
      );
    }
    // ── BRANA 2: neto cena SAMA određuje rabat — eksplicitan rabat bi bio drugo umanjenje ──
    if (hasNet && hasRequestedDiscount) {
      throw new BadRequestException(
        "Neto cena sama određuje rabat — ne šaljite i rabat uz nju.",
      );
    }

    const quantity = this.toDecimal(args.quantity);

    // ── BRANA 3: negativan novac nikad nije ispravan unos ────────────────────
    const overrideValue = this.toDecimal(args.overrideUnitPrice);
    const netValue = this.toDecimal(args.netUnitPrice);
    if (hasOverride && overrideValue.lessThan(ZERO)) {
      throw new BadRequestException("Cena ne sme biti negativna.");
    }
    if (hasNet && netValue.lessThan(ZERO)) {
      throw new BadRequestException("Neto cena ne sme biti negativna.");
    }

    const warnings: string[] = [];

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

    // ── 1) Bazna (fakturna) cena + poreklo ──
    let basePrice: Prisma.Decimal;
    let priceSource: PriceSource;
    if (hasOverride) {
      basePrice = overrideValue;
      priceSource = "OVERRIDE";
    } else {
      const resolved = await this.resolveBasePrice(
        args.itemId,
        args.priceListCode ?? args.documentType,
        item,
      );
      basePrice = resolved.price;
      priceSource = resolved.source;
    }

    // ── 2) Kasa (uvek iz unosa; rabatna politika je danas ne nosi — v. §4.4b) ──
    let cashDiscountPercent = this.toDecimal(args.cashDiscountPercent);
    if (cashDiscountPercent.lessThan(ZERO)) cashDiscountPercent = ZERO;
    if (cashDiscountPercent.greaterThan(HUNDRED)) {
      cashDiscountPercent = HUNDRED; // brana: kasa > 100% bi dala negativnu cenu
      warnings.push("Kasa-skonto je ograničen na 100%.");
    }

    // ── 3) Rabat ──
    const maxDiscount = this.capPercent(
      this.toDecimal(item?.maxDiscountPercent ?? 100),
    );
    let discountPercent: Prisma.Decimal;
    let discountCapped = false;
    let unitPrice: Prisma.Decimal;

    if (hasNet) {
      // Kanal „NETO" — rabat UNAZAD (§8/O2). Rabat kupca se NE dodaje: neto je konačan.
      priceSource = "OVERRIDE_NET";
      const derived = this.deriveDiscountFromNet(
        basePrice,
        netValue,
        cashDiscountPercent,
      );
      basePrice = derived.basePrice;
      discountPercent = derived.discountPercent;

      if (discountPercent.greaterThan(maxDiscount)) {
        // Kap je poslovna brana i pobeđuje otkucanu neto cenu — ali GLASNO.
        discountPercent = maxDiscount;
        discountCapped = true;
        unitPrice = this.round(
          this.applyChain(basePrice, discountPercent, cashDiscountPercent),
          MONEY_DP,
        );
        warnings.push(
          `Neto cena ${netValue.toFixed(MONEY_DP)} traži rabat veći od najvećeg dozvoljenog za artikal (${maxDiscount.toFixed(2)}%) — cena je vraćena na ${unitPrice.toFixed(MONEY_DP)}.`,
        );
      } else {
        // Otkucana neto cena je istina; rabat je izveden i primenjen TAČNO JEDNOM.
        unitPrice = this.round(netValue, MONEY_DP);
      }
    } else {
      if (hasRequestedDiscount) {
        discountPercent = this.toDecimal(args.requestedDiscountPercent);
      } else {
        discountPercent = await this.resolveDiscount(
          args.customerId,
          itemGroupCode,
        );
      }
      // KAP na Item.maxDiscountPercent
      if (discountPercent.greaterThan(maxDiscount)) {
        discountPercent = maxDiscount;
        discountCapped = true;
        warnings.push(
          `Rabat je odsečen na najveći dozvoljeni za artikal (${maxDiscount.toFixed(2)}%).`,
        );
      }
      if (discountPercent.lessThan(ZERO)) discountPercent = ZERO;
      unitPrice = this.applyChain(
        basePrice,
        discountPercent,
        cashDiscountPercent,
      );
    }

    // ── 4) Osnovica + PDV ──
    const vatBase = quantity.mul(unitPrice);
    const rate = VAT_RATE_BY_CODE[vatRateCode];
    if (rate === undefined) {
      // Tiha nula na nepoznatoj šifri je bila neprimetna — sad se bar prijavi.
      warnings.push(
        `Nepoznata poreska šifra „${vatRateCode}" — PDV je obračunat kao 0%.`,
      );
    }
    const vatRate = rate ?? ZERO;
    const vatAmount = vatBase.mul(vatRate);
    const lineTotal = vatBase.add(vatAmount);

    // ── 5) Nabavna neto + RUC (samo uz magacin; §4.3/§5) ──
    const { purchasePriceNet, markupPercent } = await this.resolveMargin(
      args.itemId,
      args.warehouseId,
      unitPrice,
      warnings,
    );

    // Cena PRE rabata (posle kase) — jedini trag pune cene koji ostaje u bazi. Računa se
    // iz ISTE `basePrice` i ISTE kase koje su ušle u `unitPrice`, pa i posle kanala „NETO"
    // (gde je `basePrice` mogla da se podigne) ostaje tačno na istoj razmeri kao `unitPrice`.
    const unitPriceBeforeDiscount = this.round(
      basePrice.mul(HUNDRED.sub(cashDiscountPercent).div(HUNDRED)),
      MONEY_DP,
    );

    return {
      unitPrice,
      basePrice,
      unitPriceBeforeDiscount,
      discountPercent,
      cashDiscountPercent,
      quantity,
      vatRateCode,
      vatBase,
      vatAmount,
      lineTotal,
      discountCapped,
      vatRatePercent: vatRate.mul(HUNDRED),
      maxDiscountPercent: maxDiscount,
      priceSource,
      priceOverridden: hasOverride || hasNet,
      purchasePriceNet,
      markupPercent,
      warnings,
    };
  }

  /** Procenat u [0, 100] — brana od negativne cene iz pokvarenog šifarnika. */
  private capPercent(p: Prisma.Decimal): Prisma.Decimal {
    if (p.lessThan(ZERO)) return ZERO;
    if (p.greaterThan(HUNDRED)) return HUNDRED;
    return p;
  }

  /**
   * Kanal „NETO" (§8/O2): rabat unazad iz otkucane neto cene.
   *
   *   neto = F × (1 − r/100) × (1 − k/100)  ⇒  r = 100 × (1 − neto / (F × (1 − k/100)))
   *
   * Kad je neto IZNAD fakturne (ili fakturne nema), rabat je 0 a fakturna se podiže na
   * `neto / (1 − k/100)` — invarijanta ostaje tačna i „cena pre rabata" na štampi je
   * doslednija nego negativan rabat.
   */
  private deriveDiscountFromNet(
    basePrice: Prisma.Decimal,
    net: Prisma.Decimal,
    cashDiscountPercent: Prisma.Decimal,
  ): { basePrice: Prisma.Decimal; discountPercent: Prisma.Decimal } {
    const cashFactor = HUNDRED.sub(cashDiscountPercent).div(HUNDRED);
    if (cashFactor.lessThanOrEqualTo(ZERO)) {
      // Kasa 100% — neto je po definiciji 0, rabat nema šta da objasni.
      return { basePrice, discountPercent: ZERO };
    }
    const grossAfterCash = basePrice.mul(cashFactor);
    if (grossAfterCash.lessThanOrEqualTo(ZERO) || net.greaterThan(grossAfterCash)) {
      return {
        basePrice: this.round(net.div(cashFactor), MONEY_DP),
        discountPercent: ZERO,
      };
    }
    const discountPercent = this.round(
      HUNDRED.sub(net.div(grossAfterCash).mul(HUNDRED)),
      PCT_DP,
    );
    return { basePrice, discountPercent: this.capPercent(discountPercent) };
  }

  /**
   * Bazna cena: PriceListEntry.priceWithoutVat po (itemId, šifra cenovnika) →
   * fallback Item.wholesalePrice → 0, uz poreklo. `wholesalePrice` je Decimal u šemi
   * (migracija Float → Decimal), pa `toDecimal` ovde samo propušta vrednost dalje —
   * novac nikad ne prolazi kroz Float.
   *
   * NAPOMENA (§4.3): BigBit redosled je „poslednja kalkulacija za magacin → prosečna
   * nabavna → cenovnik", i put „cena iz artikla" je namerno ugašen 2009. Ovde je i dalje
   * stari redosled — menjanje bi promenilo cene na živom `createProforma` toku i traži
   * rutu `GET /robno/poslednja-kalkulacija` (v. izveštaj).
   */
  private async resolveBasePrice(
    itemId: number | null | undefined,
    priceListKey: string | null | undefined,
    item: { wholesalePrice: Prisma.Decimal | null } | null,
  ): Promise<{ price: Prisma.Decimal; source: PriceSource }> {
    if (itemId != null) {
      const entry = await this.prisma.priceListEntry.findFirst({
        where: {
          itemId,
          ...(priceListKey ? { documentTypeId: priceListKey } : {}),
        },
        select: { priceWithoutVat: true },
      });
      if (entry?.priceWithoutVat != null && !entry.priceWithoutVat.equals(ZERO)) {
        return { price: entry.priceWithoutVat, source: "PRICE_LIST" };
      }
    }
    const fallback = this.toDecimal(item?.wholesalePrice ?? 0);
    return {
      price: fallback,
      source: fallback.equals(ZERO) ? "NONE" : "ITEM_WHOLESALE",
    };
  }

  /**
   * Nabavna neto + RUC iz snapshot-a zaliha magacina (`stock_levels`):
   * prosečna nabavna → poslednja nabavna kad prosek nije obračunat.
   * Bez magacina ili bez reda → oba null (ekran tada ne prikazuje RUC, ne izmišlja ga).
   */
  private async resolveMargin(
    itemId: number | null | undefined,
    warehouseId: number | null | undefined,
    unitPrice: Prisma.Decimal,
    warnings: string[],
  ): Promise<{
    purchasePriceNet: Prisma.Decimal | null;
    markupPercent: Prisma.Decimal | null;
  }> {
    if (itemId == null || warehouseId == null) {
      return { purchasePriceNet: null, markupPercent: null };
    }
    const level = await this.prisma.stockLevel.findUnique({
      where: { itemId_warehouseId: { itemId, warehouseId } },
      select: { avgPurchaseNet: true, lastPurchaseNet: true },
    });
    if (!level) return { purchasePriceNet: null, markupPercent: null };

    const purchase = !level.avgPurchaseNet.equals(ZERO)
      ? level.avgPurchaseNet
      : level.lastPurchaseNet;
    if (purchase.equals(ZERO)) {
      return { purchasePriceNet: ZERO, markupPercent: null };
    }
    const markupPercent = this.round(
      unitPrice.sub(purchase).div(purchase).mul(HUNDRED),
      PCT_DP,
    );
    if (unitPrice.lessThan(purchase)) {
      warnings.push(
        `Cena je ispod nabavne (${purchase.toFixed(MONEY_DP)}) — razlika u ceni je negativna.`,
      );
    }
    return { purchasePriceNet: purchase, markupPercent };
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
