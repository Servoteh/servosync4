import { BadRequestException } from "@nestjs/common";

/**
 * DTO-i za Blagajnu (gotovinski dnevnik). Obrazac: interface + validate*()
 * (BACKEND_RULES §6). Novac kao number u ulazu → Decimal u servisu.
 */

export interface CreateCashJournalDto {
  name: string;
  accountCode: string; // konto blagajne (npr. 2430)
  currency?: string;
  companyId?: number;
}

export function validateCreateCashJournal(dto: CreateCashJournalDto): void {
  const errors: string[] = [];
  if (typeof dto.name !== "string" || dto.name.trim() === "")
    errors.push("Naziv blagajne je obavezan.");
  if (typeof dto.accountCode !== "string" || dto.accountCode.trim() === "")
    errors.push("Konto blagajne je obavezan.");
  if (dto.currency !== undefined && (typeof dto.currency !== "string" || dto.currency.length > 3))
    errors.push("Valuta mora biti oznaka do 3 znaka.");
  if (errors.length) throw new BadRequestException(errors);
}

export interface CreateCashEntryDto {
  direction: string; // IN (uplatnica) | OUT (isplatnica)
  amount: number; // > 0
  entryDate?: string; // ISO; default danas
  partnerId?: number | null; // komitent
  contraAccount: string; // protivkonto
  description?: string | null;
  /** knjiži odmah u GK (default true — uplatnica/isplatnica je izvršena gotovina). */
  post?: boolean;
}

const DIRECTIONS = new Set(["IN", "OUT"]);

export function validateCreateCashEntry(dto: CreateCashEntryDto): void {
  const errors: string[] = [];
  if (typeof dto.direction !== "string" || !DIRECTIONS.has(dto.direction))
    errors.push("Smer mora biti IN (uplatnica) ili OUT (isplatnica).");
  if (typeof dto.amount !== "number" || Number.isNaN(dto.amount) || dto.amount <= 0)
    errors.push("Iznos mora biti pozitivan broj.");
  if (typeof dto.contraAccount !== "string" || dto.contraAccount.trim() === "")
    errors.push("Protivkonto je obavezan.");
  if (
    dto.entryDate !== undefined &&
    Number.isNaN(Date.parse(dto.entryDate))
  )
    errors.push("Datum mora biti validan.");
  if (
    dto.partnerId !== undefined &&
    dto.partnerId !== null &&
    (!Number.isInteger(dto.partnerId) || dto.partnerId <= 0)
  )
    errors.push("Komitent mora biti pozitivan ceo broj.");
  if (errors.length) throw new BadRequestException(errors);
}
