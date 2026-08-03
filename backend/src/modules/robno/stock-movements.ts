import { Prisma } from "@prisma/client";

/**
 * JEDAN IZVOR ISTINE O KRETANJU ZALIHA (`v_stock_movements`).
 *
 * PRAVILO: nijedan upit o stanju, proseku, kartici ili raspoloživom NE SME sam da
 * prepisuje predikat kretanja (`document_type_code <> 'KODJ'`, `affects_stock`,
 * `deleted_at IS NULL`) ni pravilo znaka (`CASE WHEN is_inbound …`). Sve to živi u
 * pogledu — migracija `20260804100000_v_stock_movements`.
 *
 * ZAŠTO: taj predikat je do 04.08.2026. bio prepisan u 10 upita u 5 fajlova, a
 * doslednost su držali samo komentari („filter VERBATIM iz stateAsOf"). Kad se
 * doda novo pravilo a jedno mesto se propusti, ništa ne pukne — lager, kartica
 * artikla i guard izlaza samo počnu da tvrde različite brojeve o istoj robi.
 *
 * KAKO SE KORISTI:
 * ```ts
 * const rows = await db.$queryRaw<{ state: Prisma.Decimal | null }[]>(Prisma.sql`
 *   SELECT COALESCE(SUM(m.signed_quantity), 0) AS state
 *   FROM ${V_STOCK_MOVEMENTS} m
 *   WHERE m.item_id = ${itemId} AND m.warehouse_id = ${warehouseId}
 *     AND m.document_date <= ${asOf}
 * `);
 * ```
 *
 * Simbol `V_STOCK_MOVEMENTS` postoji baš zato da `grep` nad njim izlista SVE
 * potrošače kretanja zaliha — pre izmene pravila prođi kroz taj spisak.
 */
export const V_STOCK_MOVEMENTS = Prisma.raw("v_stock_movements");

/**
 * (artikal, magacin) — zrno po kome se računa stanje, prosek i raspoloživo.
 * Živi ovde jer je to grain pogleda `v_stock_movements`; `dto/reservation.dto.ts`
 * ga re-eksportuje zbog postojećih import-a.
 */
export interface StockKey {
  itemId: number;
  warehouseId: number;
}

/**
 * Ključ mape po (artikal, magacin) — JEDNA definicija za ceo modul.
 *
 * Bio je definisan u `reservation.service.ts`, a `robno.service.ts` je isti ključ
 * pravio i ručno (`` `${itemId}:${warehouseId}` ``) — dve definicije istog ključa u
 * istom modulu su tiha zamka: promeni se format na jednom mestu i mape prestanu da
 * se poklapaju bez ijedne greške.
 */
export function stockKeyOf(itemId: number, warehouseId: number): string {
  return `${itemId}:${warehouseId}`;
}

/**
 * Red pogleda `v_stock_movements` (snake_case — dolazi iz `$queryRaw`, ne kroz Prisma mapiranje).
 *
 * `signed_quantity` je JEDINI ispravan način da se sabere stanje: `SUM(signed_quantity)`.
 * Ručno `CASE WHEN is_inbound …` nad ovim pogledom je greška — znak je već primenjen.
 */
export interface StockMovementRow {
  item_line_id: number;
  document_id: number;
  document_number: string;
  kind: string;
  document_type_code: string;
  document_date: Date;
  /** DRAFT | CALCULATED | POSTED | LOCKED — costing ga NAMERNO ne filtrira (doc 39 §C). */
  document_status: string;
  header_warehouse_id: number;
  item_id: number;
  warehouse_id: number;
  is_inbound: boolean;
  /** Uvek pozitivna (kao u tabeli). Za sabiranje koristi `signed_quantity`. */
  quantity: Prisma.Decimal;
  /** ±Kol — znak iz `document_types.is_inbound`. */
  signed_quantity: Prisma.Decimal;
  /** A+B+C = nabavna neto + ZTsop + ZTdob (doc 39 §C). */
  unit_purchase_net: Prisma.Decimal;
  /** KalkVP. */
  unit_wholesale: Prisma.Decimal;
  /** KalkMP sa fallback-om na stvarnu MP (KEPU se vodi po MP vrednosti). */
  unit_retail: Prisma.Decimal;
}
