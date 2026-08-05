import { Prisma } from "@prisma/client";
import { VAT_RATE_BY_CODE } from "../gl/posting/vat-rates";
import { grossToNet } from "../pdv/vat-bridge.util";
import {
  DEFAULT_TAX_TREATMENT,
  type DocumentTaxTreatment,
  type TaxTreatmentSource,
  taxTreatmentOf,
  treatmentChargesVat,
} from "./service-revenue-type";

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
 * ═════════════════════════════════════════════════════════════════════════════
 * DOPUNA 02.08.2026 (sedmi krug) — ZAGLAĐIVANJE SAMO TAMO GDE POREZ DOLAZI IZ BRUTA
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * Preuzimanje objavljenog poreza iz šestog kruga (odeljak iznad) bilo je tačno po
 * NAMERI, ali je sprovedeno kao osobina POZIVA („neko je prosledio `documentVatTotal`"),
 * a ne kao osobina DOKUMENTA. Pošto ga prosleđuje SVAKO ko prikazuje postojeći dokument,
 * pojas od `0,01 × n` je usisavao razliku bez obzira odakle je došla. Izmereno (sedmi
 * krug, izvršavanjem modula nad `Prisma.Decimal`):
 *
 *   ULAZ                                  tačan PDV   `vat_total`   stari ishod
 *   20 × 1.000,00 @ 20 %                   4.000,00     3.999,80   grupa nosi 3.999,80
 *   100 × 1.000,00 @ 20 %                 20.000,00    19.999,00   usisano 1,00 RSD
 *
 * Pojačivač A — meta se birala po NAJVEĆOJ osnovici, bez ikakve veze sa iznosom koji joj
 * se dodaje: 99 redova @ 0 % × 100,00 + 1 red @ 20 % sa osnovicom 0,05 uz `vat_total`
 * 1,01 → papir je štampao `20 % | 0,05 | 1,01`, dakle efektivnu stopu od **2020 %**.
 * Pojačivač B — pojas je rastao po `lines.length`, a red sa osnovicom 0,00 je legitiman
 * (rabat 100 %): 1 red 1.000,00 @ 20 % + 500 praznih redova davalo je toleranciju
 * 5,01 RSD, pa je `vat_total = 194,99` (tačno 200,00) prolazio nemo.
 *
 * ZATO OD OVE IZMENE:
 *
 *  1. ZAGLAĐIVANJE JE OPT-IN PO VRSTI DOKUMENTA. Objavljen porez ne prima
 *     `vatBreakdown` nego `documentVatBreakdown`, kome se predaje CEO dokument
 *     (`documentType`, `isExport`, `vatTotal`) — i on sam odlučuje. Zaglađuje se samo
 *     dokument koji porez STVARNO izvodi deljenjem (`GROSS_DERIVED_VAT_DOCUMENT_TYPES`
 *     = danas `AVR`; v. `advance-invoice.service.ts` → `splitAdvance` → `grossToNet`).
 *     Time otpada cela klasa gornjih primera: redovan račun se više ne zaglađuje NIKAD.
 *     Opcija se ne prosleđuje „ručno" ni sa jednog mesta — pozivalac ne može da zaboravi
 *     uslov koji ne postavlja.
 *
 *  2. ODBRANA U DUBINU, i kad je zaglađivanje dozvoljeno (v. `applyGrossDerivedVatTotal`):
 *     tolerancija `max(0,01; 0,005 × broj redova SA IZNOSOM ≠ 0)`, meta po `|osnovica|`,
 *     provera efektivne stope grupe i provera da je grupa i SAMA valjan izvod iz bruta.
 *
 *  3. NEZAGLAĐENO MORA DA SE VIDI. Kontrolni red na papiru je do sada merio
 *     `Σosn + Σpdv − bruto`, a taj izraz je po konstrukciji NULA kad je zaglavlje interno
 *     dosledno (`bruto = neto + pdv`) — dakle nije mogao da vidi pogrešan `vat_total`.
 *     Merilo je sada `vatRecapMismatch`: Σ osnovica grupa naspram `netTotal` i
 *     Σ poreza grupa naspram `vat_total`, ODVOJENO (u zbiru se te dve greške poništavaju).
 *
 * ŠTA OVO KOŠTA: zatečeno zaglavlje upisano po STAROM pravilu (Σ poreza po stavci) se
 * više ne zaglađuje ćutke nego se prijavljuje. To je namerno — i bezbolno, jer na
 * produkciji nema nijedne fakture ni stavke (izmereno 0/0, v. „ODBRANA PRI SABIRANJU").
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
 *   S  — standardna ili snižena stopa (>0 %), domaći promet
 *   Z  — izvoz / oslobođeno SA pravom na odbitak (0 %, uz osnov čl. 24)
 *   E  — domaće oslobođenje BEZ izvoznog osnova (0 %)
 *   AE — domaći promet gde je poreski dužnik PRIMALAC („VAT reverse charge")
 *   O  — usluga van polja primene poreza („services outside scope of tax")
 *
 * Zajednička je za zbirove, papir i UBL: kategorija je pola ključa grupisanja, pa bi
 * dve definicije značile dve podele istog dokumenta.
 *
 * ⚠️ `AE` I `O` SU DODATE 05.08.2026. uz šifarnik vrsta usluge. Do tada su oba slučaja
 * padala u `E` („domaće oslobođenje"), što nije isto: `E` znači da je promet OSLOBOĐEN,
 * a kod otpada promet je OPOREZIV — samo porez obračunava kupac. Kupac koji dobije `E`
 * umesto `AE` nema iz čega da zna da mora sam da obračuna PDV, pa mu e-faktura ćutke
 * skriva njegovu poresku obavezu. Šifre su iz UNCL 5305, koji EN 16931 propisuje za
 * BT-118 (`AE` = VAT Reverse Charge, `O` = Services outside scope of tax).
 */
export type VatCategory = "S" | "Z" | "E" | "AE" | "O";

/**
 * Kategorija po stopi, izvozu i poreskom tretmanu dokumenta.
 *
 * `treatment` je NAMERNO opcion sa podrazumevanim `TAXED`: pozivalac koji o vrsti usluge
 * ne zna ništa (roba, avans, zatečeni kod) dobija tačno zatečeno ponašanje. Uslužni
 * promet ga uvek prosleđuje kroz `vatBreakdown`.
 */
export function vatCategoryOf(
  ratePercent: Prisma.Decimal,
  isExport: boolean,
  treatment: DocumentTaxTreatment = DEFAULT_TAX_TREATMENT,
): VatCategory {
  if (ratePercent.greaterThan(ZERO)) return "S";
  // Izvoz je JAČI od tretmana: čl. 24 je osnov sa pravom na odbitak i on je ono što
  // stoji na ino obrascu i u SEF-u. Vrsta usluge tada i dalje bira KONTO PRIHODA
  // (`6151` za uslugu stranom kupcu), samo ne menja poresku kategoriju.
  if (isExport) return "Z";
  if (treatment === "REVERSE_CHARGE") return "AE";
  if (treatment === "OUTSIDE_SCOPE") return "O";
  return "E";
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
   * PDV grupe. UVEK `round2(base × stopa)` — osim kad dokument porez izvodi iz bruta
   * (`documentVatBreakdown` nad vrstom iz `GROSS_DERIVED_VAT_DOCUMENT_TYPES`) i kad
   * razlika prođe sve četiri brane; tada nosi OBJAVLJENI iznos. V. uvod fajla, „R1/R2"
   * i „sedmi krug".
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
   * PORESKI TRETMAN DOKUMENTA (šifarnik vrsta usluge, 05.08.2026).
   *
   * `REVERSE_CHARGE` i `OUTSIDE_SCOPE` obaraju sve redove na 0 % — isto što `isExport`
   * radi, ali iz drugog razloga i sa drugom kategorijom (`AE` / `O` umesto `Z`):
   * kod otpada je promet DOMAĆI i oporeziv, samo porez obračunava kupac.
   *
   * ⚠️ NE PROSLEĐUJE SE „RUČNO": tretman se dobija iz `taxTreatmentOf(zaglavlje)`, koje
   * spaja vrstu dokumenta i šifarnik. Pozivalac koji ga izostavi dobija `TAXED`, dakle
   * tačno zatečeno ponašanje — a razlika bi se, ako je neko negde ipak zaboravi, videla
   * na knjiženju: `assertTotalsMatchItems` odbija račun kod kog se zaglavlje i stavke
   * ne slažu.
   */
  taxTreatment?: DocumentTaxTreatment;
}

/**
 * VRSTE DOKUMENATA KOJE POREZ IZVODE IZ BRUTA (deljenjem), a ne množenjem osnovice.
 *
 * Danas je to samo AVANSNI RAČUN: `advance-invoice.service.ts` → `splitAdvance` →
 * `grossToNet` (pdv/vat-bridge.util). Bruto je naplaćen novac i dat je unapred, osnovica
 * se DELI preračunatom stopom (20/120 = 16,6667 %), a porez je RAZLIKA — pa
 * `round2(osnovica × stopa)` za 16,67 % bruto iznosa po 20 % (9,09 % po 10 %) vraća paru
 * više. V. uvod fajla, „R1/R2".
 *
 * ⚠️ SPISAK, A NE „ima li dokument `vat_total`" (sedmi krug, 02.08.2026): `vat_total` ima
 * SVAKI dokument, pa je pojas za zaokruživanje usisavao i greške koje sa deljenjem nemaju
 * veze — 100 × 1.000,00 @ 20 % je uz `vat_total = 19.999,00` tiho progutalo 1,00 RSD.
 * Osobina „porez je izveden iz bruta" je osobina VRSTE DOKUMENTA i tu se objavljuje.
 *
 * Ko doda novu takvu vrstu, dodaje je OVDE — i time automatski i za papir, i za
 * rekapitulaciju, i za e-fakturu, jer sve tri prolaze kroz `documentVatBreakdown`.
 */
export const GROSS_DERIVED_VAT_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "AVR",
]);

/** Da li dokument porez IZVODI IZ BRUTA (deljenjem) — v. spisak iznad. */
export function vatIsDerivedFromGross(invoice: {
  documentType?: string | null;
}): boolean {
  return GROSS_DERIVED_VAT_DOCUMENT_TYPES.has(
    (invoice.documentType ?? "").trim().toUpperCase(),
  );
}

/**
 * Minimum zaglavlja koji je potreban da bi se POSTOJEĆI dokument prikazao (papir,
 * rekapitulacija, e-faktura). Traži se CEO ovaj oblik, a ne samo `vatTotal`, baš zato da
 * pozivalac ne bi mogao da objavi porez ne izjasnivši se o vrsti dokumenta.
 */
export interface VatDocumentHeader extends TaxTreatmentSource {
  documentType?: string | null;
  isExport: boolean;
  /** `invoices.vat_total` — porez koji je dokument objavio (proknjižen, na ekranu, u GK). */
  vatTotal: Prisma.Decimal;
}

function resolveRatePercent(line: VatTotalsLine): Prisma.Decimal {
  if (line.ratePercent != null) return new D(line.ratePercent);
  return vatPercentOf(line.vatRateCode);
}

/**
 * JEDINA FUNKCIJA GRUPISANJA PDV-a U SISTEMU. Ključ = **(kategorija, stopa)**.
 *
 * Zovu je zaglavlje (`documentVatTotals`) i prikaz postojećeg dokumenta
 * (`documentVatBreakdown` → papir, rekapitulacija, e-faktura). Ko grupiše mimo nje, pravi
 * četvrtu podelu istog dokumenta — a upravo su tri različite podele bile nalaz R3.
 *
 * ⚠️ OVDE NEMA ZAGLAĐIVANJA (sedmi krug): porez grupe je UVEK `round2(osnovica × stopa)`.
 * Objavljen porez dokumenta ume da preuzme samo `documentVatBreakdown`, i to samo za
 * vrste iz `GROSS_DERIVED_VAT_DOCUMENT_TYPES`. Dok je preuzimanje bilo ovde, dovoljno je
 * bilo proslediti `documentVatTotal` da se svaka razlika progura kao „zaokruživanje".
 */
export function vatBreakdown(
  lines: ReadonlyArray<VatTotalsLine>,
  opts: VatBreakdownOptions = {},
): VatRateGroup[] {
  const byKey = new Map<
    string,
    { ratePercent: Prisma.Decimal; category: VatCategory; base: Prisma.Decimal }
  >();

  const treatment = opts.taxTreatment ?? DEFAULT_TAX_TREATMENT;
  // Dva nezavisna razloga da na dokumentu nema poreza: izvoz (čl. 24) i poreski tretman
  // vrste usluge (poreski dužnik je primalac / mesto prometa van RS). Oba obaraju stopu
  // na nulu, ali daju RAZLIČITU kategoriju — v. `vatCategoryOf`.
  const zeroRated = (opts.isExport ?? false) || !treatmentChargesVat(treatment);

  for (const line of lines) {
    const ratePercent = zeroRated ? ZERO : resolveRatePercent(line);
    const category = vatCategoryOf(ratePercent, opts.isExport ?? false, treatment);
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

  return groups;
}

/**
 * GRUPE ZA PRIKAZ POSTOJEĆEG DOKUMENTA — jedini ulaz za papir, rekapitulaciju i e-fakturu.
 *
 * Razlika u odnosu na goli `vatBreakdown`: OVDE se, i samo ovde, dokumentu koji porez
 * izvodi iz bruta (`vatIsDerivedFromGross`) preuzima objavljen porez. Pozivalac ne
 * prosleđuje „hoću li zaglađivanje" — prosleđuje DOKUMENT, a odluka je ovde, na jednom
 * mestu, po `documentType`.
 *
 * ⚠️ ZAŠTO OVAKAV POTPIS (sedmi krug, 02.08.2026): dok je objavljen porez bio obična
 * opcija `vatBreakdown`-a (`documentVatTotal`), prosleđivao ga je SVAKI prikaz, pa je
 * pojas tolerancije usisavao razliku bez obzira odakle je došla — 20 × 1.000,00 @ 20 %
 * uz `vat_total = 3.999,80` je tiho štampalo 3.999,80. Sada je nemoguće zatražiti
 * zaglađivanje a ne izjasniti se koji je to dokument.
 */
export function documentVatBreakdown(
  invoice: VatDocumentHeader,
  lines: ReadonlyArray<VatTotalsLine>,
): VatRateGroup[] {
  const groups = vatBreakdown(lines, {
    isExport: invoice.isExport,
    // Tretman se IZVODI iz zaglavlja, ne prima kao opcija: papir, rekapitulacija i
    // e-faktura svi prolaze ovuda, pa nijedan od njih ne može da ga zaboravi.
    taxTreatment: taxTreatmentOf(invoice),
  });
  if (vatIsDerivedFromGross(invoice)) {
    applyGrossDerivedVatTotal(groups, lines, invoice.vatTotal);
  }
  return groups;
}

/** Najveća razlika koju jedan red može da napravi zaokruživanjem osnovice — pola pare. */
const HALF_CENT = new D("0.005");
/** Najmanja tolerancija: jedan red uvek sme da odstupi za paru (izmereno: `grossToNet`). */
const ONE_CENT = new D("0.01");

/**
 * PREUZMI POREZ KOJI JE DOKUMENT IZVEO IZ BRUTA — uz četiri nezavisne brane.
 *
 * Zove se SAMO iz `documentVatBreakdown`, i samo za vrste iz
 * `GROSS_DERIVED_VAT_DOCUMENT_TYPES`. Sve ispod je odbrana u dubinu: i kad je
 * zaglađivanje dozvoljeno, razlika mora da liči na zaokruživanje BAŠ TE grupe.
 *
 * ── (1) TOLERANCIJA `max(0,01; 0,005 × broj redova SA IZNOSOM) ─────────────────
 * Matematički: svaki red doprinosi najviše pola pare, pa `n` redova daje najviše
 * `0,005·n + 0,005·G`. Brute force sedmog kruga (120.000 nasumičnih dokumenata +
 * iscrpna konstruktivna pretraga): **0 prekoračenja**, najveći izmeren odnos
 * `razlika/tolerancija` = **0,5000** — dakle stari pojas `0,01 × n` je bio TAČNO
 * dvostruko širi nego što treba. Iscrpno za `grossToNet` (svih 9.999.901 bruto iznosa
 * 1,00–100.000,00): `max |razlika| = 0,01`, uvek na JEDNOM redu.
 *
 * ⚠️ BROJE SE SAMO REDOVI SA IZNOSOM ≠ 0. Red sa osnovicom 0,00 je legitiman (rabat
 * 100 %), ali zaokruživanjem ne može da napravi ni pare razlike. Dok se brojao
 * `lines.length`, 1 red od 1.000,00 uz **500 praznih redova** davao je toleranciju
 * 5,01 RSD, pa je `vat_total = 194,99` (tačno 200,00) prolazio nemo; pojas je rastao
 * linearno sa praznim redovima, do proizvoljne veličine.
 *
 * ── (2) META PO `|osnovica|`, NE PO OSNOVICI ────────────────────────────────────
 * Obrazloženje „grupa gde je razlika relativno najmanja" važi za VELIČINU, a
 * `greaterThan` nad negativnim iznosima bira NAJMANJU po apsolutnoj vrednosti — tačno
 * suprotno. Izmereno na ogledalskom paru (faktura i njeno knjižno odobrenje): grupe se
 * nisu poništavale po stopi, ostajalo je ±0,02 po stopi iako je dokumentarni zbir nula.
 * Za KIF/POPDV, koji se vode PO STOPI, to je trajni ostatak.
 *
 * ── (3) EFEKTIVNA STOPA GRUPE SE NE SME PROMENITI ──────────────────────────────
 * `|porez_mete − round2(osnovica × stopa)| ≤ 0,01`. Bez toga je meta birana po najvećoj
 * osnovici primala iznos bez ikakve veze sa svojom osnovicom: 99 redova @ 0 % × 100,00 +
 * 1 red @ 20 % sa osnovicom 0,05 uz `vat_total = 1,01` štampalo je `20 % | 0,05 | 1,01`,
 * dakle **efektivnu stopu od 2020 %**, bez ijednog upozorenja.
 *
 * ── (4) GRUPA MORA I SAMA DA BUDE VALJAN IZVOD IZ BRUTA ────────────────────────
 * `grossToNet(osnovica + porez, stopa) === (osnovica, porez)` — ISTOM funkcijom kojom je
 * avans i nastao. Ovo je brana za nalaz Z3: razlika rođena u jednoj grupi ne sme da
 * završi u drugoj. Izmereno: red 110,03 @ 20 % (porez izveden deljenjem) + red 1.000,00
 * @ 10 % uz `vat_total = 122,00` → stara meta (10 %, veća osnovica) dobijala je 99,99,
 * tj. efektivnu stopu 9,999 % i pad BR-CO-17 na grupi koja problem nije ni imala.
 * Provera nevinu grupu ODBIJA (`grossToNet(1.099,99; 10) = (999,99; 100,00)`), a pravu
 * PREPOZNAJE (`grossToNet(132,03; 20) = (110,03; 22,00)`) — pa razlika ide tamo gde je i
 * nastala, umesto da se samo odustane. Ista provera hvata i mali iznos iz nalaza Z4
 * (1 red @ 20 % sa osnovicom 0,05 uz `vat_total = 0`):
 * `grossToNet(0,05; 20) = (0,04; 0,01) ≠ (0,05; 0,00)`.
 *
 * ── PRIPISIVANJE MORA DA BUDE JEDNOZNAČNO ──────────────────────────────────────
 * Ako obe provere prođu za VIŠE od jedne grupe (ili ni za jednu), ne zna se čija je
 * razlika — i ne zaglađuje se. Dvosmislenost je konstruktibilna (iscrpna pretraga po
 * osnovicama do 20.000,00): grupa 0,13 @ 20 % i grupa 0,25 @ 10 % obe primaju −0,01 i
 * obe ostaju valjan izvod iz bruta. Neslaganje tada ostaje VIDLJIVO: kontrolni red na
 * papiru (`vatRecapMismatch`) i pad BR-CO-14 na SEF-u.
 *
 * Grupa sa 0 % nikad nije kandidat: para poreza na oslobođenom prometu je poreska
 * tvrdnja, ne zaokruživanje.
 */
function applyGrossDerivedVatTotal(
  groups: VatRateGroup[],
  lines: ReadonlyArray<VatTotalsLine>,
  publishedVatTotal: Prisma.Decimal | null | undefined,
): void {
  if (publishedVatTotal == null || groups.length === 0) return;

  const computed = groups.reduce((sum, g) => sum.add(g.vat), ZERO);
  const drift = roundAmount(publishedVatTotal).sub(computed);
  if (drift.isZero()) return;

  // (1) Tolerancija po redovima KOJI NOSE IZNOS.
  const payingLines = lines.filter(
    (l) => !roundAmount(l.vatBase).isZero(),
  ).length;
  const scaled = HALF_CENT.mul(payingLines);
  const tolerance = scaled.greaterThan(ONE_CENT) ? scaled : ONE_CENT;
  if (drift.abs().greaterThan(tolerance)) return;

  // (2) Kandidati: oporezovane grupe, najveća po APSOLUTNOJ osnovici prva.
  const candidates = groups
    .filter((g) => g.ratePercent.greaterThan(ZERO))
    .sort((a, b) => b.base.abs().comparedTo(a.base.abs()));

  // (3) + (4) Pripisati se sme samo grupi koja i posle razlike ostaje sama sebi verna.
  const accepted = candidates.filter((g) => {
    const vat = g.vat.add(drift);
    const exact = roundAmount(g.base.mul(g.ratePercent).div(HUNDRED));
    if (vat.sub(exact).abs().greaterThan(ONE_CENT)) return false;
    return isGrossDerivation(g.base, vat, g.ratePercent);
  });

  // Jednoznačno ili nikako.
  if (accepted.length !== 1) return;
  accepted[0].vat = accepted[0].vat.add(drift);
}

/**
 * Da li (osnovica, porez) MOŽE da nastane deljenjem bruta po datoj stopi — proverava se
 * ISTOM funkcijom kojom avans i nastaje (`grossToNet`, pdv/vat-bridge.util), da provera i
 * obračun ne bi mogli da se raziđu.
 *
 * Radi i na negativnom dokumentu (storno, knjižno odobrenje): `grossToNet` zaokružuje
 * ROUND_HALF_UP (od nule), pa je ogledalski par simetričan do pare —
 * `grossToNet(−132,03; 20) = (−110,03; −22,00)`.
 */
function isGrossDerivation(
  base: Prisma.Decimal,
  vat: Prisma.Decimal,
  ratePercent: Prisma.Decimal,
): boolean {
  const split = grossToNet(base.add(vat), ratePercent);
  return split.net.equals(base) && split.vat.equals(vat);
}

/**
 * KONTROLA TIHE GREŠKE: da li se grupe za prikaz slažu sa zaglavljem dokumenta.
 *
 * ⚠️ ZAŠTO NE `Σosn + Σpdv − bruto` (sedmi krug, nalaz Z1): kad je zaglavlje interno
 * dosledno — a jeste, jer `bruto = neto + porez` važi i za uvoz i za ručnu izmenu kroz
 * UI — taj izraz je IDENTIČKI NULA, pa kontrola po konstrukciji nije mogla da vidi
 * pogrešan `vat_total`. Papir je zato mogao da odštampa `20 % | 0,05 | 1,01` bez ijednog
 * upozorenja.
 *
 * Zato se mere DVE stvari ODVOJENO:
 *   • `baseDiff` = Σ osnovica grupa − `net_total`  → stavke i zaglavlje su se razišle;
 *   • `vatDiff`  = Σ poreza grupa − `vat_total`    → objavljen porez nije ono što
 *     osnovice po stopi daju (i nije preuzet, jer nije izveden iz bruta).
 * Odvojeno, jer se u zbiru poništavaju: osnovica +0,01 i porez −0,01 daju zbir 0,00.
 *
 * `null` = sve se poklapa. Merilo je PARA — na papiru sa dve decimale se ispod pare
 * ništa ne vidi, a `Decimal(19,4)` kolone umeju da nose ostatak od 0,0001.
 */
export interface VatRecapMismatch {
  /** Σ osnovica grupa − `netTotal`, zaokruženo na paru. */
  baseDiff: Prisma.Decimal;
  /** Σ poreza grupa − `vatTotal`, zaokruženo na paru. */
  vatDiff: Prisma.Decimal;
}

export function vatRecapMismatch(
  groups: ReadonlyArray<{ base: Prisma.Decimal; vat: Prisma.Decimal }>,
  invoice: { netTotal: Prisma.Decimal; vatTotal: Prisma.Decimal },
): VatRecapMismatch | null {
  let sumBase = ZERO;
  let sumVat = ZERO;
  for (const g of groups) {
    sumBase = sumBase.add(g.base);
    sumVat = sumVat.add(g.vat);
  }
  const baseDiff = roundAmount(sumBase.sub(invoice.netTotal));
  const vatDiff = roundAmount(sumVat.sub(invoice.vatTotal));
  if (baseDiff.isZero() && vatDiff.isZero()) return null;
  return { baseDiff, vatDiff };
}

/**
 * ZBIROVI DOKUMENTA IZ STAVKI — jedini računar za `netTotal`/`vatTotal`/`grossTotal`.
 *
 * Ovo je put kojim se zaglavlje TEK RAČUNA, pa `documentVatTotal` ovde namerno NE
 * postoji: nema šta da se preuzme, ovaj račun i JESTE izvor tog broja.
 *
 * `isExport` obara sve stavke u stopu 0 % (kategorija Z, čl. 24): izvozni račun ne
 * sme da nosi obračunat PDV ni kad je stavka nasledila domaću poresku šifru. Isto radi
 * i `taxTreatment` različit od `TAXED` (otpad / usluga sa mestom prometa van RS) — v.
 * `VatBreakdownOptions`.
 */
export function documentVatTotals(
  lines: ReadonlyArray<VatTotalsLine>,
  opts: VatBreakdownOptions = {},
): DocumentVatTotals {
  const groups = vatBreakdown(lines, opts);

  let netTotal = ZERO;
  let vatTotal = ZERO;
  for (const g of groups) {
    netTotal = netTotal.add(g.base);
    vatTotal = vatTotal.add(g.vat);
  }

  return { netTotal, vatTotal, grossTotal: netTotal.add(vatTotal), groups };
}
