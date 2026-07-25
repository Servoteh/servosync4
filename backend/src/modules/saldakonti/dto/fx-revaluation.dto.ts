import { BadRequestException, ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DTO-i revalorizacije deviznih otvorenih stavki (C2 — kursne razlike na dan bilansa).
 * Obrazac: interface + ručna validate*() (kao ostatak saldakonta; class-validator još
 * nije uveden, BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 *
 * Zakonska osnova: devizna potraživanja/obaveze se na dan bilansa (31.12.) preračunavaju
 * po kursu na taj dan; razlika je prihod (663) ili rashod (563) perioda.
 */

/** Domaća valuta — nema šta da se revalorizuje. */
const HOME_CURRENCY = "RSD";

/** GET /saldakonti/fx-revaluation/preview — presek + valuta (+ firma). */
export interface FxRevaluationPreviewQuery {
  asOfDate?: string; // ISO datum preseka (31.12.)
  currency?: string; // devizna valuta (EUR, USD…)
  companyId?: string | number;
  allowStaleRate?: string | boolean; // svesno dozvoli kurs sa ranijeg dana
  force?: string | boolean; // svesno uključi sporne grupe u pregled
}

/** POST /saldakonti/fx-revaluation/run — obračun + knjiženje kursnih razlika. */
export interface FxRevaluationRunDto {
  asOfDate: string; // ISO datum preseka
  currency: string; // devizna valuta
  companyId?: number;
  note?: string;
  /**
   * Svesno uključi SPORNE grupe (devizni i dinarski saldo se ne slažu — npr. delimično
   * zatvaranje bez deviznog para) u obračun. Obrazac `force` iz fakturisanje.service.ts.
   */
  force?: boolean;
  /**
   * Svesno dozvoli obračun po kursu sa ranijeg dana kad kursna lista za dan preseka
   * nije uneta. Bez ovoga obračun odbija (revizorski trag = `rateDate` obračuna).
   */
  allowStaleRate?: boolean;
  /** Kurs koji je korisnik video u pregledu — razlika → 409 (podaci su se promenili). */
  expectedRate?: string | number;
  /** Neto efekat koji je korisnik video u pregledu — razlika → 409. */
  expectedNetAmount?: string | number;
}

/** POST /saldakonti/fx-revaluation/reverse — storno obračuna (oslobađa presek). */
export interface FxRevaluationReverseDto {
  runId: number;
  reason?: string;
}

/** GET /saldakonti/fx-revaluation — lista ranijih obračuna. */
export interface FxRevaluationListQuery {
  year?: string | number;
  currency?: string;
}

/**
 * Valuta obračuna → normalizovana (trim + velika slova). Prazna, nepravilne dužine
 * ili RSD → 400 (dinarska stavka nema kursnu razliku).
 */
export function normalizeFxCurrency(value: unknown): string {
  const cur = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (cur === "") throw new BadRequestException("Valuta je obavezna.");
  if (cur.length !== 3)
    throw new BadRequestException(
      "Valuta mora imati tačno tri znaka (npr. EUR).",
    );
  if (cur === HOME_CURRENCY)
    throw new BadRequestException(
      "Kursne razlike se obračunavaju samo za devizne valute — RSD nema kursnu razliku.",
    );
  return cur;
}

/**
 * Datum preseka → Date. Neispravan datum = 400. Datum u BUDUĆNOSTI = 409 (isti
 * obrazac kao `lockOlderThan` u gl-write.service.ts): kurs za budući dan ne postoji,
 * a obračun bi zauzeo (presek, valuta) slot za period koji se još knjiži.
 */
export function parseAsOfDate(value: unknown): Date {
  if (typeof value !== "string" || value.trim() === "")
    throw new BadRequestException("Datum preseka je obavezan.");
  const d = new Date(value);
  if (Number.isNaN(d.getTime()))
    throw new BadRequestException(
      "Datum preseka mora biti validan datum (YYYY-MM-DD).",
    );
  if (d.getTime() > Date.now())
    throw new ConflictException(
      `Datum preseka (${d.toISOString().slice(0, 10)}) je u budućnosti — ` +
        `kurs za taj dan ne postoji. Izaberi datum do danas.`,
    );
  return d;
}

/** Firma (company_id); prazno → undefined (sve firme / podrazumevana 0 pri upisu). */
export function parseCompanyId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new BadRequestException(
      "Firma (companyId) mora biti nenegativan ceo broj.",
    );
  return n;
}

export function validateFxRevaluationRun(dto: FxRevaluationRunDto): void {
  if (dto == null || typeof dto !== "object")
    throw new BadRequestException("Telo zahteva je obavezno.");
  // Datum i valuta se validiraju kroz parse*/normalize* u servisu (jedno mesto istine);
  // ovde hvatamo samo strukturne greške tela.
  if (dto.note !== undefined && typeof dto.note !== "string")
    throw new BadRequestException("Napomena mora biti tekst.");
  if (dto.force !== undefined && typeof dto.force !== "boolean")
    throw new BadRequestException("Polje force mora biti true ili false.");
  if (
    dto.allowStaleRate !== undefined &&
    typeof dto.allowStaleRate !== "boolean"
  )
    throw new BadRequestException(
      "Polje allowStaleRate mora biti true ili false.",
    );
  // Očekivane vrednosti iz pregleda se samo PARSIRAJU ovde (poređenje je u servisu).
  parseExpectedDecimal(dto.expectedRate, "expectedRate");
  parseExpectedDecimal(dto.expectedNetAmount, "expectedNetAmount");
}

/**
 * Očekivana vrednost iz pregleda (kurs / neto) → Decimal; prazno → undefined.
 * Decimal, nikad Float — poređenje mora biti egzaktno na 6 odnosno 2 decimale.
 */
export function parseExpectedDecimal(
  value: unknown,
  label: string,
): Prisma.Decimal | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number")
    throw new BadRequestException(`Polje ${label} mora biti broj.`);
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(value);
  } catch {
    throw new BadRequestException(`Polje ${label} mora biti broj.`);
  }
  if (!parsed.isFinite())
    throw new BadRequestException(`Polje ${label} mora biti konačan broj.`);
  return parsed;
}

/**
 * Zastavica iz query stringa (`?allowStaleRate=1`) ili tela. Prihvata "1"/"true"/"da"
 * (i logičku vrednost); sve ostalo je false. Prazno → false.
 */
export function parseFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "da";
}

export function validateFxRevaluationReverse(
  dto: FxRevaluationReverseDto,
): void {
  if (
    dto == null ||
    typeof dto.runId !== "number" ||
    !Number.isInteger(dto.runId) ||
    dto.runId <= 0
  )
    throw new BadRequestException("runId mora biti pozitivan ceo broj.");
  if (dto.reason !== undefined && typeof dto.reason !== "string")
    throw new BadRequestException("Razlog storna mora biti tekst.");
}

/** Godina iz query-ja (filter liste); prazno → undefined. */
export function parseYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 2000 || n > 2100)
    throw new BadRequestException("Godina mora biti ceo broj (2000–2100).");
  return n;
}
