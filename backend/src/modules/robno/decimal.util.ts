import { Prisma } from "@prisma/client";

/**
 * Decimal helperi za robni modul (BACKEND_RULES §2: novac/količine su `Decimal`, nikad Float;
 * računa se `Prisma.Decimal` — decimal.js runtime — a NE JS `number`).
 *
 * Aritmetika ide preko INSTANCE metoda (`a.add(b)`, `a.sub(b)`, `a.mul(b)`, `a.div(b)`,
 * `a.equals(b)`) — isti oblik kao GL posting adapter (`posting` README §Decimal) i `mrp.service`
 * (`.minus`/`... `). decimal.js baca na deljenju nulom → deljenje se štiti u pozivaocu.
 */

export type Dec = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

/** Konstruiši Decimal (kratica). */
export function dec(value: string | number | Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

/**
 * Parsiraj ulaznu vrednost (string iz JSON envelope-a, number, Decimal ili null/undefined) u
 * `Prisma.Decimal`. Prazno/izostavljeno → 0. Nevalidan broj → 0 (validaciju vrednosti radi servis
 * pre poziva; ovde je defanzivni fallback da `new Decimal("")` ne baci).
 */
export function toDec(
  value: string | number | Prisma.Decimal | null | undefined,
): Prisma.Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  if (value instanceof Prisma.Decimal) return value;
  try {
    return new Prisma.Decimal(value);
  } catch {
    return ZERO;
  }
}

/** Zaokruži na N decimala (default 4) — tek pri UPISU (doc 39 §A: „zaokruživanje na 4 decimale tek pri upisu"). */
export function round(value: Prisma.Decimal, dp = 4): Prisma.Decimal {
  return value.toDecimalPlaces(dp, Prisma.Decimal.ROUND_HALF_UP);
}

/** `a/b` uz zaštitu od deljenja nulom (decimal.js baca) → vraća `ZERO` kad je `b == 0`. */
export function safeDiv(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
  return b.isZero() ? ZERO : a.div(b);
}
