/**
 * Čista računica za ŠKART izveštaje neusaglašenosti (bez I/O — lako testabilna).
 * Formula vlasnika (Q6: jedinica vremena = SATI; legacy vrednosti takođe sati):
 *
 *  - „Utrošeni radni sati" = Σ po operacijama do (UKLJUČIVO) operacije škarta:
 *      setupTime (Tpz, JEDNOM po operaciji) + cycleTime (Tk) × količina.
 *    Komad je trošio vreme i na operaciji na kojoj je škartiran → uključivo.
 *  - „Trošak materijala (kg)" = količina × masa jednog dela (kg).
 *
 * Paritet sa štampom RN-a (`work-order-print.service` „Ukupno vreme" = Σ Tpz + Σ Tk × kom)
 * i sa PDM `parseWeight` semantikom (masa ≤ 0 = NEPOZNATO: 0 = prazan XML, -1 = nenumerički).
 */

/** Nenegativna vrednost vremena: null/NaN/negativno → 0 (Tpz/Tk se ne oduzimaju). */
function nonNegHours(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Zaokruži na 3 decimale (Decimal(_, 3) u bazi); +EPSILON protiv float repova. */
function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/** Jedna operacija routinga RN-a (`work_order_operations`) za računicu sati. */
export interface ScrapHoursOp {
  operationNumber: number;
  setupTime: number | null;
  cycleTime: number | null;
}

/**
 * Utrošeni radni sati za škartirani komad: Σ (Tpz + Tk × qty) po SVIM operacijama
 * routinga sa `operationNumber <= scrapOperationNumber` (UKLJUČIVO operacija škarta).
 * Tpz (setupTime) ulazi JEDNOM po operaciji (ne množi se količinom). null/negativna
 * vremena → 0. Ako nema NIJEDNE operacije u opsegu → `null` (nepoznato, ne 0).
 * Rezultat na 3 decimale.
 */
export function computeScrapHours(
  ops: ScrapHoursOp[],
  scrapOperationNumber: number,
  qty: number,
): number | null {
  const inRange = ops.filter((o) => o.operationNumber <= scrapOperationNumber);
  if (inRange.length === 0) return null;
  let total = 0;
  for (const op of inRange)
    total += nonNegHours(op.setupTime) + nonNegHours(op.cycleTime) * qty;
  return round3(total);
}

/**
 * Trošak materijala u kg: qty × masa jednog dela (kg). Masa ≤ 0 ili null/NaN →
 * `null` (0/-1 su „nepoznato" po PDM `parseWeight` paritetu). Rezultat na 3 decimale.
 */
export function computeMaterialKg(
  qty: number,
  unitWeightKg: number | null | undefined,
): number | null {
  if (
    typeof unitWeightKg !== "number" ||
    !Number.isFinite(unitWeightKg) ||
    unitWeightKg <= 0
  )
    return null;
  return round3(qty * unitWeightKg);
}
