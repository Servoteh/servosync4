import { Prisma } from "@prisma/client";
import { stockKeyOf } from "../../src/modules/robno/stock-movements";

/**
 * Dvojnik `CostingService`-a za jedinične testove robnog modula.
 *
 * ZAŠTO POSTOJI: `CostingService` nudi DVA ulaza u isto stanje — `stateAsOf` (jedan par)
 * i `stateAsOfMany` (svi parovi jednim upitom, koje guard dovoljnog stanja koristi od
 * 04.08.2026). U produkciji je `stateAsOf` tanak omotač nad `stateAsOfMany`, pa se dva
 * odgovora NE MOGU razići. Ako bi svaki spec pisao svoj dubler, mogao bi da implementira
 * samo jednu metodu ili dve iz različitih tabela — i test bi „prolazio" nad stanjem koje
 * produkcija nikad ne bi vratila. Zato obe metode ovde izlaze iz JEDNOG resolvera.
 *
 * Živi u `test/` (isključen iz `tsconfig.build.json`) namerno: koristi `jest`, pa bi u
 * `src/` ušao u `dist` i oborio `nest build`.
 */

/**
 * Izvor simuliranog stanja. `undefined` = par nema NIJEDNO kretanje (verno produkciji:
 * takav par se u mapi `stateAsOfMany` uopšte ne pojavljuje, a `stateAsOf` vraća 0).
 */
export type StockStateResolver = (
  itemId: number,
  warehouseId: number,
) => Prisma.Decimal | undefined;

type StateOpts = { excludeDocId?: number; tx?: unknown };

export interface CostingDouble {
  stateAsOf: jest.Mock<
    Promise<Prisma.Decimal>,
    [number, number, Date, StateOpts?]
  >;
  stateAsOfMany: jest.Mock<
    Promise<Map<string, Prisma.Decimal>>,
    [ReadonlyArray<{ itemId: number; warehouseId: number }>, Date, StateOpts?]
  >;
}

/** `{ stateAsOf, stateAsOfMany }` — obe metode iz istog `resolve`, kao u produkciji. */
export function makeCostingDouble(resolve: StockStateResolver): CostingDouble {
  const stateAsOf: CostingDouble["stateAsOf"] = jest.fn(
    (
      itemId: number,
      warehouseId: number,
      _asOf: Date,
      _opts?: StateOpts,
    ): Promise<Prisma.Decimal> =>
      Promise.resolve(resolve(itemId, warehouseId) ?? new Prisma.Decimal(0)),
  );

  const stateAsOfMany: CostingDouble["stateAsOfMany"] = jest.fn(
    (
      keys: ReadonlyArray<{ itemId: number; warehouseId: number }>,
      _asOf: Date,
      _opts?: StateOpts,
    ): Promise<Map<string, Prisma.Decimal>> => {
      const out = new Map<string, Prisma.Decimal>();
      for (const k of keys) {
        const state = resolve(k.itemId, k.warehouseId);
        // Par bez kretanja se NE upisuje — pozivalac mora da ima svoj `?? 0`.
        if (state !== undefined) out.set(stockKeyOf(k.itemId, k.warehouseId), state);
      }
      return Promise.resolve(out);
    },
  );

  return { stateAsOf, stateAsOfMany };
}

/** Dubler nad statičkom tabelom `"itemId:warehouseId" → Decimal` (najčešći oblik u specovima). */
export function makeCostingDoubleFromTable(
  stateByKey: Record<string, Prisma.Decimal>,
): CostingDouble {
  return makeCostingDouble(
    (itemId, warehouseId) => stateByKey[stockKeyOf(itemId, warehouseId)],
  );
}
