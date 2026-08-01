import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import { GoodsReceiptReportPdfService } from "./goods-receipt-report-pdf.service";
import { fmtQty } from "./robno-doc-layout";

/**
 * ZAPISNIK O PRIJEMU ROBE — test onoga što obrazac NE SME da izmisli.
 * =========================================================================
 * Kvantitativni deo ima izvor (narudžbenica vs primljeno) i mora da bude tačan;
 * kvalitativni ga NEMA i mora da ostane prazan. Tri kolone bez izvora („Rok
 * trajanja", „Serija / LOT", „Nalaz kontrole") su najlakše mesto za tihu
 * regresiju — neko ih jednom napuni „nečim smislenim" i papir počne da tvrdi
 * nalaz kontrole koji niko nije uneo.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

function allText(node: unknown, acc: string[] = []): string[] {
  if (node == null) return acc;
  if (typeof node === "string") {
    acc.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const n of node) allText(n, acc);
    return acc;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>))
      allText(v, acc);
  }
  return acc;
}

/** Prva mreža sa 10 kolona = tabela stavki zapisnika. */
function itemTable(node: unknown): { body: unknown[][] } | null {
  let found: { body: unknown[][] } | null = null;
  const walk = (n: unknown) => {
    if (found || n == null || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    const obj = n as Record<string, unknown>;
    const t = obj.table as
      | { widths?: unknown[]; body?: unknown[][] }
      | undefined;
    if (t?.widths?.length === 10 && t.body) {
      found = { body: t.body };
      return;
    }
    for (const v of Object.values(obj)) walk(v);
  };
  walk(node);
  return found;
}

function cellText(row: unknown[], i: number): string {
  const cell = row[i] as { text?: unknown } | undefined;
  return String(cell?.text ?? "");
}

/** Stavka prijemnice: `[artikal, količina]` — isti artikal SME da se ponovi. */
type ReceivedLine = [articleId: number, qty: string];
/** Stavka narudžbenice: `[artikal|null, količina]` (null = slobodan tekst). */
type OrderedLine = [articleId: number | null, qty: string];

function setup(opts: {
  purchaseOrderId: number | null;
  /** Prosto: količine za artikle 101, 102, … Složeno: eksplicitni parovi. */
  received: string[] | ReceivedLine[];
  ordered?: string[] | OrderedLine[];
  orderNumber?: string;
}) {
  let docDef: TDocumentDefinitions = {} as TDocumentDefinitions;
  const pdf = {
    render: jest.fn((d: TDocumentDefinitions) => {
      docDef = d;
      return Promise.resolve(Buffer.from("%PDF-proba"));
    }),
  } as unknown as PdfService;

  const receivedLines: ReceivedLine[] = opts.received.map((r, i) =>
    Array.isArray(r) ? r : ([101 + i, r] as ReceivedLine),
  );
  const orderedLines: OrderedLine[] = (opts.ordered ?? []).map((r, i) =>
    Array.isArray(r) ? r : ([101 + i, r] as OrderedLine),
  );

  const items = receivedLines.map(([articleId, qty], i) => ({
    id: i + 1,
    documentId: 1,
    itemId: articleId,
    warehouseId: 1,
    lineNo: i + 1,
    quantity: D(qty),
    deletedAt: null,
  }));

  // Katalog pokriva OBA skupa — i naručeno-a-nestiglo mora imati naziv.
  const catalogIds = [
    ...new Set([
      ...receivedLines.map(([id]) => id),
      ...orderedLines
        .map(([id]) => id)
        .filter((id): id is number => id != null),
    ]),
  ];

  const prisma = {
    stockDocument: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        companyId: 0,
        kind: "UL",
        documentTypeCode: "UFROB",
        documentNumber: "0001/2026",
        warehouseId: 1,
        supplierId: 7,
        purchaseOrderId: opts.purchaseOrderId,
        documentDate: new Date("2026-07-10T00:00:00Z"),
        postingDate: new Date("2026-07-10T00:00:00Z"),
        status: "POSTED",
        items,
      }),
    },
    item: {
      findMany: jest.fn().mockResolvedValue(
        catalogIds.map((id) => ({
          id,
          name: `Artikal ${id}`,
          catalogNumber: `KAT-${id}`,
          unit: "kom",
          barCode: null,
        })),
      ),
    },
    warehouse: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ name: "Magacin repromaterijala" }),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue({ name: "METALPROM d.o.o." }),
    },
    purchaseOrder: {
      findUnique: jest.fn().mockResolvedValue({
        orderNumber: opts.orderNumber ?? "0143/2026",
        orderedAt: new Date("2026-07-01T00:00:00Z"),
      }),
    },
    purchaseOrderItem: {
      findMany: jest.fn().mockResolvedValue(
        orderedLines.map(([articleId, qty]) => ({
          articleId,
          orderedQuantity: D(qty),
        })),
      ),
    },
    company: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({
        companyName: "SERVOTEH d.o.o.",
        address: "Dobanovački put 1",
        city: "Zemun",
        taxId: "101017443",
        registrationNumber: "17400169",
        bankAccount: null,
        phone: null,
        email: null,
        businessActivity: null,
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;

  const service = new GoodsReceiptReportPdfService(prisma, pdf);
  return { service, getDocDef: () => docDef };
}

describe("GoodsReceiptReportPdfService — zapisnik o prijemu robe", () => {
  it("poredi naručeno sa primljenim i ističe odstupanje", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: ["120", "2400", "1850.5"],
      received: ["118", "2400", "1902.25"],
    });
    await service.buildPdf(1, null);

    const table = itemTable(getDocDef().content)!;
    const rows = table.body.slice(1, 4);
    // Kolone: 4 naručeno, 5 primljeno, 6 razlika.
    expect(cellText(rows[0], 4)).toBe(fmtQty(D("120")));
    expect(cellText(rows[0], 5)).toBe(fmtQty(D("118")));
    expect(cellText(rows[0], 6)).toBe(fmtQty(D("-2")));
    // Bez odstupanja kolona razlike ostaje prazna (ne štampa se „0").
    expect(cellText(rows[1], 6)).toBe("");
    expect(cellText(rows[2], 6)).toBe(fmtQty(D("51.75")));

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("ODSTUPANJE OD NARUDŽBENICE");
  });

  it("kvalitativne kolone (rok, serija, nalaz) ostaju PRAZNE — nemaju izvor u šemi", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: ["10"],
      received: ["10"],
    });
    await service.buildPdf(1, null);

    const table = itemTable(getDocDef().content)!;
    const row = table.body[1];
    expect(cellText(row, 7)).toBe(""); // Rok trajanja
    expect(cellText(row, 8)).toBe(""); // Serija / LOT
    expect(cellText(row, 9)).toBe(""); // Nalaz kontrole

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("popunjava komisija ručno");
  });

  it('bez narudžbenice kolona „Naručeno" ostaje prazna i papir to kaže', async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: null,
      received: ["40", "500"],
    });
    await service.buildPdf(1, null);

    const table = itemTable(getDocDef().content)!;
    for (const row of table.body.slice(1, 3)) {
      expect(cellText(row, 4)).toBe(""); // naručeno — nema izvor
      expect(cellText(row, 6)).toBe(""); // razlika — nema se sa čim porediti
    }
    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("nije vezana za narudžbenicu");
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Naručeno se agregiralo po artiklu pa
   * PRIPISIVALO SVAKOM redu prijemnice sa tim artiklom: prijemnica sa istim
   * artiklom na dva reda (druga cena, druga isporuka istog dana) dobijala je
   * naručenu količinu dvaput, Σ naručeno je bilo naduvano, a papir je crvenim
   * teretio dobavljača za manjak koji ne postoji.
   */
  it("REGRESIJA: isti artikal na više redova prijemnice ne duplira naručeno", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: [[101, "100"]],
      // Ista roba stigla u dve isporuke istog dana — ukupno tačno 100.
      received: [
        [101, "60"],
        [101, "40"],
      ],
    });
    await service.buildPdf(1, null);

    const table = itemTable(getDocDef().content)!;
    // Poređenje je po artiklu → JEDAN red, ne dva.
    const rows = table.body.slice(1, -1);
    expect(rows).toHaveLength(1);
    expect(cellText(rows[0], 4)).toBe(fmtQty(D("100"))); // naručeno, NE 200
    expect(cellText(rows[0], 5)).toBe(fmtQty(D("100"))); // primljeno 60+40
    expect(cellText(rows[0], 6)).toBe(""); // razlike nema

    const text = allText(getDocDef().content).join(" ");
    expect(text).not.toContain("ODSTUPANJE OD NARUDŽBENICE");
    expect(text).toContain("nema odstupanja");
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Stavka koja je naručena a NIJE isporučena
   * uopšte ne postoji u robnom ulazu (`nabavka.service.ts` upisuje samo
   * `receivedQuantity > 0`), pa nije ulazila ni u jedan red ni u Σ razliku —
   * papir je tvrdio „nema odstupanja" baš za isporuku koja nije kompletna.
   */
  it("REGRESIJA: naručeno a NEISPORUČENO dobija svoj red i crveni manjak", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: [
        [101, "10"],
        [102, "20"],
        [103, "30"], // ovaj artikal dobavljač NIJE poslao
      ],
      received: [
        [101, "10"],
        [102, "20"],
      ],
    });
    await service.buildPdf(1, null);

    const table = itemTable(getDocDef().content)!;
    const rows = table.body.slice(1, -1);
    expect(rows).toHaveLength(3); // 2 primljena + 1 naručen-a-nestigao

    const missing = rows[2];
    expect(cellText(missing, 4)).toBe(fmtQty(D("30"))); // naručeno
    expect(cellText(missing, 5)).toBe(fmtQty(D("0"))); // primljeno = STVARNA nula
    expect(cellText(missing, 6)).toBe(fmtQty(D("-30"))); // manjak
    expect(cellText(missing, 2)).toContain("nije isporučeno");

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("ODSTUPANJE OD NARUDŽBENICE");
    expect(text).toContain("naručeno a NIJE isporučeno: 1 artikala");
    expect(text).not.toContain("nema odstupanja");
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Kad se NIJEDNA stavka nije uparila,
   * `sumDiff` ostaje nula pa je papir izricao najčistiji mogući nalaz — baš za
   * isporuku pogrešne robe, tj. za slučaj zbog kog zapisnik i postoji.
   */
  it("REGRESIJA: pogrešna roba (ništa upoređeno) NE daje čist nalaz", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: [[101, "100"]], // naručen artikal 101
      received: [[999, "100"]], // stigao artikal 999
    });
    await service.buildPdf(1, null);

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("NIJEDNA STAVKA NIJE UPOREĐENA SA NARUDŽBENICOM");
    expect(text).not.toContain("odgovaraju naručenim");

    const table = itemTable(getDocDef().content)!;
    const rows = table.body.slice(1, -1);
    // Oba artikla imaju svoj red: stigao-nenaručen i naručen-nestigao.
    expect(rows).toHaveLength(2);
    expect(cellText(rows[0], 2)).toContain("van narudžbenice");
    expect(cellText(rows[1], 2)).toContain("nije isporučeno");
  });

  it("štampa BROJ narudžbenice, ne interni id reda", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 992101,
      orderNumber: "PO-BROJ-2032/17",
      ordered: ["10"],
      received: ["10"],
    });
    await service.buildPdf(1, null);

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("PO-BROJ-2032/17");
    expect(text).not.toContain("992101");
  });

  it("stavke narudžbenice bez šifre artikla se prijavljuju kao neuporedive", async () => {
    const { service, getDocDef } = setup({
      purchaseOrderId: 55,
      ordered: [
        [101, "10"],
        [null, "5"], // slobodan tekst — nema šta da se uporedi
      ],
      received: [[101, "10"]],
    });
    await service.buildPdf(1, null);

    const text = allText(getDocDef().content).join(" ");
    expect(text).toContain("1 stavki bez šifre artikla");
  });

  it("odbija izlazni dokument — zapisnik o prijemu se izdaje samo uz UL", async () => {
    const { service } = setup({ purchaseOrderId: null, received: ["1"] });
    const prismaAny = (
      service as unknown as {
        prisma: { stockDocument: { findUnique: jest.Mock } };
      }
    ).prisma;
    prismaAny.stockDocument.findUnique.mockResolvedValueOnce({
      id: 1,
      companyId: 0,
      kind: "IZ",
      documentNumber: "0002/2026",
      items: [],
    });
    await expect(service.buildPdf(1, null)).rejects.toThrow(
      /samo uz ULAZNI dokument/,
    );
  });
});
