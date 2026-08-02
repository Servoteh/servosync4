import { Prisma } from "@prisma/client";
import type { PrintAdvanceDeduction, PrintCtx, PrintLine } from "./ctx";
import {
  advanceTotal,
  assertExportWithoutVat,
  discountFromLines,
  lineDiscountAmount,
  payableAfterAdvance,
  printableAdvanceDeductions,
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
    // Podrazumevano STARA stavka (kolona `unit_price_before_discount` je novija od nje):
    // tako svaki test koji je ne postavi proverava REZERVNI put, obračun unazad.
    unitPriceBeforeDiscount: null,
    discountPercent: D("0"),
    lineTotal: D("100.00"),
    vatRatePercent: 20,
    ...over,
  };
}

describe("rabat iz cene PRE rabata (prvi izvor)", () => {
  /**
   * RUPA ZBOG KOJE JE KOLONA I UVEDENA: rabat od 100 %. Cena posle rabata je 0, pa
   * obračun unazad (`neto × p / (100 − p)`) deli nulom i daje 0 — papir je pokazivao
   * „R% 100" uz „Rabat: 0,00". Sa cenom pre rabata na stavci iznos je pun.
   */
  it("rabat 100 %: 10 kom × 1.000,00 daje rabat 10.000,00 (bruto 10.000,00)", () => {
    const osnovica = D("0");
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("0"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("100"),
        lineTotal: osnovica,
      }),
    );
    expect(rabat.toFixed(2)).toBe("10000.00");
    // Obrasci bruto računaju kao `osnovica + rabat`, pa invarijanta
    // „bruto − rabat = osnovica" stoji sama od sebe; ovde se proverava da je bruto
    // baš puna cena robe (10 × 1.000,00), a ne nula kao do sada.
    expect(osnovica.add(rabat).toFixed(2)).toBe("10000.00");
  });

  it("rabat 10 %: isti vektor daje isti iznos kao obračun unazad", () => {
    const withPrice = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(withPrice.toFixed(2)).toBe("1000.00");
    expect(withPrice.add(D("9000.00")).toFixed(2)).toBe("10000.00");
  });

  it("bez rabata je tačno 0,00 i kad je puna cena upisana", () => {
    // Kolona `R%` je prazna → red „Rabat" mora biti 0,00 bez zaokružne sitnine, pa se
    // oduzimanje uopšte ne izvodi. Bez te brane bi 3 × 33,3333 − 99,99 dalo „rabat" od
    // jedne pare na papiru koji rabat nema.
    const rabat = lineDiscountAmount(
      line({
        quantity: D("3"),
        unitPrice: D("33.3333"),
        unitPriceBeforeDiscount: D("33.3333"),
        discountPercent: D("0"),
        lineTotal: D("99.99"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("0.00");
  });

  it("protivrečna stavka (puna cena manja od neto) pada na rezervu, ne štampa minus", () => {
    // Negativan „Rabat" je greška vidljiva kupcu; bolje iznos iz obračuna unazad.
    const rabat = lineDiscountAmount(
      line({
        quantity: D("10"),
        unitPrice: D("900.00"),
        unitPriceBeforeDiscount: D("500.00"), // pokvaren podatak
        discountPercent: D("10"),
        lineTotal: D("9000.00"),
      }),
    );
    expect(rabat.toFixed(2)).toBe("1000.00");
  });
});

describe("rabat izveden iz cene POSLE rabata (rezerva za stare stavke)", () => {
  /**
   * Scenario koji je otkrio kvar: 10 kom × 1.000,00 uz rabat 10 %. U bazi stoji
   * `unitPrice = 900,00` i `lineTotal (vatBase) = 9.000,00`; stavka je starija od kolone
   * sa cenom pre rabata (`unitPriceBeforeDiscount = null`), pa se rabat vraća unazad.
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

  it("meša stare i nove stavke na istom papiru", () => {
    // Jedan račun ume da nosi i prepisanu (staru) i novu stavku — zbir mora biti tačan.
    const total = discountFromLines([
      line({
        quantity: D("10"),
        unitPriceBeforeDiscount: D("1000.00"),
        discountPercent: D("100"),
        lineTotal: D("0"),
      }), // 10.000,00 iz pune cene
      line({ lineTotal: D("9000.00"), discountPercent: D("10") }), // 1.000,00 unazad
    ]);
    expect(total.toFixed(2)).toBe("11000.00");
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
   * Stara stavka sa rabatom od 100 %: cena posle rabata je 0, a pune cene u bazi nema
   * ni u jednom obliku — iznos se ne može rekonstruisati. Bolje 0 nego deljenje nulom
   * ili izmišljen iznos (v. komentar u `totals.ts`).
   */
  it("rabat od 100 % bez pune cene ne obara štampu (vraća 0, ne beskonačno)", () => {
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

describe("odbijeni avansi (N:M primene)", () => {
  const ctx = (deductions: PrintAdvanceDeduction[]): PrintCtx =>
    ({ advanceDeductions: deductions }) as PrintCtx;

  it("zbir je zbir PRIKAZANIH primena, ne kolone sa dokumenta", () => {
    // Izmereni ulaz: račun 10.000,00 zatvara `A-1/26` (3.000) i `A-2/26` (2.000).
    const list = printableAdvanceDeductions(
      ctx([
        { documentNumber: "A-1/26", amount: D("3000.00") },
        { documentNumber: "A-2/26", amount: D("2000.00") },
      ]),
    );
    expect(list).toHaveLength(2);
    expect(advanceTotal(list).toFixed(2)).toBe("5000.00");
  });

  it("bez primena je nula (ne pada na kolonu i ne štampa red)", () => {
    expect(printableAdvanceDeductions(ctx([]))).toEqual([]);
    expect(advanceTotal([]).toFixed(2)).toBe("0.00");
  });

  /**
   * Primena na 0 (stornirana pa ponovo upisana, ručna ispravka) ne sme da proizvede red
   * „Umanjenje za primljeni avans (br. …): − 0,00" — kupac bi ga čitao kao postojeći
   * avans koji ništa ne umanjuje.
   */
  it("primena sa iznosom 0 ne ide na papir", () => {
    const list = printableAdvanceDeductions(
      ctx([
        { documentNumber: "A-1/26", amount: D("0") },
        { documentNumber: "A-2/26", amount: D("2000.00") },
      ]),
    );
    expect(list.map((d) => d.documentNumber)).toEqual(["A-2/26"]);
    expect(advanceTotal(list).toFixed(2)).toBe("2000.00");
  });
});

describe("brana: izvozni papir bez PDV-a", () => {
  const doc = (vatTotal: string) => ({
    documentNumber: "228/25",
    vatTotal: D(vatTotal),
  });

  it("propušta izvoz bez PDV-a", () => {
    expect(() => assertExportWithoutVat(doc("0"))).not.toThrow();
  });

  it("puca na dokument sa obračunatim PDV-om i imenuje ga", () => {
    expect(() => assertExportWithoutVat(doc("19872.73"))).toThrow(
      /Izvozna faktura 228\/25 nosi obračunat PDV 19,872\.73/,
    );
  });
});
