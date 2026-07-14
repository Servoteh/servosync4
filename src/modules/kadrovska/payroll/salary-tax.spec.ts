/**
 * salary-tax.spec.ts — ZLATNI TESTOVI (TALAS G, G3) za BE port `salary-tax.ts`.
 * Ulaz→izlaz je PRESLIKAN iz 1.0 `tests/lib/salaryTax.test.js` (poznati referentni
 * brojevi) — bilo koje odstupanje znači da port NIJE veran 1.0 obračunu.
 */
import {
  grossToNet,
  netToGross,
  PARAMS_BY_YEAR,
  DEFAULT_PARAMS,
  paramsForYear,
} from "./salary-tax";

const P26 = PARAMS_BY_YEAR[2026];
const P25 = PARAMS_BY_YEAR[2025];

describe("salary-tax parametri (poreske tablice u kodu)", () => {
  it("2026 zvanični parametri", () => {
    expect(P26.nonTaxable).toBe(34221);
    expect(P26.minBase).toBe(51297);
    expect(P26.maxBase).toBe(732820);
    expect(P26.empContribRate).toBeCloseTo(0.199, 5);
    expect(P26.taxRate).toBeCloseTo(0.1, 5);
  });
  it("2025 zvanični parametri (prethodna godina prisutna)", () => {
    expect(P25.nonTaxable).toBe(28423);
    expect(P25.minBase).toBe(45950);
    expect(P25.maxBase).toBe(656425);
  });
  it("DEFAULT_PARAMS je 2026", () => {
    expect(DEFAULT_PARAMS.year).toBe(2026);
  });
  it("paramsForYear: nepoznata godina → DEFAULT (2026), 1.0 paritet", () => {
    expect(paramsForYear(2019).year).toBe(2026);
    expect(paramsForYear(2025).year).toBe(2025);
  });
});

describe("grossToNet (2026) — zlatni referentni brojevi", () => {
  it("bruto 100.000 → neto 73.522,10", () => {
    const r = grossToNet(100000, P26);
    expect(r.empContrib).toBeCloseTo(19900, 2);
    expect(r.tax).toBeCloseTo(6577.9, 2);
    expect(r.neto).toBeCloseTo(73522.1, 2);
    expect(r.base).toBe(100000);
    expect(r.bruto2).toBeCloseTo(115150, 2);
  });

  it("klamp na NAJNIŽU osnovicu: bruto 40.000 → doprinosi na 51.297", () => {
    const r = grossToNet(40000, P26);
    expect(r.base).toBe(51297);
    expect(r.empContrib).toBeCloseTo(51297 * 0.199, 2);
    expect(r.tax).toBeCloseTo((40000 - 34221) * 0.1, 2);
  });

  it("klamp na NAJVIŠU osnovicu: bruto 800.000 → doprinosi na 732.820", () => {
    const r = grossToNet(800000, P26);
    expect(r.base).toBe(732820);
    expect(r.empContrib).toBeCloseTo(732820 * 0.199, 2);
  });

  it("bruto ispod neoporezivog → porez 0", () => {
    expect(grossToNet(30000, P26).tax).toBe(0);
  });
});

describe("netToGross je tačna inverzija grossToNet", () => {
  for (const bruto of [51297, 60000, 100000, 150000, 300000, 732820]) {
    it(`round-trip bruto ${bruto}`, () => {
      const neto = grossToNet(bruto, P26).neto;
      expect(netToGross(neto, P26)).toBeCloseTo(bruto, 1);
    });
  }
  it("neto 0 → bruto 0", () => {
    expect(netToGross(0, P26)).toBe(0);
  });
});
