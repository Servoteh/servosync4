import { BadRequestException } from "@nestjs/common";

/**
 * DTO za AVANSE (Batch C1b) — ULAZNI avansni račun (KUF) + zajednička lista avansa.
 * Obrazac: interface + ručna `validate*()` (kao manual-vat-entry / create-proforma;
 * class-validator još nije uveden u ovom modulu — BACKEND_RULES §6). Poruke na
 * srpskom, kod na engleskom.
 *
 * DOMEN: avansni račun se evidentira kao `Invoice` sa `documentType = 'AVR'` i
 * `advanceDirection` ('out' = mi izdajemo kupcu → KIF, 'in' = dobavljač nama → KUF).
 * Za ULAZNI avans pretporez nastaje NAPLATOM (plaćanjem), ne izdavanjem dokumenta —
 * zato je `paidAt` odvojen korak (`markIncomingAdvancePaid`), a KUF stavka
 * (`VatLedgerEntry direction='input'`) se upisuje u period po datumu PLAĆANJA.
 */

/** `Invoice.documentType` avansnog računa. */
export const ADVANCE_DOCUMENT_TYPE = "AVR";

/** Smer avansa (`Invoice.advanceDirection`). */
export const ADVANCE_DIRECTION = {
  /** Mi izdajemo kupcu — izlazni avans (KIF, obaveza za PDV). */
  OUT: "out",
  /** Dobavljač nama — ulazni avans (KUF, pretporez po plaćanju). */
  IN: "in",
} as const;

export type AdvanceDirection =
  (typeof ADVANCE_DIRECTION)[keyof typeof ADVANCE_DIRECTION];

const DIRECTIONS = new Set<string>([
  ADVANCE_DIRECTION.OUT,
  ADVANCE_DIRECTION.IN,
]);

/** Najveći broj redova po strani liste avansa (zaštita od „daj sve"). */
export const ADVANCE_PAGE_SIZE_MAX = 200;
/** Podrazumevana veličina strane liste avansa. */
export const ADVANCE_PAGE_SIZE_DEFAULT = 50;

// ── ulazni avansni račun (evidencija) ────────────────────────────────────────

/**
 * Evidencija ULAZNOG avansnog računa dobavljača. `paidAt` je opcion — bez njega
 * dokument samo stoji evidentiran (BEZ KUF stavke, pretporez se ne priznaje).
 */
export interface RecordIncomingAdvanceDto {
  /** Dobavljač — meki ref `customers.id` (šifarnik komitenata je KUPDOB). */
  partnerId: number;
  /** Broj avansnog računa dobavljača (kako stoji na dokumentu). */
  documentNumber: string;
  /** Datum dokumenta (ISO datum). */
  documentDate: string;
  /**
   * Bruto iznos avansa (osnovica + PDV). Prima se i kao STRING — novac ne sme da
   * prođe kroz JS Float (BACKEND_RULES §3); `Decimal` ga uzima direktno iz stringa.
   */
  grossAmount: number | string;
  /** Šifra poreske stope (meki ref `tax_rates.code`, npr. "3" / "20"). */
  vatRateCode: string;
  /** Ako je avans već plaćen pri evidenciji — datum plaćanja (ISO datum). */
  paidAt?: string;
  /** Napomena uz dokument (opciono). */
  note?: string;
}

/** Označavanje NAPLATE (plaćanja) ulaznog avansa — tek tad nastaje pretporez. */
export interface MarkIncomingAdvancePaidDto {
  /** `Invoice.id` avansnog računa (AVR, advanceDirection='in'). */
  id: number;
  /** Datum plaćanja (ISO datum) — određuje PORESKI PERIOD KUF stavke. */
  paidAt: string;
  /** Plaćen bruto iznos (može biti delimičan; ≤ bruto avansa). String = bez Float-a. */
  amount: number | string;
}

/** Vezivanje avansa na konačni (ulazni) račun — storno pretporeza avansa. */
export interface LinkIncomingAdvanceToFinalDto {
  /** `Invoice.id` avansnog računa (AVR, advanceDirection='in'). */
  advanceId: number;
  /** `Invoice.id` konačnog ulaznog računa na koji se avans odbija. */
  finalInvoiceId: number;
}

/** Filter/paginacija liste avansa (oba smera). */
export interface ListAdvancesQuery {
  /** 'out' (izdati) | 'in' (primljeni); bez filtera = oba smera. */
  direction?: string;
  /** Komitent (kupac ili dobavljač) — meki ref `customers.id`. */
  partnerId?: number;
  /** true = samo avansi bez upisane naplate (`advancePaidAt` null). */
  unpaidOnly?: boolean;
  /** 1-bazna strana (default 1). */
  page?: number;
  /** Veličina strane (default 50, max 200). */
  pageSize?: number;
}

// ── validacija ───────────────────────────────────────────────────────────────

export function validateRecordIncomingAdvance(
  dto: RecordIncomingAdvanceDto,
): void {
  const errors: string[] = [];

  errors.push(...partnerErrors(dto.partnerId, true));
  errors.push(...documentNumberErrors(dto.documentNumber));
  errors.push(...dateErrors("Datum dokumenta", dto.documentDate, true));
  errors.push(...positiveAmountErrors("Bruto iznos avansa", dto.grossAmount));
  errors.push(...rateCodeErrors(dto.vatRateCode));
  if (dto.paidAt !== undefined && dto.paidAt !== null) {
    errors.push(...dateErrors("Datum plaćanja", dto.paidAt, true));
  }
  if (
    dto.note !== undefined &&
    dto.note !== null &&
    typeof dto.note !== "string"
  ) {
    errors.push("Napomena mora biti tekst.");
  }

  if (errors.length) throw new BadRequestException(errors);
}

export function validateMarkIncomingAdvancePaid(
  dto: MarkIncomingAdvancePaidDto,
): void {
  const errors: string[] = [];

  errors.push(...idErrors("Avansni račun", dto.id));
  errors.push(...dateErrors("Datum plaćanja", dto.paidAt, true));
  errors.push(...positiveAmountErrors("Plaćen iznos", dto.amount));

  if (errors.length) throw new BadRequestException(errors);
}

export function validateLinkIncomingAdvanceToFinal(
  dto: LinkIncomingAdvanceToFinalDto,
): void {
  const errors: string[] = [];

  errors.push(...idErrors("Avansni račun", dto.advanceId));
  errors.push(...idErrors("Konačni račun", dto.finalInvoiceId));
  if (
    Number.isInteger(dto.advanceId) &&
    Number.isInteger(dto.finalInvoiceId) &&
    dto.advanceId === dto.finalInvoiceId
  ) {
    errors.push("Avansni i konačni račun ne mogu biti isti dokument.");
  }

  if (errors.length) throw new BadRequestException(errors);
}

/**
 * Normalizuj query listu avansa (stringovi iz URL-a → tipovi). Baca 400 za
 * nevalidan smer; strana/veličina se tiho svode na dozvoljen opseg.
 */
export function normalizeListAdvancesQuery(raw: {
  direction?: string;
  partnerId?: string | number;
  unpaidOnly?: string | boolean;
  page?: string | number;
  pageSize?: string | number;
}): Required<Pick<ListAdvancesQuery, "page" | "pageSize">> & ListAdvancesQuery {
  const direction =
    raw.direction === undefined || raw.direction === ""
      ? undefined
      : raw.direction;
  if (direction !== undefined && !DIRECTIONS.has(direction)) {
    throw new BadRequestException(
      "Smer avansa mora biti 'out' (izdat kupcu) ili 'in' (primljen od dobavljača).",
    );
  }

  const partnerRaw = toNumberOrUndefined(raw.partnerId);
  if (
    partnerRaw !== undefined &&
    (!Number.isInteger(partnerRaw) || partnerRaw <= 0)
  ) {
    throw new BadRequestException("Komitent mora biti pozitivan ceo broj.");
  }

  const pageRaw = toNumberOrUndefined(raw.page);
  const pageSizeRaw = toNumberOrUndefined(raw.pageSize);
  const page =
    pageRaw !== undefined && Number.isInteger(pageRaw) && pageRaw > 0
      ? pageRaw
      : 1;
  const pageSize =
    pageSizeRaw !== undefined &&
    Number.isInteger(pageSizeRaw) &&
    pageSizeRaw > 0
      ? Math.min(pageSizeRaw, ADVANCE_PAGE_SIZE_MAX)
      : ADVANCE_PAGE_SIZE_DEFAULT;

  return {
    direction,
    partnerId: partnerRaw,
    unpaidOnly: raw.unpaidOnly === true || raw.unpaidOnly === "true",
    page,
    pageSize,
  };
}

// ── interno ──────────────────────────────────────────────────────────────────

function toNumberOrUndefined(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function idErrors(label: string, value: unknown): string[] {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return [`${label} (id) mora biti pozitivan ceo broj.`];
  }
  return [];
}

function partnerErrors(partnerId: unknown, required: boolean): string[] {
  if (partnerId === undefined || partnerId === null) {
    return required ? ["Komitent (dobavljač) je obavezan."] : [];
  }
  if (
    typeof partnerId !== "number" ||
    !Number.isInteger(partnerId) ||
    partnerId <= 0
  ) {
    return ["Komitent mora biti pozitivan ceo broj."];
  }
  return [];
}

function documentNumberErrors(documentNumber: unknown): string[] {
  if (
    typeof documentNumber !== "string" ||
    documentNumber.trim().length === 0
  ) {
    return ["Broj dokumenta je obavezan."];
  }
  if (documentNumber.trim().length > 30) {
    return ["Broj dokumenta sme imati najviše 30 znakova."];
  }
  return [];
}

function dateErrors(
  label: string,
  value: unknown,
  required: boolean,
): string[] {
  if (value === undefined || value === null) {
    return required ? [`${label} je obavezan.`] : [];
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    return [`${label} nije ispravan.`];
  }
  return [];
}

/**
 * Pozitivan novčani iznos: BROJ ili DECIMAL-STRING („6000.00").
 *
 * String se prima namerno (BACKEND_RULES §3: novac ne sme kroz JS Float) i tako ga
 * šalju ekrani — izlazni smer avansa (`parseAmount` u sales DTO-u) to prima od početka.
 * Ulazni smer je do drugog kruga pregleda tražio isključivo `number`, pa je dijalog
 * „Označi plaćanje" za ULAZNI avans vraćao 400 „Plaćen iznos mora biti broj." i
 * pretporez po plaćenom avansu nije imao gde da uđe. Asimetrija dva DTO-a je koren.
 */
function positiveAmountErrors(label: string, value: unknown): string[] {
  if (value === undefined || value === null) return [`${label} je obavezan.`];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return [`${label} mora biti broj.`];
    return value <= 0 ? [`${label} mora biti veći od nule.`] : [];
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return [`${label} mora biti broj (decimale odvoji tačkom).`];
    }
    return Number(text) <= 0 ? [`${label} mora biti veći od nule.`] : [];
  }
  return [`${label} mora biti broj.`];
}

function rateCodeErrors(vatRateCode: unknown): string[] {
  if (typeof vatRateCode !== "string" || vatRateCode.trim().length === 0) {
    return ["Šifra poreske stope je obavezna."];
  }
  if (vatRateCode.trim().length > 5) {
    return ["Šifra poreske stope sme imati najviše 5 znakova."];
  }
  return [];
}
