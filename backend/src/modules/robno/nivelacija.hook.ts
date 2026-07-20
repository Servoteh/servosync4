import { Prisma } from "@prisma/client";

/**
 * Hook (port) za AUTO nivelaciju pri ulazu (doc 39 §F, PLAN_FAZA_3_IMPL §c).
 *
 * `CalculationService` na kraju kalkulacije ULAZA (`kind='UL'`) mora da pokrene uprosečavanje
 * valuacione cene po artiklu (ponderisana prosečna, doc 39 §F). Da bi izbegli tvrdi import ciklus
 * `CalculationService → NivelacijaService`, poziv ide preko OVOG porta injektovanog kroz DI:
 *
 *   • Ako je pravi `NivelacijaService` registrovan pod tokenom `NIVELACIJA_HOOK` → poziva se.
 *   • Ako nije (npr. faza gradnje pre nego što je nivelacija napisana) → `NoopNivelacijaHook`
 *     ostavlja jasan `TODO` trag u logu i ne dira `ItemValuation` (kalkulacija se ipak kompletira).
 *
 * Token je `Symbol` (Nest DI custom provider). `CalculationService` ga prima kao `@Inject(NIVELACIJA_HOOK)`.
 */
export const NIVELACIJA_HOOK = Symbol("NIVELACIJA_HOOK");

/** Jedna kalkulisana ulazna stavka koju nivelacija uprosečava sa zatečenim stanjem. */
export interface NivelacijaInboundLine {
  itemId: number;
  warehouseId: number;
  /** Ulazna količina (pozitivna). */
  quantity: Prisma.Decimal;
  /** Kalkulisane ulazne cene (doc 39 §A rezultat) — osnov `ulaznaVP`/`ulaznaNab` za uprosečavanje. */
  purchasePriceNet: Prisma.Decimal; // A
  dependentCostOwn: Prisma.Decimal; // B
  dependentCostSupplier: Prisma.Decimal; // C
  calculatedWholesalePrice: Prisma.Decimal; // KalkVP (ulaznaVP)
  calculatedRetailPrice: Prisma.Decimal; // KalkMP
}

export interface NivelacijaHook {
  /**
   * Uproseči valuacionu cenu artikala sa zatečenim stanjem i (auto) proknjiži nivelacionu razliku.
   * Poziva se UNUTAR iste `$transaction` kao kalkulacija (prima `tx`).
   *
   * @param tx            transakcioni klijent kalkulacije
   * @param inboundDocId  izvorni `UL` StockDocument (`linkedInboundDocId` na NIV dokumentu)
   * @param documentDate  as-of datum ulaza (stanje pre ulaza se računa do ovog datuma)
   * @param lines         kalkulisane ulazne stavke
   */
  applyForInbound(
    tx: Prisma.TransactionClient,
    inboundDocId: number,
    documentDate: Date,
    lines: NivelacijaInboundLine[],
  ): Promise<void>;
}
