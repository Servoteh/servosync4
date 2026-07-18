/**
 * Dubinski BigInt→Number nad $queryRaw/RPC izlazom (TALAS D; reuse za PB/Profil/Podešavanja).
 * PG `bigint`/`int8` (count/size/audit id) Prisma vraća kao JS `BigInt`, koji `JSON.stringify`
 * (res.json) baca (TypeError). `Prisma.Decimal` ostaje NETAKNUT (ima `toJSON` → precizan string).
 * Rekurzija po nizovima/objektima (RPC vraća redove / ugnježdeni jsonb).
 */
export function jsonSafe<T>(value: T): T {
  return convert(value) as T;
}

function convert(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(convert);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    // Prisma.Decimal (i sl.) ima toJSON — ne diramo ga.
    if (typeof (value as { toJSON?: unknown }).toJSON === "function")
      return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = convert(v);
    return out;
  }
  return value;
}
