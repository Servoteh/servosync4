import { Prisma } from "@prisma/client";
import {
  KEP_VALUATION_DEFAULT,
  KEP_VALUATION_LABEL,
  parseKepValuation,
} from "./kep-valuation";
import { computeKepuEntries } from "../../modules/robno/kepu-book.util";

const D = Prisma.Decimal;

/**
 * KEP knjiga se po Pravilniku može voditi po maloprodajnoj ILI veleprodajnoj ceni.
 * Odluka vlasnika (27.07.2026) je da se OBA principa podešavaju, pa svaki red knjige
 * nosi oba iznosa — inače bi preklop menjao samo buduće redove i knjiga bi postala
 * mešavina dva principa, što je gore od pogrešnog principa jer se ne vidi.
 */

describe("parseKepValuation — čitanje podešavanja", () => {
  it("prazno/nepostojeće pada na MP (zatečeno ponašanje, štampa ne sme da stane)", () => {
    expect(parseKepValuation(null)).toBe("MP");
    expect(parseKepValuation(undefined)).toBe("MP");
    expect(parseKepValuation("")).toBe("MP");
    expect(parseKepValuation("   ")).toBe("MP");
    expect(KEP_VALUATION_DEFAULT).toBe("MP");
  });

  it("prepoznaje VP bez obzira na velika/mala slova i razmake", () => {
    expect(parseKepValuation("VP")).toBe("VP");
    expect(parseKepValuation("vp")).toBe("VP");
    expect(parseKepValuation("  Vp  ")).toBe("VP");
  });

  it("nepoznata vrednost NE ruši štampu nego pada na MP", () => {
    expect(parseKepValuation("XYZ")).toBe("MP");
    expect(parseKepValuation("maloprodaja")).toBe("MP");
  });

  it("oba principa imaju srpski naziv za obrazac", () => {
    expect(KEP_VALUATION_LABEL.MP).toContain("maloprodajna");
    expect(KEP_VALUATION_LABEL.VP).toContain("veleprodajna");
  });
});

describe("computeKepuEntries — red nosi OBA vrednovanja", () => {
  const doc = {
    id: 1,
    companyId: 0,
    kind: "IZ",
    documentTypeCode: "IFR",
    documentNumber: "125/27",
    warehouseId: 1,
    targetWarehouseId: null,
    documentDate: new Date("2027-03-15T00:00:00.000Z"),
  };

  const item = (retail: string, wholesale: string, qty = "2") => ({
    quantity: new D(qty),
    calculatedRetailPrice: new D(retail),
    actualRetailPrice: new D(0),
    calculatedWholesalePrice: new D(wholesale),
    actualWholesalePrice: new D(0),
  });

  it("razduženje se upisuje i po MP i po VP ceni, iz istog dokumenta", () => {
    // 2 kom: MP 120, VP 100 → MP 240, VP 200
    const entries = computeKepuEntries(doc, [item("120", "100")], []);

    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(new D(e.discharge as Prisma.Decimal).toFixed(2)).toBe("240.00");
    expect(new D(e.dischargeVp as Prisma.Decimal).toFixed(2)).toBe("200.00");
    // Smer je isti za oba principa — razlikuje se samo cena.
    expect(new D(e.charge as Prisma.Decimal).toFixed(2)).toBe("0.00");
    expect(new D(e.chargeVp as Prisma.Decimal).toFixed(2)).toBe("0.00");
  });

  it("zaduženje (ulaz) takođe nosi oba iznosa", () => {
    const entries = computeKepuEntries(
      { ...doc, kind: "UL", documentTypeCode: "UFROB" },
      [item("120", "100")],
      [],
    );

    const e = entries[0];
    expect(new D(e.charge as Prisma.Decimal).toFixed(2)).toBe("240.00");
    expect(new D(e.chargeVp as Prisma.Decimal).toFixed(2)).toBe("200.00");
  });

  it("stavka bez maloprodajne cene NE ispada iz knjige vođene po VP ceni", () => {
    // Regresija: ranije se red preskakao kad je MP vrednost nula, pa bi VP knjiga
    // tiho izgubila stavku koja ima samo veleprodajnu cenu.
    const samoVp = {
      quantity: new D("3"),
      calculatedRetailPrice: new D(0),
      actualRetailPrice: new D(0),
      calculatedWholesalePrice: new D("50"),
      actualWholesalePrice: new D(0),
    };

    const entries = computeKepuEntries(doc, [samoVp], []);

    expect(entries).toHaveLength(1);
    expect(new D(entries[0].dischargeVp as Prisma.Decimal).toFixed(2)).toBe("150.00");
  });

  it("dokument bez ijedne vrednosti se i dalje preskače", () => {
    const prazna = {
      quantity: new D("5"),
      calculatedRetailPrice: new D(0),
      actualRetailPrice: new D(0),
      calculatedWholesalePrice: new D(0),
      actualWholesalePrice: new D(0),
    };

    expect(computeKepuEntries(doc, [prazna], [])).toHaveLength(0);
  });
});
