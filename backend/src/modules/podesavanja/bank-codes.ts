import { UnprocessableEntityException } from "@nestjs/common";

/**
 * IBAN i SWIFT/BIC — kanonski oblik i provera ispravnosti.
 *
 * ZAŠTO ZASEBAN FAJL: ista dva podatka se unose na DVA mesta koja pišu u DVE tabele —
 * `companies.iban/swift` (`company-details.service.ts`) i `payment_accounts.iban/swift`
 * (`payment-accounts.service.ts`). Kad bi svaki imao svoju kopiju provere, jedan bi pre ili
 * kasnije popustio, pa bi neispravan IBAN ušao na papir kroz slabija vrata. Provera zato
 * živi na jednom mestu, a oba pisca je uvoze.
 */

/** IBAN/SWIFT bez razmaka i velikim slovima (kanonski oblik za poređenje i za UBL). */
export function normalizeBankCode(
  v: string | null | undefined,
): string | null | undefined {
  if (v === undefined) return undefined;
  if (v == null) return null;
  return v.replace(/\s+/g, "").toUpperCase();
}

/**
 * IBAN — struktura po ISO 13616 (2 slova zemlje + 2 kontrolne cifre + do 30 alfanumerika)
 * i MOD-97 kontrola po ISO 7064. Ovo NIJE kozmetika: pogrešan IBAN na ino fakturi znači
 * da uplata ne stigne, a greška se otkrije tek kad kupac pozove.
 */
export function assertIban(iban: string): void {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(iban))
    throw new UnprocessableEntityException(
      "IBAN nije ispravnog oblika (dva slova zemlje, dve kontrolne cifre, pa broj računa).",
    );
  // MOD-97: prva 4 znaka na kraj, slova → brojevi (A=10 … Z=35), ostatak deljenja mora biti 1.
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const part = /\d/.test(ch)
      ? ch
      : String(ch.charCodeAt(0) - "A".charCodeAt(0) + 10);
    for (const d of part) remainder = (remainder * 10 + Number(d)) % 97;
  }
  if (remainder !== 1)
    throw new UnprocessableEntityException(
      "IBAN ne prolazi kontrolu ispravnosti (MOD-97) — proverite da nije pogrešno prepisan.",
    );
}

/** SWIFT/BIC po ISO 9362: 4 slova banka + 2 slova zemlja + 2 alfanum. lokacija + opciono 3 filijala. */
export function assertSwift(swift: string): void {
  if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift))
    throw new UnprocessableEntityException(
      "SWIFT/BIC mora imati 8 ili 11 znakova (npr. DBDBRSBG ili DBDBRSBGXXX).",
    );
}
