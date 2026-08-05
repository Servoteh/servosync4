/**
 * DOKAZ štampi robnog modula — zasejava probne dokumente SA STAVKAMA na dev bazi,
 * generiše svaki PDF kroz STVARNI servis i ispisuje broj bajtova, pa počisti za sobom.
 *
 * Servisi se instanciraju direktno (bez AppModule) da dokaz ne zavisi od tuđeg
 * paralelnog rada u istom worktree-u.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { PdfService } from "../src/modules/documents/pdf.service";
import { BarcodeService } from "../src/modules/documents/barcode.service";
import { DocumentPrintService } from "../src/modules/documents/document-print.service";
import { StockDocumentPdfService } from "../src/modules/robno/print/stock-document-pdf.service";
import { InventoryCountPdfService } from "../src/modules/robno/print/inventory-count-pdf.service";
import { StockReportPdfService } from "../src/modules/robno/print/stock-report-pdf.service";
import { RobnoService } from "../src/modules/robno/robno.service";
import { LagerQueryService } from "../src/modules/robno/lager-query.service";
import { CostingService } from "../src/modules/robno/costing.service";
import { StockDocumentNumberingService } from "../src/modules/robno/stock-document-numbering.service";

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

const OUT_DIR = process.env.PROOF_OUT ?? "reports/robno-print";
const D = (v: number | string) => new Prisma.Decimal(v);

const SEED = {
  companyId: 990001,
  warehouseA: 990001,
  warehouseB: 990002,
  supplier: 990001,
  customer: 990002,
  items: [990001, 990002, 990003],
};

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  }) as any;

  const pdf = new PdfService();
  const barcode = new BarcodeService();
  const costing = new CostingService(prisma);
  const numbering = new StockDocumentNumberingService(); // bez zavisnosti (prima `tx` po pozivu)
  const robno = new RobnoService(prisma, numbering, costing);
  const lagerQuery = new LagerQueryService(prisma, costing);
  // Trag štampe piše u `document_prints` iste baze — dokazna štampa ga vozi PRAVI,
  // da se u dokazima vidi i drugi primerak sa žigom „KOPIJA".
  const prints = new DocumentPrintService(prisma);
  const stockPdf = new StockDocumentPdfService(prisma, pdf, barcode, prints);
  const countPdf = new InventoryCountPdfService(prisma, pdf, prints);
  const reportPdf = new StockReportPdfService(prisma, pdf, lagerQuery);

  mkdirSync(OUT_DIR, { recursive: true });
  const results: Array<[string, number]> = [];

  const ids = await seed(prisma);

  // Dijagnostika: izveštajne štampe moraju da imaju STVARNE redove, ne prazan obrazac.
  const lagerProbe: any = await lagerQuery.listLager({ onlyInStock: false, take: 500 });
  const cardProbe: any = await lagerQuery.getItemCard({
    itemId: SEED.items[0],
    warehouseId: SEED.warehouseA,
  });
  console.log(
    `[dijagnostika] lager redova: ${lagerProbe.data.length} (ukupno ${lagerProbe.meta.total}) · ` +
      `kartica artikla redova: ${cardProbe.data.lines.length}, stanje ${cardProbe.data.closingBalance}`,
  );

  const emit = async (
    label: string,
    fn: () => Promise<{ buffer: Buffer; fileName: string }>,
  ) => {
    const { buffer, fileName } = await fn();
    writeFileSync(`${OUT_DIR}/${fileName}`, buffer);
    results.push([`${label} → ${fileName}`, buffer.length]);
  };

  try {
    await emit("primka (UL)", () => stockPdf.buildPdf(ids.ul, "primka", ids.userId));
    await emit("kalkulacija KL (UL)", () =>
      stockPdf.buildPdf(ids.ul, "kalkulacija", ids.userId),
    );
    await emit("izdatnica (IZ)", () =>
      stockPdf.buildPdf(ids.iz, "izdatnica", ids.userId),
    );
    await emit("otpremnica (IZ)", () =>
      stockPdf.buildPdf(ids.iz, "otpremnica", ids.userId),
    );
    await emit("nivelacija (NIV)", () =>
      stockPdf.buildPdf(ids.niv, "nivelacija", ids.userId),
    );
    await emit("prenosnica (PRENOS)", () =>
      stockPdf.buildPdf(ids.prenos, "prenosnica", ids.userId),
    );
    await emit("zapisnik o višku (VISAK)", () =>
      stockPdf.buildPdf(ids.visak, "zapisnik", ids.userId),
    );
    await emit("popisna lista — popunjena", () =>
      countPdf.buildPdf(ids.count, "popunjena", ids.userId),
    );
    await emit("popisna lista — prazna", () =>
      countPdf.buildPdf(ids.count, "prazna", ids.userId),
    );
    await emit("lager lista", () =>
      reportPdf.buildLagerPdf({ onlyInStock: false }, ids.userId),
    );
    await emit("kartica artikla", () =>
      reportPdf.buildItemCardPdf(
        { itemId: SEED.items[0], warehouseId: SEED.warehouseA },
        ids.userId,
      ),
    );
    // Prazan dokument (bez stavki) NE sme da pukne.
    await emit("primka BEZ stavki (rubni slučaj)", () =>
      stockPdf.buildPdf(ids.emptyDoc, "primka", ids.userId),
    );
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }

  console.log("\n=== DOKAZ ŠTAMPE — ROBNO I ZALIHE ===");
  for (const [label, bytes] of results) {
    console.log(`${bytes.toString().padStart(8)} B   ${label}`);
  }
  const tooSmall = results.filter(([, b]) => b < 3000);
  console.log(
    tooSmall.length
      ? `\nUPOZORENJE: ${tooSmall.length} PDF-a ispod 3 KB (sumnja na prazan obrazac).`
      : "\nSvi PDF-ovi iznad 3 KB.",
  );
}

async function seed(prisma: any) {
  const now = new Date();
  const year = now.getFullYear();

  await prisma.company.upsert({
    where: { id: SEED.companyId },
    update: {},
    create: {
      id: SEED.companyId,
      companyName: "SERVOTEH d.o.o. — PROBA ŠTAMPE",
      address: "Dobanovački put 1",
      city: "11080 Zemun",
      taxId: "101017443",
      registrationNumber: "17400169",
      bankAccount: "160-0000000123456-78",
      phone: "011/3160-000",
      email: "office@servoteh.com",
      businessActivity: "Proizvodnja mašina i opreme",
    },
  });

  for (const [id, name, city] of [
    [SEED.warehouseA, "Magacin gotovih proizvoda", "Dobanovci"],
    [SEED.warehouseB, "Magacin rezervnih delova", "Zemun"],
  ] as [number, string, string][]) {
    await prisma.warehouse.upsert({
      where: { id },
      update: {},
      create: {
        id,
        companyId: SEED.companyId,
        name,
        street: "Dobanovački put 1",
        city,
        managerName: "Petar Petrović",
      },
    });
  }

  for (const [id, name] of [
    [SEED.supplier, "METALPROM d.o.o. Beograd"],
    [SEED.customer, "TERMOELEKTRO ENGINEERING a.d."],
  ] as [number, string][]) {
    await prisma.customer.upsert({
      where: { id },
      update: {},
      create: {
        id,
        name,
        address: "Bulevar oslobođenja 12",
        city: "Novi Sad",
        postalCode: "21000",
        taxId: `1000${id}`,
        registrationNumber: `2000${id}`,
        phone: "021/555-000",
        // Meke FK kolone (vozač / komercijalista / šifarnici) — probni komitent ih nema.
        driverId: null,
        salespersonId: null,
        routeId: null,
        paymentAccountId: null,
        codeTypeCode: null,
      },
    });
  }

  const itemDefs = [
    ["Ležaj kuglični SKF 6205-2RS", "LEZ-6205", "8712345000018", "kom"],
    ["Zaptivka NBR 40×52×7", "ZAP-4052", "8712345000025", "kom"],
    ["Čelična šipka Č.4732 ⌀60", "SIP-4732-60", "8712345000032", "kg"],
  ];
  for (let i = 0; i < SEED.items.length; i += 1) {
    const [name, cat, bar, unit] = itemDefs[i];
    await prisma.item.upsert({
      where: { id: SEED.items[i] },
      update: {},
      create: {
        id: SEED.items[i],
        name,
        catalogNumber: cat,
        barCode: bar,
        unit,
        groupCode: "PROBA",
        goodsTaxRateCode: "3",
        transportPackaging: 10,
      },
    });
  }

  const user = await prisma.user.findFirst({
    orderBy: { id: "asc" },
    select: { id: true },
  });

  const mkDoc = async (
    kind: string,
    typeCode: string,
    num: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.stockDocument.create({
      data: {
        companyId: SEED.companyId,
        kind,
        documentTypeCode: typeCode,
        documentNumber: num,
        year,
        warehouseId: SEED.warehouseA,
        documentDate: now,
        postingDate: now,
        status,
        ...extra,
      },
    });

  // ULAZ (primka + kalkulacija) — pune landed kolone.
  const ul = await mkDoc("UL", "UFROB", "PROBA-0001", "CALCULATED", {
    supplierId: SEED.supplier,
    isCalculated: true,
    isImport: true,
    customsExchangeRate: D("117.2345"),
    accountingExchangeRate: D("117.5010"),
    fxInvoiceValue: D("4250.00"),
    customs: D("18500.00"),
    forwarding: D("9200.00"),
    otherDependentCosts: D("3100.00"),
  });
  const ulLines = [
    { itemId: SEED.items[0], qty: "120", inv: "845.5000", disc: "5", net: "803.2250" },
    { itemId: SEED.items[1], qty: "2400", inv: "62.4000", disc: "0", net: "62.4000" },
    { itemId: SEED.items[2], qty: "1850.5", inv: "218.9000", disc: "2.5", net: "213.4275" },
  ];
  for (let i = 0; i < ulLines.length; i += 1) {
    const l = ulLines[i];
    const net = D(l.net);
    const ztOwn = net.mul("0.035").toDecimalPlaces(4);
    const ztSup = net.mul("0.018").toDecimalPlaces(4);
    const landed = net.add(ztOwn).add(ztSup);
    const markup = landed.mul("0.22").toDecimalPlaces(4);
    const vp = landed.add(markup);
    await prisma.stockDocumentItem.create({
      data: {
        documentId: ul.id,
        itemId: l.itemId,
        warehouseId: SEED.warehouseA,
        lineNo: i + 1,
        quantity: D(l.qty),
        invoicePrice: D(l.inv),
        discountPercent: D(l.disc),
        purchasePriceNet: net,
        dependentCostOwn: ztOwn,
        dependentCostSupplier: ztSup,
        calculatedWholesalePrice: vp,
        calculatedRetailPrice: vp.mul("1.2").toDecimalPlaces(4),
        actualWholesalePrice: vp,
        markupAmount: markup,
        fxPurchasePrice: net.div("117.5010").toDecimalPlaces(4),
        customsRate: D("5"),
        goodsTaxRateCode: "3",
      },
    });
  }

  // IZLAZ (izdatnica + otpremnica).
  const iz = await mkDoc("IZ", "MANJR", "PROBA-0002", "POSTED", {
    customerId: SEED.customer,
    isCalculated: true,
    journalEntryId: 987654,
  });
  const izLines = [
    { itemId: SEED.items[0], qty: "35", vp: "1085.4000" },
    { itemId: SEED.items[1], qty: "600", vp: "82.1500" },
    { itemId: SEED.items[2], qty: "410.25", vp: "289.7000" },
  ];
  for (let i = 0; i < izLines.length; i += 1) {
    const l = izLines[i];
    await prisma.stockDocumentItem.create({
      data: {
        documentId: iz.id,
        itemId: l.itemId,
        warehouseId: SEED.warehouseA,
        lineNo: i + 1,
        quantity: D(l.qty),
        invoicePrice: D(l.vp),
        actualWholesalePrice: D(l.vp),
        calculatedWholesalePrice: D(l.vp),
        goodsTaxRateCode: "3",
      },
    });
  }

  // NIVELACIJA — parovi stara/nova cena.
  const niv = await mkDoc("NIV", "NIV", "PROBA-0003", "CALCULATED", {
    linkedInboundDocId: ul.id,
    isCalculated: true,
  });
  const nivLines = [
    { itemId: SEED.items[0], qty: "85", oldP: "1040.0000", newP: "1085.4000" },
    { itemId: SEED.items[1], qty: "1800", oldP: "80.0000", newP: "82.1500" },
    { itemId: SEED.items[2], qty: "1440.25", oldP: "289.7000", newP: "289.7000" },
  ];
  for (const l of nivLines) {
    const qty = D(l.qty);
    const oldP = D(l.oldP);
    const newP = D(l.newP);
    await prisma.stockLevelingItem.create({
      data: {
        documentId: niv.id,
        itemId: l.itemId,
        warehouseId: SEED.warehouseA,
        quantityRevalued: qty,
        oldWholesalePrice: oldP,
        newWholesalePrice: newP,
        oldRetailPrice: oldP.mul("1.2"),
        newRetailPrice: newP.mul("1.2"),
        valueAdjustment: qty.mul(newP.minus(oldP)).toDecimalPlaces(4),
        isPosted: true,
      },
    });
  }

  // PRENOS između magacina.
  const prenos = await mkDoc("PRENOS", "UFROB", "PROBA-0004", "DRAFT", {
    targetWarehouseId: SEED.warehouseB,
  });
  for (let i = 0; i < 2; i += 1) {
    await prisma.stockDocumentItem.create({
      data: {
        documentId: prenos.id,
        itemId: SEED.items[i],
        warehouseId: SEED.warehouseA,
        lineNo: i + 1,
        quantity: D(i === 0 ? "18" : "250"),
        invoicePrice: D(i === 0 ? "1085.4000" : "82.1500"),
        actualWholesalePrice: D(i === 0 ? "1085.4000" : "82.1500"),
        goodsTaxRateCode: "3",
      },
    });
  }

  // VIŠAK iz popisa.
  const visak = await mkDoc("VISAK", "VISAR", "PROBA-0005", "CALCULATED", {});
  await prisma.stockDocumentItem.create({
    data: {
      documentId: visak.id,
      itemId: SEED.items[2],
      warehouseId: SEED.warehouseA,
      lineNo: 1,
      quantity: D("12.75"),
      invoicePrice: D("213.4275"),
      purchasePriceNet: D("213.4275"),
      goodsTaxRateCode: "3",
    },
  });

  // Dokument BEZ stavki (rubni slučaj — štampa ne sme da padne).
  const emptyDoc = await mkDoc("UL", "UFROB", "PROBA-0006", "DRAFT", {
    supplierId: SEED.supplier,
  });

  // POPIS sa stavkama (višak i manjak).
  const count = await prisma.inventoryCount.create({
    data: {
      companyId: SEED.companyId,
      warehouseId: SEED.warehouseA,
      countNumber: "PROBA-0001",
      year,
      countDate: now,
      status: "COUNTING",
      note: "Godišnji popis — proba štampe",
    },
  });
  const countLines = [
    { itemId: SEED.items[0], book: "85", counted: "83", price: "845.5000" },
    { itemId: SEED.items[1], book: "1800", counted: "1812", price: "62.4000" },
    { itemId: SEED.items[2], book: "1440.25", counted: "1440.25", price: "218.9000" },
  ];
  for (const l of countLines) {
    await prisma.inventoryCountItem.create({
      data: {
        countId: count.id,
        itemId: l.itemId,
        bookQuantity: D(l.book),
        countedQuantity: D(l.counted),
        price: D(l.price),
      },
    });
  }

  return {
    ul: ul.id,
    iz: iz.id,
    niv: niv.id,
    prenos: prenos.id,
    visak: visak.id,
    emptyDoc: emptyDoc.id,
    count: count.id,
    userId: user?.id ?? null,
  };
}

async function cleanup(prisma: any) {
  const docs = await prisma.stockDocument.findMany({
    where: { companyId: SEED.companyId },
    select: { id: true },
  });
  const docIds = docs.map((d: { id: number }) => d.id);
  if (docIds.length) {
    await prisma.stockDocumentItem.deleteMany({ where: { documentId: { in: docIds } } });
    await prisma.stockLevelingItem.deleteMany({ where: { documentId: { in: docIds } } });
    await prisma.stockDocument.deleteMany({ where: { id: { in: docIds } } });
  }
  const counts = await prisma.inventoryCount.findMany({
    where: { companyId: SEED.companyId },
    select: { id: true },
  });
  const countIds = counts.map((c: { id: number }) => c.id);
  if (countIds.length) {
    await prisma.inventoryCountItem.deleteMany({ where: { countId: { in: countIds } } });
    await prisma.inventoryCount.deleteMany({ where: { id: { in: countIds } } });
  }
  await prisma.item.deleteMany({ where: { id: { in: SEED.items } } });
  await prisma.customer.deleteMany({
    where: { id: { in: [SEED.supplier, SEED.customer] } },
  });
  await prisma.warehouse.deleteMany({
    where: { id: { in: [SEED.warehouseA, SEED.warehouseB] } },
  });
  await prisma.company.deleteMany({ where: { id: SEED.companyId } });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
