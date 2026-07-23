import { Prisma } from "@prisma/client";

/**
 * Centralne PDV stope po `goodsTaxRateCode` (doc 43 §4 R_Tarife: Osnovna=20%/VISA,
 * Zeleznica=10%/NIZA, Posebna=8%/POLJO). Legacy default kod stavke je "3".
 *
 * VREDNOSTI SU RAZLOMCI (0.20 = 20%) — pogodno za množenje osnovice PDV-om u posting engine-u
 * (`aggregateDocAmounts`). Kalkulacija (`CalculationService.taxRateOf`) koristi ISTU mapu kao
 * fallback kad `tax_rates` tabela nema red, ali je konvertuje u PROCENAT (×100) jer `KalkMP`
 * formula radi sa `ΣStopa/100` (doc 39 §A).
 *
 * Izdvojeno iz `posting.service.ts` (C8) da se stopa ne duplira između GL kontiranja i robne
 * kalkulacije — jedan izvor istine dok se ne uvede pun `TaxRate` CRUD/resolver (plan D1).
 * Nepoznat kod → stopa 0 (PDV linija za taj artikal se ne knjiži) — doc 43 §5 disciplina.
 */
const D = Prisma.Decimal;
const ZERO = new D(0);

export const VAT_RATE_BY_CODE: Readonly<Record<string, Prisma.Decimal>> = {
  "3": new D("0.20"), // Osnovna / VISA (20%) — default stavke (doc 43 §4)
  "1": new D("0.20"), // Osnovna (alt kod)
  "2": new D("0.10"), // Zeleznica / NIZA (10%)
  "4": new D("0.08"), // Posebna / POLJO (8%)
  "0": ZERO, // bez PDV (izvoz/oslobođeno)
};

export const RATE_VISA = new D("0.20");
export const RATE_NIZA = new D("0.10");
export const RATE_POLJO = new D("0.08");
