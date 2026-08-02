import { Prisma } from "@prisma/client";
import type { InvoiceWithItems, PrintCtx, PrintLine } from "./ctx";
import {
  assertExportWithoutVat,
  discountFromLines,
  lineDiscountAmount,
  payableAfterAdvance,
} from "./totals";

/**
 * Aritmetika zbirnog bloka — ono što je zajedničko svim obrascima.
 *
 * Obrasci imaju svoje testove nad papirom; ovde su GRANIČNI slučajevi do kojih se kroz
 * papir teško dolazi (rabat 100 %, preplata, protivrečan dokument), da bi ostali
 * zapisani na jednom mestu umesto da se ponavljaju u četiri spec fajla.
 */

const D = (v: string) => new Prisma.Decimal(v);

function line(over: Partial<PrintLine> = {}): PrintLine {
  return {
    ordinal: 1,
    catalogNumber: null,
    name: "Stavka",
    unit: "kom",
    customsTariff: null,
    quantity: D("1"),
    unitPrice: D("100.00"),
    discountPercent: D("0"),
    lineTotal: D("100.00"),
    vatRatePercent: 20,
    ...over,
  };
}

describe("rabat izveden iz cene POSLE rabata", () => {
  /**
   * Scenario koji je otkrio kvar: 10 kom × 1.000,00 uz rabat 10 %. U bazi stoji
   * `unitPrice = 900,00` i `lineTotal (vatBase) = 9.000,00`; rabat se vraća unazad.
   */
  it("9.000,00 uz 10 % daje rabat 1.000,00 (bruto 10.000,00)", () => {
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("1000.00");
    expect(rabat.add(D("9000.00")).toFixed(2)).toBe("10000.00");
  });

  it("bez rabata je tačno nula — ne para gore ni dole", () => {
    // Da red „Rabat: 0.00" ostane 0.00, zaokruživanje ne sme da proizvede sitninu.
    expect(discountFromLines([line(), line({ lineTotal: D("33.33") })]).toFixed(2)).toBe(
      "0.00",
    );
  });

  it("sabira rabat po stavkama, i kad ga nemaju sve", () => {
    const total = discountFromLines([
      line({ lineTotal: D("9000.00"), discountPercent: D("10") }), // 1.000,00
      line({ lineTotal: D("1000.00"), discountPercent: D("0") }), // 0
    ]);
    expect(total.toFixed(2)).toBe("1000.00");
  });

  it("zaokružuje po stavci na dve decimale, kao i štampa", () => {
    // 100 × 3 / 97 = 3,0927835… → 3,09
    expect(
      lineDiscountAmount(
        line({ lineTotal: D("100.00"), discountPercent: D("3") }),
      ).toFixed(2),
    ).toBe("3.09");
  });

  /**
   * Rabat od 100 % se NE MOŽE izvesti: cena posle rabata je 0, pa u podacima koji stižu
   * do štampe (`PrintLine`) nema nijednog traga cene pre rabata. Bolje 0 nego deljenje
   * nulom ili izmišljen iznos — v. komentar u `totals.ts`.
   */
  it("rabat od 100 % ne obara štampu (vraća 0, ne beskonačno)", () => {
    const rabat = lineDiscountAmount(
      line({ unitPrice: D("0"), discountPercent: D("100"), lineTotal: D("0") }),
    );
    expect(rabat.toFixed(2)).toBe("0.00");
  });

  it("negativan rabat se ignoriše", () => {
    expect(
      lineDiscountAmount(line({ discountPercent: D("-5") })).toFixed(2),
    ).toBe("0.00");
  });
});

describe("iznos za uplatu posle avansa", () => {
  it("umanjuje za primljeni avans", () => {
    expect(payableAfterAdvance(D("10000.00"), D("3000.00")).toFixed(2)).toBe(
      "7000.00",
    );
  });

  it("avans veći od računa daje nulu, nikad minus", () => {
    // Preplata se rešava odobrenjem, ne negativnim iznosom na fakturi.
    expect(payableAfterAdvance(D("10000.00"), D("12000.00")).toFixed(2)).toBe(
      "0.00",
    );
  });
});

describe("brana: izvozni papir bez PDV-a", () => {
  const ctx = (vatTotal: string): PrintCtx =>
    ({
      invoice: {
        documentNumber: "228/25",
        vatTotal: D(vatTotal),
      } as unknown as InvoiceWithItems,
    }) as PrintCtx;

  it("propušta izvoz bez PDV-a", () => {
    expect(() => assertExportWithoutVat(ctx("0"))).not.toThrow();
  });

  it("puca na dokument sa obračunatim PDV-om i imenuje ga", () => {
    expect(() => assertExportWithoutVat(ctx("19872.73"))).toThrow(
      /Izvozna faktura 228\/25 nosi obračunat PDV 19,872\.73/,
    );
  });
});
