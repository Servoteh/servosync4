import { Prisma } from "@prisma/client";
import {
  formatAmount,
  formatDateDomestic,
  formatDateForeign,
  formatDeliveryDate,
  formatInvoiceNumber,
  formatWeight,
  formatWeightKg,
} from "./format";

/**
 * Test-vektori NISU izmišljeni: to su brojevi i datumi prepisani sa pet donetih BigBit
 * izlaza (`docs/zahtevi/fakture-obrasci-2026-08/`). Ako neki od ovih testova padne,
 * znači da bi papir izašao drugačiji nego kod kupca — to je greška, ne „promena formata".
 */
describe("štampa faktura — formatiranje", () => {
  describe("formatAmount — zarez za hiljade, tačka za decimale", () => {
    it.each([
      // [ulaz, očekivano, odakle sa papira]
      [99363.64, "99,363.64", "IFR 657/25 — osnovica"],
      [119236.37, "119,236.37", "IFR 657/25 — za uplatu"],
      [28080.0, "28,080.00", "IFUSL 653/25"],
      [10530.75, "10,530.75", "IFUSL 653/25"],
      [19872.73, "19,872.73", "IFR 657/25 — PDV 20%"],
    ])("%s → %s (%s)", (input, expected) => {
      expect(formatAmount(input)).toBe(expected);
    });

    it("radi nad Prisma.Decimal-om, bez prolaska kroz Number", () => {
      expect(formatAmount(new Prisma.Decimal("99363.64"))).toBe("99,363.64");
      // Vrednost koju binarni float ne ume tačno da predstavi — Decimal je čuva.
      expect(formatAmount(new Prisma.Decimal("1234567.005"))).toBe(
        "1,234,567.01",
      );
    });

    it("prima i string iz baze", () => {
      expect(formatAmount("119236.37")).toBe("119,236.37");
    });

    it("ne stavlja separator ispod hiljade", () => {
      expect(formatAmount(0)).toBe("0.00");
      expect(formatAmount(1)).toBe("1.00");
      expect(formatAmount(999.9)).toBe("999.90");
    });

    it("grupiše i milione", () => {
      expect(formatAmount(1000)).toBe("1,000.00");
      expect(formatAmount(1234567.89)).toBe("1,234,567.89");
      expect(formatAmount(1000000000)).toBe("1,000,000,000.00");
    });

    it("čuva predznak ispred grupisanog broja", () => {
      expect(formatAmount(-99363.64)).toBe("-99,363.64");
      expect(formatAmount(-1234.5)).toBe("-1,234.50");
    });

    it("zaokružuje na traženi broj decimala", () => {
      expect(formatAmount(2.345)).toBe("2.35");
      expect(formatAmount(2.344)).toBe("2.34");
    });

    it("kolona Količina koristi isti oblik sa tri decimale", () => {
      expect(formatAmount(1720, 3)).toBe("1,720.000");
      expect(formatAmount(2.5, 3)).toBe("2.500");
    });

    it("bez decimala ne ostavlja viseću tačku", () => {
      expect(formatAmount(99363.64, 0)).toBe("99,364");
    });
  });

  describe("formatWeight / formatWeightKg — OBRNUTI separatori", () => {
    it("kilaža sa ino usluge 060/26 ide tačka-hiljade, zarez-decimale", () => {
      expect(formatWeight(1720)).toBe("1.720,00");
      expect(formatWeight(1700)).toBe("1.700,00");
      expect(formatWeightKg(1720)).toBe("1.720,00 kg");
      expect(formatWeightKg(1700)).toBe("1.700,00 kg");
    });

    it("na istom papiru iznos i kilaža imaju suprotne separatore", () => {
      // Nije nedoslednost testa — tako je u originalu (STAMPA_IZLAZNIH_FAKTURA.md §5).
      expect(formatAmount(1720)).toBe("1,720.00");
      expect(formatWeight(1720)).toBe("1.720,00");
    });

    it("ispod hiljade nema separatora hiljada", () => {
      expect(formatWeight(20)).toBe("20,00");
      expect(formatWeightKg(20)).toBe("20,00 kg");
    });

    it("čuva predznak", () => {
      expect(formatWeight(-1720)).toBe("-1.720,00");
    });
  });

  describe("datumi", () => {
    it("domaći je DD-MM-YY (IFR 657/25: datum prometa 25-12-25)", () => {
      expect(formatDateDomestic(new Date(2025, 11, 25))).toBe("25-12-25");
    });

    it("ino je DD.MM.GGGG. sa tačkom na kraju (228/25: 25.04.2025.)", () => {
      expect(formatDateForeign(new Date(2025, 3, 25))).toBe("25.04.2025.");
    });

    it("Date of delivery na ino usluzi je opet DD-MM-YY (060/26: 06-03-26)", () => {
      expect(formatDeliveryDate(new Date(2026, 2, 6))).toBe("06-03-26");
    });

    it("dopunjava vodećom nulom i dan i mesec", () => {
      expect(formatDateDomestic(new Date(2026, 0, 1))).toBe("01-01-26");
      expect(formatDateForeign(new Date(2026, 0, 1))).toBe("01.01.2026.");
    });

    it("godina 2000-te ostaje dvocifreno 00", () => {
      expect(formatDateDomestic(new Date(2000, 8, 9))).toBe("09-09-00");
    });

    it("prazan datum daje prazan string, ne 'Invalid Date'", () => {
      expect(formatDateDomestic(null)).toBe("");
      expect(formatDateForeign(null)).toBe("");
      expect(formatDeliveryDate(undefined)).toBe("");
    });
  });

  describe("formatInvoiceNumber", () => {
    it("prikazuje broj onakav kakav u bazi i jeste (odluka O-F1)", () => {
      // O-F1: numeracija se menja u `numbering.service.ts` na BigBit oblik `657/25`,
      // pa papir, SEF i glavna knjiga nose ISTI broj — štampa ga ne prepravlja.
      expect(formatInvoiceNumber("657/25")).toBe("657/25");
      expect(formatInvoiceNumber("650/25")).toBe("650/25");
      expect(formatInvoiceNumber("060/26")).toBe("060/26");
    });

    it("ne pada na praznom broju", () => {
      expect(formatInvoiceNumber(null)).toBe("");
      expect(formatInvoiceNumber(undefined)).toBe("");
      expect(formatInvoiceNumber("  657/25  ")).toBe("657/25");
    });
  });
});
