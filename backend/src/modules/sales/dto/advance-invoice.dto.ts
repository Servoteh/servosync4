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
  /**
   * Izvorni predračun/ponuda (Invoice.id, PON/PROF, level 250). OPCION:
   * avans se izdaje i po UGOVORU, bez predračuna (BigBit: dva najveća avansa 2025.
   * su po Ugovoru — doc BIGBIT_IZLAZNE_FAKTURE_I_AVANSI §4.1/G5). Bez predračuna su
   * obavezni `customerId`, `amount` i `basis`.
   */
  proformaId?: number;
  /** Kupac — obavezan SAMO kad nema predračuna (inače se uzima sa predračuna). */
  customerId?: number;
  /** BRUTO iznos avansa; uz predračun podrazumevano ceo njegov `grossTotal`. */
  amount?: AmountInput;
  /** Datum izdavanja AVR-a (ISO); podrazumevano danas. */
  documentDate?: string;
  /** OSNOV avansa (broj ugovora / slobodan opis) — obavezan bez predračuna. */
  basis?: string;
  /** Napomena na dokumentu. */
  note?: string;
  /** Šifra PDV stope (bez predračuna; podrazumevano '3' = opšta, '0' za izvoz). */
  vatRateCode?: string;
  /** Izvoz (bez PDV-a) — samo bez predračuna. */
  isExport?: boolean;
  /** Valuta (bez predračuna; podrazumevano RSD). */
  currency?: string;
  /** Firma izdavalac (numeracija po firmi); podrazumevano 0. */
  companyId?: number;
  /** Kurs (bez predračuna; podrazumevano 1). */
  exchangeRate?: AmountInput;
}

export interface NormalizedCreateAdvanceInvoice {
  /** null = avans bez izvornog dokumenta (po ugovoru). */
  proformaId: number | null;
  customerId: number | null;
  /** null = ceo bruto predračuna. */
  amount: string | null;
  documentDate: Date | null;
  basis: string | null;
  note: string | null;
  vatRateCode: string | null;
  isExport: boolean | null;
  currency: string | null;
  companyId: number | null;
  exchangeRate: string | null;
}

export function validateCreateAdvanceInvoice(
  dto: CreateAdvanceInvoiceDto,
): NormalizedCreateAdvanceInvoice {
  const errors: string[] = [];

  const hasProforma =
    dto?.proformaId !== undefined && dto?.proformaId !== null;
  if (hasProforma && !isPositiveInt(dto?.proformaId)) {
    errors.push("Predračun (proformaId) nije ispravan.");
  }

  let amount: string | null = null;
  if (dto?.amount !== undefined && dto.amount !== null) {
    const parsed = parseAmount(dto.amount, "Iznos avansa", errors);
    if (parsed !== null) amount = parsed;
  }

  const basis =
    typeof dto?.basis === "string" && dto.basis.trim().length > 0
      ? dto.basis.trim().slice(0, 255)
      : null;

  // Bez predračuna nema izvora iz kojeg bi se izveli kupac, iznos i osnov —
  // sva tri su tada obavezna (osnov je i poreski trag: „po osnovu ugovora br…").
  if (!hasProforma) {
    if (!isPositiveInt(dto?.customerId)) {
      errors.push("Kupac (customerId) je obavezan za avans bez predračuna.");
    }
    if (amount === null) {
      errors.push("Iznos avansa je obavezan za avans bez predračuna.");
    }
    if (basis === null) {
      errors.push(
        "Osnov avansa (basis — broj ugovora ili opis) je obavezan za avans bez predračuna.",
      );
    }
  }

  const documentDate = parseDate(
    dto?.documentDate,
    "Datum avansnog računa",
    errors,
  );

  let exchangeRate: string | null = null;
  if (dto?.exchangeRate !== undefined && dto.exchangeRate !== null) {
    exchangeRate = parseAmount(dto.exchangeRate, "Kurs", errors);
  }

  if (errors.length) throw new BadRequestException(errors);
  return {
    proformaId: hasProforma ? (dto.proformaId as number) : null,
    customerId: isPositiveInt(dto?.customerId) ? dto.customerId : null,
    amount,
    documentDate,
    basis,
    note: typeof dto?.note === "string" ? dto.note : null,
    vatRateCode:
      typeof dto?.vatRateCode === "string" && dto.vatRateCode.trim().length > 0
        ? dto.vatRateCode.trim()
        : null,
    isExport: typeof dto?.isExport === "boolean" ? dto.isExport : null,
    currency:
      typeof dto?.currency === "string" && dto.currency.trim().length > 0
        ? dto.currency.trim()
        : null,
    companyId: isPositiveInt(dto?.companyId) ? dto.companyId : null,
    exchangeRate,
  };
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
  /**
   * BRUTO iznos ove primene (delimično odbijanje). Podrazumevano = ceo PREOSTALI
   * (još neiskorišćen) naplaćen iznos avansa. Isti avans se sme odbiti na više
   * računa dok se ne potroši (BigBit `T_AVR_*.KoristiIznosSaPDV`).
   */
  amount?: AmountInput;
}

export interface NormalizedApplyAdvance {
  invoiceId: number;
  advanceInvoiceId: number;
  /** null = ceo preostali naplaćen iznos avansa. */
  amount: string | null;
}

export function validateApplyAdvance(
  dto: ApplyAdvanceDto,
): NormalizedApplyAdvance {
  const errors: string[] = [];
  if (!isPositiveInt(dto?.invoiceId)) {
    errors.push("Konačni račun (invoiceId) je obavezan.");
  }
  if (!isPositiveInt(dto?.advanceInvoiceId)) {
    errors.push("Avansni račun (advanceInvoiceId) je obavezan.");
  }
  let amount: string | null = null;
  if (dto?.amount !== undefined && dto.amount !== null) {
    amount = parseAmount(dto.amount, "Iznos odbitka avansa", errors);
  }
  if (errors.length) throw new BadRequestException(errors);
  return {
    invoiceId: dto.invoiceId,
    advanceInvoiceId: dto.advanceInvoiceId,
    amount,
  };
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
