import { UnprocessableEntityException } from "@nestjs/common";
import { isValidPib } from "../../common/validation/pib.util";
import { isValidGln } from "../../common/validation/gln.util";
import { isValidAccountNumber } from "../placanja/mod97.util";
import type { CustomerWriteData } from "./dto/upsert-customer.dto";

/**
 * BigBit-verna semantika validacije komitenta.
 * =========================================================================
 * Izvor pravila: `docs/migration/BIGBIT_KOMITENTI.md` §3 (+ §4 za formu, §5.1 za
 * placeholder PIB-a). Vodeći zahtev vlasnika: **ponoviti BigBit ponašanje, ne
 * strože.** Zato je ovde tačno tri nivoa strogosti, onako kako ih BigBit ima:
 *
 *   1. PIB → POLU-TVRDA brana. Prava BigBit forma u `Form_BeforeUpdate` pita
 *      „PIB nije dobar!!! Da li nastavljate unos?" (Yes/No, default **No**) i na
 *      „No" otkazuje snimanje (§3.1). HTTP prevod: prvi zahtev → 422
 *      `PIB_NIJE_DOBAR`, ponovljen sa `confirmInvalidTaxId: true` → prolazi.
 *      `skipTaxIdValidation` (`NeProveravajPIB`) preskače proveru u celosti —
 *      to je BigBit-ov predviđen izlaz za strane komitente i fizička lica.
 *   2. GLN i tri žiro računa → SAMO UPOZORENJE. U obe varijante forme to su
 *      računate kolone `DobarGLN` / `DobarTR1..3` u `RecordSource`-u, čisto
 *      vizuelni indikatori — nijedna ne blokira snimanje (§3.2, §3.4). Tvrda
 *      brana ovde bi bila STROŽA od izvora i odbijala bi zatečene podatke.
 *   3. Dupli PIB → SAMO UPOZORENJE, uz IMENOVANJE zatečenog komitenta. BigBit
 *      duplikat tolerira: postoji samo administrativni izveštaj
 *      `00_FirmeSaDuplimPIBovima` na dugme, nema brane pri unosu (§3.3).
 *
 * Validatori se NE pišu ponovo — koriste se postojeći verni portovi:
 *   `common/validation/pib.util.ts`  → `DobarPIB`
 *   `common/validation/gln.util.ts`  → `DobarGLN`
 *   `placanja/mod97.util.ts`         → `DobarTR` (`isValidAccountNumber`)
 */

/** Komitent koji već nosi isti PIB (podskup kolona dovoljan za poruku). */
export interface ExistingTaxIdHolder {
  id: number;
  name: string;
  city?: string | null;
}

/** Ulaz za PIB odluku — sve tri vrednosti u konačnom obliku posle merge-a. */
export interface TaxIdDecisionInput {
  /** Konačan PIB (posle merge-a starog i novog stanja); `null` = prazan. */
  taxId: string | null;
  /** `NeProveravajPIB` — konačna vrednost. */
  skipTaxIdValidation: boolean;
  /** Klijent je eksplicitno odgovorio „Yes" na BigBit pitanje. */
  confirmInvalidTaxId: boolean;
}

/**
 * PIB placeholder za komitenta bez PIB-a — `"XX_" & Sifra`.
 *
 * Ovo NIJE naša izmišljotina: identičnu vrednost upisuje sam BigBit transfer
 * (`DodajNoveKomitenteIzBigBita`, §5.1):
 *   `IIf(Nz([PIB],"")="", "XX_" & [Sifra], [PIB])`
 * Postoji zato što je `Komitenti.PIB` u originalu NULL-abilan, a `customers.tax_id`
 * u 4.0 je NOT NULL — bez placeholder-a komitent bez PIB-a (strani kupac, fizičko
 * lice) uopšte ne može da se upiše.
 */
export function taxIdPlaceholder(id: number): string {
  return `XX_${id}`;
}

/** Da li je vrednost placeholder (`XX_<Sifra>`), a ne stvaran PIB. */
export function isPlaceholderTaxId(taxId: string | null | undefined): boolean {
  return typeof taxId === "string" && /^XX_\d+$/u.test(taxId.trim());
}

/**
 * PIB odluka — jedina POLU-TVRDA brana, verna `Form_BeforeUpdate` (§3.1).
 *
 * Redosled je isti kao u BigBit-u:
 *   `NeProveravajPIB` → nema provere uopšte (i prazan PIB je u redu);
 *   inače `DobarPIB(Nz([PIB],""))` — prazan PIB pada isto kao pogrešan, jer
 *   `DobarPIB("")` vraća `False`, pa se i za njega postavlja isto pitanje.
 *
 * @throws UnprocessableEntityException `code: "PIB_NIJE_DOBAR"` dok klijent ne
 *         potvrdi (`confirmInvalidTaxId`) ili ne uključi `skipTaxIdValidation`.
 */
export function assertTaxIdAcceptable(input: TaxIdDecisionInput): void {
  if (input.skipTaxIdValidation) return;

  const taxId = (input.taxId ?? "").trim();
  // Placeholder je legitimno zatečeno stanje (uneo ga BigBit transfer) — ne
  // provlači se kroz DobarPIB, inače bi svaka izmena takvog komitenta tražila
  // potvrdu za PIB koji korisnik nije ni dirao.
  if (isPlaceholderTaxId(taxId)) return;
  if (taxId !== "" && isValidPib(taxId)) return;
  if (input.confirmInvalidTaxId) return;

  const what =
    taxId === ""
      ? "PIB nije unet"
      : `PIB „${taxId}" nije ispravan (kontrolna cifra se ne poklapa)`;

  throw new UnprocessableEntityException({
    statusCode: 422,
    error: "Unprocessable Entity",
    code: "PIB_NIJE_DOBAR",
    message:
      `${what}. Ako komitent nema srpski PIB (strano lice, fizičko lice), ` +
      "uključite opciju „Ne proveravaj PIB“ (skipTaxIdValidation) — tada se upisuje " +
      "oznaka XX_<šifra>, isto kao u BigBit-u. Ako svesno unosite ovakav PIB, " +
      "ponovite zahtev sa confirmInvalidTaxId: true.",
    taxId: taxId === "" ? null : taxId,
  });
}

/**
 * Čitljiv opis komitenta za poruku — poruka MORA da imenuje zatečenog komitenta,
 * ne da kaže samo „već postoji".
 */
export function describeCustomer(c: ExistingTaxIdHolder): string {
  const city = c.city?.trim();
  return city ? `${c.id} — „${c.name}", ${city}` : `${c.id} — „${c.name}"`;
}

/**
 * Upozorenje o duplom PIB-u (NE greška — v. §3.3: BigBit dupli PIB tolerira i ima
 * samo izveštaj `00_FirmeSaDuplimPIBovima`).
 *
 * ⚠️ ODLUKA „brana ili samo izveštaj" JE OTVORENA (klasa BACKEND_RULES §11). Tvrd
 * `UNIQUE` na `customers.tax_id` se NE sme uvesti jednostrano: zatečeni podaci
 * duplikate imaju, pa bi indeks počeo da obara/preskače uvoz iz BigBit-a.
 */
export function duplicateTaxIdWarning(
  taxId: string | null,
  others: ExistingTaxIdHolder[],
): string | null {
  const value = (taxId ?? "").trim();
  if (value === "" || isPlaceholderTaxId(value) || others.length === 0) {
    return null;
  }

  const shown = others.slice(0, 3).map(describeCustomer).join("; ");
  const rest =
    others.length > 3 ? ` i još ${others.length - 3} komitenata` : "";
  return (
    `PIB ${value} već vodi ${others.length === 1 ? "komitent" : "komitenti"}: ` +
    `${shown}${rest}. BigBit dupli PIB dozvoljava, pa unos nije zaustavljen — ` +
    "proverite da li se radi o istom pravnom licu."
  );
}

/**
 * „Meka" BigBit upozorenja — GLN i tri žiro računa. Nikad ne obaraju zahtev
 * (§3.2, §3.4: računate kolone su vizuelni indikator, ne brana).
 *
 * Proverava se samo ono što je u ovom zahtevu POSLATO (`undefined` = nije dirano),
 * da izmena telefona ne bi prijavljivala račun koji korisnik nije ni video.
 */
export function softValidationWarnings(data: CustomerWriteData): string[] {
  const warnings: string[] = [];

  if (typeof data.gln === "string" && !isValidGln(data.gln)) {
    warnings.push(
      `GLN „${data.gln}" nije ispravan — BigBit traži 6 do 14 cifara ` +
        "(bez kontrolne cifre po GS1 standardu). Vrednost je sačuvana kakva jeste.",
    );
  }

  const accounts: [keyof CustomerWriteData, string][] = [
    ["bankAccount1", "Žiro račun 1"],
    ["bankAccount2", "Žiro račun 2"],
    ["bankAccount3", "Žiro račun 3"],
  ];
  for (const [field, label] of accounts) {
    const value = data[field];
    if (typeof value === "string" && !isValidAccountNumber(value)) {
      warnings.push(
        `${label} „${value}" ne prolazi kontrolu (oblik banka-račun-KK, ` +
          "MOD97). Vrednost je sačuvana kakva jeste, isto kao u BigBit-u.",
      );
    }
  }

  return warnings;
}

/**
 * BigBit automatika vozača (`Form_AfterUpdate`, §4, linije :212-219): ako je
 * `Vrsta sifre` LIKE `"Voza*"` a `IDVozac` prazan, slog se snimi pa se `IDVozac`
 * postavi na SOPSTVENU `Sifra` — komitent-vozač referiše samog sebe (odatle
 * self-FK `customers.driver_id → customers.id`).
 *
 * Poređenje je case-insensitive jer legacy modul radi pod `Option Compare Database`.
 */
export function isDriverCodeType(codeTypeCode: string | null | undefined): boolean {
  return typeof codeTypeCode === "string"
    ? codeTypeCode.trim().toLowerCase().startsWith("voza")
    : false;
}
