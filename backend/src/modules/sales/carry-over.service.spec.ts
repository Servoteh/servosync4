import { Prisma } from "@prisma/client";
import { DocumentCarryOverService } from "./carry-over.service";

/**
 * PREPIS PREDRAČUN → RAČUN: DVE RAZMERE CENE U ISTOJ STAVCI.
 * ===========================================================================
 * NALAZ ADVERSARNOG PREGLEDA 02.08.2026 (NOVO-B). Stavka nosi cene na DVA nivoa:
 *
 *   • PRE koeficijenta ....... `baseUnitPrice`, `unitPriceBeforeDiscount`
 *   • POSLE koeficijenta ..... `unitPrice`, `vatBase`, `vatAmount`, `lineTotal`
 *
 * Prepis kopira obe kolone doslovno, ali koeficijent dokumenta nije prenosio — cilj
 * je padao na `@default(1)` i dve razmere su se našle u istom redu. Testovi ispod su
 * pisani tako da NA STAROM KODU PADAJU.
 *
 * IZMEREN VEKTOR: predračun sa koeficijentom 0,5, cena 1.000, rabat 10 %, 1 kom →
 * `unitPriceBeforeDiscount = 1.000`, `baseUnitPrice = 900`, `unitPrice = 450`,
 * `vatBase = 450`. Papir je posle prepisa tvrdio „R% 10" i „Rabat: 550,00" nad
 * osnovicom 450 — stvarno odobren rabat je 50,00.
 */

const D = Prisma.Decimal;

type Row = Record<string, unknown>;

/** Stavka izvornog predračuna — tačno izmeren vektor iz nalaza. */
function proformaItem(over: Row = {}): Row {
  return {
    id: 100,
    lineNo: 1,
    itemId: 42,
    description: "Artikal",
    unit: "kom",
    quantity: new D(1),
    // 900 × 0,5 = 450 — bazna cena je POSLE rabata, PRE koeficijenta.
    baseUnitPrice: new D(900),
    unitPrice: new D(450),
    // Puna cena je takođe PRE koeficijenta (štampa je množi koeficijentom dokumenta).
    unitPriceBeforeDiscount: new D(1000),
    discountPercent: new D(10),
    cashDiscountPercent: new D(0),
    vatRateCode: "3",
    vatBase: new D(450),
    vatAmount: new D(90),
    lineTotal: new D(540),
    ...over,
  };
}

function makeDb(over: { invoice?: Row; items?: Row[] } = {}) {
  const proforma: Row = {
    id: 1,
    documentType: "PROF",
    documentNumber: "1/26",
    level: 250,
    status: "DRAFT",
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
    netTotal: new D(450),
    vatTotal: new D(90),
    grossTotal: new D(540),
    isExport: false,
    poNumber: null,
    salespersonId: 3,
    paymentMethod: "VIRMAN",
    supplyDate: null,
    note: null,
    // Koeficijent 0,5 primenjen na predračunu (masovna akcija §8/O1).
    priceCoefficient: new D("0.5"),
    priceCoefficientAppliedAt: new Date("2026-08-01T09:00:00Z"),
    priceCoefficientAppliedBy: 7,
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
        ).map((it, idx) => ({
          id: 500 + idx,
          // `unit_price_before_discount` je opciona kolona (NULL za stavke starije od nje).
          unitPriceBeforeDiscount: null,
          ...it,
        }));
        return Promise.resolve({
          id: 2,
          // ⚠️ PODRAZUMEVANE VREDNOSTI ŠEME se simuliraju NAMERNO: `price_coefficient`
          // je `NOT NULL DEFAULT 1` (schema.prisma). Bez toga bi izostavljena kolona
          // ovde bila `undefined` i test bi pao na TypeError umesto da izmeri stvarno
          // ponašanje starog koda (koeficijent 1 → rabat 550,00 na papiru).
          priceCoefficient: new D(1),
          priceCoefficientAppliedAt: null,
          priceCoefficientAppliedBy: null,
          ...data,
          items: created,
        });
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

function service(db: unknown) {
  return new DocumentCarryOverService(
    db as ConstructorParameters<typeof DocumentCarryOverService>[0],
  );
}

/**
 * Isti račun koji obrazac radi u `print/templates/totals.ts` (izvor 1 — puna cena
 * sa stavke). Namerno prepisan ovde, a ne uvezen: test meri STANJE koje prepis
 * ostavlja u bazi, pa mora da padne i ako se štampa u međuvremenu promeni.
 */
function printDiscount(item: Row, coefficient: Prisma.Decimal) {
  const gross = (item.quantity as Prisma.Decimal).mul(
    (item.unitPriceBeforeDiscount as Prisma.Decimal).mul(coefficient),
  );
  return { gross, discount: gross.sub(item.vatBase as Prisma.Decimal) };
}

describe("DocumentCarryOverService — koeficijent cene preživljava prepis", () => {
  it("SCENARIO 0,5 / 1.000 / rabat 10 % → račun nosi isti koeficijent kao predračun", async () => {
    const db = makeDb();
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");

    // Na starom kodu je ovde stajala podrazumevana 1 i papir je lagao za 500 dinara.
    expect((invoice.priceCoefficient as Prisma.Decimal).toFixed(4)).toBe(
      "0.5000",
    );
  });

  it("posle prepisa važi `bruto − rabat = osnovica`, a R% odgovara stvarnom rabatu", async () => {
    const db = makeDb();
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");
    const line = (invoice.items as Row[])[0];

    const { gross, discount } = printDiscount(
      line,
      invoice.priceCoefficient as Prisma.Decimal,
    );

    expect(gross.toFixed(2)).toBe("500.00"); // 1 kom × 1.000 × 0,5
    expect(discount.toFixed(2)).toBe("50.00"); // stvarno odobren rabat, ne 550,00
    // Invarijanta obrasca: bruto − rabat = osnovica (`vatBase`).
    expect(gross.sub(discount).toFixed(2)).toBe(
      (line.vatBase as Prisma.Decimal).toFixed(2),
    );
    // Kolona „R%" mora da opisuje BAŠ taj odnos: 50 / 500 = 10 %.
    expect(discount.div(gross).mul(100).toFixed(2)).toBe(
      (line.discountPercent as Prisma.Decimal).toFixed(2),
    );
  });

  it("na cilju važi `unitPrice = baseUnitPrice × koeficijent` (prva izmena ne diže cenu)", async () => {
    const db = makeDb();
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");
    const line = (invoice.items as Row[])[0];

    // `SalesService.updateItem` (grana bez preračuna cene) izvodi cenu upravo ovako.
    // Sa koeficijentom 1 na cilju bi ispravka količine podigla cenu sa 450 na 900.
    const derived = (line.baseUnitPrice as Prisma.Decimal).mul(
      invoice.priceCoefficient as Prisma.Decimal,
    );
    expect(derived.toFixed(2)).toBe(
      (line.unitPrice as Prisma.Decimal).toFixed(2),
    );
    expect(derived.toFixed(2)).toBe("450.00");
  });

  it("prepis ne dira nijedan iznos — novac je identičan izvoru", async () => {
    const db = makeDb();
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");
    const line = (invoice.items as Row[])[0];

    expect((invoice.netTotal as Prisma.Decimal).toFixed(2)).toBe("450.00");
    expect((invoice.vatTotal as Prisma.Decimal).toFixed(2)).toBe("90.00");
    expect((invoice.grossTotal as Prisma.Decimal).toFixed(2)).toBe("540.00");
    expect((line.vatBase as Prisma.Decimal).toFixed(2)).toBe("450.00");
    expect((line.unitPriceBeforeDiscount as Prisma.Decimal).toFixed(2)).toBe(
      "1000.00",
    );
  });

  it("audit primene koeficijenta ide uz vrednost (ko je i kada odobrio korekciju)", async () => {
    const db = makeDb();
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");

    expect(invoice.priceCoefficientAppliedBy).toBe(7);
    expect(invoice.priceCoefficientAppliedAt).toEqual(
      new Date("2026-08-01T09:00:00Z"),
    );
  });

  it("predračun bez koeficijenta (1) daje račun sa 1 — nema regresije", async () => {
    const db = makeDb({
      invoice: {
        priceCoefficient: new D(1),
        priceCoefficientAppliedAt: null,
        priceCoefficientAppliedBy: null,
      },
      items: [
        proformaItem({
          baseUnitPrice: new D(900),
          unitPrice: new D(900),
          vatBase: new D(900),
          vatAmount: new D(180),
          lineTotal: new D(1080),
        }),
      ],
    });
    const invoice = await service(db).createInvoiceFromProforma(1, "IFR");
    const line = (invoice.items as Row[])[0];

    expect((invoice.priceCoefficient as Prisma.Decimal).toFixed(4)).toBe(
      "1.0000",
    );
    const { gross, discount } = printDiscount(
      line,
      invoice.priceCoefficient as Prisma.Decimal,
    );
    expect(gross.toFixed(2)).toBe("1000.00");
    expect(discount.toFixed(2)).toBe("100.00"); // 10 % od 1.000
  });
});
