import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  KNOWN_VAT_CODES,
  unknownVatCodeMessage,
} from "../../gl/posting/vat-rates";

/**
 * DTO za IZMENU prodajnog dokumenta (zaglavlje + stavke).
 *
 * Obrazac je isti kao `create-proforma.dto.ts`: interface + ručna `validate*()`
 * (class-validator još nije uveden — BACKEND_RULES §6). Poruke na srpskom
 * (latinica), kod na engleskom.
 *
 * DVE STVARI KOJE OVAJ DTO RADI DRUGAČIJE OD OSTALIH:
 *
 * 1) PATCH semantika je „prisutan ključ = menjaj". Razlika `undefined` (polje
 *    NIJE u telu → ne diraj) vs `null` (polje JESTE u telu → obriši vrednost)
 *    se čuva kroz `in` operator, ne kroz `!== undefined`. Bez toga se napomena
 *    ili valuta ne bi mogle OBRISATI, samo prepisati.
 *
 * 2) Novac i količine NIKAD ne prolaze kroz `Number()` (BACKEND_RULES §3).
 *    Prihvata se `string | number`, a validator vraća `Prisma.Decimal`
 *    napravljen direktno iz ulaza — string ide u Decimal tačno, bez međukoraka
 *    kroz double. Zato koeficijent „1.0345" ostaje 1.0345, a ne 1.0344999999.
 */

/**
 * Poznate šifre poreskih stopa: `KNOWN_VAT_CODES` je IZVEDEN iz `VAT_RATE_BY_CODE`
 * (`gl/posting/vat-rates.ts`), pa se ovde uvozi — ne prepisuje.
 *
 * ⚠️ ZAŠTO PREPIS VIŠE NE SME DA POSTOJI: do 02.08.2026. je ovde stajalo
 * `new Set(["0","1","2","3","4"])` — ogledalo mape od pre njene ispravke. Posle
 * ispravke je gejt PRIMAO „2" (u `R_Tarife` je nema), a `VAT_RATE_BY_CODE["2"]` je
 * `undefined` → `pricing.service.ts` je stavku upisivao sa **0 % PDV-a** i samo
 * upozorio. Domaća oporeziva stavka je tako tiho išla bez poreza, a `assertTotalsMatchItems`
 * to ne hvata: i zaglavlje i stavke se slože — na nuli. Istovremeno je ODBIJAO „5"
 * i „6", koje su legitimne šifre.
 */

/** Profil stavki dokumenta — DB CHECK `chk_invoices_line_profile`. */
const LINE_PROFILES = new Set(["GOODS", "SERVICE"]);

// ─────────────────────────────────────────────────────────────────────────────
// Zajednički parseri
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `string | number` → `Prisma.Decimal` bez prolaska kroz Number(). Vraća
 * `undefined` i puni `errors` kad ulaz nije ispravan broj.
 */
function parseDecimal(
  value: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    errors.push(`${label} mora biti broj.`);
    return undefined;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    errors.push(`${label} mora biti broj.`);
    return undefined;
  }
  try {
    const dec = new Prisma.Decimal(value);
    if (!dec.isFinite()) {
      errors.push(`${label} mora biti broj.`);
      return undefined;
    }
    return dec;
  } catch {
    errors.push(`${label} mora biti broj.`);
    return undefined;
  }
}

function parsePositiveDecimal(
  value: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | undefined {
  const dec = parseDecimal(value, label, errors);
  if (dec && dec.lessThanOrEqualTo(0)) {
    errors.push(`${label} mora biti veći od 0.`);
    return undefined;
  }
  return dec;
}

function parsePercent(
  value: unknown,
  label: string,
  errors: string[],
): Prisma.Decimal | undefined {
  const dec = parseDecimal(value, label, errors);
  if (dec && (dec.lessThan(0) || dec.greaterThan(100))) {
    errors.push(`${label} mora biti 0–100%.`);
    return undefined;
  }
  return dec;
}

function parseDate(
  value: unknown,
  label: string,
  errors: string[],
): Date | undefined {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} nije ispravan datum.`);
    return undefined;
  }
  return new Date(value);
}

/** Prazan/space-only tekst → null (brisanje polja), inače trimovan tekst. */
function parseNullableText(
  value: unknown,
  label: string,
  maxLength: number,
  errors: string[],
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") {
    errors.push(`${label} mora biti tekst.`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    errors.push(`${label} sme imati najviše ${maxLength} karaktera.`);
    return undefined;
  }
  return trimmed.length === 0 ? null : trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZAGLAVLJE
// ─────────────────────────────────────────────────────────────────────────────

export interface UpdateInvoiceHeaderDto {
  /** Datum izdavanja (ISO). */
  documentDate?: string;
  /** Valuta plaćanja / rok (ISO) — BigBit „uslovi plaćanja". `null` briše. */
  dueDate?: string | null;
  /** Datum prometa dobara i usluga (BT-72, ZPDV čl. 42). `null` briše. */
  supplyDate?: string | null;
  /** Komitent (kupac). */
  customerId?: number;
  /** Valuta dokumenta (RSD/EUR/…). */
  currency?: string;
  /** Kurs na dan izdavanja. */
  exchangeRate?: string | number;
  /** Knjigovodstveni kurs (BigBit ObrKurs). */
  accountingExchangeRate?: string | number;
  /** Napomena. `null` briše. */
  note?: string | null;
  /** Broj narudžbenice kupca (UBL OrderReference). `null` briše. */
  poNumber?: string | null;
  /** Poziv na broj (BT-83). `null` briše. */
  paymentReference?: string | null;
  /** Koeficijent cene (§8/O1) — množilac SVIH stavki, mora biti > 0. */
  priceCoefficient?: string | number;
  /** GOODS | SERVICE; `null` = uzmi predlog iz registra vrsta. */
  lineProfile?: string | null;
}

/** Normalizovan patch: ključ postoji SAMO ako ga je telo poslalo. */
export interface ValidatedInvoiceHeaderPatch {
  documentDate?: Date;
  dueDate?: Date | null;
  supplyDate?: Date | null;
  customerId?: number;
  currency?: string;
  exchangeRate?: Prisma.Decimal;
  accountingExchangeRate?: Prisma.Decimal;
  note?: string | null;
  poNumber?: string | null;
  paymentReference?: string | null;
  priceCoefficient?: Prisma.Decimal;
  lineProfile?: string | null;
}

export function validateUpdateInvoiceHeader(
  dto: UpdateInvoiceHeaderDto,
): ValidatedInvoiceHeaderPatch {
  const errors: string[] = [];
  const patch: ValidatedInvoiceHeaderPatch = {};
  const body = (dto ?? {}) as Record<string, unknown>;

  if ("documentDate" in body) {
    const d = parseDate(body.documentDate, "Datum izdavanja", errors);
    if (d) patch.documentDate = d;
  }
  if ("dueDate" in body) {
    if (body.dueDate === null) patch.dueDate = null;
    else {
      const d = parseDate(body.dueDate, "Valuta (rok plaćanja)", errors);
      if (d) patch.dueDate = d;
    }
  }
  if ("supplyDate" in body) {
    if (body.supplyDate === null) patch.supplyDate = null;
    else {
      const d = parseDate(body.supplyDate, "Datum prometa", errors);
      if (d) patch.supplyDate = d;
    }
  }

  if ("customerId" in body) {
    const v = body.customerId;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      errors.push("Kupac nije ispravan.");
    } else {
      patch.customerId = v;
    }
  }

  if ("currency" in body) {
    const v = body.currency;
    if (typeof v !== "string" || !/^[A-Za-z]{3}$/.test(v.trim())) {
      errors.push("Valuta mora imati tačno 3 slova (npr. RSD, EUR).");
    } else {
      patch.currency = v.trim().toUpperCase();
    }
  }

  if ("exchangeRate" in body) {
    const d = parsePositiveDecimal(body.exchangeRate, "Kurs", errors);
    if (d) patch.exchangeRate = d;
  }
  if ("accountingExchangeRate" in body) {
    const d = parsePositiveDecimal(
      body.accountingExchangeRate,
      "Knjigovodstveni kurs",
      errors,
    );
    if (d) patch.accountingExchangeRate = d;
  }

  if ("note" in body) {
    const t = parseNullableText(body.note, "Napomena", 4000, errors);
    if (t !== undefined) patch.note = t;
  }
  if ("poNumber" in body) {
    const t = parseNullableText(body.poNumber, "Broj narudžbenice", 50, errors);
    if (t !== undefined) patch.poNumber = t;
  }
  if ("paymentReference" in body) {
    const t = parseNullableText(
      body.paymentReference,
      "Poziv na broj",
      50,
      errors,
    );
    if (t !== undefined) patch.paymentReference = t;
  }

  if ("priceCoefficient" in body) {
    // DB CHECK `chk_invoices_price_coefficient` traži > 0; koeficijent 0 bi tiho
    // utišao ceo dokument (sve cene na nulu), pa se odbija ovde sa jasnom porukom.
    const d = parsePositiveDecimal(
      body.priceCoefficient,
      "Koeficijent cene",
      errors,
    );
    if (d) patch.priceCoefficient = d;
  }

  if ("lineProfile" in body) {
    const v = body.lineProfile;
    if (v === null) patch.lineProfile = null;
    else if (
      typeof v !== "string" ||
      !LINE_PROFILES.has(v.trim().toUpperCase())
    ) {
      errors.push("Profil stavki mora biti GOODS ili SERVICE.");
    } else {
      patch.lineProfile = v.trim().toUpperCase();
    }
  }

  if (errors.length) throw new BadRequestException(errors);
  if (Object.keys(patch).length === 0) {
    throw new BadRequestException("Nema nijednog polja za izmenu.");
  }
  return patch;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAVKE
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateInvoiceItemDto {
  /** Artikal iz šifarnika; izostavljen = slobodna (uslužna) stavka. */
  itemId?: number | null;
  description?: string | null;
  quantity: string | number;
  /** BAZNA cena PRE rabata — preskače cenovnik (slobodna uslužna stavka). */
  unitPrice?: string | number;
  discountPercent?: string | number;
  cashDiscountPercent?: string | number;
  vatRateCode?: string;
}

export interface ValidatedNewInvoiceItem {
  itemId: number | null;
  description: string | null;
  quantity: Prisma.Decimal;
  basePriceOverride?: Prisma.Decimal;
  discountPercent?: Prisma.Decimal;
  cashDiscountPercent?: Prisma.Decimal;
  vatRateCode?: string;
}

export function validateCreateInvoiceItem(
  dto: CreateInvoiceItemDto,
): ValidatedNewInvoiceItem {
  const errors: string[] = [];
  const body = (dto ?? {}) as unknown as Record<string, unknown>;

  let itemId: number | null = null;
  if ("itemId" in body && body.itemId !== null && body.itemId !== undefined) {
    const v = body.itemId;
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      errors.push("Artikal nije ispravan.");
    } else {
      itemId = v;
    }
  }

  let description: string | null = null;
  if ("description" in body && body.description !== null) {
    const t = parseNullableText(body.description, "Opis stavke", 255, errors);
    if (t !== undefined) description = t;
  }

  if (itemId == null && !description) {
    errors.push("Stavka: artikal ili opis je obavezan.");
  }

  const quantity = parsePositiveDecimal(body.quantity, "Količina", errors);

  const result: ValidatedNewInvoiceItem = {
    itemId,
    description,
    quantity: quantity ?? new Prisma.Decimal(0),
  };

  if ("unitPrice" in body && body.unitPrice !== null) {
    const d = parseDecimal(body.unitPrice, "Cena", errors);
    if (d && d.lessThan(0)) errors.push("Cena ne sme biti negativna.");
    else if (d) result.basePriceOverride = d;
  }
  if ("discountPercent" in body && body.discountPercent !== null) {
    const d = parsePercent(body.discountPercent, "Rabat", errors);
    if (d) result.discountPercent = d;
  }
  if ("cashDiscountPercent" in body && body.cashDiscountPercent !== null) {
    const d = parsePercent(body.cashDiscountPercent, "Kasa", errors);
    if (d) result.cashDiscountPercent = d;
  }
  if ("vatRateCode" in body && body.vatRateCode !== null) {
    const v = body.vatRateCode;
    if (typeof v !== "string" || !KNOWN_VAT_CODES.has(v.trim())) {
      errors.push(unknownVatCodeMessage(typeof v === "string" ? v.trim() : ""));
    } else {
      result.vatRateCode = v.trim();
    }
  }

  if (errors.length) throw new BadRequestException(errors);
  return result;
}

export interface UpdateInvoiceItemDto {
  itemId?: number | null;
  description?: string | null;
  quantity?: string | number;
  unitPrice?: string | number;
  discountPercent?: string | number;
  cashDiscountPercent?: string | number;
  vatRateCode?: string;
}

export interface ValidatedInvoiceItemPatch {
  itemId?: number | null;
  description?: string | null;
  quantity?: Prisma.Decimal;
  basePriceOverride?: Prisma.Decimal;
  discountPercent?: Prisma.Decimal;
  cashDiscountPercent?: Prisma.Decimal;
  vatRateCode?: string;
  /**
   * true kad telo dira ijedno polje koje ULAZI U CENU (artikal, cena, rabat,
   * kasa, PDV šifra). Servis tada preračunava cenu kroz PricingService; kad je
   * false (npr. promena samo količine ili opisa), zapamćena `baseUnitPrice`
   * stavke se NE dira — inače bi ispravka količine tiho pregazila dogovorenu
   * cenu novom cenom iz cenovnika.
   */
  repriceRequested: boolean;
}

export function validateUpdateInvoiceItem(
  dto: UpdateInvoiceItemDto,
): ValidatedInvoiceItemPatch {
  const errors: string[] = [];
  const patch: ValidatedInvoiceItemPatch = { repriceRequested: false };
  const body = (dto ?? {}) as Record<string, unknown>;

  if ("itemId" in body) {
    const v = body.itemId;
    if (v === null) {
      patch.itemId = null;
    } else if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      errors.push("Artikal nije ispravan.");
    } else {
      patch.itemId = v;
    }
    patch.repriceRequested = true;
  }
  if ("description" in body) {
    const t = parseNullableText(body.description, "Opis stavke", 255, errors);
    if (t !== undefined) patch.description = t;
  }
  if ("quantity" in body) {
    const d = parsePositiveDecimal(body.quantity, "Količina", errors);
    if (d) patch.quantity = d;
  }
  if ("unitPrice" in body) {
    const d = parseDecimal(body.unitPrice, "Cena", errors);
    if (d && d.lessThan(0)) errors.push("Cena ne sme biti negativna.");
    else if (d) patch.basePriceOverride = d;
    patch.repriceRequested = true;
  }
  if ("discountPercent" in body) {
    const d = parsePercent(body.discountPercent, "Rabat", errors);
    if (d) patch.discountPercent = d;
    patch.repriceRequested = true;
  }
  if ("cashDiscountPercent" in body) {
    const d = parsePercent(body.cashDiscountPercent, "Kasa", errors);
    if (d) patch.cashDiscountPercent = d;
    patch.repriceRequested = true;
  }
  if ("vatRateCode" in body) {
    const v = body.vatRateCode;
    if (typeof v !== "string" || !KNOWN_VAT_CODES.has(v.trim())) {
      errors.push(unknownVatCodeMessage(typeof v === "string" ? v.trim() : ""));
    } else {
      patch.vatRateCode = v.trim();
    }
    patch.repriceRequested = true;
  }

  if (errors.length) throw new BadRequestException(errors);
  const touched = Object.keys(patch).filter((k) => k !== "repriceRequested");
  if (touched.length === 0) {
    throw new BadRequestException("Nema nijednog polja za izmenu stavke.");
  }
  return patch;
}
