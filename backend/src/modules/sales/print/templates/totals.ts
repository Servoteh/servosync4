import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatAmount } from "../format";
import type { PrintAdvanceDeduction, PrintCtx, PrintLine } from "./ctx";

/**
 * ZBIR IZLAZNE FAKTURE — aritmetika i brane koje SVI obrasci moraju da dele.
 *
 * ZAŠTO ZAJEDNIČKI FAJL, kad je pravilo da je svaki obrazac zaseban (v. `ctx.ts`):
 * razlike među obrascima su u NATPISIMA i rasporedu — koliko duguje kupac NIJE stvar
 * obrasca. Kad je rabat u tri fajla bio računat tri puta, ista faktura je umela da
 * pokaže tri različita rabata zavisno od toga da li je prodata roba ili usluga, u
 * zemlji ili u izvozu. Sve što je ovde je „koliko", a ne „kako izgleda".
 */

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/**
 * RABAT JEDNE STAVKE, u novcu.
 *
 * ⚠️ KLJUČNA ČINJENICA O NAŠIM PODACIMA (`pricing.service.ts` §„INVARIJANTA"):
 * `InvoiceItem.unitPrice` je cena **POSLE rabata**
 * (`unitPrice = basePrice × (1 − rabat/100) × (1 − kasa/100)`), a `vatBase`
 * (= `PrintLine.lineTotal` na papiru) je `količina × unitPrice`, dakle takođe POSLE
 * rabata. `discountPercent` stoji uz njih samo kao podatak koliko je odbijeno.
 *
 * Zato je do 02.08.2026. red „Rabat"/„DISCOUNT" na svim novčanim obrascima bio
 * STRUKTURNO nula: bruto se računao kao Σ(količina × unitPrice) = osnovica, pa je
 * rabat ispadao „osnovica − osnovica = 0,00". Papir je istovremeno u koloni pokazivao
 * `R% 10` i ispod `Rabat: 0.00` — dve tvrdnje koje se međusobno poriču.
 *
 * ── DVA IZVORA BRUTA, PO STROGOM REDOSLEDU ─────────────────────────────────────
 *
 * 1) `PrintLine.unitPriceBeforeDiscount` — CENA PRE RABATA sa same stavke
 *    (`invoice_items.unit_price_before_discount`, uvedena 02.08.2026). Kad je ima:
 *
 *        bruto = količina × cena_pre_rabata      rabat = bruto − osnovica
 *
 *    Ovo je jedini izvor koji radi i za **RABAT OD 100 %**: tada je cena posle rabata 0,
 *    pa unazad nema šta da se računa. 10 kom × 1.000,00 uz rabat 100 % → osnovica 0,00,
 *    rabat **10.000,00**, bruto **10.000,00**. Do ove kolone je takav papir tvrdio
 *    „R% 100" i „Rabat: 0,00" istovremeno.
 *
 * 2) REZERVA — obračun UNAZAD iz neto iznosa, za stavke starije od kolone i za uvoz
 *    (`unitPriceBeforeDiscount = null`):
 *
 *        rabat = neto × p / (100 − p)            bruto = neto + rabat
 *
 *    SCENARIO (10 kom × 1.000,00 uz rabat 10 %): u bazi `unitPrice = 900,00`,
 *    `lineTotal (vatBase) = 9.000,00`, `discountPercent = 10` →
 *    rabat = 9.000 × 10 / 90 = **1.000,00**, bruto = **10.000,00**. Za svaki rabat ispod
 *    100 % rezerva daje isti iznos kao prvi izvor, pa se papir za zatečene račune ne menja.
 *    Kod rabata od 100 % rezerva vraća 0 — ne deli nulom i ne izmišlja iznos.
 *
 * ZAŠTO SE ODUZIMA OD `lineTotal`, A NE OD `količina × unitPrice`: `lineTotal` je iznos
 * koji se i ŠTAMPA u koloni VREDNOST / I Z N O S / Total, a njegov zbir je osnovica u
 * zbirnom bloku. Računanjem od iste vrednosti koja se štampa nema zaokruživanja koje bi
 * proizvelo rabat od jedne pare tamo gde rabata nema.
 *
 * ⚠️ KASA (`cashDiscountPercent`) NI U JEDNOM IZVORU NE UČESTVUJE: u kolonu se upisuje
 * `basePrice × (1 − kasa/100)`, dakle cena pre rabata ali POSLE kase — tačno ono što
 * kolona `R%`/`Rab%` na papiru tvrdi. Da je kasa napolju, red „Rabat" bi nosio i nju.
 */
export function lineDiscountAmount(line: PrintLine): Prisma.Decimal {
  const percent = line.discountPercent;
  // Bez rabata red mora biti tačno 0,00 — zato pre svakog računa. Da se ovde ulazilo u
  // oduzimanje, razlika u zaokruživanju cene i osnovice dala bi „rabat" od jedne pare.
  if (percent.lessThanOrEqualTo(ZERO)) return ZERO;

  // ── 1) Puna cena sa stavke ──
  const beforeDiscount = line.unitPriceBeforeDiscount;
  if (beforeDiscount && beforeDiscount.greaterThan(ZERO)) {
    const gross = line.quantity.mul(beforeDiscount);
    const amount = gross.sub(line.lineTotal);
    // Negativan ishod znači da je puna cena manja od cene posle rabata — protivrečan
    // podatak (pokvaren uvoz, ručna izmena u bazi). Papir tada ide na rezervu umesto da
    // odštampa „Rabat −…", što je greška vidljiva kupcu.
    if (amount.greaterThanOrEqualTo(ZERO)) return amount.toDecimalPlaces(2);
  }

  // ── 2) Rezerva: unazad iz neto iznosa ──
  if (percent.greaterThanOrEqualTo(HUNDRED)) return ZERO;
  return line.lineTotal
    .mul(percent)
    .div(HUNDRED.sub(percent))
    .toDecimalPlaces(2);
}

/**
 * Ukupan odobren rabat na dokumentu = zbir rabata po stavkama.
 *
 * Obrasci ga koriste OVAKO: `bruto = osnovica sa dokumenta + rabat`. Time zbir na
 * papiru zatvara sam od sebe (**bruto − rabat = osnovica**, do pare), i kad se
 * zaokruživanje po stavkama razlikuje od zaokruživanja zbira. Suprotan smer
 * (rabat = bruto − osnovica) je ono što je proizvodilo lažne iznose kad Σ stavki i
 * zbir na dokumentu nisu bili identični.
 */
export function discountFromLines(lines: PrintLine[]): Prisma.Decimal {
  return lines.reduce((sum, l) => sum.add(lineDiscountAmount(l)), ZERO);
}

/**
 * Iznos za uplatu posle odbijanja primljenog avansa.
 *
 * Avans umanjuje SAMO ono što kupac još duguje — ne osnovicu i ne PDV (oni su već
 * obračunati na avansnom računu). Avans veći od računa ne sme da da negativan iznos
 * „za uplatu": preplata se rešava odobrenjem, ne minusom na fakturi.
 */
export function payableAfterAdvance(
  total: Prisma.Decimal,
  advance: Prisma.Decimal,
): Prisma.Decimal {
  const rest = total.sub(advance);
  return rest.greaterThan(ZERO) ? rest : ZERO;
}

/**
 * ODBIJENI AVANSI KOJI IDU NA PAPIR — jedan red po primeni, bez praznih redova.
 *
 * Primena sa iznosom 0 (stornirana pa ponovo upisana, ručna ispravka u bazi) ne sme da
 * proizvede red `Umanjenje za primljeni avans (br. …): − 0,00` — kupac bi ga čitao kao
 * avans koji postoji, a ne umanjuje ništa. Filtriranje je OVDE, a ne u učitavanju, da
 * bi sva četiri obrasca imala isto pravilo i kad im `PrintCtx` stigne iz testa.
 */
export function printableAdvanceDeductions(
  ctx: PrintCtx,
): PrintAdvanceDeduction[] {
  return ctx.advanceDeductions.filter((d) => d.amount.greaterThan(ZERO));
}

/**
 * UKUPNO ODBIJENI AVANS = zbir PRIKAZANIH primena.
 *
 * ⚠️ NIJE `invoice.advanceAppliedAmount` (ispravka 02.08.2026). Dva razloga:
 *
 *  1. Zbir mora da odgovara onome što na papiru PIŠE: „za uplatu" je `bruto − Σ redova
 *     umanjenja`, pa kupac koji sabere odštampane redove dobije baš završni iznos.
 *  2. Kolona nosi samo UKUPNO odbijeno, bez podele po avansima — uz nju bi „za uplatu"
 *     moglo da se raziđe sa zbirom odštampanih redova (npr. kad kolona zaostane za
 *     spojnom tabelom posle ručne ispravke u bazi). Listu umanjenja sklapa
 *     `InvoicePdfService.loadAdvanceDeductions` po pravilu UNIJE (Σ aktivnih primena +
 *     zatečena 1:1 veza bez reda u spojnoj tabeli), pa u zdravom stanju daje isti zbir
 *     kao kolona — samo raščlanjen po avansnim računima.
 */
export function advanceTotal(
  deductions: readonly PrintAdvanceDeduction[],
): Prisma.Decimal {
  return deductions.reduce((sum, d) => sum.add(d.amount), ZERO);
}

/**
 * BRANA: izvozni obrazac ne sme da odštampa PDV kao deo iznosa za uplatu.
 *
 * SCENARIO KOJI JE OVO TRAŽIO: predračun se napravi kao DOMAĆI (PDV 20 %, bruto
 * 119.236,37), pa se `POST /sales/invoices/:id/from-proforma` prepiše u izvozni račun
 * (`IZVRO`). Stavke zadrže poresku šifru sa predračuna, dokument ostane sa
 * `vatTotal > 0`, a ino obrazac uzme `grossTotal` (SA PDV-om) u red
 * `TOTAL AMOUNT ( EUR)` — na papiru koji dva reda niže tvrdi da je promet oslobođen
 * PDV-a. Uz to `DISCOUNT` (razlika zbira stavki bez PDV-a i bruto iznosa) ispadne
 * NEGATIVAN, pa je i sama aritmetika na papiru vidljivo netačna.
 *
 * ZAŠTO PUCA, A NE „ISPRAVLJA U HODU": tiho štampanje `netTotal` umesto `grossTotal`
 * dalo bi ispravan papir za dokument koji je i dalje pogrešno proknjižen — PDV bi
 * ostao u glavnoj knjizi i u PDV prijavi, a niko ne bi saznao. Izvozna faktura uz to
 * NE ide na SEF (`sef.service.ts` je odbija), pa je papir jedini dokument koji kupac
 * dobija; ako je on u redu, greška se ne otkriva sve do poreske kontrole.
 * Isti duh je i brana u UBL builderu (`ubl-builder.service.ts` — račun bez datuma
 * prometa ne sme na SEF): glasan 400 pri štampi je jeftiniji od tihog pogrešnog papira.
 *
 * ⚠️ PRIMA DOKUMENT, NE CEO `PrintCtx` (02.08.2026): brana se poziva i iz šablona i iz
 * `InvoicePdfService.loadPrintCtx`, PRE učitavanja podataka firme. Bez toga bi izvozni
 * dokument koji nosi i PDV i prazan IBAN dobio poruku o IBAN-u — a pravi uzrok je PDV
 * na izvozu (v. `loadPrintCtx`, „redosled brana").
 */
export function assertExportWithoutVat(invoice: {
  documentNumber: string;
  vatTotal: Prisma.Decimal;
}): void {
  if (invoice.vatTotal.isZero()) return;
  throw new BadRequestException(
    `Izvozna faktura ${invoice.documentNumber} nosi obračunat PDV ` +
      `${formatAmount(invoice.vatTotal)} — izvozni obrazac ne sme da ga odštampa ` +
      `kao deo iznosa za uplatu, jer isti papir tvrdi da je promet oslobođen PDV-a. ` +
      `Najčešći uzrok je prepis DOMAĆEG predračuna u izvozni račun: ispravi poresku ` +
      `šifru stavki (izvoz = šifra „0") i zbirove dokumenta, pa ponovi štampu.`,
  );
}
