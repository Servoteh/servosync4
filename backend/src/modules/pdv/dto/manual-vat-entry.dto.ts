import { BadRequestException } from "@nestjs/common";

/**
 * DTO za RUČNI unos/izmenu KIF/KUF stavke (`vat_ledger_entries`) — Talas 1D §D4.
 * Obrazac: interface + ručna validate*() (kao create-proforma / nabavka; class-validator
 * još nije uveden u ovom modulu — BACKEND_RULES §6). Poruke srpski, kod engleski.
 *
 * Ručna stavka se razlikuje od GK-izvedene po `sourceJournalEntryId = null`
 * (šema nema zasebnu `source` kolonu; poreklo diskriminira taj meki ref). Zato
 * DTO NE prima `sourceJournalEntryId` — servis ga uvek postavlja na null.
 */

const DIRECTIONS = new Set(["input", "output"]);

/**
 * MARKER „KUF van PDV" (ulazni račun bez prava na odbitak pretporeza) — B4.
 * Šema VatLedgerEntry NEMA zaseban boolean za to, pa se poreklo diskriminira
 * preko `vatRateCode` sentinel vrednosti "VP" (van PDV). NE koristimo "0" (kako
 * je prvo predloženo) jer "0" je legitimna 0% stopa (ulazni računi po 0% su
 * odbitni i moraju u pretporez) — sentinel bi ih pomešao. "VP" ne može biti
 * realna šifra stope (stope su numeričke: "20","10","0"), pa je poređenje po
 * jednakosti nedvosmisleno. Takva stavka ostaje u KUF listi (direction=input)
 * ali se ISKLJUČUJE iz pretporeza (`sumManualVatEntries`/`buildKifKuf`).
 * Rate se za takvu stavku ne čuva (VP nosi samo iznos PDV kao trošak).
 */
export const VAT_RATE_CODE_NO_DEDUCTION = "VP";

/** true ako stavka nosi „van PDV" marker (bez prava odbitka). */
export function isNoDeduction(vatRateCode: string | null | undefined): boolean {
  return vatRateCode === VAT_RATE_CODE_NO_DEDUCTION;
}

/** Novi ručni KIF/KUF red — sva ključna polja obavezna (osim partnera/stope). */
export interface CreateManualVatEntryDto {
  /** input = KUF (ulazna), output = KIF (izlazna). */
  direction: string;
  documentNumber: string;
  partnerId?: number | null; // meki ref customers.id; null = bez komitenta
  documentDate: string; // ISO datum dokumenta
  taxPeriodYear: number;
  taxPeriodMonth: number; // 1..12
  vatBase: number; // osnovica
  vatAmount: number; // iznos PDV
  vatRateCode?: string | null; // meki ref stope (npr. "20", "10")
  /**
   * „Van PDV" — ulazni račun bez prava odbitka (samo za direction=input/KUF).
   * true → servis postavlja `vatRateCode = "VP"` (marker), stavka izlazi iz
   * pretporeza. Prosleđena numerička stopa se u tom slučaju ignoriše.
   */
  noDeduction?: boolean;
}

/** Izmena ručnog reda — sva polja opciona (parcijalni PATCH). */
export type UpdateManualVatEntryDto = Partial<CreateManualVatEntryDto>;

export function validateCreateManualVatEntry(dto: CreateManualVatEntryDto): void {
  const errors: string[] = [];

  if (typeof dto.direction !== "string" || !DIRECTIONS.has(dto.direction)) {
    errors.push("Smer stavke mora biti 'input' (KUF) ili 'output' (KIF).");
  }
  if (
    typeof dto.documentNumber !== "string" ||
    dto.documentNumber.trim().length === 0
  ) {
    errors.push("Broj dokumenta je obavezan.");
  } else if (dto.documentNumber.trim().length > 30) {
    errors.push("Broj dokumenta sme imati najviše 30 znakova.");
  }
  if (typeof dto.documentDate !== "string" || Number.isNaN(Date.parse(dto.documentDate))) {
    errors.push("Datum dokumenta nije ispravan.");
  }
  errors.push(...periodErrors(dto.taxPeriodYear, dto.taxPeriodMonth, true));
  errors.push(...decimalErrors("Osnovica", dto.vatBase, true));
  errors.push(...decimalErrors("Iznos PDV", dto.vatAmount, true));
  errors.push(...partnerErrors(dto.partnerId));
  errors.push(...rateErrors(dto.vatRateCode));
  errors.push(...noDeductionErrors(dto.noDeduction, dto.direction));

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateManualVatEntry(dto: UpdateManualVatEntryDto): void {
  const errors: string[] = [];

  if (dto.direction !== undefined && !DIRECTIONS.has(dto.direction)) {
    errors.push("Smer stavke mora biti 'input' (KUF) ili 'output' (KIF).");
  }
  if (dto.documentNumber !== undefined) {
    if (
      typeof dto.documentNumber !== "string" ||
      dto.documentNumber.trim().length === 0
    ) {
      errors.push("Broj dokumenta ne sme biti prazan.");
    } else if (dto.documentNumber.trim().length > 30) {
      errors.push("Broj dokumenta sme imati najviše 30 znakova.");
    }
  }
  if (
    dto.documentDate !== undefined &&
    (typeof dto.documentDate !== "string" || Number.isNaN(Date.parse(dto.documentDate)))
  ) {
    errors.push("Datum dokumenta nije ispravan.");
  }
  if (dto.taxPeriodYear !== undefined || dto.taxPeriodMonth !== undefined) {
    // Godina i mesec se menjaju u paru (period je celina) — traži oba.
    if (dto.taxPeriodYear === undefined || dto.taxPeriodMonth === undefined) {
      errors.push("Poreski period se menja u paru (godina i mesec zajedno).");
    } else {
      errors.push(...periodErrors(dto.taxPeriodYear, dto.taxPeriodMonth, true));
    }
  }
  if (dto.vatBase !== undefined) errors.push(...decimalErrors("Osnovica", dto.vatBase, true));
  if (dto.vatAmount !== undefined) errors.push(...decimalErrors("Iznos PDV", dto.vatAmount, true));
  if (dto.partnerId !== undefined) errors.push(...partnerErrors(dto.partnerId));
  if (dto.vatRateCode !== undefined) errors.push(...rateErrors(dto.vatRateCode));
  // Na izmeni direction može izostati (ostaje postojeći smer); servis dodatno
  // proverava efektivni smer prema učitanoj stavci pre nego što upiše marker.
  if (dto.noDeduction !== undefined) {
    errors.push(...noDeductionErrors(dto.noDeduction, dto.direction));
  }

  if (errors.length) throw new BadRequestException(errors);
}

// ── interno ──────────────────────────────────────────────────────────────────

function periodErrors(year: unknown, month: unknown, required: boolean): string[] {
  const errors: string[] = [];
  if (year === undefined && month === undefined && !required) return errors;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100) {
    errors.push("Godina poreskog perioda mora biti 2000–2100.");
  }
  if (typeof month !== "number" || !Number.isInteger(month) || month < 1 || month > 12) {
    errors.push("Mesec poreskog perioda mora biti 1–12.");
  }
  return errors;
}

function decimalErrors(label: string, value: unknown, required: boolean): string[] {
  if (value === undefined) return required ? [`${label} je obavezan.`] : [];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [`${label} mora biti broj.`];
  }
  return [];
}

function partnerErrors(partnerId: unknown): string[] {
  if (partnerId === undefined || partnerId === null) return [];
  if (typeof partnerId !== "number" || !Number.isInteger(partnerId) || partnerId <= 0) {
    return ["Komitent (partnerId) mora biti pozitivan ceo broj ili prazno."];
  }
  return [];
}

function rateErrors(vatRateCode: unknown): string[] {
  if (vatRateCode === undefined || vatRateCode === null) return [];
  if (typeof vatRateCode !== "string" || vatRateCode.length > 5) {
    return ["Šifra stope sme imati najviše 5 znakova."];
  }
  return [];
}

/**
 * „Van PDV" marker: mora biti boolean; true je dozvoljeno SAMO za ulazni račun
 * (direction=input/KUF) — izlazni PDV (KIF) uvek nosi obavezu, nema „bez odbitka".
 * `direction` može biti undefined (izmena bez menjanja smera) — tada se smer ne
 * proverava ovde nego u servisu prema učitanoj stavci.
 */
function noDeductionErrors(noDeduction: unknown, direction: unknown): string[] {
  if (noDeduction === undefined) return [];
  if (typeof noDeduction !== "boolean") {
    return ['Polje „bez prava odbitka" mora biti true/false.'];
  }
  if (noDeduction === true && direction === "output") {
    return ['„Bez prava odbitka" važi samo za ulazni račun (KUF), ne za KIF.'];
  }
  return [];
}
