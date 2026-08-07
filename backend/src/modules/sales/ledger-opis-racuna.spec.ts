/**
 * OPIS REDA NALOGA NA RUČNOJ GRANI (`buildSalesLedgerLines`).
 * =============================================================================
 * Ručna grana (račun bez vezanog robnog izlaza — IFUSL i svaki račun kome izdatnica nije
 * proknjižena) je jedina koja je opis uopšte pisala, ali PO KONTU: `Kupac 243/26`,
 * `Prihod 243/26`, `PDV 20% 243/26`. To je bilo:
 *
 *   • drugačije od robne grane (koja je od 07.08.2026. pisala prazno) — dve grane, dva
 *     opisa za isti posao, tačno obrazac koji se u ovom repou već četiri puta razišao;
 *   • drugačije od BigBita — izmereno: 131 od 132 grupe „nalog + dokument" u uvezenoj
 *     knjizi ima ISTI opis na SVIM kontima;
 *   • bez ijedne nove informacije — broj računa već stoji u koloni `document_number` na
 *     istom redu (`openItemFields`), a uloga konta se vidi iz samog konta.
 *
 * Od 07.08.2026. obe grane zovu `ledgerDescription` iz `gl/posting/ledger-line.ts`.
 */
import { Prisma } from "@prisma/client";
import { buildSalesLedgerLines } from "./fakturisanje.service";
import type { ServiceRevenueTypeRef } from "./service-revenue-type";

const D = (v: string) => new Prisma.Decimal(v);

function invoice(over: Record<string, unknown> = {}) {
  return {
    documentType: "IFR",
    documentNumber: "243/26",
    customerId: 11568,
    isExport: false,
    customerName: "FMB d.o.o.",
    serviceRevenueType: null as ServiceRevenueTypeRef | null,
    ...over,
  };
}

describe("buildSalesLedgerLines — opis je isti na svim redovima", () => {
  it("🔴 kupac, prihod i PDV nose ISTI opis (vrsta + broj + komitent)", () => {
    const lines = buildSalesLedgerLines(invoice(), [
      { vatRateCode: "3", vatBase: D("10000.00") },
    ]);

    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6040", "4702"]);
    for (const l of lines) {
      expect(l.description).toBe("IFR 243/26 · FMB d.o.o.");
    }
  });

  it("bez naziva komitenta (šifarnik ćuti) opis je vrsta + broj, nikad prazan", () => {
    const lines = buildSalesLedgerLines(
      invoice({ customerName: null, documentType: "IFUSL" }),
      [{ vatRateCode: "3", vatBase: D("10000.00") }],
    );

    for (const l of lines) {
      expect(l.description).toBe("IFUSL 243/26");
    }
  });

  it("izvozni račun (bez PDV reda) nosi isti opis na obe linije", () => {
    const lines = buildSalesLedgerLines(
      invoice({ documentType: "IZVRO", isExport: true }),
      [{ vatRateCode: "1", vatBase: D("10000.00") }],
    );

    // Konta su ZATEČENA (2050 kupac u inostranstvu, 6040 prihod od robe) — ovaj test ih
    // samo zaključava da se ne bi pomerila uz izmenu opisa.
    expect(lines.map((l) => l.accountCode)).toEqual(["2050", "6040"]);
    for (const l of lines) {
      expect(l.description).toBe("IZVRO 243/26 · FMB d.o.o.");
    }
  });

  it("iznosi i konta ostaju nedirnuti kad se opis promeni (regresija)", () => {
    const lines = buildSalesLedgerLines(invoice(), [
      { vatRateCode: "3", vatBase: D("10000.00") },
    ]);

    expect(
      lines.map((l) => [
        l.accountCode,
        l.debit.toFixed(2),
        l.credit.toFixed(2),
        l.analyticalCode,
      ]),
    ).toEqual([
      ["2040", "12000.00", "0.00", 11568],
      ["6040", "0.00", "10000.00", null],
      ["4702", "0.00", "2000.00", null],
    ]);
  });
});
