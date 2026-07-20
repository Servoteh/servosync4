/**
 * PRODUKCIJSKI Arith<Prisma.Decimal> adapter za GL posting engine (Faza 2/3).
 * =========================================================================
 * `expression-parser.ts` je decimal-agnostičan — radi nad apstraktnim tipom `T`
 * kroz `Arith<T>` (add/sub/mul/div/neg/fromString/isZero). Za NOVAC prosleđujemo
 * OVAJ adapter nad `Prisma.Decimal` (decimal.js runtime), nikad `numberArith`
 * (Float) — BACKEND_RULES §2 „Decimal, nikad Float".
 *
 * `Prisma.Decimal` operacije su egzaktne (bez binarne float greške). Deljenje
 * nulom hvatamo eksplicitno pre `div` da bacimo istu `ExpressionError` kao i
 * referentni `numberArith` (parser ionako proverava `isZero(rhs)` pre `div`,
 * ali držimo i ovde radi robusnosti ako se adapter koristi direktno).
 */

import { Prisma } from "@prisma/client";
import { Arith, ExpressionError } from "./expression-parser";

const D = Prisma.Decimal;

/** Aritmetika nad Prisma.Decimal — jedina tačka vezivanja parsera za novac. */
export const prismaDecimalArith: Arith<Prisma.Decimal> = {
  fromString(literal: string): Prisma.Decimal {
    try {
      return new D(literal);
    } catch {
      throw new ExpressionError(`Nevalidan broj: "${literal}"`);
    }
  },
  add: (a, b) => a.add(b),
  sub: (a, b) => a.sub(b),
  mul: (a, b) => a.mul(b),
  div(a, b) {
    if (b.isZero()) {
      throw new ExpressionError("Deljenje nulom");
    }
    return a.div(b);
  },
  neg: (a) => a.neg(),
  isZero: (a) => a.isZero(),
};
