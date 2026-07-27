/**
 * PRENOS IZMEĐU MAGACINA (međuskladišnica) — ulazni podaci.
 *
 * Prenos NIJE jedan dokument. Stanje zaliha se svuda (lager, kartica artikla, costing,
 * guard negativnog stanja) računa kao Σ(±količina) po `stock_document_items.warehouse_id`,
 * a znak dolazi iz `DocumentType.isInbound` — dakle jedan dokument nosi JEDAN znak i JEDAN
 * magacin. Zato prenos ulazi kao PAR dokumenata (izlaz PREIZ + ulaz PREUL) koje
 * `TransferService` pravi u JEDNOJ transakciji i povezuje.
 *
 * Iznosi su string ili broj (BACKEND_RULES §6 — Decimal u JSON-u kao string); servis ih
 * pretvara u `Prisma.Decimal`.
 */
export interface CreateTransferItemDto {
  itemId: number;
  /** Uvek POZITIVNA količina koja se seli; znak nosi vrsta dokumenta. */
  quantity: string | number;
  lineNo?: number;

  /**
   * Vrednovanje po JM. Kad se IZOSTAVE, servis uzima ponderisanu prosečnu cenu izvornog
   * magacina na dan prenosa (ista formula kao lager) — tako Σ vrednosti zaliha firme
   * ostaje NEPROMENJENA: izvor gubi tačno onoliko koliko odredište dobija, a prosek u
   * izvornom magacinu se ne pomera (skida se po proseku).
   */
  purchasePriceNet?: string | number;
  wholesalePrice?: string | number;
}

export interface CreateTransferDto {
  /** Magacin IZ kog roba ide (razdužuje se). */
  sourceWarehouseId: number;
  /** Magacin U koji roba ide (zadužuje se). Mora biti različit od izvornog. */
  targetWarehouseId: number;

  /** ISO datum prenosa (as-of ključ za stanje i vrednovanje). Izostane → sada. */
  documentDate?: string;
  postingDate?: string;

  /** Napomena (upisuje se na OBA dokumenta para). */
  note?: string;
  projectId?: number;
  workOrderId?: number;

  items: CreateTransferItemDto[];
}

/** Storno (poništenje) prenosa — razlog ide u napomenu oba storno-dokumenta. */
export interface ReverseTransferDto {
  reason?: string;
  /** ISO datum storna; izostane → sada (nikad se ne vraća na datum originala). */
  documentDate?: string;
}
