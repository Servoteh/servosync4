/**
 * Rekurzivno pretvara `bigint` (Postgres int8) u `number` da bi rezultat mogao u
 * `res.json()` — Express/Nest JSON.stringify baca `TypeError: Do not know how to
 * serialize a BigInt`. Talas-C read sloj čita view-ove (`v_production_operations*`,
 * `production_drawings`) sa int8 kolonama (work_order_id, line_id, item_id…) kroz
 * `$queryRaw`/Prisma → BigInt. Sve vrednosti su u sigurnom opsegu Number-a
 * (max ~185k line_id, ~40k work_order); veći ključevi ne postoje.
 *
 * Datumi/Decimal/Buffer se NE diraju (Prisma već vraća Date/Decimal koje Nest
 * serijalizuje kao ISO/string). Menja se samo BigInt → Number.
 */
export function jsonSafe<T>(value: T): T {
  if (typeof value === "bigint") return Number(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v)) as unknown as T;
  if (value !== null && typeof value === "object") {
    // Date/Decimal/Buffer imaju sopstvenu toJSON/serijalizaciju — ne rastavljati.
    const proto = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[k] = jsonSafe(v);
      return out as unknown as T;
    }
  }
  return value;
}
