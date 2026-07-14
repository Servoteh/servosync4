/**
 * payroll-calc.spec.ts — ZLATNI TESTOVI (TALAS G, G3) za BE port `payroll-calc.ts`.
 * Ulaz→izlaz PRESLIKAN iz 1.0 `tests/services/payrollCalc.test.js` (6 poslovnih
 * scenarija + rubni slučajevi + V2 modeli). Bilo koje odstupanje = neveran port.
 */
import {
  computeEarnings,
  computePayableHours,
  computeMonthlyFond,
  deriveCompensationModel,
  sanitizeHoursForWorkType,
  aggregateWorkHoursForMonth,
  gridRedovniUnitsOneDay,
  BOLOVANJE_OBICNO_FACTOR,
  paymentWindowsForModel,
  paymentWindowLabel,
  isDateInPaymentWindow,
  type HoursAgg,
  type SalaryTermsInput,
} from "./payroll-calc";

function emptyHours(overrides: Partial<HoursAgg> = {}): Partial<HoursAgg> {
  return {
    redovanRadSati: 0,
    prekovremeniSati: 0,
    praznikRadSati: 0,
    praznikPlaceniSati: 0,
    godisnjiSati: 0,
    slobodniDaniSati: 0,
    bolovanje65Sati: 0,
    bolovanje100Sati: 0,
    dveMasineSati: 0,
    ...overrides,
  };
}
function termsFiksno(o: SalaryTermsInput = {}): SalaryTermsInput {
  return {
    compensationModel: "fiksno",
    fixedAmount: 100000,
    fixedTransportComponent: 6000,
    fixedExtraHourRate: 800,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...o,
  };
}
function termsDvaDela(o: SalaryTermsInput = {}): SalaryTermsInput {
  return {
    compensationModel: "dva_dela",
    firstPartAmount: 30000,
    splitHourRate: 500,
    splitTransportAmount: 5000,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...o,
  };
}
function termsSatnica(o: SalaryTermsInput = {}): SalaryTermsInput {
  return {
    compensationModel: "satnica",
    hourlyRate: 600,
    hourlyTransportAmount: 4000,
    terrainDomesticRate: 0,
    terrainForeignRate: 0,
    ...o,
  };
}

describe("payrollCalc — acceptance scenariji (zlatni)", () => {
  it("1) Fiksno + ugovor: pun mesec bez extra → fixed_amount", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsFiksno({ fixedAmount: 100000 }),
      hours: emptyHours({ redovanRadSati: 168 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.compensationModel).toBe("fiksno");
    expect(r.payableHours).toBe(0);
    expect(r.ukupnaZarada).toBe(100000);
    expect(r.preostaloZaIsplatu).toBe(100000);
    expect(r.warnings).toEqual([]);
  });

  it("2) Fiksno: prekov 4 + 2 maš 2 + praznik_rad 8 → +extra", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsFiksno({ fixedAmount: 100000, fixedExtraHourRate: 800 }),
      hours: emptyHours({
        redovanRadSati: 160,
        prekovremeniSati: 4,
        praznikRadSati: 8,
        dveMasineSati: 2,
      }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 50000,
    });
    expect(r.payableHours).toBe(14);
    expect(r.ukupnaZarada).toBe(111200);
    expect(r.prviDeo).toBe(50000);
    expect(r.preostaloZaIsplatu).toBe(61200);
    expect(r.warnings).toEqual([]);
  });

  it("3) Dva dela: prvi_deo + sati×rate + transport", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsDvaDela({
        firstPartAmount: 30000,
        splitHourRate: 500,
        splitTransportAmount: 5000,
      }),
      hours: emptyHours({ redovanRadSati: 160, prekovremeniSati: 8 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.payableHours).toBe(168);
    expect(r.ukupnaZarada).toBe(119000);
    expect(r.prviDeo).toBe(30000);
    expect(r.preostaloZaIsplatu).toBe(89000);
  });

  it("4) Satnica: redovan 160 + bolovanje 65% 16h → ponderisano", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsSatnica({ hourlyRate: 600, hourlyTransportAmount: 4000 }),
      hours: emptyHours({ redovanRadSati: 160, bolovanje65Sati: 16 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.payableHours).toBe(170.4);
    expect(r.ukupnaZarada).toBe(106240);
    expect(BOLOVANJE_OBICNO_FACTOR).toBe(0.65);
  });

  it("5) Satnica: praznik_rad i 2 mašine po istoj satnici", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsSatnica({ hourlyRate: 600, hourlyTransportAmount: 0 }),
      hours: emptyHours({
        redovanRadSati: 160,
        praznikRadSati: 8,
        dveMasineSati: 4,
      }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.payableHours).toBe(172);
    expect(r.ukupnaZarada).toBe(103200);
  });

  it("6) Satnica + praksa: plaćena odsustva → warnings + 0", () => {
    const r = computeEarnings({
      workType: "praksa",
      terms: termsSatnica({ hourlyRate: 500, hourlyTransportAmount: 0 }),
      hours: emptyHours({
        redovanRadSati: 120,
        godisnjiSati: 16,
        bolovanje65Sati: 8,
        praznikPlaceniSati: 8,
        slobodniDaniSati: 8,
      }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 0,
    });
    expect(r.payableHours).toBe(120);
    expect(r.ukupnaZarada).toBe(60000);
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("no_right_godisnji");
    expect(codes).toContain("no_right_bolovanje");
    expect(codes).toContain("no_right_praznik_placeni");
    expect(codes).toContain("no_right_slobodni");
  });
});

describe("payrollCalc — teren, rubni slučajevi, nop", () => {
  it("teren zemlja RSD; ino EUR (zaseban total)", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsSatnica({
        hourlyRate: 500,
        hourlyTransportAmount: 0,
        terrainDomesticRate: 1500,
        terrainForeignRate: 35,
      }),
      hours: emptyHours({ redovanRadSati: 168 }),
      terrain: { domestic: 3, foreign: 2 },
      advanceAmount: 0,
    });
    expect(r.ukupnaZarada).toBe(88500);
    expect(r.terrainRsd).toBe(4500);
    expect(r.terrainEur).toBe(70);
  });

  it("negativan preostalo → warning", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsSatnica({ hourlyRate: 500 }),
      hours: emptyHours({ redovanRadSati: 10 }),
      terrain: { domestic: 0, foreign: 0 },
      advanceAmount: 50000,
    });
    expect(r.preostaloZaIsplatu).toBeLessThan(0);
    expect(r.warnings.map((w) => w.code)).toContain("negative_remainder");
  });

  it("deriveCompensationModel: legacy salary_type mapping", () => {
    expect(deriveCompensationModel({ salaryType: "satnica" })).toBe("satnica");
    expect(deriveCompensationModel({ salaryType: "ugovor" })).toBe("fiksno");
    expect(deriveCompensationModel({ salaryType: "dogovor" })).toBe("fiksno");
    expect(deriveCompensationModel({ compensationModel: "dva_dela" })).toBe(
      "dva_dela",
    );
    expect(deriveCompensationModel(null)).toBe(null);
  });

  it("computePayableHours: fiksno=extra-only; weighted množi 65% sa 0.65", () => {
    expect(
      computePayableHours(
        emptyHours({
          redovanRadSati: 160,
          prekovremeniSati: 5,
          praznikRadSati: 8,
          dveMasineSati: 3,
          godisnjiSati: 8,
        }),
        "fiksno",
      ).payableHours,
    ).toBe(16);
    expect(
      computePayableHours(
        emptyHours({ redovanRadSati: 100, bolovanje65Sati: 20 }),
        "satnica",
      ).payableHours,
    ).toBe(113);
  });

  it("Fiksno 5/22 neplaćenih → fixed × (17/22) + warning", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsFiksno({ fixedAmount: 110000, fixedExtraHourRate: 0 }),
      hours: emptyHours({ redovanRadSati: 136 }),
      neplacenoDays: 5,
      fondSati: 176,
    });
    expect(r.ukupnaZarada).toBe(Math.round(110000 * (17 / 22) * 100) / 100);
    const warn = r.warnings.find((w) => w.code === "neplaceno_fiksno");
    expect(warn?.neplacenoDays).toBe(5);
  });

  it("computeMonthlyFond: praznik na radni dan smanjuje fond za 8", () => {
    const noHol = computeMonthlyFond(2026, 1, new Set());
    const withHol = computeMonthlyFond(2026, 1, new Set(["2026-01-01"]));
    expect(noHol.fondSati - withHol.fondSati).toBe(8);
  });

  it("computeMonthlyFond: neplaceno dani umanjuju fond (feb 2026)", () => {
    expect(computeMonthlyFond(2026, 2, []).fondSati).toBe(20 * 8);
    expect(computeMonthlyFond(2026, 2, [], 5).fondSati).toBe(120);
  });

  it("aggregate: GO=8h god.; državni praznik bez unosa=8h; pre hireDate=0", () => {
    expect(
      aggregateWorkHoursForMonth(
        2026,
        4,
        new Map([["2026-04-01", { hours: 0, absenceCode: "go" }]]),
        new Set(),
      ).godisnjiSati,
    ).toBe(8);
    expect(
      aggregateWorkHoursForMonth(2026, 1, new Map(), new Set(["2026-01-01"]))
        .praznikPlaceniSati,
    ).toBe(8);
    expect(
      aggregateWorkHoursForMonth(2026, 1, new Map(), new Set(["2026-01-01"]), {
        workType: "dualno",
      }).praznikPlaceniSati,
    ).toBe(0);
  });

  it("aggregate: bolovanje obično/povreda → bucket 65/100", () => {
    const h = aggregateWorkHoursForMonth(
      2026,
      4,
      new Map([
        ["2026-04-01", { hours: 0, absenceCode: "bo", absenceSubtype: "obicno" }],
        [
          "2026-04-02",
          { hours: 0, absenceCode: "bo", absenceSubtype: "povreda_na_radu" },
        ],
      ]),
      new Set(),
    );
    expect(h.bolovanje65Sati).toBe(8);
    expect(h.bolovanje100Sati).toBe(8);
  });

  it("gridRedovniUnitsOneDay: sv/pl=8h; nop=0; praznik pre/na hireDate", () => {
    expect(
      gridRedovniUnitsOneDay("2026-04-14", { hours: 0, absence_code: "sv" }, new Set()),
    ).toBe(8);
    expect(
      gridRedovniUnitsOneDay("2026-05-12", { hours: 0, absence_code: "nop" }, new Set()),
    ).toBe(0);
    expect(
      gridRedovniUnitsOneDay("2026-01-01", { hours: 0 }, new Set(["2026-01-01"]), {
        workType: "ugovor",
        hireDate: "2026-01-15",
      }),
    ).toBe(0);
  });
});

describe("payrollCalc — V2 modeli i prozori isplate", () => {
  it("jednokratno: cela zarada u jednoj isplati (prvi deo=avans)", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: { compensationModel: "jednokratno", fixedAmount: 80000, fixedExtraHourRate: 0 },
      hours: emptyHours({ redovanRadSati: 160 }),
      advanceAmount: 0,
    });
    expect(r.ukupnaZarada).toBe(80000);
    expect(r.prviDeo).toBe(0);
  });

  it("fiksno strogi režim (fixedNoExtraHours): extra se NE plaća + warning", () => {
    const r = computeEarnings({
      workType: "ugovor",
      terms: termsFiksno({ fixedNoExtraHours: true }),
      hours: emptyHours({ redovanRadSati: 160, prekovremeniSati: 10, dveMasineSati: 4 }),
      advanceAmount: 0,
    });
    expect(r.ukupnaZarada).toBe(100000);
    expect(r.warnings.some((w) => w.code === "fiksno_bez_dodatnih")).toBe(true);
  });

  it("satnica: prvi deo = first_part_amount kad avans nije unet; avans ima prednost", () => {
    expect(
      computeEarnings({
        workType: "ugovor",
        terms: termsSatnica({ firstPartAmount: 50000 }),
        hours: emptyHours({ redovanRadSati: 160 }),
        advanceAmount: 0,
      }).prviDeo,
    ).toBe(50000);
    expect(
      computeEarnings({
        workType: "ugovor",
        terms: termsSatnica({ firstPartAmount: 50000 }),
        hours: emptyHours({ redovanRadSati: 160 }),
        advanceAmount: 40000,
      }).prviDeo,
    ).toBe(40000);
  });

  it("prozori isplate izvedeni iz modela + izuzetak + labela", () => {
    expect(paymentWindowsForModel("fiksno")).toEqual(["01_05"]);
    expect(paymentWindowsForModel("dva_dela")).toEqual(["01_05", "15_20"]);
    expect(paymentWindowsForModel("jednokratno")).toEqual(["15_20"]);
    expect(paymentWindowsForModel("fiksno", "15_20")).toEqual(["15_20"]);
    expect(paymentWindowsForModel(null)).toEqual([]);
    expect(paymentWindowLabel("dva_dela")).toBe("01–05. u mesecu + 15–20. u mesecu");
    expect(isDateInPaymentWindow("2026-07-06", "01_05")).toBe(false);
    expect(isDateInPaymentWindow("2026-07-15", "15_20")).toBe(true);
  });

  it("sanitize: penzioner nema godišnji/bolovanje", () => {
    const { sanitized, warnings } = sanitizeHoursForWorkType(
      emptyHours({ redovanRadSati: 40, godisnjiSati: 8, bolovanje65Sati: 16 }),
      "penzioner",
    );
    expect(sanitized.godisnjiSati).toBe(0);
    expect(sanitized.bolovanje65Sati).toBe(0);
    expect(sanitized.redovanRadSati).toBe(40);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
