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
 * `InvoiceItem.vatAmount` zato ostaje IZVEDENA INFORMACIJA — ali se VIŠE NIGDE NE SABIRA
 * da bi se dobio porez dokumenta, niti se iz njega izvodi stopa. Ko sabira, sabira preko
 * ovog modula; ko traži stopu, traži je po ŠIFRI (`vatPercentOf`). Od 02.08.2026. je
 * skinut i sa ekrana detalja računa (`frontend/.../fakturisanje/detalj/page.tsx`), jer je
 * kolona „PDV" po stavci tvrdila drugi porez nego zbirni blok ispod nje.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DOPUNA 02.08.2026 (šesti krug) — JEDAN KLJUČ GRUPISANJA I OBJAVLJEN POREZ
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Pravilo iznad je bilo tačno, ali sprovedeno u TRI računara sa TRI ključa:
 *
 *   zaglavlje (`documentVatTotals`)         grupisalo po ŠIFRI       (`byCode`)
 *   e-faktura (`groupTaxSubtotals`)         grupisalo po STOPI       (`byPercent`)
 *   papir     (`buildVatRecap`)             grupisalo po EFEKTIVNOJ stopi iz iznosa
 *
 * IZMERENO (nalaz R3) na šiframa „1" i „3", koje su TADA obe bile 20 % u
 * `VAT_RATE_BY_CODE`. Račun sa dve stavke po 100,03 din, jedna sa šifrom „3" a druga „1":
 *
 *   zaglavlje  2 grupe × round2(100,03 × 20 %) = 20,01 + 20,01 = 40,02
 *   e-faktura  1 grupa  × round2(200,06 × 20 %)             = 40,01   → BR-CO-14 pada
 *   papir      200,06 + 40,01 = 240,07, a „Ukupno" ispod    = 240,08
 *
 * Najmanji ulaz koji to pokazuje su osnovice 0,01 i 0,02 pod dve šifre iste stope
 * (`round2(0,002) + round2(0,004) = 0,00` po šifri, a `round2(0,03 × 20 %) = 0,01`).
 * Zato od ove izmene postoji JEDNA funkcija grupisanja — `vatBreakdown` — i JEDAN
 * ključ: **(poreska kategorija, stopa)**. Ključ je izabran po tome šta traži
 * e-faktura, jer je ona jedini potrošač koji ima formalnu proveru: EN 16931 BG-23
 * („VAT BREAKDOWN") nosi tačno jednu grupu po paru BT-118 (kategorija: S/Z/E) +
 * BT-119 (stopa). Dve šifre iste stope su isti par (npr. (S, 20)) → JEDNA grupa svuda.
 * Uz to nestaje i nalaz S4: prazna šifra `""`, šifra `"0"` i nepoznata `"9"` su sve
 * (E, 0) — jedna grupa, a ne tri `TaxSubtotal`-a od po 0 %.
 *
 * ⚠️ Mapa stopa je istog dana ispravljena po stvarnim redovima `R_Tarife` (šifra „1" je
 * BEZPDV 0 %, „2" ne postoji, „4" je NIZA 10 %), pa par sa istom stopom danas čine „3" i
 * „6" (obe 20 %). Izmereni brojevi se ne menjaju — ključ i jeste STOPA, ne šifra — a
 * testovi par IZVODE IZ MAPE, da ne zastare uz sledeću njenu ispravku.
 *
 * ── ZAŠTO `documentVatTotal` (nalazi R1 i R2) ────────────────────────────────
 * AVANSNI RAČUN POREZ NE MNOŽI NEGO DELI. `advance-invoice.service.ts` zove
 * `grossToNet` (pdv/vat-bridge.util): iz BRUTA koji je kupac stvarno uplatio izvodi
 * osnovicu, a porez dobija RAZLIKOM (`PDV = bruto − osnovica`), da zbir uvek zatvori.
 * Za takav dokument `round2(osnovica × stopa)` NE MORA da vrati upisani porez:
 *
 *   AVR bruto 132,03 uz 20 %:  osnovica = round2(132,03 / 1,2) = 110,03
 *                              porez    = 132,03 − 110,03      =  22,00   (u GK i zaglavlju)
 *                              round2(110,03 × 20 %)           =  22,01   ← druga para
 *
 * Brute force nad SVIM bruto iznosima 1,00–100.000,00 (9.999.901 iznos): razilazi se
 * **16,67 %** avansa po stopi od 20 % i **9,09 %** po stopi od 10 %. To NIJE greška
 * zaokruživanja koju treba popraviti — za tih 1/6 iznosa **ne postoji osnovica za koju
 * obe jednačine važe**: `f(B) = B + round2(0,2·B)` preskače baš te bruto iznose
 * (110,02 → 132,02; 110,03 → 132,04; 132,03 nije u slici funkcije).
 *
 * ODLUKA (šesti krug): prednost ima **unutrašnja doslednost**. Bruto avansa je stvarno
 * naplaćen novac i ostaje tačan, a zaglavlje, papir i e-faktura MORAJU reći isti broj.
 * Zato dokument koji je porez izveo iz bruta taj porez **objavljuje** kroz
 * `documentVatTotal`, a grupe ga preuzimaju umesto da ga ponovo množe:
 *
 *   papir:      20 % | 110,03 | 22,00 | 132,03   ← „Ukupno za uplatu" 132,03 se poklapa
 *   e-faktura:  BT-110 = 22,00 = Σ BT-117        ← BR-CO-14 ✔, BR-CO-15 ✔
 *
 * CENA KOJU SVESNO PLAĆAMO: kod tih 16,67 % avansa `cac:TaxSubtotal` obara **BR-CO-17**
 * (`TaxAmount = round2(TaxableAmount × Percent/100)`) za tačno 0,01. To je svojstvo
 * PRERAČUNATE STOPE, a ne kvar: porez avansa se po zakonu dobija iz bruta
 * (20/120 = 16,6667 %), pa nijedna osnovica ne može istovremeno da zadovolji i
 * `osnovica + porez = bruto` i `porez = osnovica × 20 %`. Ranije je isti taj AVR obarao
 * BR-CO-17 preko zbira po stavci, a od pete ispravke je obarao BR-CO-14 i lagao papir —
 * dakle biramo koji jedan prekršaj ostaje, a ne da li ga uopšte ima. Zapisano i u
 * `backend/docs/PREOSTALE_FAZE.md`, odeljak „🔶 OTVORENO NA DAN 01.08.2026".
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

/**
 * PDV KATEGORIJA (EN 16931 BT-118 / `cac:TaxCategory/cbc:ID`):
 *   S — standardna ili snižena stopa (>0 %), domaći promet
 *   Z — izvoz / oslobođeno SA pravom na odbitak (0 %, uz osnov čl. 24)
 *   E — domaće oslobođenje BEZ izvoznog osnova (0 %)
 *
 * Zajednička je za zbirove, papir i UBL: kategorija je pola ključa grupisanja, pa bi
 * dve definicije značile dve podele istog dokumenta.
 */
export type VatCategory = "S" | "Z" | "E";

export function vatCategoryOf(
  ratePercent: Prisma.Decimal,
  isExport: boolean,
): VatCategory {
  if (ratePercent.greaterThan(ZERO)) return "S";
  return isExport ? "Z" : "E";
}

/** Jedna PDV grupa dokumenta: sve stavke iste KATEGORIJE i STOPE. */
export interface VatRateGroup {
  /** Stopa u procentima (20 / 10 / 8 / 0). */
  ratePercent: Prisma.Decimal;
  /** Poreska kategorija grupe (S / Z / E) — druga polovina ključa. */
  category: VatCategory;
  /** Osnovica grupe = Σ zaokruženih osnovica stavki. */
  base: Prisma.Decimal;
  /**
   * PDV grupe. Podrazumevano `round2(base × stopa)`; kad dokument objavi svoj porez
   * (`documentVatTotal` — avans), nosi OBJAVLJENI iznos. V. uvod fajla, „R1/R2".
   */
  vat: Prisma.Decimal;
}

export interface DocumentVatTotals {
  netTotal: Prisma.Decimal;
  vatTotal: Prisma.Decimal;
  grossTotal: Prisma.Decimal;
  /** Grupe, opadajuće po stopi (20, 10, 8, 0) — determinističan redosled za XML i papir. */
  groups: VatRateGroup[];
}

/**
 * Minimum koji jedan red mora da ponudi da bi ušao u grupisanje.
 *
 * Stopa se daje NA JEDAN OD DVA NAČINA, jer je dobijaju dva različita pozivaoca:
 *   • `vatRateCode` — stavka iz baze (`invoice_items.vat_rate_code`); stopa se izvodi
 *     iz `VAT_RATE_BY_CODE`, iste mape iz koje je porez i obračunat;
 *   • `ratePercent` — štampa (`PrintLine`), koja šifru ne prenosi nego već razrešen
 *     procenat — ali iz TE ISTE mape (v. `InvoicePdfService.loadPrintCtx`).
 * Kad su data oba, prednost ima `ratePercent` (pozivalac ga je već razrešio).
 */
export interface VatTotalsLine {
  vatRateCode?: string | null;
  ratePercent?: Prisma.Decimal | number | null;
  vatBase: Prisma.Decimal;
}

export interface VatBreakdownOptions {
  /** Izvoz obara SVE redove na 0 % / kategoriju Z (čl. 24), ma kakvu šifru nosili. */
  isExport?: boolean;
  /**
   * POREZ KOJI JE DOKUMENT OBJAVIO (`invoice.vat_total`) — prosleđuje ga svako ko
   * PRIKAZUJE postojeći dokument (papir, e-faktura), a NIKAD onaj ko ga tek računa.
   * V. uvod fajla: avans porez izvodi deljenjem, pa ga grupe preuzimaju umesto da ga
   * ponovo množe. Bez njega grupe nose `round2(base × stopa)`.
   */
  documentVatTotal?: Prisma.Decimal | null;
}

function resolveRatePercent(line: VatTotalsLine): Prisma.Decimal {
  if (line.ratePercent != null) return new D(line.ratePercent);
  return vatPercentOf(line.vatRateCode);
}

/**
 * JEDINA FUNKCIJA GRUPISANJA PDV-a U SISTEMU. Ključ = **(kategorija, stopa)**.
 *
 * Zovu je zaglavlje (`documentVatTotals`), papir (`buildVatRecap`, `vatSummaryRows`) i
 * e-faktura (`groupTaxSubtotals`). Ko grupiše mimo nje, pravi četvrtu podelu istog
 * dokumenta — a upravo su tri različite podele bile nalaz R3 (v. uvod fajla).
 */
export function vatBreakdown(
  lines: ReadonlyArray<VatTotalsLine>,
  opts: VatBreakdownOptions = {},
): VatRateGroup[] {
  const byKey = new Map<
    string,
    { ratePercent: Prisma.Decimal; category: VatCategory; base: Prisma.Decimal }
  >();

  for (const line of lines) {
    const ratePercent = opts.isExport ? ZERO : resolveRatePercent(line);
    const category = vatCategoryOf(ratePercent, opts.isExport ?? false);
    // Ključ nosi OBA dela (BT-118 + BT-119). Sam procenat ne bi bio dovoljan: izvozna
    // 0 % (Z) i domaća oslobođena 0 % (E) su u UBL-u dve grupe sa različitim osnovom
    // oslobođenja. Normalizacija na dve decimale spaja `20` i `20.00`.
    const key = `${category}|${ratePercent.toFixed(2)}`;
    const acc = byKey.get(key) ?? { ratePercent, category, base: ZERO };
    // Zaokruženje PRE sabiranja — v. „ODBRANA PRI SABIRANJU" u uvodu fajla.
    acc.base = acc.base.add(roundAmount(line.vatBase));
    byKey.set(key, acc);
  }

  const groups: VatRateGroup[] = [...byKey.values()]
    .map((g) => ({
      ...g,
      // ⚠️ Porez iz OSNOVICE GRUPE, ne sabiranjem poreza po stavkama:
      // `500,05 × 20 % = 100,01`, a ne `5 × 20,00 = 100,00`.
      vat: roundAmount(g.base.mul(g.ratePercent).div(HUNDRED)),
    }))
    .sort((a, b) => b.ratePercent.comparedTo(a.ratePercent));

  applyPublishedVatTotal(groups, lines.length, opts.documentVatTotal);
  return groups;
}

/**
 * PREUZMI POREZ KOJI JE DOKUMENT OBJAVIO — ali samo koliko je zaokruživanje moglo da
 * napravi, i nikad na promet bez poreza.
 *
 * ⚠️ ZAŠTO GRANICA, A NE SLEPO PREUZIMANJE: bez nje bi dokument sa pokvarenim
 * zaglavljem (`vat_total = 0` uz osnovicu od 500,00 — ručna izmena u bazi, prekinut
 * uvoz) tiho dobio papir i e-fakturu koji ga POTVRĐUJU: red „20 % | 500,00 | 0,00" i
 * `TaxSubtotal` sa nulom poreza. Zato se preuzima samo razlika koja MOŽE biti posledica
 * zaokruživanja: svaki red doprinosi najviše pola pare, pa `n` redova daje najviše
 * `0,005 × (n + 1)`, što je za `n ≥ 1` uvek ≤ `0,01 × n`. Preko toga se ne dira ništa —
 * neslaganje ostaje VIDLJIVO (crveni kontrolni red na papiru, odbijanje na SEF-u)
 * umesto da bude zaglađeno.
 *
 * Izmereni slučajevi koje granica pokriva: AVR (jedan red, razlika 0,01 — v. uvod) i
 * zatečeni dokument kome je zaglavlje upisano po STAROM pravilu (Σ poreza po stavci:
 * 5 stavki × 100,01 → razlika 0,01; 20 stavki → do 0,05).
 *
 * Razlika ide na grupu sa NAJVEĆOM OSNOVICOM MEĐU OPOREZOVANIMA (stopa > 0), gde je
 * relativno najmanja. Grupa sa 0 % je namerno isključena: para poreza na oslobođenom
 * prometu je poreska tvrdnja, ne zaokruživanje.
 */
function applyPublishedVatTotal(
  groups: VatRateGroup[],
  lineCount: number,
  documentVatTotal: Prisma.Decimal | null | undefined,
): void {
  if (documentVatTotal == null || groups.length === 0) return;

  const computed = groups.reduce((sum, g) => sum.add(g.vat), ZERO);
  const drift = roundAmount(documentVatTotal).sub(computed);
  if (drift.isZero()) return;

  const tolerance = new D("0.01").mul(Math.max(1, lineCount));
  if (drift.abs().greaterThan(tolerance)) return;

  let target: VatRateGroup | null = null;
  for (const g of groups) {
    if (!g.ratePercent.greaterThan(ZERO)) continue;
    if (target === null || g.base.greaterThan(target.base)) target = g;
  }
  if (target === null) return;
  target.vat = target.vat.add(drift);
}

/**
 * ZBIROVI DOKUMENTA IZ STAVKI — jedini računar za `netTotal`/`vatTotal`/`grossTotal`.
 *
 * Ovo je put kojim se zaglavlje TEK RAČUNA, pa `documentVatTotal` ovde namerno NE
 * postoji: nema šta da se preuzme, ovaj račun i JESTE izvor tog broja.
 *
 * `isExport` obara sve stavke u stopu 0 % (kategorija Z, čl. 24): izvozni račun ne
 * sme da nosi obračunat PDV ni kad je stavka nasledila domaću poresku šifru.
 */
export function documentVatTotals(
  lines: ReadonlyArray<VatTotalsLine>,
  opts: { isExport?: boolean } = {},
): DocumentVatTotals {
  const groups = vatBreakdown(lines, { isExport: opts.isExport });

  let netTotal = ZERO;
  let vatTotal = ZERO;
  for (const g of groups) {
    netTotal = netTotal.add(g.base);
    vatTotal = vatTotal.add(g.vat);
  }

  return { netTotal, vatTotal, grossTotal: netTotal.add(vatTotal), groups };
}
