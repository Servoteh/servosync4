import { Prisma } from "@prisma/client";
import { accountGroups, fmtAmount } from "./statement-pdf.service";

/**
 * Jedinice štampe završnog računa. Pokrivene su dve tačke u kojima štampa može tiho
 * da slaže brojku ili kolonu obrasca:
 *   1. kolona „Grupa računa, račun" se IZVODI iz GKEval formule (nema je u modelu),
 *   2. iznosi se svode na hiljade dinara, jer se obrazac tako predaje.
 */
describe("statement-pdf helpers", () => {
  describe("accountGroups (kolona „Grupa računa, račun“)", () => {
    it("izvlači maske konta iz D/P/PSD/PSP prefiksa, bez duplikata", () => {
      expect(accountGroups("D011*-P011*+D012*-P012*+D014*-P014*")).toBe(
        "011, 012 i 014",
      );
    });

    it("hvata i početno stanje (PSD/PSP)", () => {
      expect(accountGroups("PSD01*+D01*-PSD019*-D019*")).toBe("01 i 019");
    });

    it("zbirne pozicije (A-reference) nemaju konta — kolona ostaje prazna", () => {
      expect(accountGroups("A0003+A0009+A0017+A0018+A0028")).toBe("");
    });

    it("MANUAL i prazna formula daju prazno", () => {
      expect(accountGroups("MANUAL")).toBe("");
      expect(accountGroups(null)).toBe("");
    });

    it("skraćuje predugačku listu umesto da razbije kolonu", () => {
      expect(accountGroups("D10*+D11*+D12*+D13*+D14*+D15*")).toBe(
        "10, 11, 12 i 13 …",
      );
    });
  });

  describe("fmtAmount", () => {
    it("hiljade: deli sa 1.000, zaokružuje i grupiše tačkom", () => {
      expect(fmtAmount(new Prisma.Decimal("868293456.78"), "hiljade")).toBe(
        "868.293",
      );
    });

    it("hiljade: HALF_UP zaokruženje (500 din → 1 hiljada)", () => {
      expect(fmtAmount(new Prisma.Decimal("1500"), "hiljade")).toBe("2");
      expect(fmtAmount(new Prisma.Decimal("1499"), "hiljade")).toBe("1");
    });

    it("dinari: dve decimale sa zarezom i tačkom za hiljade", () => {
      expect(fmtAmount(new Prisma.Decimal("1234567.8"), "dinari")).toBe(
        "1.234.567,80",
      );
    });

    it("negativan iznos zadržava znak ispred grupisanja", () => {
      expect(fmtAmount(new Prisma.Decimal("-1234567.89"), "dinari")).toBe(
        "-1.234.567,89",
      );
    });

    it("nula se štampa kao 0, ne kao prazno", () => {
      expect(fmtAmount(new Prisma.Decimal(0), "hiljade")).toBe("0");
      expect(fmtAmount(new Prisma.Decimal(0), "dinari")).toBe("0,00");
    });
  });
});
