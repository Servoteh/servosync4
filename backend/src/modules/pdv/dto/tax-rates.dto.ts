import { BadRequestException } from "@nestjs/common";

/**
 * DTO za registar poreskih tarifa (R_Tarife → `tax_rates`). Obrazac: interface +
 * validate*() funkcije (class-validator još nije uveden za ove module — v. izvodi
 * dto/statement-line.dto.ts). Poruke na srpskom, kod na engleskom.
 *
 * Model `TaxRate` drži pet komponenti stope (base/railway/city/war/special) — efektivna
 * stopa na dan = njihov ZBIR (isti algoritam kao robno calculation.service `taxRateOf`).
 * FE po pravilu unosi samo `baseRate` (npr. 20/10), ostale su 0.
 */

/** Zajednički deo — pet nenegativnih komponenti stope + kraj važenja. */
interface TaxRateRatesPart {
  baseRate?: number;
  railwayRate?: number;
  cityRate?: number;
  warRate?: number;
  specialRate?: number;
  vatGroup?: string | null;
  validTo?: string | null; // ISO ili null (otvoreno)
}

export interface CreateTaxRateDto extends TaxRateRatesPart {
  code: string; // šifra tarife (VarChar(5), @unique u šemi)
  description?: string | null; // napomena / naziv
  validFrom: string; // ISO — OBAVEZAN
}

/** Izmena — sva polja opciona (PATCH). `code` se NE menja (FK iz price_list_entries). */
export interface UpdateTaxRateDto extends TaxRateRatesPart {
  description?: string | null;
  validFrom?: string;
}

/** Imena komponenti stope — jedan izvor za validaciju i sumiranje. */
export const RATE_FIELDS = [
  "baseRate",
  "railwayRate",
  "cityRate",
  "warRate",
  "specialRate",
] as const;
export type RateField = (typeof RATE_FIELDS)[number];

export function validateCreateTaxRate(dto: CreateTaxRateDto): void {
  const errors: string[] = [];

  if (typeof dto.code !== "string" || dto.code.trim() === "")
    errors.push("Šifra tarife je obavezna.");
  else if (dto.code.trim().length > 5)
    errors.push("Šifra tarife može imati najviše 5 znakova.");

  if (typeof dto.validFrom !== "string" || Number.isNaN(Date.parse(dto.validFrom)))
    errors.push(
      "Datum početka važenja (validFrom) je obavezan i mora biti validan datum.",
    );

  validateCommon(dto, errors);

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateTaxRate(dto: UpdateTaxRateDto): void {
  const errors: string[] = [];

  if (
    dto.validFrom !== undefined &&
    (typeof dto.validFrom !== "string" || Number.isNaN(Date.parse(dto.validFrom)))
  )
    errors.push("Datum početka važenja (validFrom) mora biti validan datum.");

  validateCommon(dto, errors);

  if (errors.length) throw new BadRequestException(errors);
}

function validateCommon(dto: TaxRateRatesPart, errors: string[]): void {
  for (const f of RATE_FIELDS) {
    const v = dto[f];
    if (
      v !== undefined &&
      v !== null &&
      (typeof v !== "number" || Number.isNaN(v) || v < 0)
    )
      errors.push(`Stopa (${f}) mora biti nenegativan broj.`);
  }

  if (
    dto.validTo !== undefined &&
    dto.validTo !== null &&
    Number.isNaN(Date.parse(dto.validTo))
  )
    errors.push("Datum kraja važenja (validTo) mora biti validan datum.");

  if (
    dto.vatGroup !== undefined &&
    dto.vatGroup !== null &&
    (typeof dto.vatGroup !== "string" || dto.vatGroup.length > 10)
  )
    errors.push("PDV grupa (vatGroup) može imati najviše 10 znakova.");
}
