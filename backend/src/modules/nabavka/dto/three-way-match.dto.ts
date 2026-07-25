import { BadRequestException } from "@nestjs/common";

/**
 * 3-WAY MATCH (naručeno ↔ primljeno ↔ fakturisano) — ulazni DTO-i + oblik rezultata.
 *
 * ⚠️ POSLOVNO PRAVILO (odluka korisnika, izričita): odstupanje se **PRIJAVLJUJE,
 * ali NIKAD ne blokira plaćanje.** Nijedan tip odavde ne sme završiti u guard-u
 * koji zaustavlja pripremu/potpis/izvoz naloga — nalazi su isključivo informativni.
 *
 * Obrazac: interface + ručna `validate*()` (kao ostatak nabavka DTO-a; class-validator
 * još nije uveden — BACKEND_RULES §6). Decimal vrednosti izlaze kao **string** (§6).
 */

// ─────────────────────────────────────────────────────────────── vrste nalaza

/** Nivo nalaza: INFO = uredno/očekivano stanje, WARNING = traži pogled čoveka. */
export type MatchFindingLevel = "INFO" | "WARNING";

/**
 * Kodovi odstupanja (stabilni ključevi za UI/izveštaj):
 *   QTY_OVER_RECEIPT  — fakturisano više nego primljeno (WARNING)
 *   QTY_UNDER_RECEIPT — primljeno više nego fakturisano (INFO — faktura možda tek stiže)
 *   PRICE_VARIANCE    — jedinična cena na fakturi odstupa od naručene preko tolerancije (WARNING)
 *   QTY_OVER_ORDER    — primljeno više nego naručeno (WARNING)
 *   NO_RECEIPT        — faktura bez prijema (WARNING)
 */
export type MatchFindingCode =
  | "QTY_OVER_RECEIPT"
  | "QTY_UNDER_RECEIPT"
  | "PRICE_VARIANCE"
  | "QTY_OVER_ORDER"
  | "NO_RECEIPT";

/** Jedan nalaz poređenja. `orderItemId`/`lineNo` = null → nalaz na nivou dokumenta. */
export interface MatchFinding {
  code: MatchFindingCode;
  level: MatchFindingLevel;
  /** Srpski opis za UI (tooltip / traka upozorenja). */
  message: string;
  orderItemId: number | null;
  lineNo: number | null;
}

// ─────────────────────────────────────────────────────────────── rezultat po stavci

/**
 * Poređenje po stavci narudžbenice. Sve količine/iznosi su Decimal-as-string.
 *
 * IZVORI (v. `three-way-match.service.ts` §Izvori):
 *   naručeno   = `purchase_order_items.ordered_quantity` × `unit_price`
 *   primljeno  = `purchase_order_items.received_quantity` (BigBit IsporucenaKolicina)
 *   fakturisano= stavke robnog ulaza (`stock_document_items`) vezanog robnog dokumenta
 *                (`stock_documents.purchase_order_id`) — `quantity` × `invoice_price`
 */
export interface ThreeWayMatchLine {
  orderItemId: number;
  lineNo: number;
  articleId: number | null;
  description: string | null;
  unit: string | null;
  orderedQty: string;
  receivedQty: string;
  invoicedQty: string;
  /** Naručena jedinična cena (`unit_price`); null kad cena nije uneta. */
  orderedUnitPrice: string | null;
  /** Fakturna jedinična cena (ponderisani prosek stavki robnog ulaza); null bez fakture. */
  invoicedUnitPrice: string | null;
  orderedAmount: string;
  invoicedAmount: string;
  /** `invoicedAmount − orderedAmount` (pozitivno = faktura veća od narudžbenice). */
  varianceAmount: string;
  /**
   * Stavka bez artikla (usluga/slobodan opis) ne može da se uparuje sa robnim
   * dokumentom — količinski nalazi se za nju NE računaju (false = nema uparivanja).
   */
  matchable: boolean;
  findings: MatchFinding[];
}

/** Vezani robni ulaz (primka) — nosilac „primljeno/fakturisano" podataka. */
export interface MatchedStockDocument {
  id: number;
  documentNumber: string;
  status: string;
  documentDate: string;
  /** GL nalog robnog ulaza (meki ref) — most do KUF stavke. */
  journalEntryId: number | null;
}

/**
 * KUF trag (ulazna faktura) izveden iz GL naloga robnog ulaza:
 *   PO → stock_documents.purchase_order_id → stock_documents.journal_entry_id
 *      → vat_ledger_entries.source_journal_entry_id (direction='input').
 * Nosi samo iznose (šema nema stavke ulazne fakture) — služi kao kontrola zbira.
 */
export interface MatchedVatLedger {
  entryIds: number[];
  documentNumbers: string[];
  /** Σ osnovica KUF stavki (Decimal-as-string). */
  vatBase: string;
  /** Σ iznos PDV KUF stavki (Decimal-as-string). */
  vatAmount: string;
}

/** Pun rezultat poređenja jedne narudžbenice. */
export interface ThreeWayMatchResult {
  orderId: number;
  orderNumber: string;
  supplierId: number;
  supplierName: string | null;
  status: string;
  currency: string;
  orderedAt: string | null;
  stockDocuments: MatchedStockDocument[];
  vatLedger: MatchedVatLedger | null;
  totals: {
    orderedAmount: string;
    invoicedAmount: string;
    /** `invoicedAmount − orderedAmount`. */
    varianceAmount: string;
  };
  lines: ThreeWayMatchLine[];
  /** Svi nalazi (stavke + nivo dokumenta), redosled = stavke pa dokument. */
  findings: MatchFinding[];
  hasFindings: boolean;
  /** Bar jedan nalaz nivoa WARNING (INFO se ne broji). */
  hasWarnings: boolean;
}

/** Red pregleda po više narudžbenica (`matchSummary`). */
export interface ThreeWayMatchSummaryRow {
  orderId: number;
  orderNumber: string;
  supplierId: number;
  supplierName: string | null;
  status: string;
  currency: string;
  orderedAt: string | null;
  orderedAmount: string;
  invoicedAmount: string;
  varianceAmount: string;
  findingCount: number;
  warningCount: number;
  hasWarnings: boolean;
  /** Kodovi nalaza bez duplikata — za ikonice/filtere u listi. */
  codes: MatchFindingCode[];
}

/**
 * Upozorenje pripremljeno za ekran plaćanja. `documentNumbers` su svi brojevi pod
 * kojima se nalaz može prepoznati u otvorenim stavkama (broj narudžbenice, broj
 * robnog ulaza, brojevi KUF stavki) — priprema plaćanja spaja po tim brojevima.
 */
export interface PaymentMatchWarning {
  code: MatchFindingCode;
  level: MatchFindingLevel;
  message: string;
  orderId: number;
  orderNumber: string;
  supplierId: number;
  lineNo: number | null;
  documentNumbers: string[];
}

// ─────────────────────────────────────────────────────────────── ulazni DTO-i

/** Filteri pregleda 3-way match-a po više narudžbenica. */
export interface MatchSummaryQueryDto {
  /** Donja granica po `ordered_at` (fallback `created_at`) — ISO datum. */
  from?: string;
  /** Gornja granica (uključivo do kraja dana) — ISO datum. */
  to?: string;
  supplierId?: number;
  /** true = vrati samo narudžbenice sa bar jednim nalazom. */
  onlyWithFindings?: boolean;
  skip?: number;
  take?: number;
}

/** Filteri upozorenja za pripremu plaćanja. Bez ijednog filtera → prazan rezultat. */
export interface PaymentWarningsQueryDto {
  /** Komitent (dobavljač) — `ledger_entries.analytical_code` iz otvorene stavke. */
  partnerId?: number;
  /** Brojevi dokumenata iz otvorenih stavaka (narudžbenica / robni ulaz / KUF). */
  documentNumbers?: string[];
}

function isIsoDateLike(v: unknown): boolean {
  return typeof v === "string" && !Number.isNaN(new Date(v).getTime());
}

export function validateMatchSummaryQuery(dto: MatchSummaryQueryDto): void {
  const errors: string[] = [];

  if (dto.from !== undefined && !isIsoDateLike(dto.from))
    errors.push("Datum od nije ispravan.");
  if (dto.to !== undefined && !isIsoDateLike(dto.to))
    errors.push("Datum do nije ispravan.");
  if (
    dto.from !== undefined &&
    dto.to !== undefined &&
    isIsoDateLike(dto.from) &&
    isIsoDateLike(dto.to) &&
    new Date(dto.from).getTime() > new Date(dto.to).getTime()
  )
    errors.push("Datum od ne može biti posle datuma do.");
  if (
    dto.supplierId !== undefined &&
    (!Number.isInteger(dto.supplierId) || dto.supplierId <= 0)
  )
    errors.push("Šifra dobavljača mora biti pozitivan ceo broj.");
  if (dto.skip !== undefined && (!Number.isInteger(dto.skip) || dto.skip < 0))
    errors.push("Parametar skip mora biti nenegativan ceo broj.");
  if (dto.take !== undefined && (!Number.isInteger(dto.take) || dto.take <= 0))
    errors.push("Parametar take mora biti pozitivan ceo broj.");

  if (errors.length) throw new BadRequestException(errors);
}

export function validatePaymentWarningsQuery(
  dto: PaymentWarningsQueryDto,
): void {
  const errors: string[] = [];

  if (
    dto.partnerId !== undefined &&
    (!Number.isInteger(dto.partnerId) || dto.partnerId <= 0)
  )
    errors.push("Šifra komitenta mora biti pozitivan ceo broj.");
  if (dto.documentNumbers !== undefined) {
    if (!Array.isArray(dto.documentNumbers))
      errors.push("Brojevi dokumenata moraju biti niz.");
    else if (dto.documentNumbers.some((n) => typeof n !== "string"))
      errors.push("Svaki broj dokumenta mora biti tekst.");
  }

  if (errors.length) throw new BadRequestException(errors);
}
