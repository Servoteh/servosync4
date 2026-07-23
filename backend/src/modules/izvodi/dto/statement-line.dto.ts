import { BadRequestException } from "@nestjs/common";

/**
 * DTO za RUČNI unos i korekciju stavke izvoda (BigBit paritet — „Unos naloga glavne knjige"
 * dozvoljava ručno kucanje stavke pored TXT importa). Obrazac: interface + validate*()
 * (class-validator još nije uveden — BACKEND_RULES §6). Poruke na srpskom, kod na engleskom.
 */
export interface CreateStatementLineDto {
  partnerAccount?: string | null; // žiro komitenta (opciono za ručni unos)
  partnerName?: string | null; // naziv komitenta
  amount: number; // iznos (> 0)
  direction: string; // DEBIT (odliv) | CREDIT (priliv)
  referenceNumber?: string | null; // poziv na broj / broj dokumenta
  documentDate?: string | null; // ISO datum dokumenta
  matchedCustomerId?: number | null; // ručno izabran komitent (komitent-picker)
}

/** Izmena postojeće stavke — sva polja opciona (PATCH semantika). */
export interface UpdateStatementLineDto {
  partnerAccount?: string | null;
  partnerName?: string | null;
  amount?: number;
  direction?: string;
  referenceNumber?: string | null;
  documentDate?: string | null;
  matchedCustomerId?: number | null;
}

const DIRECTIONS = new Set(["DEBIT", "CREDIT"]);

export function validateCreateStatementLine(dto: CreateStatementLineDto): void {
  const errors: string[] = [];

  if (typeof dto.amount !== "number" || Number.isNaN(dto.amount) || dto.amount <= 0)
    errors.push("Iznos mora biti pozitivan broj.");

  if (typeof dto.direction !== "string" || !DIRECTIONS.has(dto.direction))
    errors.push("Smer mora biti DEBIT (odliv) ili CREDIT (priliv).");

  validateOptionalCommon(dto, errors);

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateStatementLine(dto: UpdateStatementLineDto): void {
  const errors: string[] = [];

  if (dto.amount !== undefined) {
    if (typeof dto.amount !== "number" || Number.isNaN(dto.amount) || dto.amount <= 0)
      errors.push("Iznos mora biti pozitivan broj.");
  }
  if (dto.direction !== undefined && !DIRECTIONS.has(dto.direction))
    errors.push("Smer mora biti DEBIT (odliv) ili CREDIT (priliv).");

  validateOptionalCommon(dto, errors);

  if (errors.length) throw new BadRequestException(errors);
}

function validateOptionalCommon(
  dto: CreateStatementLineDto | UpdateStatementLineDto,
  errors: string[],
): void {
  if (
    dto.documentDate !== undefined &&
    dto.documentDate !== null &&
    Number.isNaN(Date.parse(dto.documentDate))
  )
    errors.push("Datum dokumenta mora biti validan datum.");

  if (
    dto.matchedCustomerId !== undefined &&
    dto.matchedCustomerId !== null &&
    (!Number.isInteger(dto.matchedCustomerId) || dto.matchedCustomerId <= 0)
  )
    errors.push("Komitent (matchedCustomerId) mora biti pozitivan ceo broj.");

  if (
    dto.referenceNumber !== undefined &&
    dto.referenceNumber !== null &&
    typeof dto.referenceNumber === "string" &&
    dto.referenceNumber.length > 30
  )
    errors.push("Poziv na broj može imati najviše 30 znakova.");
}
