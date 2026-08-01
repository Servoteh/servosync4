import { Prisma } from "@prisma/client";

/**
 * Formatiranje brojeva, datuma i broja dokumenta za štampu izlaznih faktura
 * (STAMPA_IZLAZNIH_FAKTURA.md §6, STAMPA_FAKTURA_GAP.md §4 korak 2).
 *
 * Sve vrednosti dolaze iz baze kao `Prisma.Decimal` — računa se i zaokružuje NAD
 * Decimal-om (`toFixed`), nikad preko `Number`, jer se na fakturi zbir mora poklopiti
 * sa knjiženjem do pare.
 *
 * ⚠️ Zašto ovde nema `english` prekidača kakav ima stari `formatDecimal`
 * (`invoice-pdf.service.ts:667`): svih pet donetih BigBit obrazaca — i domaći i ino —
 * štampa iznose ISTO (`99,363.64`). Razlika domaći/ino je u datumima i natpisima, ne u
 * brojevima. Jedan format manje je jedan izvor greške manje.
 */

/** Šta god da stigne iz baze ili iz testa — svede se na Decimal pre računa. */
type Numeric = Prisma.Decimal | number | string;

function toDecimal(value: Numeric): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/**
 * Ubacuje separator hiljada u niz cifara: `99363` → `99,363`.
 * Radi nad stringom (ne nad brojem) da zaokruživanje ostane posao Decimal-a.
 */
function groupThousands(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+$)/g, separator);
}

/** Razdvaja predznak i „ceo.decimalni" deo već zaokruženog Decimal-a. */
function splitFixed(
  value: Numeric,
  decimals: number,
): { sign: string; int: string; frac: string } {
  const fixed = toDecimal(value).toFixed(decimals);
  const negative = fixed.startsWith("-");
  const [int, frac = ""] = (negative ? fixed.slice(1) : fixed).split(".");
  return { sign: negative ? "-" : "", int, frac };
}

/**
 * Iznos onako kako ga štampa BigBit: **zarez za hiljade, tačka za decimale**
 * (`99,363.64`). Obrnuto od srpske norme, ali je tako na svih pet donetih papira —
 * pa se prepisuje doslovno.
 *
 * Isti oblik služi i za količine (`formatAmount(qty, 3)`) — kolona `Količina` na
 * obrascu ne razlikuje se po formatu od kolone `CENA`.
 *
 * Valuta se NE lepi uz iznos: na obrascu stoji samo u naslovu reda
 * (`Za uplatu (RSD):`, `TOTAL AMOUNT ( EUR)`).
 */
export function formatAmount(value: Numeric, decimals = 2): string {
  const { sign, int, frac } = splitFixed(value, decimals);
  const whole = groupThousands(int, ",");
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Težina u otpremnom bloku ino usluge: **tačka za hiljade, zarez za decimale**
 * (`1.720,00`) — dakle TAČNO OBRNUTO od iznosa na istom papiru (060/26).
 *
 * Nije greška u čitanju obrasca: BigBit iznose štampa engleski, a kilažu srpski.
 * Dok se ne odluči drugačije, prepisuje se kako jeste.
 */
export function formatWeight(value: Numeric, decimals = 2): string {
  const { sign, int, frac } = splitFixed(value, decimals);
  const whole = groupThousands(int, ".");
  return `${sign}${whole}${frac ? `,${frac}` : ""}`;
}

/** Težina sa jedinicom, kako stoji na obrascu: `1.720,00 kg`. */
export function formatWeightKg(value: Numeric, decimals = 2): string {
  return `${formatWeight(value, decimals)} kg`;
}

/**
 * Datum se čita LOKALNIM geterima, isto kao dosadašnji `fmtDate`. Kolone tipa `date`
 * Prisma vraća kao ponoć UTC; Beograd je UTC+1/+2, pa lokalni dan ostaje isti dan.
 * (Za `timestamptz` polja to ne bi važilo — zato datumi na fakturi i jesu `date`.)
 */
function parts(d: Date): { dd: string; mm: string; yyyy: string; yy: string } {
  const p = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  return {
    dd: p(d.getDate()),
    mm: p(d.getMonth() + 1),
    yyyy,
    yy: yyyy.slice(-2),
  };
}

/**
 * Domaći datum: `DD-MM-YY` (`25-12-25`) — crtice i DVOCIFRENA godina.
 * Koristi se na IFR/IFGP/IFUSL (datum izdavanja, valuta, datum prometa).
 */
export function formatDateDomestic(d: Date | null | undefined): string {
  if (!d) return "";
  const { dd, mm, yy } = parts(d);
  return `${dd}-${mm}-${yy}`;
}

/**
 * Ino datum: `DD.MM.GGGG.` (`25.04.2025.`) — tačke i **tačka na kraju**, četvorocifrena
 * godina. Koristi se na ino robi (`Date:`) i ino usluzi (`Payment terms:`).
 */
export function formatDateForeign(d: Date | null | undefined): string {
  if (!d) return "";
  const { dd, mm, yyyy } = parts(d);
  return `${dd}.${mm}.${yyyy}.`;
}

/**
 * `Date of delivery` na ino usluzi (060/26) je — uprkos tome što je ceo obrazac
 * engleski — u DOMAĆEM obliku `DD-MM-YY` (`06-03-26`), dok je `Payment terms:` na istoj
 * strani `DD.MM.GGGG.`. Zato ovo ima svoje ime umesto da se zove `formatDateDomestic`:
 * kad vlasnik jednom presudi da se ujednači, menja se samo ovde.
 */
export function formatDeliveryDate(d: Date | null | undefined): string {
  return formatDateDomestic(d);
}

/**
 * Broj računa za prikaz na papiru.
 *
 * **Presuđeno O-F1** (STAMPA_FAKTURA_ODLUKE.md): 4.0 prelazi na BigBit format `657/25`
 * u samoj numeraciji — dakle broj se NE skraćuje u štampi, nego takav i stoji u bazi,
 * u SEF-u i u glavnoj knjizi. Ova funkcija zato samo prikazuje ono što je zapisano.
 *
 * Ostaje kao jedno mesto kroz koje prolazi svih pet obrazaca: ako se prikaz ikada bude
 * razlikovao od zapisa, menja se ovde i nigde više. Samu numeraciju pravi
 * `numbering.service.ts` — ne ovaj fajl.
 */
export function formatInvoiceNumber(
  documentNumber: string | null | undefined,
): string {
  return (documentNumber ?? "").trim();
}
