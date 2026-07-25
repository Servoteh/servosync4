import { BadRequestException } from "@nestjs/common";

/**
 * DTO-i avansnog računa (izlazni AVR, Batch C §C1a).
 * Obrazac: interface + ručna validate*() koja vraća NORMALIZOVAN oblik (kao
 * storno-invoice.dto — BACKEND_RULES §6; class-validator još nije uveden).
 *
 * Novac se NE pretvara u Number nigde na putu: iznos ostaje string i servis od
 * njega pravi `Prisma.Decimal` (BACKEND_RULES §3 — nikad Float). DTO prima i
 * `number` (JSON telo iz FE) — tada se koristi `String(value)` bez aritmetike.
 *
 * Poruke na srpskom, kod na engleskom.
 */

/** Iznos iz JSON tela: broj ili string (decimalna tačka). */
export type AmountInput = number | string;

// ── kreiranje AVR iz predračuna ──────────────────────────────────────────────

export interface CreateAdvanceInvoiceDto {
  /** Izvorni predračun/ponuda (Invoice.id, PON/PROF, level 250). */
  proformaId: number;
  /** BRUTO iznos avansa; podrazumevano ceo `grossTotal` predračuna. */
  amount?: AmountInput;
  /** Datum izdavanja AVR-a (ISO); podrazumevano danas. */
  documentDate?: string;
}

export interface NormalizedCreateAdvanceInvoice {
  proformaId: number;
  /** null = ceo bruto predračuna. */
  amount: string | null;
  documentDate: Date | null;
}

export function validateCreateAdvanceInvoice(
  dto: CreateAdvanceInvoiceDto,
): NormalizedCreateAdvanceInvoice {
  const errors: string[] = [];

  if (!isPositiveInt(dto?.proformaId)) {
    errors.push("Predračun (proformaId) je obavezan.");
  }

  let amount: string | null = null;
  if (dto?.amount !== undefined && dto.amount !== null) {
    const parsed = parseAmount(dto.amount, "Iznos avansa", errors);
    if (parsed !== null) amount = parsed;
  }

  const documentDate = parseDate(
    dto?.documentDate,
    "Datum avansnog računa",
    errors,
  );

  if (errors.length) throw new BadRequestException(errors);
  return { proformaId: dto.proformaId, amount, documentDate };
}

// ── naplata avansa (PDV obaveza nastaje NAPLATOM) ────────────────────────────

export interface MarkAdvancePaidDto {
  /** AVR koji se naplaćuje (Invoice.id, documentType='AVR'). */
  advanceInvoiceId: number;
  /** Datum naplate (ISO) — datum nastanka PDV obaveze po avansu. */
  paidAt: string;
  /** Naplaćen BRUTO iznos. */
  amount: AmountInput;
}

export interface NormalizedMarkAdvancePaid {
  advanceInvoiceId: number;
  paidAt: Date;
  amount: string;
}

export function validateMarkAdvancePaid(
  dto: MarkAdvancePaidDto,
): NormalizedMarkAdvancePaid {
  const errors: string[] = [];

  if (!isPositiveInt(dto?.advanceInvoiceId)) {
    errors.push("Avansni račun (advanceInvoiceId) je obavezan.");
  }

  const paidAt = parseDate(dto?.paidAt, "Datum naplate avansa", errors);
  if (paidAt === null && dto?.paidAt === undefined) {
    errors.push("Datum naplate avansa je obavezan.");
  }

  const amount = parseAmount(dto?.amount, "Naplaćen iznos avansa", errors);
  if (amount === null && dto?.amount === undefined) {
    errors.push("Naplaćen iznos avansa je obavezan.");
  }

  if (errors.length) throw new BadRequestException(errors);
  // Nakon provera iznad oba polja postoje (errors bi bio neprazan inače).
  return {
    advanceInvoiceId: dto.advanceInvoiceId,
    paidAt: paidAt as Date,
    amount: amount as string,
  };
}

// ── odbijanje avansa na konačnom računu ──────────────────────────────────────

export interface ApplyAdvanceDto {
  /** Konačni (proknjižen) račun na kome se avans odbija. */
  invoiceId: number;
  /** AVR čiji se naplaćen avans odbija. */
  advanceInvoiceId: number;
}

export function validateApplyAdvance(dto: ApplyAdvanceDto): ApplyAdvanceDto {
  const errors: string[] = [];
  if (!isPositiveInt(dto?.invoiceId)) {
    errors.push("Konačni račun (invoiceId) je obavezan.");
  }
  if (!isPositiveInt(dto?.advanceInvoiceId)) {
    errors.push("Avansni račun (advanceInvoiceId) je obavezan.");
  }
  if (errors.length) throw new BadRequestException(errors);
  return { invoiceId: dto.invoiceId, advanceInvoiceId: dto.advanceInvoiceId };
}

// ── pomoćne provere ──────────────────────────────────────────────────────────

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Iznos → normalizovan decimalni string. Prihvata broj (JSON telo) i string;
 * NE računa ništa u Float-u — broj se samo prepisuje u string (`String(v)`).
 */
function parseAmount(
  value: AmountInput | undefined | null,
  label: string,
  errors: string[],
): string | null {
  if (value === undefined || value === null) return null;
  const raw = typeof value === "number" ? String(value) : String(value).trim();
  if (raw.length === 0 || !/^-?\d+(\.\d+)?$/.test(raw)) {
    errors.push(`${label} nije ispravan broj.`);
    return null;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    errors.push(`${label} nije konačan broj.`);
    return null;
  }
  return raw;
}

/** ISO datum → Date; nevalidan datum upisuje grešku i vraća null. */
function parseDate(
  value: string | undefined,
  label: string,
  errors: string[],
): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} nije ispravan.`);
    return null;
  }
  return new Date(value);
}
