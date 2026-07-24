import { BadRequestException } from "@nestjs/common";

/**
 * DTO za registar kursne liste (ExchangeRate → `exchange_rates`). Obrazac: interface +
 * ručna validate*() funkcija (class-validator još nije uveden u ovim modulima — v.
 * izvodi dto/statement-line.dto.ts i pdv dto/tax-rates.dto.ts). Poruke na srpskom,
 * kod na engleskom.
 *
 * BigBit pravila kursa (doc 09 §banking): IZVODI/nalozi = PRODAJNI (sellRate),
 * blagajna = SREDNJI (middleRate). Sve tri komponente (kupovni/srednji/prodajni)
 * čuvaju se po (rateDate, currency) — @@unique u šemi.
 */

/** Tipovi kursa — kolone koje resolver vraća (kupovni/srednji/prodajni). */
export type ExchangeRateType = "buy" | "middle" | "sell";
export const RATE_TYPES: readonly ExchangeRateType[] = ["buy", "middle", "sell"];

/** Imena decimalnih kolona stope — jedan izvor za validaciju/mapiranje. */
export const RATE_FIELDS = ["buyRate", "middleRate", "sellRate"] as const;
export type RateField = (typeof RATE_FIELDS)[number];

/** Zajednički deo unosa/izmene — tri komponente kursa + izvor + napomena. */
interface ExchangeRateRatesPart {
  buyRate?: number; // kupovni
  middleRate?: number; // srednji (blagajna)
  sellRate?: number; // prodajni (izvodi/nalozi)
  source?: string | null; // NBS | RUCNO | PREPIS (VarChar 20)
  note?: string | null; // slobodna napomena (VarChar 255)
}

export interface CreateExchangeRateDto extends ExchangeRateRatesPart {
  rateDate: string; // ISO datum važenja — OBAVEZAN
  currency: string; // 3 slova (EUR/USD/CHF) — normalizuje se na uppercase
}

/** Izmena — sva polja opciona (PATCH). Promena (rateDate,currency) može udariti @@unique → 409. */
export interface UpdateExchangeRateDto extends ExchangeRateRatesPart {
  rateDate?: string;
  currency?: string;
}

/** Telo „Prepiši od datuma za datum" (BigBit „Formiraj iz datuma za datum"). */
export interface CopyExchangeRatesDto {
  fromDate: string; // ISO — izvorni dan (odakle se kopira)
  toDate: string; // ISO — ciljni dan (kuda se kopira; postojeći parovi se preskaču)
}

const CURRENCY_RE = /^[A-Za-z]{3}$/u;

/** Normalizacija valute na kanonski oblik (trim + uppercase). */
export function normalizeCurrency(v: string): string {
  return v.trim().toUpperCase();
}

export function validateCreateExchangeRate(dto: CreateExchangeRateDto): void {
  const errors: string[] = [];

  if (typeof dto.rateDate !== "string" || Number.isNaN(Date.parse(dto.rateDate)))
    errors.push("Datum kursa (rateDate) je obavezan i mora biti validan datum.");

  if (typeof dto.currency !== "string" || !CURRENCY_RE.test(dto.currency.trim()))
    errors.push("Valuta mora biti oznaka od 3 slova (npr. EUR, USD, CHF).");

  validateRatesCommon(dto, errors);

  // Bar jedna stopa mora biti uneta (> 0) — prazan red kursa je besmislen.
  const anyRate = RATE_FIELDS.some((f) => {
    const v = dto[f];
    return typeof v === "number" && !Number.isNaN(v) && v > 0;
  });
  if (!anyRate)
    errors.push(
      "Unesite bar jedan kurs (kupovni, srednji ili prodajni) veći od nule.",
    );

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateExchangeRate(dto: UpdateExchangeRateDto): void {
  const errors: string[] = [];

  if (
    dto.rateDate !== undefined &&
    (typeof dto.rateDate !== "string" || Number.isNaN(Date.parse(dto.rateDate)))
  )
    errors.push("Datum kursa (rateDate) mora biti validan datum.");

  if (
    dto.currency !== undefined &&
    (typeof dto.currency !== "string" || !CURRENCY_RE.test(dto.currency.trim()))
  )
    errors.push("Valuta mora biti oznaka od 3 slova (npr. EUR, USD, CHF).");

  validateRatesCommon(dto, errors);

  if (errors.length) throw new BadRequestException(errors);
}

export function validateCopyExchangeRates(dto: CopyExchangeRatesDto): void {
  const errors: string[] = [];

  if (typeof dto.fromDate !== "string" || Number.isNaN(Date.parse(dto.fromDate)))
    errors.push("Izvorni datum (fromDate) je obavezan i mora biti validan datum.");

  if (typeof dto.toDate !== "string" || Number.isNaN(Date.parse(dto.toDate)))
    errors.push("Ciljni datum (toDate) je obavezan i mora biti validan datum.");

  if (errors.length) throw new BadRequestException(errors);
}

/** Svaka UNETA stopa mora biti pozitivan broj; izvor/napomena ograničenja dužine. */
function validateRatesCommon(
  dto: ExchangeRateRatesPart,
  errors: string[],
): void {
  for (const f of RATE_FIELDS) {
    const v = dto[f];
    if (
      v !== undefined &&
      v !== null &&
      (typeof v !== "number" || Number.isNaN(v) || v <= 0)
    )
      errors.push(`Kurs (${f}) mora biti pozitivan broj.`);
  }

  if (
    dto.source !== undefined &&
    dto.source !== null &&
    (typeof dto.source !== "string" || dto.source.length > 20)
  )
    errors.push("Izvor (source) može imati najviše 20 znakova.");

  if (
    dto.note !== undefined &&
    dto.note !== null &&
    (typeof dto.note !== "string" || dto.note.length > 255)
  )
    errors.push("Napomena (note) može imati najviše 255 znakova.");
}
