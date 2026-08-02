import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { formatAmount } from "../format";
import type { PrintCtx, PrintLine } from "./ctx";

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
 * SCENARIO (10 kom × 1.000,00 sa rabatom 10 %): `PricingService` upiše
 * `unitPrice = 900,00`, `lineTotal (vatBase) = 9.000,00`, `discountPercent = 10`.
 * Rabat se vraća unazad iz neto iznosa:
 *
 *   rabat = neto × p / (100 − p) = 9.000 × 10 / 90 = **1.000,00**
 *   bruto = neto + rabat = **10.000,00**   (= 10 × 1.000,00, cena PRE rabata)
 *
 * ZAŠTO IZ `lineTotal`, A NE IZ `količina × unitPrice`: `lineTotal` je iznos koji se
 * i ŠTAMPA u koloni VREDNOST / I Z N O S / Total, a njegov zbir je osnovica u zbirnom
 * bloku. Računanjem iz iste vrednosti koja se štampa nema zaokruživanja koje bi
 * proizvelo rabat od jedne pare tamo gde rabata nema.
 *
 * ⚠️ KASA (`cashDiscountPercent`) OVDE NE UČESTVUJE: `PrintLine` je ne nosi (a ni jedan
 * obrazac je ne prikazuje), pa se izvedeni bruto računa samo do rabata. Kad je uz rabat
 * odobrena i kasa, „bruto" je cena pre rabata ali posle kase — i dalje tačno u odnosu
 * na kolonu `R%`/`Rab%` koja je jedino što papir tvrdi.
 *
 * ⚠️ RABAT OD 100 % se ne može izvesti: `unitPrice` je tada 0, pa u podacima ne postoji
 * nijedan trag cene pre rabata (`baseUnitPrice` sa stavke ne stiže do štampe). Takva
 * stavka doprinosi 0 — bolje nego deljenje nulom ili izmišljen iznos.
 */
export function lineDiscountAmount(line: PrintLine): Prisma.Decimal {
  const percent = line.discountPercent;
  if (percent.lessThanOrEqualTo(ZERO) || percent.greaterThanOrEqualTo(HUNDRED))
    return ZERO;
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
 */
export function assertExportWithoutVat(ctx: PrintCtx): void {
  if (ctx.invoice.vatTotal.isZero()) return;
  throw new BadRequestException(
    `Izvozna faktura ${ctx.invoice.documentNumber} nosi obračunat PDV ` +
      `${formatAmount(ctx.invoice.vatTotal)} — izvozni obrazac ne sme da ga odštampa ` +
      `kao deo iznosa za uplatu, jer isti papir tvrdi da je promet oslobođen PDV-a. ` +
      `Najčešći uzrok je prepis DOMAĆEG predračuna u izvozni račun: ispravi poresku ` +
      `šifru stavki (izvoz = šifra „0") i zbirove dokumenta, pa ponovi štampu.`,
  );
}
