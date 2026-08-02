import { Prisma } from "@prisma/client";
import { UnprocessableEntityException } from "@nestjs/common";
import { VAT_RATE_BY_CODE } from "../gl/posting/vat-rates";
import { documentVatTotals } from "./vat-totals";
import {
  buildSalesLedgerLines,
  assertTotalsMatchItems,
} from "./fakturisanje.service";
import { DocumentCarryOverService } from "./carry-over.service";

/**
 * PORESKE ŠIFRE (N1) I IZVOZNI RAČUN U GLAVNOJ KNJIZI (N2).
 * =============================================================================
 * Svi testovi ispod PADAJU NA KODU OD 02.08.2026. PRE OVE ISPRAVKE.
 *
 * N1 — mapa `VAT_RATE_BY_CODE` protivrečila je stvarnoj BigBit tabeli `R_Tarife`
 *      (`_legacy/BigbitRaznoNenad/_extracted/rule_tables/BB_T_26/R_Tarife.csv`).
 *      Efektivna stopa je ZBIR 5 kolona (`R_Tarife_ZbirnaStopa.sql`), a ne kolona
 *      „Osnovna" — i nije ono što piše u koloni `Opis`.
 *
 * N2 — izvozni račun nastao prepisom domaćeg predračuna zadužio je kupca u glavnoj
 *      knjizi NETO iznosom, dok su zaglavlje i saldakonti pokazivali BRUTO.
 */

const D = Prisma.Decimal;

// ─────────────────────────────────────────────────────────── N1 · ŠIFRE STOPA

describe("N1 · VAT_RATE_BY_CODE prati stvarne redove `R_Tarife`", () => {
  /**
   * Tabela je prepisana IZ CSV-a, ne iz koda — da bi test merio podatak, a ne sam
   * sebe. Kolona „stopa" je ZBIR (Osnovna+Zeleznica+Gradska+Ratna+Posebna), tačno
   * onako kako je definiše `R_Tarife_ZbirnaStopa.sql` i `PDVStopaZaTarifu()`.
   */
  const R_TARIFE: ReadonlyArray<[code: string, percent: string, grupa: string]> =
    [
      ["0", "0", "VANPDV"], // Roba od dobavljača van PDV-a
      ["1", "0", "BEZPDV"], // Roba i usluge bez poreza
      ["3", "20", "VISA"], // Roba i usluge 20% (od 01.10.2012)
      ["4", "10", "NIZA"], // Σ = Zeleznica 10 — `Opis` i dalje kaže „8%"!
      ["5", "8", "POLJO"], // Poljoprivrednici 8% (od 01.10.2012)
      ["6", "20", "VANPDV"], // Bezcarinska zona
    ];

  it.each(R_TARIFE)(
    "tarifa %s → %s%% (grupa %s)",
    (code, percent) => {
      const rate = VAT_RATE_BY_CODE[code];
      expect(rate).toBeDefined();
      expect(rate.mul(100).toFixed(0)).toBe(percent);
    },
  );

  /**
   * ⚠️ NAJVAŽNIJI TEST OVOG PAKETA — i jedini koji čuva od „popravke" unazad.
   * Kolona `Opis` tarife 4 glasi „Roba i usluge 8%", a numeričke kolone daju 10.
   * Ko veruje opisu, vrati 0,08 — što je i bilo u kodu. Zakon isto: snižena stopa
   * je 10 % od 01.01.2014 (VBA `F_PDV_NizaStopa` vraća 8 samo za datume pre toga),
   * a 8 % je PDV NADOKNADA POLJOPRIVREDNICIMA — tarifa 5, ne 4.
   */
  it("tarifa 4 je NIZA 10 %, a NE 8 % (kolona `Opis` laže)", () => {
    expect(VAT_RATE_BY_CODE["4"].toFixed(2)).toBe("0.10");
    expect(VAT_RATE_BY_CODE["5"].toFixed(2)).toBe("0.08");
  });

  it('tarifa 1 je BEZPDV (0 %), nije „alt kod" za osnovnu stopu', () => {
    // Na produkciji SVIH 92.575 artikala nosi `service_tax_rate_code = "1"`
    // (izmereno 02.08.2026) — pogrešnih 20 % ovde bi postalo novac čim se
    // „Tarifa usluga" uveže u obračun.
    expect(VAT_RATE_BY_CODE["1"].toFixed(2)).toBe("0.00");
  });

  it('šifra „2" ne postoji u `R_Tarife` — ne sme biti u mapi', () => {
    expect(VAT_RATE_BY_CODE["2"]).toBeUndefined();
    const totals = documentVatTotals([
      { vatRateCode: "2", vatBase: new D(1000) },
    ]);
    expect(totals.vatTotal.toFixed(2)).toBe("0.00");
  });

  it("istekle tarife (15, 18) nisu u mapi — mapa nema datumsku dimenziju", () => {
    // Važenje im je prestalo 30.09.2012. Glasan pad („Nepoznata šifra PDV stope"
    // u `advance-vat`) je bolji od tihih 18 % na dokumentu iz 2026.
    expect(VAT_RATE_BY_CODE["15"]).toBeUndefined();
    expect(VAT_RATE_BY_CODE["18"]).toBeUndefined();
  });

  it("mapa nema nijednu šifru koja nije u `R_Tarife`", () => {
    expect(Object.keys(VAT_RATE_BY_CODE).sort()).toEqual([
      "0",
      "1",
      "3",
      "4",
      "5",
      "6",
    ]);
  });
});

// ────────────────────────────────────── N2 · IZVOZ: ZAGLAVLJE ⟷ STAVKE ⟷ GK

/** Tačan vektor iz nalaza: domaći predračun 99.363,64 + 20 % = 119.236,37. */
const OSNOVICA = new D("99363.64");
const PDV = new D("19872.73");
const BRUTO = new D("119236.37");

type Row = Record<string, unknown>;

function proformaItem(over: Row = {}): Row {
  return {
    id: 100,
    lineNo: 1,
    itemId: 42,
    description: "Artikal",
    unit: "kom",
    quantity: new D(1),
    baseUnitPrice: OSNOVICA,
    unitPrice: OSNOVICA,
    unitPriceBeforeDiscount: null,
    discountPercent: new D(0),
    cashDiscountPercent: new D(0),
    vatRateCode: "3", // ← domaća šifra na predračunu
    vatBase: OSNOVICA,
    vatAmount: PDV,
    lineTotal: BRUTO,
    ...over,
  };
}

function makeDb(over: { invoice?: Row; items?: Row[] } = {}) {
  const proforma: Row = {
    id: 1,
    documentType: "PROF",
    documentNumber: "1/26",
    level: 250,
    isLocked: false,
    linkedInvoiceDocId: null,
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-08-01T00:00:00Z"),
    dueDate: null,
    currency: "RSD",
    exchangeRate: new D(1),
    accountingExchangeRate: new D(1),
    fxInvoiceValue: null,
    netTotal: OSNOVICA,
    vatTotal: PDV,
    grossTotal: BRUTO,
    isExport: false, // ← predračun je DOMAĆI
    poNumber: null,
    salespersonId: 3,
    paymentMethod: "VIRMAN",
    supplyDate: null,
    note: null,
    priceCoefficient: new D(1),
    priceCoefficientAppliedAt: null,
    priceCoefficientAppliedBy: null,
    ...over.invoice,
  };
  const items = over.items ?? [proformaItem()];

  const db = {
    invoice: {
      findUnique: jest.fn(() => Promise.resolve({ ...proforma, items })),
      create: jest.fn((args: { data: Row }) => {
        const data = args.data;
        const created = (
          (data.items as { create: Row[] } | undefined)?.create ?? []
        ).map((it, idx) => ({ id: 500 + idx, ...it }));
        return Promise.resolve({ id: 2, ...data, items: created });
      }),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((arg: unknown) =>
    (arg as (tx: unknown) => unknown)(db),
  );
  return db;
}

function carryOver(db: unknown) {
  return new DocumentCarryOverService(
    db as ConstructorParameters<typeof DocumentCarryOverService>[0],
  );
}

describe("N2 · prepis domaćeg predračuna u IZVOZNI račun", () => {
  it("stavke gube domaću poresku šifru (3 → 0)", async () => {
    const db = makeDb();
    const invoice = await carryOver(db).createInvoiceFromProforma(1, "IZVRO");

    // Na starom kodu je ovde ostajala „3" — izvozni dokument sa domaćim PDV-om.
    for (const it of invoice.items as Row[]) {
      expect(it.vatRateCode).toBe("0");
      expect((it.vatAmount as Prisma.Decimal).toFixed(2)).toBe("0.00");
      expect((it.lineTotal as Prisma.Decimal).toFixed(2)).toBe(
        OSNOVICA.toFixed(2),
      );
    }
  });

  it("zaglavlje se IZVODI iz stavki, ne prepisuje sa predračuna", async () => {
    const db = makeDb();
    const invoice = await carryOver(db).createInvoiceFromProforma(1, "IZVRO");

    // Staro: 99.363,64 + 19.872,73 = 119.236,37 (prepisano doslovno).
    expect((invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe("99363.64");
    expect((invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("0.00");
    expect((invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe("99363.64");
  });

  it("domaći cilj (IFR) ostaje netaknut — ista šifra, isti novac", async () => {
    const db = makeDb();
    const invoice = await carryOver(db).createInvoiceFromProforma(1, "IFR");

    expect((invoice.items as Row[])[0].vatRateCode).toBe("3");
    expect((invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe(
      BRUTO.toFixed(2),
    );
  });

  it("zaglavlje i glavna knjiga vide ISTI bruto (kupac 2050)", async () => {
    const db = makeDb();
    const invoice = await carryOver(db).createInvoiceFromProforma(1, "IZVRO");

    const lines = buildSalesLedgerLines(
      {
        documentType: "IZVRO",
        documentNumber: "1/26",
        customerId: 5,
        isExport: true,
      },
      (invoice.items as Row[]).map((it) => ({
        vatRateCode: it.vatRateCode as string,
        vatBase: it.vatBase as Prisma.Decimal,
      })),
    );

    const kupac = lines.find((l) => l.accountCode === "2050");
    expect(kupac).toBeDefined();
    // Staro: zaglavlje 119.236,37 ≠ dug 99.363,64 → razlika −19.872,73.
    expect(kupac!.debit.toFixed(2)).toBe(
      (invoice.grossTotal as Prisma.Decimal).toFixed(2),
    );
    // Izvoz nema PDV liniju (kategorija Z / čl. 24).
    expect(lines.some((l) => l.accountCode.startsWith("47"))).toBe(false);
  });
});

describe("N2 · brana pri knjiženju (`assertTotalsMatchItems`)", () => {
  const izvoznaFakturaSaDomacimPdv = {
    documentNumber: "657/26",
    isExport: true,
    netTotal: OSNOVICA,
    vatTotal: PDV,
    grossTotal: BRUTO,
    items: [{ vatRateCode: "3", vatBase: OSNOVICA }],
  };

  it("odbija izvozni račun koji nosi domaći PDV", () => {
    expect(() => assertTotalsMatchItems(izvoznaFakturaSaDomacimPdv)).toThrow(
      UnprocessableEntityException,
    );
  });

  it("poruka nosi OBA iznosa i objašnjenje za izvoz", () => {
    try {
      assertTotalsMatchItems(izvoznaFakturaSaDomacimPdv);
      throw new Error("brana nije reagovala");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("119236.37"); // zaglavlje
      expect(msg).toContain("99363.64"); // stavke
      expect(msg).toContain("izvozni");
    }
  });

  it("hvata i razilaženje koje nema veze sa izvozom (ručna izmena stavki)", () => {
    // Zaglavlje zaostalo za stavkama — npr. uvoz ili ispravka u bazi mimo
    // `recalcTotals`. Posledica je ista: kupčev dug ≠ iznos fakture.
    expect(() =>
      assertTotalsMatchItems({
        documentNumber: "658/26",
        isExport: false,
        netTotal: OSNOVICA,
        vatTotal: PDV,
        grossTotal: BRUTO,
        items: [{ vatRateCode: "3", vatBase: new D("50000.00") }],
      }),
    ).toThrow(UnprocessableEntityException);
  });

  it("propušta dokument čije se zaglavlje slaže sa stavkama", () => {
    expect(() =>
      assertTotalsMatchItems({
        documentNumber: "659/26",
        isExport: false,
        netTotal: OSNOVICA,
        vatTotal: PDV,
        grossTotal: BRUTO,
        items: [{ vatRateCode: "3", vatBase: OSNOVICA }],
      }),
    ).not.toThrow();

    expect(() =>
      assertTotalsMatchItems({
        documentNumber: "660/26",
        isExport: true,
        netTotal: OSNOVICA,
        vatTotal: new D(0),
        grossTotal: OSNOVICA,
        items: [{ vatRateCode: "0", vatBase: OSNOVICA }],
      }),
    ).not.toThrow();
  });
});
