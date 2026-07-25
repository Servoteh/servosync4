import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

/**
 * Generički soft-delete + Undo (Batch B, T3).
 * ============================================================================
 * Jedan obrazac za poništivo brisanje stavki dokumenata: umesto tvrdog `DELETE`
 * postavljamo `deletedAt`/`deletedByUserId`, a svi ČITAOCI filtriraju
 * `deletedAt: null` (v. `NOT_DELETED`). Brisanje je poništivo („Poništi") u kratkom
 * prozoru (`UNDO_WINDOW_MS`); posle isteka `restore` vraća 409.
 *
 * Namena je deljena (robno stavke sada; izvod stavke / GK linije draft naloga u
 * sledećem batch-u — polja u šemi su već tu). Delegat se prosleđuje strukturno da
 * bi util ostao nezavisan od konkretnog modela.
 */

/** Prozor u kome je „Poništi" (undo) dozvoljen. Posle isteka `restore` → 409. */
export const UNDO_WINDOW_MS = 30_000;

/**
 * Prisma `where` fragment „nije obrisano". Spread-uj u svaki `where`/nested `where`
 * čitaoca stavki (`{ ...NOT_DELETED }` ili `where: NOT_DELETED`), da meko-obrisan
 * red NE utiče na listu, zalihe, kalkulaciju ni knjiženje.
 */
export const NOT_DELETED = { deletedAt: null } as const;

/**
 * Minimalni (strukturni) oblik Prisma delegata koji soft-delete koristi: čita
 * `deletedAt` i piše `deletedAt`/`deletedByUserId`. Svaki model sa te dve kolone
 * (StockDocumentItem, BankStatementLine, …) zadovoljava ovaj interfejs.
 */
export interface SoftDeleteDelegate {
  findUnique(args: {
    where: { id: number };
    select: { deletedAt: true };
  }): Promise<{ deletedAt: Date | null } | null>;
  update(args: {
    where: { id: number };
    data: { deletedAt?: Date | null; deletedByUserId?: number | null };
  }): Promise<unknown>;
}

/**
 * Meko obriši red (`deletedAt = now`, `deletedByUserId = korisnik`). Radi kroz
 * prosleđeni (tx-vezani) delegat, unutar postojeće transakcije. Pretpostavlja da je
 * pozivalac već proverio postojanje i poslovne guarde (npr. dokument nije proknjižen).
 */
export async function softDelete(
  tx: Prisma.TransactionClient,
  delegate: SoftDeleteDelegate,
  id: number,
  userId: number | null,
): Promise<void> {
  void tx; // delegat je već vezan za `tx`; parametar stoji radi jednoobraznosti/audit-a
  await delegate.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: userId ?? null },
  });
}

/**
 * Poništi (undo) meko brisanje — SAMO unutar `UNDO_WINDOW_MS` od brisanja; posle
 * isteka baca 409 (rok istekao). Idempotentno za već-aktivan red (nije obrisan →
 * bez izmene). Nepostojeći red → 404 (pozivalac uz to radi svoje provere konteksta).
 */
export async function restore(
  tx: Prisma.TransactionClient,
  delegate: SoftDeleteDelegate,
  id: number,
): Promise<void> {
  void tx; // delegat je već vezan za `tx`
  const row = await delegate.findUnique({
    where: { id },
    select: { deletedAt: true },
  });
  if (!row) throw new NotFoundException("Stavka ne postoji.");
  // Već aktivna (nije obrisana) → nema šta da se poništi (idempotentno).
  if (row.deletedAt == null) return;
  const elapsedMs = Date.now() - row.deletedAt.getTime();
  if (elapsedMs > UNDO_WINDOW_MS)
    throw new ConflictException(
      "Rok za poništavanje brisanja (30 s) je istekao.",
    );
  await delegate.update({
    where: { id },
    data: { deletedAt: null, deletedByUserId: null },
  });
}
