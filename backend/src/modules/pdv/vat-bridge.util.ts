/**
 * PDV BRUTO↔NETO MOST (Talas 2 B4).
 * =========================================================================
 * Čiste, bez-stanja funkcije za dvosmerni prevod između bruto (osnovica + PDV)
 * i neto (osnovica) iznosa po nominalnoj stopi. Koristi ih ručni GK/KIF-KUF
 * unos (FE kalkulator + eventualna server verifikacija) — jedina tačka istine
 * za matematiku mosta, da FE i BE daju identičan rezultat.
 *
 * Sve u `Prisma.Decimal` (decimal.js runtime, egzaktno — BACKEND_RULES §2: nikad
 * Float). Zaokruženje na 2 decimale (ROUND_HALF_UP, kao robno/decimal.util).
 *
 * INVARIJANTA (zbir uvek zatvara): PDV = bruto − neto, tj. neto + PDV === bruto
 * do na cent. Zato se u OBA smera jedna strana izvodi razlikom, ne nezavisnim
 * zaokruženjem — inače bi na graničnim slučajevima (1000 @ 20%) zbir promašio
 * cent. Primeri (BACKEND ugovor B4):
 *   grossToNet(1200, 20) → { net: 1000.00, vat: 200.00 }
 *   grossToNet(1000, 20) → { net: 833.33,  vat: 166.67 }  (166.67 = 1000 − 833.33)
 *   netToGross(1000, 20) → { gross: 1200.00, vat: 200.00 }
 */

import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const D = Prisma.Decimal;
const HUNDRED = new D(100);
const ONE = new D(1);

/** Ulaz koji funkcija ume da normalizuje u Decimal (JSON string, number, Decimal). */
export type DecimalLike = Prisma.Decimal | number | string;

/** Rezultat bruto → neto: osnovica + izdvojeni PDV. */
export interface NetVat {
  net: Prisma.Decimal;
  vat: Prisma.Decimal;
}

/** Rezultat neto → bruto: bruto iznos + obračunati PDV. */
export interface GrossVat {
  gross: Prisma.Decimal;
  vat: Prisma.Decimal;
}

/**
 * Nevalidan ulaz mosta (stopa/iznos) — poslovna greška, ne 500.
 *
 * Komentar je i do sada tvrdio „ne 500", ali klasa je nasleđivala goli `Error` pa je
 * `AllExceptionsFilter` pravio TAČNO 500 sa generičkom porukom (ispravka 04.08.2026).
 *
 * 422, ne 400: most zovu i putevi u kojima iznos/stopa NE dolaze iz tela zahteva nego
 * iz baze — `advance-vat.service` uzima stopu iz registra tarifa (`TaxRate`),
 * `sales/vat-totals` proverava iznose već upisanog dokumenta. Tamo „loš zahtev" nije
 * istina; istina je da je vrednost stigla a obračun se nad njom ne može izvesti, što
 * je upravo značenje 422. Isti status je tačan i za HTTP put (avansna uplata), gde
 * DTO već garantuje da je polje broj — ostaje poslovna provera (stopa ≥ 0, konačan
 * iznos).
 */
export class VatBridgeError extends UnprocessableEntityException {
  readonly code = "PDV_BRIDGE_INPUT";
  constructor(message: string) {
    super({ message, code: "PDV_BRIDGE_INPUT" });
    this.name = "VatBridgeError";
  }
}

/** Zaokruži Decimal na 2 decimale (novac), ROUND_HALF_UP. */
function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Normalizuj iznos u Decimal; nevalidan/nekonačan → VatBridgeError. */
function toAmount(value: DecimalLike, label: string): Prisma.Decimal {
  let d: Prisma.Decimal;
  try {
    d = new D(value);
  } catch {
    throw new VatBridgeError(`${label} nije ispravan broj.`);
  }
  if (!d.isFinite()) throw new VatBridgeError(`${label} nije konačan broj.`);
  return d;
}

/** Normalizuj i validiraj PDV stopu (u procentima, npr. 20). Mora biti ≥ 0. */
function toRate(ratePct: DecimalLike): Prisma.Decimal {
  const rate = toAmount(ratePct, "PDV stopa");
  if (rate.isNegative()) {
    throw new VatBridgeError("PDV stopa ne može biti negativna.");
  }
  return rate;
}

/**
 * BRUTO → NETO: iz bruto iznosa (osnovica + PDV) izdvoji osnovicu i PDV po stopi.
 *   net = round2(bruto / (1 + stopa/100))
 *   vat = bruto − net   (razlikom, da zbir zatvara)
 * Stopa 0 → net = bruto, vat = 0.
 */
export function grossToNet(gross: DecimalLike, ratePct: DecimalLike): NetVat {
  const g = round2(toAmount(gross, "Bruto iznos"));
  const rate = toRate(ratePct);
  const divisor = ONE.add(rate.div(HUNDRED)); // 1 + stopa/100 (≥ 1, nikad 0)
  const net = round2(g.div(divisor));
  const vat = g.sub(net);
  return { net, vat };
}

/**
 * NETO → BRUTO: iz osnovice obračunaj PDV i bruto po stopi.
 *   vat   = round2(neto * stopa/100)
 *   bruto = neto + vat   (zbir zatvara po definiciji: PDV = bruto − neto)
 * Stopa 0 → vat = 0, bruto = neto.
 */
export function netToGross(net: DecimalLike, ratePct: DecimalLike): GrossVat {
  const n = round2(toAmount(net, "Neto iznos"));
  const rate = toRate(ratePct);
  const vat = round2(n.mul(rate).div(HUNDRED));
  const gross = n.add(vat);
  return { gross, vat };
}
