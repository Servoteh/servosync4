import { BadRequestException } from "@nestjs/common";

/**
 * NACRT — DTO-i za CustomerRfq (zahtev kupca za ponudu, Traka B §A).
 * Obrazac: interface + ručna validate*() (BACKEND_RULES §6). Kod engleski, poruke srpski.
 *
 * Dozvoljene vrednosti (mirror /// iz _nacrt-4.0-trakaB-predmeti.prisma):
 *   origin: PHONE | EMAIL | WEB | WALK_IN | OTHER
 *   status: DRAFT | OPEN | QUOTED | WON | LOST
 */
const RFQ_ORIGINS = ["PHONE", "EMAIL", "WEB", "WALK_IN", "OTHER"] as const;
const RFQ_STATUSES = ["DRAFT", "OPEN", "QUOTED", "WON", "LOST"] as const;

export interface CreateCustomerRfqDto {
  customerId: number; // kupac — obavezno (meki ref)
  requestDate?: string; // ISO datum; default = danas (servis)
  quoteDeadline?: string; // ISO datum — rok za ponudu
  origin?: string; // vidi RFQ_ORIGINS
  salespersonId?: number; // prodavac (meki ref); default = JWT (servis)
  proformaDocId?: number; // ponuda kupcu (meki ref na dokument)
  description?: string; // opis potrebe (postaje description predmeta)
  note?: string;
}

export interface UpdateCustomerRfqDto {
  quoteDeadline?: string;
  origin?: string;
  salespersonId?: number;
  proformaDocId?: number;
  description?: string;
  status?: string; // vidi RFQ_STATUSES
  note?: string;
}

function optPosInt(errors: string[], v: unknown, name: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0)
    errors.push(`${name} mora biti pozitivan ceo broj.`);
}
function optDate(errors: string[], v: unknown, name: string): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v)))
    errors.push(`${name} mora biti validan datum.`);
}
function optEnum(
  errors: string[],
  v: unknown,
  name: string,
  allowed: readonly string[],
): void {
  if (v === undefined || v === null) return;
  if (typeof v !== "string" || !allowed.includes(v))
    errors.push(`${name} mora biti jedna od vrednosti: ${allowed.join(", ")}.`);
}

export function validateCreateCustomerRfq(dto: CreateCustomerRfqDto): void {
  const errors: string[] = [];

  if (
    typeof dto.customerId !== "number" ||
    !Number.isInteger(dto.customerId) ||
    dto.customerId <= 0
  )
    errors.push("Komitent je obavezan.");

  optDate(errors, dto.requestDate, "Datum zahteva");
  optDate(errors, dto.quoteDeadline, "Rok za ponudu");
  optEnum(errors, dto.origin, "Poreklo", RFQ_ORIGINS);
  optPosInt(errors, dto.salespersonId, "Prodavac");
  optPosInt(errors, dto.proformaDocId, "Ponuda (dokument)");
  if (dto.description !== undefined && typeof dto.description !== "string")
    errors.push("Opis mora biti tekst.");

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateCustomerRfq(dto: UpdateCustomerRfqDto): void {
  const errors: string[] = [];

  optDate(errors, dto.quoteDeadline, "Rok za ponudu");
  optEnum(errors, dto.origin, "Poreklo", RFQ_ORIGINS);
  optEnum(errors, dto.status, "Status", RFQ_STATUSES);
  optPosInt(errors, dto.salespersonId, "Prodavac");
  optPosInt(errors, dto.proformaDocId, "Ponuda (dokument)");
  if (dto.description !== undefined && typeof dto.description !== "string")
    errors.push("Opis mora biti tekst.");

  if (Object.keys(dto).length === 0) errors.push("Nema polja za izmenu.");

  if (errors.length) throw new BadRequestException(errors);
}
