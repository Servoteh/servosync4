import { BadRequestException } from "@nestjs/common";

/**
 * DTO-i za CustomerRfq (zahtev kupca za ponudu).
 * Obrazac: interface + ručna validate*() (BACKEND_RULES §6). Kod engleski, poruke srpski.
 *
 * Dozvoljene vrednosti:
 *   origin: PHONE | EMAIL | WEB | WALK_IN | OTHER
 *   status: DRAFT | OPEN | QUOTED | WON | LOST
 *
 * `projectId` (samo u update-u) vezuje zahtev za POSTOJEĆI predmet uvezen iz BigBit-a —
 * zamena za ugašeni tok „Napravi predmet iz zahteva" (odluka 26.07.2026). `null` odvezuje.
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
  projectId?: number | null; // veži/odveži POSTOJEĆI predmet iz BigBit-a (null = odveži)
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
  // projectId: null je dozvoljen (odvezivanje) — zato ne ide kroz optPosInt.
  if (dto.projectId !== undefined && dto.projectId !== null)
    optPosInt(errors, dto.projectId, "Predmet");
  if (dto.description !== undefined && typeof dto.description !== "string")
    errors.push("Opis mora biti tekst.");

  if (Object.keys(dto).length === 0) errors.push("Nema polja za izmenu.");

  if (errors.length) throw new BadRequestException(errors);
}
