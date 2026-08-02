import { Prisma } from "@prisma/client";
import { VAT_RATE_BY_CODE } from "../gl/posting/vat-rates";

/**
 * PDV ZBIROVI DOKUMENTA — JEDNO PRAVILO ZA CEO IZLAZNI RAČUN.
 * =============================================================================
 *
 *   osnovica_stope = Σ zaokruženih osnovica stavki te stope
 *   PDV_stope      = round2(osnovica_stope × stopa)
 *   vatTotal       = Σ PDV_stope        grossTotal = netTotal + vatTotal
 *
 * ⚠️ IZMEREN KVAR KOJI JE OVO IZAZVAO (02.08.2026, peti krug provere)
 * ─────────────────────────────────────────────────────────────────────────────
 * Do ove izmene je `vatTotal` bio ZBIR PDV-a PO STAVCI. Dok je PDV stavke bio
 * nezaokružen, to je davalo isti broj po distributivnosti (Σ (o_i × s) ≡ s × Σ o_i).
 * Čim je i PDV stavke zaokružen na paru — a jeste, istog dana, da bi `osnovica × stopa`
 * moglo da se ponovi nad odštampanom stavkom — jednakost pada:
 *
 *     5 stavki × 1 kom × 100,01 din, stopa 20 %
 *       osnovica dokumenta   500,05
 *       Σ PDV po stavci      5 × round2(20,002) = 5 × 20,00 = 100,00
 *       500,05 × 20 %                              = 100,01   ← razlika 0,01
 *
 * Monte Carlo nad 20.000 nasumičnih dokumenata: na 5 stavki se razilazi 43,7 %
 * dokumenata, na 20 stavki 69,4 % i do 0,05 din; na stopi 10 % do 0,06 din.
 *
 * TRI MESTA NA KOJIMA TO NIJE KOZMETIKA:
 *
 *  1. PAPIR. Zbirni blok štampa `PDV po stopi 20 %` sa osnovicom i iznosom u istom redu
 *     (`print/templates/totals.ts`). Sa starim pravilom je izlazilo
 *     `20 %  500,05  100,00` — množenje odštampanih brojeva NE daje odštampan rezultat.
 *     Doneti papir `IFR.pdf` (657/25) tu jednačinu drži tačnu: `99.363,64 × 20 % =
 *     19.872,73`.
 *  2. SEF / UBL. `cac:TaxSubtotal` nosi `TaxableAmount`, `TaxAmount` i `Percent`;
 *     EN 16931 pravilo **BR-CO-17** traži `TaxAmount = round2(TaxableAmount × Percent/100)`.
 *     Dokument sa razlikom od pare je formalno neispravan.
 *  3. KIF. `pdv/vat-ledger.service.ts` osnovicu IZVODI iz PDV-a (`vat / (stopa/100)`),
 *     pa je iz PDV-a 100,00 dobijao osnovicu 500,00 dok je faktura glasila na 500,05.
 *
 * ZAŠTO NA NIVOU DOKUMENTA PO STOPI, A NE PO STAVCI: PDV je po zakonu (i po EN 16931)
 * obaveza po PROMETU I STOPI, ne po redu u tabeli. UBL na stavci uopšte nema element za
 * iznos poreza — stavka nosi samo osnovicu (`LineExtensionAmount`), i jedino za nju
 * postoji pravilo zbira (BR-CO-10: Σ osnovica stavki = `LineExtensionAmount` dokumenta).
 * Zato osnovica JESTE zbir stavki, a porez NIJE.
 *
 * `InvoiceItem.vatAmount` zato ostaje IZVEDENA INFORMACIJA (kolona „PDV" na stavci,
 * i osnov iz kog štampa računa efektivnu stopu reda) — ali se VIŠE NIGDE NE SABIRA
 * da bi se dobio porez dokumenta. Ko sabira, sabira preko ovog modula.
 *
 * ── ODBRANA PRI SABIRANJU (nalaz S2) ────────────────────────────────────────────
 * Osnovica svake stavke se ovde ponovo zaokružuje na paru pre sabiranja. Iznosi koje
 * piše `PricingService` su već zaokruženi, pa to nad njima ne menja ništa; ali kolona
 * je `Decimal(19,4)` i primiće nezaokružen red iz uvoza, ručne ispravke u bazi ili
 * budućeg BigBit uvoza. Bez ovog zaokruženja bi JEDAN takav red oborio zbir celog
 * dokumenta, a papir bi opet imao kolonu koja se ne sabira u svoj međuzbir.
 * (Na produkciji danas nema nijedne fakture ni stavke — izmereno 0/0 — pa migracija
 * zatečenih podataka nije potrebna; ova odbrana je za ono što tek dolazi.)
 */

/**
 * Mapa stopa se prosleđuje dalje kao deo ovog modula: prodaja je čita ODAVDE (i stavka i
 * zaglavlje), pa u modulu prodaje ne postoji nijedan drugi spisak PDV stopa.
 */
export { VAT_RATE_BY_CODE };

const D = Prisma.Decimal;
const ZERO = new D(0);
const HUNDRED = new D(100);

/** Skala novčanog IZNOSA — para. Ista kao `AMOUNT_DP` u `pricing.service.ts`. */
export const AMOUNT_DP = 2;

/** Zaokruži novčani iznos na paru (ROUND_HALF_UP, kao svuda u obračunu). */
export function roundAmount(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(AMOUNT_DP, D.ROUND_HALF_UP);
}

/**
 * Stopa kao RAZLOMAK (0,20) po `vatRateCode`. Nepoznata ili prazna šifra → 0.
 *
 * Mapa je JEDNA za ceo sistem (`gl/posting/vat-rates.ts`, deli je i robna kalkulacija):
 * kad bi zaglavlje računalo po jednoj tabeli stopa a stavka po drugoj, invarijanta
 * `vatTotal == round2(netTotal_stope × stopa)` bi pukla tiho i bez ijedne izmene koda.
 */
export function vatRateOf(code: string | null | undefined): Prisma.Decimal {
  if (code == null) return ZERO;
  return VAT_RATE_BY_CODE[code] ?? ZERO;
}

/** Stopa kao PROCENAT (20) — za `cbc:Percent`, papir i poruke o greškama. */
export function vatPercentOf(code: string | null | undefined): Prisma.Decimal {
  return vatRateOf(code).mul(HUNDRED);
}

/** Jedna PDV grupa dokumenta: sve stavke iste stope. */
export interface VatRateGroup {
  /** Šifra stope (`"3"`, `"2"`, `"4"`, `"0"`…) — takva kakva je na stavkama grupe. */
  vatRateCode: string;
  /** Stopa u procentima (20 / 10 / 8 / 0). */
  ratePercent: Prisma.Decimal;
  /** Osnovica grupe = Σ zaokruženih osnovica stavki. */
  base: Prisma.Decimal;
  /** PDV grupe = `round2(base × stopa)` — jedini ispravan izvor poreza. */
  vat: Prisma.Decimal;
}

export interface DocumentVatTotals {
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  /** Grupe, opadajuće po stopi (20, 10, 8, 0) — determinističan redosled za XML i papir. */
  groups: VatRateGroup[];
}

/** Minimum koji jedna stavka mora da ponudi da bi ušla u zbir. */
export interface VatTotalsLine {
  vatRateCode?: string | null;
  vatBase: Prisma.Decimal;
}

/**
 * ZBIROVI DOKUMENTA IZ STAVKI — jedini računar za `netTotal`/`vatTotal`/`grossTotal`.
 *
 * `isExport` obara sve stavke u stopu `"0"` (kategorija Z, čl. 24): izvozni račun ne
 * sme da nosi obračunat PDV ni kad je stavka nasledila domaću poresku šifru.
 */
export function documentVatTotals(
  lines: ReadonlyArray<VatTotalsLine>,
  opts: { isExport?: boolean } = {},
): DocumentVatTotals {
  const byCode = new Map<string, { base: Prisma.Decimal }>();

  for (const line of lines) {
    const code = opts.isExport ? "0" : (line.vatRateCode ?? "0");
    const acc = byCode.get(code) ?? { base: ZERO };
    // Zaokruženje PRE sabiranja — v. „ODBRANA PRI SABIRANJU" u uvodu fajla.
    acc.base = acc.base.add(roundAmount(line.vatBase));
    byCode.set(code, acc);
  }

  const groups: VatRateGroup[] = [...byCode.entries()]
    .map(([vatRateCode, { base }]) => ({
      vatRateCode,
      ratePercent: vatPercentOf(vatRateCode),
      base,
      // ⚠️ OVDE JE CELA ISPRAVKA: porez se računa iz OSNOVICE GRUPE, ne sabiranjem
      // poreza po stavkama. `500,05 × 20 % = 100,01`, a ne `5 × 20,00 = 100,00`.
      vat: roundAmount(base.mul(vatRateOf(vatRateCode))),
    }))
    .sort((a, b) => b.ratePercent.comparedTo(a.ratePercent));

  let netTotal = ZERO;
  let vatTotal = ZERO;
  for (const g of groups) {
    netTotal = netTotal.add(g.base);
    vatTotal = vatTotal.add(g.vat);
  }

  return { netTotal, vatTotal, grossTotal: netTotal.add(vatTotal), groups };
}
