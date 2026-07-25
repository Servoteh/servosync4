import { NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ThreeWayMatchService } from "./three-way-match.service";
import { PaymentPreparationService } from "../placanja/payment-preparation.service";
import type { MatchFindingCode } from "./dto/three-way-match.dto";

/**
 * 3-WAY MATCH — nalazi su UPOZORENJE, nikad blokada.
 *
 * Testovi pokrivaju: kodove odstupanja (količina/cena), tolerancije (2 % / 500 RSD),
 * uparivanje po artiklu i — ključno — dokaz da priprema plaćanja PROLAZI i kad
 * upozorenja postoje (nema `throw` na putu kreiranja naloga).
 *
 * Prisma je mockovana ručno (isti pristup kao robno.service.spec.ts — bez baze).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

// ─────────────────────────────────────────────────────────────── mock helperi

interface FakeOrderItem {
  id: number;
  lineNo: number;
  articleId: number | null;
  description?: string | null;
  unit?: string | null;
  orderedQuantity: Prisma.Decimal;
  receivedQuantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal | null;
}

interface FakeStockItem {
  itemId: number;
  quantity: Prisma.Decimal;
  invoicePrice: Prisma.Decimal;
}

interface FakeWorld {
  orderId?: number;
  orderNumber?: string;
  supplierId?: number;
  status?: string;
  items: FakeOrderItem[];
  /** Stavke robnog ulaza (primka = nosilac ulazne fakture). `null` = nema ulaza. */
  stockItems: FakeStockItem[] | null;
  stockDocumentNumber?: string;
  /** Status robnog ulaza; izostavljen = POSTED + kalkulisan (zavedena faktura). */
  stockDocumentStatus?: string;
  journalEntryId?: number | null;
  vatEntries?: Array<{
    id: number;
    documentNumber: string;
    vatBase: Prisma.Decimal;
    vatAmount: Prisma.Decimal;
    sourceJournalEntryId: number;
  }>;
}

/** Minimalni Prisma mock za `matchOrders` (4 upita). */
function makePrisma(world: FakeWorld) {
  const orderId = world.orderId ?? 1;
  const orderNumber = world.orderNumber ?? "0001/2026";
  const supplierId = world.supplierId ?? 555;
  const journalEntryId =
    world.journalEntryId === undefined ? 900 : world.journalEntryId;

  const orders = [
    {
      id: orderId,
      orderNumber,
      supplierId,
      status: world.status ?? "RECEIVED",
      currency: "RSD",
      orderedAt: new Date("2026-07-01T00:00:00.000Z"),
      items: world.items.map((it) => ({
        description: null,
        unit: null,
        ...it,
      })),
    },
  ];

  const stockDocs =
    world.stockItems === null
      ? []
      : [
          {
            id: 77,
            purchaseOrderId: orderId,
            documentNumber: world.stockDocumentNumber ?? "0012/2026",
            status: world.stockDocumentStatus ?? "POSTED",
            isCalculated: world.stockDocumentStatus === undefined,
            documentDate: new Date("2026-07-05T00:00:00.000Z"),
            journalEntryId,
            items: world.stockItems,
          },
        ];

  return {
    purchaseOrder: {
      findMany: jest.fn().mockResolvedValue(orders),
      count: jest.fn().mockResolvedValue(orders.length),
    },
    stockDocument: { findMany: jest.fn().mockResolvedValue(stockDocs) },
    vatLedgerEntry: {
      findMany: jest.fn().mockResolvedValue(world.vatEntries ?? []),
    },
    customer: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: supplierId, name: "Dobavljač d.o.o." }]),
    },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : Promise.resolve(arg),
    ),
  };
}

function makeService(world: FakeWorld) {
  const prisma = makePrisma(world);
  return {
    service: new ThreeWayMatchService(prisma as never),
    prisma,
  };
}

const codes = (findings: Array<{ code: MatchFindingCode }>) =>
  findings.map((f) => f.code);

// ─────────────────────────────────────────────────────────────── količinski nalazi

describe("ThreeWayMatchService — količinska odstupanja", () => {
  it("PO 100 kom / primljeno 100 / fakturisano 120 → QTY_OVER_RECEIPT (WARNING)", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          unit: "kom",
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(120), invoicePrice: D(1000) }],
    });

    const res = await service.matchOrder(1);
    const line = res.lines[0];

    expect(line.orderedQty).toBe("100.0000");
    expect(line.receivedQty).toBe("100.0000");
    expect(line.invoicedQty).toBe("120.0000");
    expect(codes(res.findings)).toEqual(["QTY_OVER_RECEIPT"]);
    expect(res.findings[0].level).toBe("WARNING");
    expect(res.findings[0].message).toContain(
      "fakturisano više nego primljeno",
    );
    expect(res.hasWarnings).toBe(true);
  });

  it("primljeno više nego fakturisano → QTY_UNDER_RECEIPT (INFO — faktura tek stiže)", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(80), invoicePrice: D(1000) }],
    });

    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["QTY_UNDER_RECEIPT"]);
    expect(res.findings[0].level).toBe("INFO");
    // INFO se ne broji kao upozorenje.
    expect(res.hasWarnings).toBe(false);
    expect(res.hasFindings).toBe(true);
  });

  it("primljeno više nego naručeno → QTY_OVER_ORDER (WARNING)", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(110),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(110), invoicePrice: D(1000) }],
    });

    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["QTY_OVER_ORDER"]);
    expect(res.findings[0].level).toBe("WARNING");
  });

  it("faktura bez prijema (primljeno 0, fakturisano 50) → NO_RECEIPT (WARNING)", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(50),
          receivedQuantity: D(0),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(50), invoicePrice: D(1000) }],
    });

    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["NO_RECEIPT"]);
    expect(res.findings[0].level).toBe("WARNING");
    expect(res.findings[0].message).toContain("bez evidentiranog prijema");
  });

  it("naručeno = primljeno = fakturisano, ista cena → nema nalaza", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(100), invoicePrice: D(1000) }],
    });

    const res = await service.matchOrder(1);
    expect(res.findings).toEqual([]);
    expect(res.hasFindings).toBe(false);
    expect(res.hasWarnings).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────── cenovna tolerancija

describe("ThreeWayMatchService — tolerancija cene (2 % I 500 RSD)", () => {
  const priceCase = (invoicePrice: number) =>
    makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [
        { itemId: 5, quantity: D(100), invoicePrice: D(invoicePrice) },
      ],
    });

  it("cena +1 % (1.010 umesto 1.000) → nema nalaza (unutar tolerancije)", async () => {
    const { service } = priceCase(1010);
    const res = await service.matchOrder(1);
    expect(res.findings).toEqual([]);
  });

  it("cena +5 % (1.050 umesto 1.000) → PRICE_VARIANCE (WARNING)", async () => {
    const { service } = priceCase(1050);
    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["PRICE_VARIANCE"]);
    expect(res.findings[0].level).toBe("WARNING");
    expect(res.findings[0].message).toContain("viša od naručene");
    expect(res.lines[0].invoicedUnitPrice).toBe("1050.0000");
  });

  it("cena +10 % ali sitan iznos (razlika 20 RSD < 500) → nema nalaza", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(10),
          receivedQuantity: D(10),
          unitPrice: D(20),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(10), invoicePrice: D(22) }],
    });
    const res = await service.matchOrder(1);
    expect(res.findings).toEqual([]);
  });

  it("cena niža od naručene preko tolerancije → PRICE_VARIANCE sa smerom niža", async () => {
    const { service } = priceCase(900);
    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["PRICE_VARIANCE"]);
    expect(res.findings[0].message).toContain("niža od naručene");
  });
});

// ─────────────────────────────────────────────────────────────── ostalo

describe("ThreeWayMatchService — uparivanje i pregled", () => {
  it("stavka bez artikla (usluga) se ne uparuje i ne daje nalaze", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: null,
          description: "Usluga montaže",
          orderedQuantity: D(1),
          receivedQuantity: D(0),
          unitPrice: D(50000),
        },
      ],
      stockItems: [],
    });

    const res = await service.matchOrder(1);
    expect(res.lines[0].matchable).toBe(false);
    expect(res.findings).toEqual([]);
    expect(res.totals.orderedAmount).toBe("50000.0000");
  });

  it("nepostojeća narudžbenica → 404 (jedini izuzetak servisa)", async () => {
    const prisma = makePrisma({ items: [], stockItems: null });
    prisma.purchaseOrder.findMany.mockResolvedValue([]);
    const service = new ThreeWayMatchService(prisma as never);
    await expect(service.matchOrder(999)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("KUF trag (ulazna faktura) se čita preko GL naloga robnog ulaza", async () => {
    const { service, prisma } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(100), invoicePrice: D(1000) }],
      journalEntryId: 900,
      vatEntries: [
        {
          id: 4001,
          documentNumber: "UF-123",
          vatBase: D(100000),
          vatAmount: D(20000),
          sourceJournalEntryId: 900,
        },
      ],
    });

    const res = await service.matchOrder(1);
    expect(prisma.vatLedgerEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          direction: "input",
          sourceJournalEntryId: { in: [900] },
        }) as unknown,
      }),
    );
    expect(res.vatLedger?.documentNumbers).toEqual(["UF-123"]);
    expect(res.vatLedger?.vatBase).toBe("100000.0000");
  });

  it("matchSummary vraća zbirni red sa kodovima i brojem upozorenja", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(120), invoicePrice: D(1000) }],
    });

    const res = await service.matchSummary({ onlyWithFindings: true });
    expect(res.data).toHaveLength(1);
    expect(res.data[0].codes).toEqual(["QTY_OVER_RECEIPT"]);
    expect(res.data[0].warningCount).toBe(1);
    expect(res.meta.withWarnings).toBe(1);
  });

  it("warningsForPayment bez filtera vraća prazno (nema punog skeniranja)", async () => {
    const { service } = makeService({ items: [], stockItems: null });
    await expect(service.warningsForPayment({})).resolves.toEqual([]);
  });

  it("warningsForPayment po komitentu nosi brojeve dokumenata za spajanje", async () => {
    const { service } = makeService({
      supplierId: 555,
      orderNumber: "0007/2026",
      stockDocumentNumber: "0012/2026",
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(120), invoicePrice: D(1000) }],
    });

    const warnings = await service.warningsForPayment({ partnerId: 555 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("QTY_OVER_RECEIPT");
    expect(warnings[0].documentNumbers).toEqual(
      expect.arrayContaining(["0007/2026", "0012/2026"]),
    );
  });
});

// ─────────────────────────────────────────────── regresije: review 25.07 (R7/H/I/J)

describe("ThreeWayMatchService — regresije (review 25.07)", () => {
  /**
   * H: dva praga u KONJUNKCIJI (>2 % I >500 RSD) gasila su ogromna odstupanja na skupim
   * stavkama — 1,5 mil RSD razlike na stavci od 100 mil je 1,5 %, dakle „u toleranciji".
   */
  it("H — krupno odstupanje ispod procentualnog praga se PRIJAVLJUJE", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1_000_000),
        },
      ],
      // +1,5 % po jedinici = 1.500.000 RSD razlike na stavci.
      stockItems: [{ itemId: 5, quantity: D(100), invoicePrice: D(1_015_000) }],
    });

    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["PRICE_VARIANCE"]);
    expect(res.findings[0].level).toBe("WARNING");
  });

  it("H — sitno odstupanje ispod oba praga i dalje ćuti", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(100), invoicePrice: D(1004) }],
    });
    const res = await service.matchOrder(1);
    expect(res.findings).toEqual([]);
  });

  /**
   * I: isti artikal na dve stavke po različitim cenama + savršen prijem davao je DVA
   * PRICE_VARIANCE upozorenja uz zbirno odstupanje 0,00 — jer se ponderisani prosek poredio
   * sa cenom pojedinačne stavke.
   */
  const sharedArticleWorld = (invoicedAmountLine2: number) => ({
    items: [
      {
        id: 10,
        lineNo: 1,
        articleId: 5,
        orderedQuantity: D(10),
        receivedQuantity: D(10),
        unitPrice: D(100),
      },
      {
        id: 11,
        lineNo: 2,
        articleId: 5,
        orderedQuantity: D(5),
        receivedQuantity: D(5),
        unitPrice: D(300),
      },
    ],
    stockItems: [
      { itemId: 5, quantity: D(10), invoicePrice: D(100) },
      { itemId: 5, quantity: D(5), invoicePrice: D(invoicedAmountLine2) },
    ],
  });

  it("I — deljeni artikal sa tačnim ukupnim iznosom NE daje lažna upozorenja", async () => {
    const { service } = makeService(sharedArticleWorld(300));
    const res = await service.matchOrder(1);
    expect(res.totals.varianceAmount).toBe("0.0000");
    expect(res.findings).toEqual([]);
  });

  it("I — stvarno zbirno odstupanje deljenog artikla se prijavljuje JEDNOM, na nivou dokumenta", async () => {
    const { service } = makeService(sharedArticleWorld(450));
    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["PRICE_VARIANCE"]);
    expect(res.findings[0].lineNo).toBeNull();
    expect(res.findings[0].message).toContain("poređenje je zbirno");
    // Po stavkama nema nijednog cenovnog nalaza.
    expect(res.lines.every((l) => l.findings.length === 0)).toBe(true);
  });

  /**
   * J: `carry-over.fromPurchaseOrder` pravi DRAFT primku iz NARUČENIH količina PRE prijema,
   * pa je `receivedQuantity = 0` tada normalno — a ne „faktura bez prijema".
   */
  it("J — DRAFT primka (pre prijema) ne daje NO_RECEIPT", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(50),
          receivedQuantity: D(0),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(50), invoicePrice: D(1000) }],
      stockDocumentStatus: "DRAFT",
    });
    const res = await service.matchOrder(1);
    expect(res.findings).toEqual([]);
  });

  it("J — proknjižen ulaz bez prijema i dalje daje NO_RECEIPT", async () => {
    const { service } = makeService({
      items: [
        {
          id: 10,
          lineNo: 1,
          articleId: 5,
          orderedQuantity: D(50),
          receivedQuantity: D(0),
          unitPrice: D(1000),
        },
      ],
      stockItems: [{ itemId: 5, quantity: D(50), invoicePrice: D(1000) }],
      stockDocumentStatus: "POSTED",
    });
    const res = await service.matchOrder(1);
    expect(codes(res.findings)).toEqual(["NO_RECEIPT"]);
  });
});

/**
 * R7: `onlyWithFindings` se primenjivao POSLE `skip/take`, a `meta.total` je brojao SVE
 * narudžbenice — strana je umela da bude prazna dok naredne imaju nalaza, a FE je računao
 * pogrešan broj strana.
 */
describe("ThreeWayMatchService.matchSummary — filter pre paginacije (R7)", () => {
  /** 10 narudžbenica; nalaz imaju samo poslednje tri (8, 9, 10). */
  function makeSummaryPrisma() {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const withFinding = new Set([8, 9, 10]);
    const orders = ids.map((id) => ({
      id,
      orderNumber: `PO-${id}`,
      supplierId: 555,
      status: "RECEIVED",
      currency: "RSD",
      orderedAt: new Date("2026-07-01T00:00:00.000Z"),
      items: [
        {
          id: id * 10,
          lineNo: 1,
          articleId: 5,
          description: null,
          unit: null,
          orderedQuantity: D(100),
          receivedQuantity: D(100),
          unitPrice: D(1000),
        },
      ],
    }));
    const docs = ids.map((id) => ({
      id: 1000 + id,
      purchaseOrderId: id,
      documentNumber: `UL-${id}`,
      status: "POSTED",
      isCalculated: true,
      documentDate: new Date("2026-07-05T00:00:00.000Z"),
      journalEntryId: null,
      items: [
        {
          itemId: 5,
          quantity: withFinding.has(id) ? D(120) : D(100),
          invoicePrice: D(1000),
        },
      ],
    }));

    return {
      purchaseOrder: {
        findMany: jest.fn(
          (args: {
            where?: { id?: { in: number[] } };
            skip?: number;
            take?: number;
          }) => {
            const idFilter = args.where?.id?.in;
            if (idFilter)
              return Promise.resolve(
                orders.filter((o) => idFilter.includes(o.id)),
              );
            const skip = args.skip ?? 0;
            const take = args.take ?? orders.length;
            return Promise.resolve(
              orders.slice(skip, skip + take).map((o) => ({ id: o.id })),
            );
          },
        ),
        count: jest.fn().mockResolvedValue(orders.length),
      },
      stockDocument: {
        findMany: jest.fn(
          (args: { where: { purchaseOrderId: { in: number[] } } }) =>
            Promise.resolve(
              docs.filter((d) =>
                args.where.purchaseOrderId.in.includes(d.purchaseOrderId),
              ),
            ),
        ),
      },
      vatLedgerEntry: { findMany: jest.fn().mockResolvedValue([]) },
      customer: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 555, name: "Dobavljač d.o.o." }]),
      },
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg) ? Promise.all(arg) : Promise.resolve(arg),
      ),
    };
  }

  it("prva strana nije prazna, a total je broj narudžbenica SA NALAZOM", async () => {
    const service = new ThreeWayMatchService(makeSummaryPrisma() as never);
    const res = await service.matchSummary({ onlyWithFindings: true, take: 2 });

    expect(res.data).toHaveLength(2); // ranije: 0 (prve dve nemaju nalaz)
    expect(res.data.every((r) => r.findingCount > 0)).toBe(true);
    expect(res.meta.total).toBe(3); // ranije: 10 → FE je crtao 5 strana
    expect(res.meta.returned).toBe(2);
  });

  it("druga strana nastavlja gde je prva stala (bez preskakanja i duplikata)", async () => {
    const service = new ThreeWayMatchService(makeSummaryPrisma() as never);
    const first = await service.matchSummary({
      onlyWithFindings: true,
      take: 2,
    });
    const second = await service.matchSummary({
      onlyWithFindings: true,
      take: 2,
      skip: 2,
    });
    expect(second.data).toHaveLength(1);
    expect(second.meta.total).toBe(3);
    const seen = [...first.data, ...second.data].map((r) => r.orderId);
    expect(new Set(seen).size).toBe(3);
  });

  it("bez filtera paginira baza (total = ukupan broj narudžbenica)", async () => {
    const service = new ThreeWayMatchService(makeSummaryPrisma() as never);
    const res = await service.matchSummary({ take: 2 });
    expect(res.data).toHaveLength(2);
    expect(res.meta.total).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────── NE BLOKIRA PLAĆANJE

describe("Priprema plaćanja PROLAZI i kad postoje 3-way match upozorenja", () => {
  /** Prisma mock za `PaymentPreparationService` (otvorene stavke + kreiranje naloga). */
  function makePaymentPrisma(created: Array<Record<string, unknown>>) {
    const tx = {
      paymentOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          const row = {
            id: created.length + 1,
            orderNumber: args.data.orderNumber,
            supplierId: args.data.supplierId,
            amount: args.data.amount as Prisma.Decimal,
            referenceNumberCredit: args.data.referenceNumberCredit ?? null,
            status: "CREATED",
          };
          created.push(row);
          return Promise.resolve(row);
        }),
      },
    };
    return {
      saldakontoAccount: {
        findMany: jest.fn().mockResolvedValue([{ account: "4330" }]),
      },
      ledgerEntry: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 5001,
            accountCode: "4330",
            analyticalCode: 555,
            documentNumber: null, // robni ulaz ne upisuje broj dokumenta u GK stavku
            debit: D(0),
            credit: D(120000),
            dueDate: new Date("2026-07-10T00:00:00.000Z"),
            currency: "RSD",
          },
        ]),
      },
      $transaction: jest.fn((arg: unknown) =>
        Array.isArray(arg)
          ? Promise.all(arg)
          : (arg as (t: unknown) => Promise<unknown>)(tx),
      ),
    };
  }

  /** 3-way match sa jednim WARNING nalazom za komitenta 555. */
  function makeWarningMatch() {
    return {
      warningsForPayment: jest.fn().mockResolvedValue([
        {
          code: "QTY_OVER_RECEIPT",
          level: "WARNING",
          message: "Fakturisano više nego primljeno.",
          orderId: 1,
          orderNumber: "0007/2026",
          supplierId: 555,
          lineNo: 1,
          documentNumbers: ["0007/2026", "0012/2026"],
        },
      ]),
    };
  }

  it("selectDue vraća upozorenja uz stavku (matchWarnings + hasMatchWarnings)", async () => {
    const prisma = makePaymentPrisma([]);
    const service = new PaymentPreparationService(
      prisma as never,
      makeWarningMatch() as never,
    );

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due).toHaveLength(1);
    expect(due[0].hasMatchWarnings).toBe(true);
    expect(due[0].matchWarnings[0].code).toBe("QTY_OVER_RECEIPT");
  });

  it("KREIRANJE NALOGA PROLAZI i sa upozorenjima (nema blokade)", async () => {
    const created: Array<Record<string, unknown>> = [];
    const prisma = makePaymentPrisma(created);
    const service = new PaymentPreparationService(
      prisma as never,
      makeWarningMatch() as never,
    );

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due[0].hasMatchWarnings).toBe(true);

    // Ista stavka — sa upozorenjem — ide u nalog za plaćanje. Mora da PROĐE.
    const result = await service.createPaymentOrders(
      {
        seriesNumber: "V-1",
        lines: [
          {
            supplierId: due[0].supplierId as number,
            amount: Number(due[0].openAmount),
            documentNumber: "0007/2026",
            sourceLedgerEntryId: due[0].sourceLedgerEntryId,
            currency: "RSD",
          },
        ],
      },
      42,
    );

    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("CREATED");
    expect(created).toHaveLength(1);
  });

  it("zbirni pregled javlja upozorenja, ali ih ne pretvara u grešku", async () => {
    const prisma = makePaymentPrisma([]);
    const service = new PaymentPreparationService(
      prisma as never,
      makeWarningMatch() as never,
    );

    const res = await service.selectDueWithWarnings(
      new Date("2026-07-25T00:00:00.000Z"),
    );
    expect(res.meta.hasMatchWarnings).toBe(true);
    expect(res.meta.warningCount).toBe(1);
    expect(res.data).toHaveLength(1);
  });

  it("bez modula nabavke priprema radi identično (upozorenja prazna)", async () => {
    const prisma = makePaymentPrisma([]);
    const service = new PaymentPreparationService(prisma as never);

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due[0].matchWarnings).toEqual([]);
    expect(due[0].hasMatchWarnings).toBe(false);
  });

  /**
   * R4: ekran „priprema plaćanja" je zvao `warningsForPayment` u SERIJSKOJ petlji, jednom po
   * komitentu (do 25 poziva × do 5 upita ≈ 126 upita / ~8 s). Sada ide JEDAN batch poziv.
   */
  it("R4 — upozorenja za 25 komitenata idu jednim batch pozivom (nema N+1)", async () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      id: 6000 + i,
      accountCode: "4330",
      analyticalCode: 900 + i, // 25 različitih komitenata
      documentNumber: null, // bez broja dokumenta → spajanje po komitentu
      debit: D(0),
      credit: D(1000 + i),
      dueDate: new Date("2026-07-10T00:00:00.000Z"),
      currency: "RSD",
    }));
    const prisma = {
      saldakontoAccount: {
        findMany: jest.fn().mockResolvedValue([{ account: "4330" }]),
      },
      ledgerEntry: { findMany: jest.fn().mockResolvedValue(entries) },
      $transaction: jest.fn(),
    };
    const warningsForPayment = jest.fn().mockResolvedValue([]);
    const service = new PaymentPreparationService(
      prisma as never,
      {
        warningsForPayment,
      } as never,
    );

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due).toHaveLength(25);
    expect(warningsForPayment).toHaveBeenCalledTimes(1);
    const calls = warningsForPayment.mock.calls as unknown as Array<
      [{ partnerIds?: number[] }]
    >;
    expect(calls[0][0].partnerIds).toHaveLength(25);
  });

  it("R4/K — stavka bez broja dokumenta uzima samo WARNING nalaze, i to ograničen broj", async () => {
    const prisma = makePaymentPrisma([]);
    const many = Array.from({ length: 40 }, (_, i) => ({
      code: "QTY_UNDER_RECEIPT",
      level: i < 3 ? "WARNING" : "INFO",
      message: "…",
      orderId: i + 1,
      orderNumber: `PO-${i + 1}`,
      supplierId: 555,
      lineNo: 1,
      documentNumbers: [`PO-${i + 1}`],
    }));
    const service = new PaymentPreparationService(
      prisma as never,
      {
        warningsForPayment: jest.fn().mockResolvedValue(many),
      } as never,
    );

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due[0].matchWarnings).toHaveLength(3); // 37 INFO poruka je odsečeno
    expect(due[0].matchWarnings.every((w) => w.level === "WARNING")).toBe(true);
  });

  it("pad 3-way match sloja NE obara pripremu plaćanja", async () => {
    const prisma = makePaymentPrisma([]);
    const broken = {
      warningsForPayment: jest
        .fn()
        .mockRejectedValue(new Error("baza nedostupna")),
    };
    const service = new PaymentPreparationService(
      prisma as never,
      broken as never,
    );

    const due = await service.selectDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(due).toHaveLength(1);
    expect(due[0].matchWarnings).toEqual([]);
  });
});
