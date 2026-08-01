import { Prisma } from "@prisma/client";
import { amountInWords, fmtDate, fmtMoney, fmtQty } from "./doc-format";

/**
 * Formatiranje na štampi — jedini izvor za sve PDF-ove modula. Testira se ono što
 * knjigovođa gleda: razdelnik hiljada, decimalni zarez, srpski datum i „slovima".
 */
describe("doc-format", () => {
  describe("fmtMoney", () => {
    it("grupiše hiljade tačkom i decimale odvaja zarezom", () => {
      expect(fmtMoney(new Prisma.Decimal("1234567.89"))).toBe("1.234.567,89");
      expect(fmtMoney(new Prisma.Decimal("999.5"))).toBe("999,50");
      expect(fmtMoney(new Prisma.Decimal("1000"))).toBe("1.000,00");
    });

    it("čuva znak i preciznost Decimal-a (bez Float aritmetike)", () => {
      expect(fmtMoney(new Prisma.Decimal("-12345.675"), 2)).toBe("-12.345,68");
      expect(fmtMoney("0")).toBe("0,00");
    });

    it("neispravan ulaz ne obara štampu", () => {
      expect(fmtMoney(null)).toBe("0,00");
      expect(fmtMoney(undefined)).toBe("0,00");
    });
  });

  it("fmtQty podrazumevano daje 3 decimale", () => {
    expect(fmtQty(new Prisma.Decimal("48.5"))).toBe("48,5");
    expect(fmtQty(new Prisma.Decimal("1234.125"))).toBe("1.234,125");
  });

  it("fmtDate daje dd.MM.yyyy.", () => {
    expect(fmtDate(new Date(2026, 6, 5))).toBe("05.07.2026.");
    expect(fmtDate(null)).toBe("");
  });

  describe("amountInWords", () => {
    it("piše iznos slovima sa dinarima i lomljenim delom", () => {
      expect(amountInWords(new Prisma.Decimal("1234.56"))).toBe(
        "hiljadu dvesta trideset četiri dinara i 56/100",
      );
      expect(amountInWords(new Prisma.Decimal("1.00"))).toBe(
        "jedan dinar i 00/100",
      );
      expect(amountInWords(new Prisma.Decimal("0"))).toBe(
        "nula dinara i 00/100",
      );
    });

    it("poštuje rod grupa (hiljade ženski, milioni muški)", () => {
      expect(amountInWords(new Prisma.Decimal("2000"))).toContain(
        "dve hiljade",
      );
      expect(amountInWords(new Prisma.Decimal("2000000"))).toContain(
        "dva miliona",
      );
    });

    it("strana valuta se ispisuje oznakom, ne „dinara“", () => {
      expect(amountInWords(new Prisma.Decimal("10.00"), "EUR")).toBe(
        "deset EUR i 00/100",
      );
    });
  });
});
