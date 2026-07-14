/**
 * salary-tax.ts — FE port 1.0 `src/lib/salaryTax.js` (P9 ZARADE, doktrina §C).
 *
 * PORT 1:1 iz 1.0 — finansijska logika mora ostati IDENTIČNA (BE `salary-tax.ts`
 * je isti kod; koeficijenti se NE menjaju). Obračun zarade po propisima RS —
 * preračun NETO ↔ BRUTO (BRUTO I).
 *
 *   BRUTO I  = neto + porez + doprinosi na teret zaposlenog (iznos iz ugovora).
 *   BRUTO II = BRUTO I + doprinosi na teret poslodavca (ukupan trošak poslodavca).
 *
 * Parametri se menjaju svake godine → drže se odvojeno (PARAMS_BY_YEAR). Nove
 * godine se dodaju u OVU mapu (i u 1.0/BE), NE u formulu.
 */

export interface TaxParams {
  year: number;
  nonTaxable: number;
  minBase: number;
  maxBase: number;
  taxRate: number;
  empContribRate: number;
  erContribRate: number;
}

/** Zvanični parametri po godini. Izvor: Sl. glasnik RS (objava krajem prethodne god.). */
export const PARAMS_BY_YEAR: Record<number, TaxParams> = {
  2025: {
    year: 2025,
    nonTaxable: 28423, // neoporezivi iznos zarade (mesečno)
    minBase: 45950, // najniža mesečna osnovica doprinosa
    maxBase: 656425, // najviša mesečna osnovica doprinosa
    taxRate: 0.1,
    empContribRate: 0.199, // doprinosi na teret zaposlenog
    erContribRate: 0.1515, // doprinosi na teret poslodavca
  },
  2026: {
    year: 2026,
    nonTaxable: 34221, // od 1.1.2026 (bio 28.423)
    minBase: 51297,
    maxBase: 732820,
    taxRate: 0.1,
    empContribRate: 0.199,
    erContribRate: 0.1515,
  },
};

/** Podrazumevani (tekući) parametri — najnovija definisana godina. */
export const DEFAULT_PARAMS: TaxParams = PARAMS_BY_YEAR[2026];

export interface GrossToNet {
  bruto: number;
  neto: number;
  tax: number;
  empContrib: number;
  erContrib: number;
  bruto2: number;
  base: number;
}

/** Osnovica doprinosa = bruto ograničen na [najniža, najviša]. */
function contributionBase(bruto: number, p: TaxParams): number {
  return Math.min(Math.max(bruto, p.minBase), p.maxBase);
}

/** BRUTO I → kompletan obračun. */
export function grossToNet(bruto: number, p: TaxParams = DEFAULT_PARAMS): GrossToNet {
  const b = Math.max(0, Number(bruto) || 0);
  const base = b <= 0 ? 0 : contributionBase(b, p);
  const empContrib = base * p.empContribRate;
  const tax = Math.max(0, b - p.nonTaxable) * p.taxRate;
  const erContrib = base * p.erContribRate;
  const neto = b - empContrib - tax;
  return {
    bruto: round2(b),
    neto: round2(neto),
    tax: round2(tax),
    empContrib: round2(empContrib),
    erContrib: round2(erContrib),
    bruto2: round2(b + erContrib),
    base: round2(base),
  };
}

/**
 * NETO → BRUTO I. Numerička inverzija (grossToNet je monotono rastuća po bruto),
 * pa je tačna i kad osnovica „udari" o najnižu/najvišu granicu. Binarna pretraga
 * do tačnosti 0,01 RSD.
 */
export function netToGross(neto: number, p: TaxParams = DEFAULT_PARAMS): number {
  const target = Math.max(0, Number(neto) || 0);
  if (target === 0) return 0;
  let lo = 0;
  let hi = Math.max(p.maxBase * 2, target * 3, 1000);
  while (grossToNet(hi, p).neto < target) hi *= 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (grossToNet(mid, p).neto < target) lo = mid;
    else hi = mid;
    if (hi - lo < 0.0005) break;
  }
  return round2((lo + hi) / 2);
}

function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/** Parametri za datu kalendarsku godinu (fallback na DEFAULT_PARAMS). */
export function paramsForYear(year: number): TaxParams {
  return PARAMS_BY_YEAR[year] || DEFAULT_PARAMS;
}
