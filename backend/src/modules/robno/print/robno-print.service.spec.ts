import "reflect-metadata";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PrismaService } from "../../../prisma/prisma.service";
import { PdfService } from "../../documents/pdf.service";
import type {
  DocumentPrintService,
  PrintTrace,
} from "../../documents/document-print.service";
import { RobnoService } from "../robno.service";
import { StockDocumentPdfService } from "./stock-document-pdf.service";
import { InventoryCountPdfService } from "./inventory-count-pdf.service";
import { StockReportPdfService } from "./stock-report-pdf.service";
import {
  amountInWords,
  fmtMoney,
  fmtQty,
  sanitizeText,
  widthSlack,
} from "./robno-doc-layout";

/**
 * Štampe robnog modula — tvrdimo NAD `docDefinition`-om (kao `work-order-print.service.spec`)
 * da je svaki obrazac stvarno kompletan: naslov, SVE propisane kolone, red zbira, potpisna
 * mesta i noga „strana N/M". Ovo je tiha grana (nema HTTP), pa bez testa regresija prolazi
 * neprimećeno — a upravo je „štampa postoji ali je prazna/bez kolone" bio najčešći nalaz revizije.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/**
 * Zamena za `DocumentPrintService` u testu: broji primerke u memoriji po istom ključu
 * kao tabela (`kind:id:variant`), pa druga štampa istog obrasca vraća `copyNo = 2` i
 * povlači žig „KOPIJA" — bez ijednog upita u bazu.
 */
function makePrintsStub() {
  const counters = new Map<string, number>();
  return {
    register: jest.fn(
      (args: {
        kind: string;
        documentId: number;
        variant?: string | null;
        printedByName?: string | null;
      }): Promise<PrintTrace> => {
        const key = `${args.kind}:${args.documentId}:${args.variant ?? ""}`;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return Promise.resolve({
          id: next,
          copyNo: next,
          isCopy: next > 1,
          printedBy: args.printedByName ?? null,
        });
      },
    ),
    discard: jest.fn().mockResolvedValue(undefined),
    history: jest.fn().mockResolvedValue([]),
  };
}

/** Rekurzivno kupi sav `text` iz docDefinition-a (uključujući ugnežđene tabele/kolone). */
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

/** Skupi `table.widths` svake tabele u dokumentu (za proveru preliva strane). */
function tableWidths(
  node: unknown,
  acc: Array<Array<string | number>> = [],
): Array<Array<string | number>> {
  if (node == null || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) tableWidths(n, acc);
    return acc;
  }
  const obj = node as Record<string, unknown>;
  const table = obj.table as { widths?: Array<string | number> } | undefined;
  // Značke i uokvirene napomene su jednokolone tabele — gledamo samo prave mreže.
  if (table?.widths && table.widths.length > 3) acc.push(table.widths);
  for (const v of Object.values(obj)) tableWidths(v, acc);
  return acc;
}

function textOf(docDef: TDocumentDefinitions): string {
  return allText(docDef.content).join("");
}

function makeItem(id: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    documentId: 1,
    itemId: id,
    warehouseId: 1,
    lineNo: id,
    quantity: D("10"),
    kgQuantity: D(0),
    invoicePrice: D("100"),
    discountPercent: D("5"),
    cashDiscountPercent: D(0),
    purchasePriceNet: D("95"),
    dependentCostOwn: D("3"),
    dependentCostSupplier: D("2"),
    calculatedWholesalePrice: D("122"),
    calculatedRetailPrice: D("146.4"),
    actualWholesalePrice: D("122"),
    markupAmount: D("22"),
    excise: D(0),
    fee: D(0),
    fixedTax: D(0),
    fxPurchasePrice: D(0),
    customsRate: D(0),
    goodsTaxRateCode: "3",
    deletedAt: null,
    ...over,
  };
}

function makeDoc(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    companyId: 0,
    kind: "UL",
    documentTypeCode: "UFROB",
    documentNumber: "0001/2026",
    year: 2026,
    warehouseId: 1,
    targetWarehouseId: null,
    supplierId: 7,
    customerId: null,
    documentDate: new Date("2026-07-27T00:00:00Z"),
    postingDate: new Date("2026-07-27T00:00:00Z"),
    isImport: false,
    customsExchangeRate: D(1),
    accountingExchangeRate: D(1),
    fxInvoiceValue: D(0),
    customs: D(0),
    forwarding: D(0),
    otherDependentCosts: D(0),
    customsRefundBase: D(0),
    purchaseOrderId: null,
    projectId: null,
    workOrderId: null,
    linkedInboundDocId: null,
    inventoryCountId: null,
    status: "CALCULATED",
    isCalculated: true,
    journalEntryId: null,
    items: [makeItem(1), makeItem(2)],
    stockLevelingItems: [],
    ...over,
  };
}

function setupStock(doc: ReturnType<typeof makeDoc>) {
  const prisma = {
    stockDocument: { findUnique: jest.fn().mockResolvedValue(doc) },
    item: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 1,
          name: "Ležaj 6205",
          catalogNumber: "LEZ-6205",
          barCode: "8712345000018",
          unit: "kom",
          transportPackaging: 10,
          goodsTaxRateCode: "3",
        },
        {
          id: 2,
          name: "Zaptivka NBR",
          catalogNumber: "ZAP-4052",
          barCode: null,
          unit: "kom",
          transportPackaging: 0,
          goodsTaxRateCode: "3",
        },
      ]),
    },
    warehouse: {
      findUnique: jest.fn().mockResolvedValue({
        id: 1,
        name: "Magacin gotovih proizvoda",
        street: "Put 1",
        city: "Dobanovci",
        managerName: "Petar P.",
      }),
    },
    customer: {
      findUnique: jest.fn().mockResolvedValue({
        name: "METALPROM d.o.o.",
        address: "Bulevar 12",
        city: "Novi Sad",
        postalCode: "21000",
        taxId: "100123456",
        registrationNumber: "20012345",
        phone: "021/555",
      }),
    },
    documentType: {
      findUnique: jest.fn().mockResolvedValue({ description: "Ulaz robe" }),
    },
    taxRate: {
      findMany: jest.fn().mockResolvedValue([{ code: "3", baseRate: 20 }]),
    },
    company: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({
        companyName: "Servoteh d.o.o.",
        address: "Put 1",
        city: "Dobanovci",
        taxId: "101017443",
        registrationNumber: "17400169",
        bankAccount: "160-123",
        phone: "011/316",
        email: "office@servoteh.com",
        businessActivity: "Proizvodnja",
      }),
    },
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ fullName: "Nenad J.", email: "n@x" }),
    },
  };
  let captured: TDocumentDefinitions | null = null;
  const pdf = {
    render: jest.fn((dd: TDocumentDefinitions) => {
      captured = dd;
      return Promise.resolve(Buffer.from("%PDF-1.4"));
    }),
  };
  const barcode = { code128Svg: jest.fn().mockReturnValue("<svg/>") };
  // Trag štampe (`document_prints`): u testu se ne piše u bazu — dupli `register`
  // vraća drugi primerak, čime se pokriva i put „KOPIJA" bez Prisma mock-a.
  const prints = makePrintsStub();
  const service = new StockDocumentPdfService(
    prisma as unknown as PrismaService,
    pdf as unknown as PdfService,
    barcode,
    prints as unknown as DocumentPrintService,
  );
  return {
    service,
    prisma,
    pdf,
    prints,
    get docDef() {
      return captured as unknown as TDocumentDefinitions;
    },
  };
}

describe("robno-doc-layout — formatiranje", () => {
  it("novac ima decimalni zarez i hiljade tačkom", () => {
    expect(fmtMoney(D("1234567.891"))).toBe("1.234.567,89");
    expect(fmtMoney(D("0"))).toBe("0,00");
    // ASCII minus (ne U+2212): iznos se iz PDF-a kopira u Excel, koji
    // matematički minus ne prepoznaje kao broj (kolona tiho da 0).
    expect(fmtMoney(D("-45.5"))).toBe("-45,50");
  });

  it("količina skida suvišne nule", () => {
    expect(fmtQty(D("12"))).toBe("12");
    expect(fmtQty(D("12.500"))).toBe("12,5");
    expect(fmtQty(D("1234.125"))).toBe("1.234,125");
  });

  it("iznos u slovima (srpski) pokriva hiljade, milione i pare", () => {
    expect(amountInWords(D("0"))).toBe("nula dinara i 00/100");
    // Valuta se slaže sa brojem: „jedan dinar", ne „jedan dinara".
    expect(amountInWords(D("1"))).toBe("jedan dinar i 00/100");
    expect(amountInWords(D("21"))).toBe("dvadeset jedan dinar i 00/100");
    expect(amountInWords(D("1250.35"))).toContain("hiljadu dvesta pedeset");
    expect(amountInWords(D("1250.35"))).toContain("35/100");
    expect(amountInWords(D("2000000"))).toContain("dva miliona");
  });

  it("pare se zaokružuju JEDNOM — nikad „100/100“", () => {
    // 1000,9950 se štampa kao 1.001,00; slova moraju reći isto.
    expect(amountInWords(D("1000.9950"))).toBe("hiljadu jedan dinar i 00/100");
    expect(amountInWords(D("0.9999"))).toBe("jedan dinar i 00/100");
    expect(amountInWords(D("999.995"))).toBe("hiljadu dinara i 00/100");
  });

  it("iznos preko opsega ne laže — ispisuje upozorenje", () => {
    expect(amountInWords(D("1234567890123.45"))).toContain("bilion");
    expect(amountInWords(D("1000000000000000000"))).toContain(
      "prevazilazi opseg",
    );
  });

  it("znakove van Roboto podskupa zamenjuje (⌀ → Ø, ↔ → /)", () => {
    expect(sanitizeText("Šipka Č.4732 ⌀60")).toBe("Šipka Č.4732 Ø60");
    expect(sanitizeText("Naručeno ↔ primljeno")).toBe("Naručeno / primljeno");
    expect(sanitizeText("ćčđšž ĆČĐŠŽ")).toBe("ćčđšž ĆČĐŠŽ");
  });
});

describe("StockDocumentPdfService", () => {
  it("primka: naslov, sve kolone, zbir i potpisi BigBit obrasca", async () => {
    const s = setupStock(makeDoc());
    const res = await s.service.buildPdf(1, "primka", 5);
    expect(res.fileName).toBe("PRIMKA-0001-2026.pdf");
    const t = textOf(s.docDef);
    expect(t).toContain("PRIJEMNICA");
    for (const col of [
      "R.br.",
      "Kat. broj",
      "Naziv artikla",
      "J.m.",
      "Količina",
      "Fakturna",
      "Rabat",
      "Nabavna neto",
      "Vrednost",
    ]) {
      expect(t).toContain(col);
    }
    expect(t).toContain("UKUPNO");
    expect(t).toContain("SLOVIMA: ");
    for (const sig of ["Robu primio", "Kontrolisao", "Robu izdao"]) {
      expect(t).toContain(sig);
    }
    // Zaglavlje kolona se PONAVLJA na svakoj strani.
    const table = (
      s.docDef.content as Array<{ table?: { headerRows?: number } }>
    ).find((n) => n?.table?.headerRows != null);
    expect(table?.table?.headerRows).toBeGreaterThanOrEqual(1);
  });

  it("otpremnica: bez cena, sa PDV %, barkodom po stavci i tri potpisa", async () => {
    const s = setupStock(
      makeDoc({ kind: "IZ", customerId: 7, supplierId: null }),
    );
    const res = await s.service.buildPdf(1, "otpremnica", null);
    expect(res.fileName).toBe("OTPREMNICA-0001-2026.pdf");
    const t = textOf(s.docDef);
    expect(t).toContain("OTPREMNICA");
    expect(t).toContain("PDV %");
    expect(t).toContain("Bar kod");
    expect(t).toContain("N A Z I V   R O B E");
    expect(t).toContain("Tr. pak.");
    // Otpremnica NE sme da nosi cene ni vrednost.
    expect(t).not.toContain("Vrednost");
    expect(t).not.toContain("Cena");
    for (const sig of ["Robu izdao", "Preuzeo za prevoz", "Robu primio"]) {
      expect(t).toContain(sig);
    }
  });

  it("prenosnica nosi OBA magacina (BigBit štampa samo odredište)", async () => {
    const s = setupStock(
      makeDoc({ kind: "PRENOS", targetWarehouseId: 2, supplierId: null }),
    );
    await s.service.buildPdf(1, "prenosnica", null);
    const t = textOf(s.docDef);
    expect(t).toContain("PRENOSNICA");
    expect(t).toContain("IZ MAGACINA");
    expect(t).toContain("U MAGACIN");
  });

  it("nivelacija: nova cena se ne ispisuje kad je nepromenjena", async () => {
    const s = setupStock(
      makeDoc({
        kind: "NIV",
        documentTypeCode: "NIV",
        items: [],
        stockLevelingItems: [
          {
            id: 1,
            documentId: 1,
            itemId: 1,
            warehouseId: 1,
            quantityRevalued: D("10"),
            oldWholesalePrice: D("100"),
            newWholesalePrice: D("110"),
            oldRetailPrice: D(0),
            newRetailPrice: D(0),
            oldPurchaseNet: D(0),
            newPurchaseNet: D(0),
            oldDependentOwn: D(0),
            newDependentOwn: D(0),
            oldDependentSupplier: D(0),
            newDependentSupplier: D(0),
            valueAdjustment: D("100"),
            isPosted: true,
          },
          {
            id: 2,
            documentId: 1,
            itemId: 2,
            warehouseId: 1,
            quantityRevalued: D("5"),
            oldWholesalePrice: D("50"),
            newWholesalePrice: D("50"),
            oldRetailPrice: D(0),
            newRetailPrice: D(0),
            oldPurchaseNet: D(0),
            newPurchaseNet: D(0),
            oldDependentOwn: D(0),
            newDependentOwn: D(0),
            oldDependentSupplier: D(0),
            newDependentSupplier: D(0),
            valueAdjustment: D("0"),
            isPosted: true,
          },
        ],
      }),
    );
    await s.service.buildPdf(1, "nivelacija", null);
    const t = textOf(s.docDef);
    expect(t).toContain("NIVELACIJA CENA");
    expect(t).toContain("Stara VP");
    expect(t).toContain("Nova VP");
    expect(t).toContain("Nivelacija");
    // Nepromenjeni red (50 → 50) ostaje bez nove cene; promenjeni je ispisan.
    expect(t).toContain("110,00");
  });

  it("kalkulacija (obrazac KL) je A4 POLOŽENO sa svim landed kolonama", async () => {
    const s = setupStock(makeDoc({ isImport: true }));
    await s.service.buildPdf(1, "kalkulacija", null);
    expect(s.docDef.pageOrientation).toBe("landscape");
    const t = textOf(s.docDef);
    expect(t).toContain("KALKULACIJA CENE");
    expect(t).toContain("Obrazac - KL");
    expect(t).toContain("ZT sopstveni");
    expect(t).toContain("ZT dobavljača");
    expect(t).toContain("Razlika\nu ceni");
    expect(t).toContain("Obračunski kurs");
    expect(t).toContain("Kontrola kalkulacije");
  });

  it("nijedan obrazac ne prelije tabelu preko desne ivice papira", async () => {
    // Nalaz revizije: fiksne širine + padding su prelazile širinu sadržaja, pa
    // je „*" kolona dobijala negativnu širinu i POSLEDNJA kolona (nivelacija:
    // „Nivelacija", kalkulacija: „MP cena") se štampala VAN PAPIRA. Ovaj test
    // pada čim neko doda kolonu bez preračuna širina.
    for (const variant of [
      "primka",
      "izdatnica",
      "otpremnica",
      "nivelacija",
      "prenosnica",
      "kalkulacija",
      "zapisnik",
      "trebovanje",
    ] as const) {
      const s = setupStock(makeDoc({ isImport: variant === "kalkulacija" }));
      await s.service.buildPdf(1, variant, null);
      const landscape = s.docDef.pageOrientation === "landscape";
      for (const w of tableWidths(s.docDef)) {
        expect(widthSlack(w, landscape, 8, 60)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("dokument BEZ stavki se štampa sa jasnom napomenom, ne puca", async () => {
    const s = setupStock(makeDoc({ items: [] }));
    const res = await s.service.buildPdf(1, "primka", null);
    expect(res.fileName).toBe("PRIMKA-0001-2026.pdf");
    const t = textOf(s.docDef);
    expect(t).toContain("DOKUMENT NEMA STAVKI");
    // Potpisi i zaglavlje ostaju — obrazac je i dalje upotrebljiv.
    expect(t).toContain("Robu primio");
    expect(t).toContain("PRIJEMNICA");
  });

  it("nacrt nosi statusnu značku i vodeni žig (BigBit ovo nema)", async () => {
    const s = setupStock(makeDoc({ status: "DRAFT" }));
    await s.service.buildPdf(1, "primka", null);
    expect(textOf(s.docDef)).toContain("NACRT");
    expect(s.docDef.watermark).toBeDefined();
  });

  it("noga ima oznaku strane N/M na svakom obrascu", async () => {
    const s = setupStock(makeDoc());
    await s.service.buildPdf(1, "primka", 5);
    const footer = s.docDef.footer as (p: number, c: number) => unknown;
    expect(typeof footer).toBe("function");
    expect(allText(footer(2, 7)).join(" ")).toContain("strana 2/7");
  });
});

describe("InventoryCountPdfService — popisna lista (zakonski obrazac)", () => {
  function setupCount(status = "COUNTING") {
    const prisma = {
      inventoryCount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 1,
          companyId: 0,
          warehouseId: 1,
          countNumber: "0001",
          year: 2026,
          countDate: new Date("2026-12-31T00:00:00Z"),
          status,
          note: null,
          items: [
            {
              id: 1,
              countId: 1,
              itemId: 1,
              bookQuantity: D("85"),
              countedQuantity: D("83"),
              price: D("845.50"),
            },
            {
              id: 2,
              countId: 1,
              itemId: 2,
              bookQuantity: D("1800"),
              countedQuantity: D("1812"),
              price: D("62.40"),
            },
          ],
        }),
      },
      item: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 1,
            name: "Ležaj",
            catalogNumber: "LEZ",
            barCode: "111",
            unit: "kom",
          },
          {
            id: 2,
            name: "Zaptivka",
            catalogNumber: "ZAP",
            barCode: "222",
            unit: "kom",
          },
        ]),
      },
      warehouse: {
        findUnique: jest.fn().mockResolvedValue({
          name: "Magacin 1",
          street: "Put 1",
          city: "Dobanovci",
        }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    let captured: TDocumentDefinitions | null = null;
    const pdf = {
      render: jest.fn((dd: TDocumentDefinitions) => {
        captured = dd;
        return Promise.resolve(Buffer.from("%PDF-1.4"));
      }),
    };
    const service = new InventoryCountPdfService(
      prisma as unknown as PrismaService,
      pdf as unknown as PdfService,
      makePrintsStub() as unknown as DocumentPrintService,
    );
    return {
      service,
      get docDef() {
        return captured as unknown as TDocumentDefinitions;
      },
    };
  }

  it("popunjena: propisane 4 grupe kolona, dvoredno zaglavlje, zbir i komisija", async () => {
    const s = setupCount();
    const res = await s.service.buildPdf(1, "popunjena", null);
    expect(res.fileName).toBe("POPIS-0001-popunjena.pdf");
    expect(s.docDef.pageOrientation).toBe("landscape");
    const t = textOf(s.docDef);
    expect(t).toContain("POPISNA LISTA");
    for (const g of [
      "Stanje po knjigama",
      "Stanje po popisu",
      "Višak",
      "Manjak",
    ]) {
      expect(t).toContain(g);
    }
    expect(t).toContain("S V E G A");
    expect(t).toContain("Odgovorno lice");
    expect(t).toContain("Za knjigovodstvo");
    expect(t).toContain("Članovi komisije za popis:");
    // Oba reda zaglavlja se ponavljaju na svakoj strani.
    const table = (
      s.docDef.content as Array<{ table?: { headerRows?: number } }>
    ).find((n) => n?.table?.headerRows === 2);
    expect(table).toBeDefined();
  });

  it("prazna: bez knjigovodstvenog stanja i cena, sa bar kodom i praznim poljem", async () => {
    const s = setupCount();
    await s.service.buildPdf(1, "prazna", null);
    const t = textOf(s.docDef);
    expect(t).toContain("Bar kod");
    expect(t).toContain("Popisana količina");
    expect(t).not.toContain("Stanje po knjigama");
    expect(t).toContain("sa stanjem na dan ______________________");
  });

  it("popis bez stavki ne puca — ispisuje napomenu i potpise", async () => {
    const s = setupCount();
    const prismaAny = (
      s.service as unknown as {
        prisma: { inventoryCount: { findUnique: jest.Mock } };
      }
    ).prisma;
    prismaAny.inventoryCount.findUnique.mockResolvedValue({
      id: 1,
      companyId: 0,
      warehouseId: 1,
      countNumber: "0002",
      year: 2026,
      countDate: new Date("2026-12-31T00:00:00Z"),
      status: "DRAFT",
      note: null,
      items: [],
    });
    await s.service.buildPdf(1, "popunjena", null);
    const t = textOf(s.docDef);
    expect(t).toContain("POPIS NEMA STAVKI");
    expect(t).toContain("Članovi komisije za popis:");
  });
});

describe("StockReportPdfService — lager i kartica artikla", () => {
  function setupReport(lagerRows: unknown[], card: unknown) {
    const prisma = {
      warehouse: {
        findMany: jest.fn().mockResolvedValue([{ id: 1, name: "Magacin 1" }]),
        findUnique: jest.fn().mockResolvedValue({ name: "Magacin 1" }),
      },
      company: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    let captured: TDocumentDefinitions | null = null;
    const pdf = {
      render: jest.fn((dd: TDocumentDefinitions) => {
        captured = dd;
        return Promise.resolve(Buffer.from("%PDF-1.4"));
      }),
    };
    const robno = {
      listLager: jest.fn().mockResolvedValue({
        data: lagerRows,
        meta: { total: lagerRows.length, skip: 0, take: 500 },
      }),
      getItemCard: jest.fn().mockResolvedValue({ data: card }),
    };
    const service = new StockReportPdfService(
      prisma as unknown as PrismaService,
      pdf as unknown as PdfService,
      robno as unknown as RobnoService,
    );
    return {
      service,
      get docDef() {
        return captured as unknown as TDocumentDefinitions;
      },
    };
  }

  const lagerRow = {
    itemId: 1,
    warehouseId: 1,
    itemName: "Ležaj",
    itemCode: "LEZ",
    unit: "kom",
    onHand: "120.000",
    reserved: "20.000",
    available: "100.000",
    avgPurchaseNet: "845.50",
    avgWholesalePrice: "1085.40",
    stockValue: "101460.00",
  };

  const card = {
    itemId: 1,
    warehouseId: 1,
    from: null,
    to: "2026-07-27T00:00:00.000Z",
    item: { id: 1, name: "Ležaj", code: "LEZ", unit: "kom" },
    openingBalance: "0.000000",
    closingBalance: "85.000000",
    stateAsOf: "85.000000",
    totalIn: "120.000000",
    totalOut: "35.000000",
    lines: [
      {
        documentNumber: "0001/2026",
        kind: "UL",
        documentTypeCode: "UFROB",
        documentDate: "2026-07-01T00:00:00.000Z",
        direction: "IN",
        in: "120.000000",
        out: "0.000000",
        balance: "120.000000",
      },
      {
        documentNumber: "0002/2026",
        kind: "IZ",
        documentTypeCode: "IFR",
        documentDate: "2026-07-15T00:00:00.000Z",
        direction: "OUT",
        in: "0.000000",
        out: "35.000000",
        balance: "85.000000",
      },
    ],
  };

  it("lager lista: kolone, traka filtera, zbir i kontrolni zbir", async () => {
    const s = setupReport([lagerRow], card);
    const res = await s.service.buildLagerPdf(
      { onlyInStock: true, q: "lez" },
      null,
    );
    expect(res.fileName).toMatch(/^LAGER-\d{4}-\d{2}-\d{2}\.pdf$/);
    expect(s.docDef.pageOrientation).toBe("landscape");
    const t = textOf(s.docDef);
    expect(t).toContain("LAGER LISTA");
    for (const c of [
      "Stanje",
      "Rezervisano",
      "Raspoloživo",
      "Pros. nabavna",
      "Vrednost zaliha",
    ]) {
      expect(t).toContain(c);
    }
    expect(t).toContain("Pretraga");
    expect(t).toContain("S V E G A");
    expect(t).toContain("Σ vrednost zaliha");
  });

  it("prazan lager ne puca — napomena + ispisani filteri", async () => {
    const s = setupReport([], card);
    await s.service.buildLagerPdf({}, null);
    const t = textOf(s.docDef);
    expect(t).toContain("NEMA STAVKI ZA ZADATE USLOVE");
    expect(t).toContain("Magacin");
  });

  it("kartica artikla: donos, ulaz/izlaz/stanje, kontrolno stanje iz costinga", async () => {
    const s = setupReport([lagerRow], card);
    const res = await s.service.buildItemCardPdf(
      { itemId: 1, warehouseId: 1 },
      null,
    );
    expect(res.fileName).toBe("KARTICA-LEZ-MAG1.pdf");
    const t = textOf(s.docDef);
    expect(t).toContain("KARTICA ARTIKLA");
    expect(t).toContain("Početno stanje (donos)");
    for (const c of ["Ulaz", "Izlaz", "Stanje", "Broj dokumenta"]) {
      expect(t).toContain(c);
    }
    expect(t).toContain("Kontrolno stanje (costing)");
  });

  it("kartica: neusklađeno krajnje stanje se KAŽE, ne prećuti", async () => {
    const s = setupReport([lagerRow], { ...card, stateAsOf: "80.000000" });
    await s.service.buildItemCardPdf({ itemId: 1, warehouseId: 1 }, null);
    expect(textOf(s.docDef)).toContain("NEUSKLAĐENO");
  });
});

/**
 * GRUPA B (27.07.2026) — uslovi otpreme i trag štampe.
 *
 * Do ovog talasa je otpremnica štampala ČETIRI TVRDE KONSTANTE („Roba je FCO: magacin
 * isporučioca", „Način otpreme: sopstveni prevoz", „Mesto prometa: magacin", datum
 * otpreme = datum dokumenta) kao da su podaci. Otpremnica je prateća isprava uz robu, pa
 * je papir tvrdio činjenice koje niko nije uneo. Ovi testovi drže to zatvorenim: bez
 * njih regresija „vrati podrazumevanu vrednost, lepše izgleda" prolazi neprimećeno.
 */
describe("uslovi otpreme + trag štampe (grupa B)", () => {
  const SHIP = {
    fco: "FCO kupac — Novi Sad",
    shippingMethod: "kurir (Bex)",
    shippingDate: new Date("2026-07-29T00:00:00Z"),
    deliveryPlace: "Bulevar oslobođenja 12, Novi Sad",
    route: "Beograd — Novi Sad",
    customerOrderRef: "PO-2026/443 od 20.07.2026.",
    note: "Roba se isporučuje u dve palete; ambalaža povratna.",
  };

  it("otpremnica štampa UNETE uslove otpreme, a ne izmišljene konstante", async () => {
    const s = setupStock(makeDoc({ kind: "IZ", customerId: 7, ...SHIP }));
    await s.service.buildPdf(1, "otpremnica", null);
    const t = textOf(s.docDef);
    for (const v of [
      SHIP.fco,
      SHIP.shippingMethod,
      "29.07.2026.",
      SHIP.deliveryPlace,
      SHIP.route,
      SHIP.customerOrderRef,
    ]) {
      expect(t).toContain(v);
    }
    expect(t).toContain("NAPOMENA");
    expect(t).toContain("ambalaža povratna");
  });

  it("neuneti uslovi otpreme = LINIJA ZA RUČNI UPIS, nikad pretpostavka", async () => {
    const s = setupStock(makeDoc({ kind: "IZ", customerId: 7 }));
    await s.service.buildPdf(1, "otpremnica", null);
    const t = textOf(s.docDef);
    // Natpisi ostaju (obrazac se dopunjava u magacinu), vrednosti su prazne linije.
    for (const label of [
      "Roba je FCO",
      "Način otpreme",
      "Datum otpreme",
      "Mesto isporuke",
    ]) {
      expect(t).toContain(label);
    }
    expect(t).toContain("____________________");
    // Stare izmišljene konstante NE SMEJU da se vrate.
    expect(t).not.toContain("magacin isporučioca");
    expect(t).not.toContain("sopstveni prevoz");
    expect(t).not.toContain("Mesto prometa");
  });

  it("izdatnica ne dodaje prazne linije otpreme (samo prateća isprava ih traži)", async () => {
    const s = setupStock(makeDoc({ kind: "IZ", customerId: 7 }));
    await s.service.buildPdf(1, "izdatnica", null);
    expect(textOf(s.docDef)).not.toContain("Roba je FCO");
  });

  it("ponovljena štampa nosi značku KOPIJA i broj primerka u nozi", async () => {
    const s = setupStock(
      makeDoc({ kind: "IZ", customerId: 7, status: "POSTED" }),
    );
    await s.service.buildPdf(1, "otpremnica", null, true);
    expect(allText(s.docDef).join(" ")).not.toContain("KOPIJA");

    await s.service.buildPdf(1, "otpremnica", null, true);
    const all = allText(s.docDef).join(" ");
    expect(all).toContain("KOPIJA · primerak br. 2");
    expect(
      (s.docDef as { watermark?: { text?: string } }).watermark?.text,
    ).toBe("KOPIJA");
    // Noga je funkcija (currentPage, pageCount) — trag primerka mora biti i tamo.
    const footer = (
      s.docDef as unknown as {
        footer: (p: number, c: number) => unknown;
      }
    ).footer(1, 1);
    expect(allText(footer).join(" ")).toContain("primerak br. 2");
  });

  it("NACRT ima prvenstvo nad KOPIJA (pdfmake nosi jedan žig po dokumentu)", async () => {
    const s = setupStock(
      makeDoc({ kind: "IZ", customerId: 7, status: "DRAFT" }),
    );
    await s.service.buildPdf(1, "otpremnica", null, true);
    await s.service.buildPdf(1, "otpremnica", null, true);
    expect(
      (s.docDef as { watermark?: { text?: string } }).watermark?.text,
    ).toBe("NACRT — nije knjiženo");
    // Značka i noga i dalje KAŽU da je kopija — gubi se samo žig.
    expect(allText(s.docDef).join(" ")).toContain("KOPIJA · primerak br. 2");
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz VISOK). Trag se upisivao na SVAKI GET PDF-a, a ruta
   * je pod ROBNO_READ — pa je svako otvaranje dokumenta radi provere trošilo redni
   * broj primerka. Prvi FIZIČKI otisak koji ide uz robu izlazio je sa žigom „KOPIJA"
   * i „primerak br. N", iako original nikad nije odštampan.
   */
  it("REGRESIJA: PREGLED ne troši primerak — tek štampa broji", async () => {
    const s = setupStock(
      makeDoc({ kind: "IZ", customerId: 7, status: "POSTED" }),
    );

    // Tri pregleda (bez `isPrintAction`) — nijedan ne sme da upiše trag.
    await s.service.buildPdf(1, "otpremnica", null);
    await s.service.buildPdf(1, "otpremnica", null);
    await s.service.buildPdf(1, "otpremnica", null);
    expect(s.prints.register).not.toHaveBeenCalled();
    expect(allText(s.docDef).join(" ")).not.toContain("KOPIJA");

    // Prva STVARNA štampa je original, ne „primerak br. 4".
    await s.service.buildPdf(1, "otpremnica", null, true);
    expect(s.prints.register).toHaveBeenCalledTimes(1);
    const all = allText(s.docDef).join(" ");
    expect(all).not.toContain("KOPIJA");
    expect(
      (s.docDef as { watermark?: { text?: string } }).watermark,
    ).toBeUndefined();
  });

  /**
   * REGRESIJA 27.07.2026 (nalaz NIZAK). Broj primerka se dodeljuje PRE rendera (deo
   * je sadržaja papira), pa neuspeo render mora da ga PONIŠTI — inače prva uspešna
   * štampa dobije „primerak br. 2" i žig KOPIJA nad nepostojećim originalom.
   */
  it("REGRESIJA: pad rendera poništava potrošen primerak", async () => {
    const s = setupStock(
      makeDoc({ kind: "IZ", customerId: 7, status: "POSTED" }),
    );
    (s.pdf.render as jest.Mock).mockRejectedValueOnce(
      new Error("render pukao"),
    );

    await expect(
      s.service.buildPdf(1, "otpremnica", null, true),
    ).rejects.toThrow("render pukao");
    // Trag je upisan pa poništen — brojač se ne pomera.
    expect(s.prints.register).toHaveBeenCalledTimes(1);
    expect(s.prints.discard).toHaveBeenCalledTimes(1);
  });
});
