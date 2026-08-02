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
 * Vrste dokumenata po kojima se NIŠTA NE UPLAĆUJE — jedine izuzete od novčanih brana
 * štampe (bankarske instrukcije, PDV na izvoznom obrascu).
 *
 * Ovde je, a ne u `invoice-pdf.service.ts`, zato što je do 02.08.2026. postojala u jednom
 * primerku pa je važila za JEDNU branu: revers je bio izuzet od brane za IBAN, ali NIJE od
 * `assertExportWithoutVat` — pa je izvozni revers ostajao bez papira zbog PDV-a koji na
 * njemu nikoga ne obavezuje (v. `assertExportWithoutVat`). Dva spiska za isto pravilo su
 * upravo to i proizvela; sada je spisak jedan, a obe brane ga čitaju odavde.
 *
 * `REV` = revers, zapis o zaduženju/vraćanju opreme. Ponuda, predračun i avansni račun
 * NISU ovde: po njima kupac plaća unapred.
 */
export const NON_PAYMENT_DOCUMENT_TYPES: ReadonlySet<string> = new Set(["REV"]);

/** Vrsta dokumenta, normalizovana kao u `invoice-pdf.service.ts` (`resolveForm`). */
function documentTypeOf(invoice: { documentType?: string | null }): string {
  return (invoice.documentType ?? "").trim().toUpperCase();
}

/**
 * Da li dva iznosa gledaju na istu stranu nule (nula je „ničija", pa se slaže sa oba).
 * Služi da se STORNO red (sve negativno) razlikuje od POKVARENOG podatka (bruto i
 * osnovica različitog znaka) — v. `lineGross`.
 */
function sameSideOfZero(a: Prisma.Decimal, b: Prisma.Decimal): boolean {
  if (a.isZero() || b.isZero()) return true;
  return a.isNegative() === b.isNegative();
}

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
  return lineGross(line).discount;
}

/**
 * ŠTA JEDNA STAVKA POKAZUJE NA PAPIRU — cena, iznos i rabat, iz JEDNOG računa.
 *
 * ⚠️ ZAŠTO ZAJEDNO (ispravka 02.08.2026, nalaz „kolona CENA i međuzbir se ne slažu"):
 * kolona `C E N A`/`Price` je do tada štampala `unitPrice` — cenu POSLE rabata — dok je
 * međuzbir iznad reda „Rabat" računat iz cene PRE rabata. Sa rabatom ≠ 0 nijedan broj u
 * zbirnom bloku nije mogao da se dobije iz odštampanih kolona: 2 kom × 125,00 uz rabat
 * 20 % dalo je kolone `125,00 / 250,00` (dva puta), a ispod njih `TOTAL 625,00`.
 *
 * PRESUDA JE SA PAPIRA, ne iz koda: na `IFR.pdf` (657/25) međuzbir `99.363,64` stoji
 * NEPOSREDNO ISPOD kolone VREDNOST i BEZ natpisa, pa se tek od njega oduzima `Rabat:` i
 * dobija „Vrednost bez PDV (osnovica)". Isto na `InoFaktura GP 228-25.pdf`
 * (`TOTAL` − `DISCOUNT:` = `TOTAL AMOUNT`) i na `IFUSL.pdf` („Vrednost bez PDV" −
 * „Odobren rabat" = „Ukupno vrednost bez PDV (osnovica)"). Međuzbir JESTE zbir kolone →
 * kolona mora da nosi BRUTO. Ni na jednom donetom papiru rabat nije ≠ 0 (svuda `R% 0`),
 * pa se stara i nova štampa na njima poklapaju do pare — struktura je ipak jednoznačna.
 *
 * Zbir se zatvara PO DEFINICIJI, ne igrom zaokruživanja: `total = osnovica + rabat`, a
 * međuzbir u zbirnom bloku je `netTotal + Σ rabata`. Kad Σ osnovica stavki daje `netTotal`
 * (a daje — v. `pricing.service.ts`, iznos stavke je zaokružen na 2 decimale), zbir
 * odštampane kolone i međuzbir su ISTI BROJ, ne dva bliska.
 */
export interface PrintLineGross {
  /** Cena PRE rabata — ono što ide u kolonu `C E N A` / `Price`. */
  unitPrice: Prisma.Decimal;
  /** Iznos PRE rabata — kolona `VREDNOST` / `I Z N O S` / `Total`; zbir mu je međuzbir. */
  total: Prisma.Decimal;
  /** Rabat te stavke u novcu; `total − discount = lineTotal` (osnovica). */
  discount: Prisma.Decimal;
}

export function lineGross(line: PrintLine): PrintLineGross {
  const percent = line.discountPercent;
  // Bez rabata je bruto == neto, pa se ništa ne izvodi: cena i iznos ostaju tačno onakvi
  // kakvi su u bazi. Da se i ovde ulazilo u računanje, razlika u zaokruživanju cene i
  // osnovice dala bi „rabat" od jedne pare na papiru koji rabata nema.
  if (percent.lessThanOrEqualTo(ZERO))
    return {
      unitPrice: line.unitPrice,
      total: line.lineTotal,
      discount: ZERO,
    };

  // ── 1) Puna cena sa stavke ──
  const beforeDiscount = line.unitPriceBeforeDiscount;
  if (beforeDiscount && !beforeDiscount.isZero()) {
    const gross = line.quantity.mul(beforeDiscount);
    const amount = gross.sub(line.lineTotal);
    // ⚠️ MERILO JE ZNAK BRUTA, NE NULA (ispravka 02.08.2026): do tada je uslov bio
    // `amount >= 0`, pa je STORNO red padao na rezervu i tiho gubio rabat. Izmereno:
    // količina −10, puna cena 1.000,00, rabat 100 % → bruto −10.000,00, rabat −10.000,00 —
    // uslov ga odbaci kao „protivrečan", a rezerva za rabat ≥ 100 % vrati 0, pa je papir
    // pisao `R% 100` uz `Rabat: 0,00`. Na storno redu je negativan rabat TAČAN: on
    // poništava rabat sa originalne fakture.
    //
    // Protivrečan podatak (puna cena manja od cene posle rabata — pokvaren uvoz, ručna
    // izmena u bazi) i dalje pada na rezervu: prepoznaje se po tome što rabat ima
    // SUPROTAN znak od bruta, a ne po tome što je negativan.
    const consistent =
      sameSideOfZero(gross, line.lineTotal) &&
      (gross.isNegative()
        ? amount.lessThanOrEqualTo(ZERO)
        : amount.greaterThanOrEqualTo(ZERO));
    if (consistent) {
      const discount = amount.toDecimalPlaces(2);
      return {
        unitPrice: beforeDiscount,
        // Iz `osnovica + rabat`, a ne `količina × puna cena`: rabat je zaokružen na dve
        // decimale (toliko ih papir i pokazuje), pa samo ovako `total − discount` daje
        // BAŠ osnovicu koja je proknjižena, bez pare razlike.
        total: line.lineTotal.add(discount),
        discount,
      };
    }
  }

  // ── 2) Rezerva: unazad iz neto iznosa ──
  if (percent.greaterThanOrEqualTo(HUNDRED))
    return {
      unitPrice: line.unitPrice,
      total: line.lineTotal,
      discount: ZERO,
    };
  const discount = line.lineTotal
    .mul(percent)
    .div(HUNDRED.sub(percent))
    .toDecimalPlaces(2);
  const total = line.lineTotal.add(discount);
  return {
    // Pune cene u bazi nema, pa se dobija iz izvedenog bruta — tako kolona i međuzbir
    // ostaju iz ISTOG broja. Kod količine 0 nema šta da se deli (i bruto je 0), pa cena
    // ostaje ona sa stavke.
    unitPrice: line.quantity.isZero()
      ? line.unitPrice
      : total.div(line.quantity),
    total,
    discount,
  };
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
 * REDOVI PDV-a U ZBIRU — stopa, osnovica na koju se primenjuje i iznos poreza.
 *
 * Kad je na računu JEDNA stopa (tako je na oba domaća donesena papira, i tako je u
 * praksi), uzimaju se zbirovi sa samog DOKUMENTA (`netTotal`/`vatTotal`) — papir mora da
 * pokaže ono što je proknjiženo, do pare. Tek kad se na istom računu nađu dve stope,
 * osnovice se razdvajaju po stavkama, jer zaglavlje nosi samo ukupan PDV.
 *
 * ⚠️ ZAŠTO JE OVO ZAJEDNIČKO (ispravka 02.08.2026, nalaz „dva obrasca, dva ishoda"):
 * uslužni obrazac je razliku zaokruživanja pripisivao najvećoj grupi, robni NIJE — pa je
 * ISTI račun sa dve stope na robnom papiru umeo da pokaže Σ PDV redova koji se od
 * `vatTotal` razlikuje za 0,01, a na uslužnom ne. Izmereno: osnovice 16.000,00 (20 %) i
 * 4.000,00 (10 %) uz `vatTotal` 3.599,99 sa dokumenta → robni papir je štampao
 * 3.200,00 + 400,00 = 3.600,00, dakle jednu paru više nego što je proknjiženo.
 * Razlika ide na grupu sa NAJVEĆOM osnovicom, gde je relativno najmanja.
 *
 * Redosled je po stopi RASTUĆE; obrazac koji ga hoće drugačije neka sortira sam
 * (raspored je izgled, a ne iznos — v. uvodni komentar fajla).
 */
export interface VatSummaryRow {
  /** Stopa u procentima; `null` = stavke bez poznate poreske šifre. */
  rate: number | null;
  base: Prisma.Decimal;
  vat: Prisma.Decimal;
}

export function vatSummaryRows(ctx: PrintCtx): VatSummaryRow[] {
  const { netTotal, vatTotal } = ctx.invoice;
  const rates = [...new Set(ctx.lines.map((l) => l.vatRatePercent))];

  // Bez ijedne stope (prazan račun, stara stavka bez `vatRateCode`) red i dalje mora da
  // postoji — obrazac ga ima uvek — pa nosi zbirove sa dokumenta.
  if (rates.length <= 1)
    return [{ rate: rates[0] ?? null, base: netTotal, vat: vatTotal }];

  const groups: VatSummaryRow[] = rates
    .slice()
    .sort((a, b) => (a ?? -1) - (b ?? -1))
    .map((rate) => {
      const base = ctx.lines
        .filter((l) => l.vatRatePercent === rate)
        .reduce((sum, l) => sum.add(l.lineTotal), ZERO);
      return {
        rate,
        base,
        vat:
          rate == null ? ZERO : base.mul(rate).div(HUNDRED).toDecimalPlaces(2),
      };
    });

  const drift = vatTotal.sub(groups.reduce((s, g) => s.add(g.vat), ZERO));
  if (!drift.isZero()) {
    const biggest = groups.reduce((a, b) =>
      b.base.greaterThan(a.base) ? b : a,
    );
    biggest.vat = biggest.vat.add(drift);
  }
  return groups;
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
  return printableDeductions(ctx.advanceDeductions);
}

/**
 * Isto pravilo, ali nad golom listom — za OPŠTI renderer (AVR/KO/KZ), koji `PrintCtx`
 * nema nego svoj `AdvanceDeduction[]` iz `loadAdvanceDeductions`.
 *
 * ⚠️ ZAŠTO POSTOJI (ispravka 02.08.2026): filtriranje je bilo samo na četiri donesena
 * obrasca, pa je red `Umanjenje za primljeni avans (br. …): − 0,00` izlazio na KNJIŽNOM
 * ODOBRENJU, a na fakturi za isti avans ne. Pravilo je jedno; ono što se razlikuje je
 * samo oblik podataka koje mu pozivalac donese.
 */
export function printableDeductions<T extends { amount: Prisma.Decimal }>(
  deductions: readonly T[],
): T[] {
  return deductions.filter((d) => d.amount.greaterThan(ZERO));
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
  documentType?: string | null;
  vatTotal: Prisma.Decimal;
}): void {
  // ⚠️ REVERS JE IZUZET (ispravka 02.08.2026, nalaz „brana obara revers"): po reversu se
  // ne uplaćuje ništa, pa PDV na njemu i ne može da bude „odštampan kao deo iznosa za
  // uplatu" — što je jedina šteta zbog koje brana postoji. Izmereno: revers nastao
  // prepisom (`carry-over`) nosi PREPISAN `vatTotal` sa izvorne fakture, a ako je uz to
  // `isExport`, pada na ino obrazac kroz `resolveForm` fallback — i ostajao je bez papira.
  // Isti spisak već izuzima revers od brane za bankarske instrukcije; ovde je taj propust
  // bio u tome što je spisak postojao u DVA primerka (v. `NON_PAYMENT_DOCUMENT_TYPES`).
  if (NON_PAYMENT_DOCUMENT_TYPES.has(documentTypeOf(invoice))) return;

  // ⚠️ MERILO JE PARA, NE APSOLUTNA NULA: `vat_total` je `Decimal(19,4)`, pa zatečeni
  // dokumenti umeju da nose ostatak zaokruživanja ispod pare (0,0001). `isZero()` je na
  // takav ostatak obarao štampu, a on se na papiru — koji ima dve decimale — ne vidi
  // uopšte. Sve što se VIDI (0,01 pa naviše, u oba smera) i dalje obara: papir koji tvrdi
  // oslobođenje, a u iznosu za uplatu nosi PDV, netačan je i za jednu paru.
  if (invoice.vatTotal.toDecimalPlaces(2).isZero()) return;

  // Dokument se imenuje po VRSTI, ne kao „izvozna faktura": na ino obrazac padaju i
  // predračun i ponuda (`resolveForm` fallback), pa je poruka umela da predračun nazove
  // fakturom i pošalje operatera da traži nepostojeći račun.
  const type = documentTypeOf(invoice);
  const label = type
    ? `Dokument ${type} ${invoice.documentNumber}`
    : `Dokument ${invoice.documentNumber}`;
  throw new BadRequestException(
    `${label} se štampa na izvoznom obrascu, a nosi obračunat PDV ` +
      `${formatAmount(invoice.vatTotal)} — taj obrazac ne sme da ga odštampa ` +
      `kao deo iznosa za uplatu, jer isti papir tvrdi da je promet oslobođen PDV-a. ` +
      `Najčešći uzrok je prepis DOMAĆEG predračuna u izvozni račun: ispravi poresku ` +
      `šifru stavki (izvoz = šifra „0") i zbirove dokumenta, pa ponovi štampu.`,
  );
}
