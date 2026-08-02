/**
 * DOKAZ — GRUPA A: preostali obrasci (KEP knjiga, trebovanje iz magacina,
 * zapisnik o prijemu robe, blagajnički izveštaj).
 * =========================================================================
 * Zasejava probne podatke SA STAVKAMA na dev bazi, generiše svaki PDF kroz
 * STVARNI servis i ispisuje broj bajtova, pa počisti za sobom.
 *
 * Servisi se instanciraju direktno (bez AppModule) da dokaz ne zavisi od tuđeg
 * paralelnog rada u istom worktree-u — isti obrazac kao `robno-print-proof.ts`.
 *
 * Pokretanje:
 *   DATABASE_URL="…dev…" npx ts-node -T scripts/proof-obrasci-grupa-a.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { writeFileSync, mkdirSync } from "node:fs";
import { PdfService } from "../src/modules/documents/pdf.service";
import { BarcodeService } from "../src/modules/documents/barcode.service";
import { DocumentPrintService } from "../src/modules/documents/document-print.service";
import { StockDocumentPdfService } from "../src/modules/robno/print/stock-document-pdf.service";
import { GoodsReceiptReportPdfService } from "../src/modules/robno/print/goods-receipt-report-pdf.service";
import { KepuService } from "../src/modules/pdv/kepu.service";
import { KepuPdfService } from "../src/modules/pdv/print/kepu-pdf.service";
import { BlagajnaService } from "../src/modules/blagajna/blagajna.service";
import { CashJournalPdfService } from "../src/modules/blagajna/print/cash-journal-pdf.service";

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

const OUT_DIR = process.env.PROOF_OUT ?? "reports/obrasci-grupa-a";
const D = (v: number | string) => new Prisma.Decimal(v);

const SEED = {
  companyId: 990101,
  warehouse: 990101,
  supplier: 990101,
  customer: 990102,
  items: [990101, 990102, 990103],
  cashJournal: 990101,
  purchaseOrder: 990101,
};

/** Period dokaza — fiksna godina/mesec, da broj strana knjige bude ponovljiv. */
const YEAR = 2026;
const MONTH = 7;

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  }) as any;

  const pdf = new PdfService();
  const barcode = new BarcodeService();
  const prints = new DocumentPrintService(prisma);
  const stockPdf = new StockDocumentPdfService(prisma, pdf, barcode, prints);
  const receiptPdf = new GoodsReceiptReportPdfService(prisma, pdf);
  const kepu = new KepuService(prisma);
  const kepuPdf = new KepuPdfService(prisma, pdf, kepu);
  // BlagajnaService se ovde koristi SAMO za `balanceOf` (čist upit nad
  // cash_entries) — PostingEngine mu za to ne treba, pa se ne instancira.
  const blagajna = new BlagajnaService(prisma, null as any);
  const cashPdf = new CashJournalPdfService(prisma, pdf, blagajna);

  mkdirSync(OUT_DIR, { recursive: true });
  const results: Array<[string, number]> = [];

  const ids = await seed(prisma);

  // Dijagnostika: obrasci moraju da imaju STVARNE redove, ne prazan papir.
  const bookRows = await kepu.book(YEAR, MONTH);
  const yearRows = await kepu.book(YEAR);
  const cashRows = await prisma.cashEntry.count({
    where: { cashJournalId: SEED.cashJournal },
  });
  console.log(
    `[dijagnostika] KEP knjiga: ${yearRows.length} redova u ${YEAR}. (${bookRows.length} u mesecu ${MONTH}) · ` +
      `blagajna: ${cashRows} stavki · trebovanje stavki: ${ids.izItemCount} · ` +
      `zapisnik o prijemu stavki: ${ids.ulItemCount}`,
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
    // 1) KEP knjiga (zakonski obrazac) — mesec i cela godina.
    await emit("KEP knjiga — mesec (2 strane knjige, DONOS/ZA PRENOS)", () =>
      kepuPdf.buildKepuPdf({
        year: YEAR,
        month: MONTH,
        userId: ids.userId,
      }),
    );
    await emit("KEP knjiga — cela godina", () =>
      kepuPdf.buildKepuPdf({ year: YEAR, userId: ids.userId }),
    );
    await emit("KEP knjiga — filter magacina", () =>
      kepuPdf.buildKepuPdf({
        year: YEAR,
        month: MONTH,
        warehouseId: SEED.warehouse,
        userId: ids.userId,
      }),
    );
    // Rubni slučaj: period bez prometa NE sme da pukne.
    await emit("KEP knjiga — prazan period (rubni slučaj)", () =>
      kepuPdf.buildKepuPdf({ year: YEAR, month: 2, userId: ids.userId }),
    );

    // 2) Trebovanje materijala iz magacina.
    await emit("trebovanje materijala (IZ)", () =>
      stockPdf.buildPdf(ids.iz, "trebovanje", ids.userId),
    );

    // 3) Zapisnik o prijemu robe (kvantitativno-kvalitativni).
    await emit("zapisnik o prijemu — uz narudžbenicu (sa odstupanjem)", () =>
      receiptPdf.buildPdf(ids.ul, ids.userId),
    );
    await emit("zapisnik o prijemu — bez narudžbenice", () =>
      receiptPdf.buildPdf(ids.ulNoPo, ids.userId),
    );

    // 4) Blagajnički izveštaj (dnevnik).
    await emit("blagajnički izveštaj — jedan dan", () =>
      cashPdf.buildPdf({
        journalId: SEED.cashJournal,
        from: ids.cashDay,
        userId: ids.userId,
      }),
    );
    await emit("blagajnički izveštaj — period (2 dana)", () =>
      cashPdf.buildPdf({
        journalId: SEED.cashJournal,
        from: ids.cashDayPrev,
        to: ids.cashDay,
        userId: ids.userId,
      }),
    );
    await emit("blagajnički izveštaj — dan bez prometa (rubni slučaj)", () =>
      cashPdf.buildPdf({
        journalId: SEED.cashJournal,
        from: `${YEAR}-02-03`,
        userId: ids.userId,
      }),
    );
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }

  console.log("\n=== DOKAZ ŠTAMPE — GRUPA A (preostali obrasci) ===");
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
  await prisma.company.upsert({
    where: { id: SEED.companyId },
    update: {},
    create: {
      id: SEED.companyId,
      companyName: "SERVOTEH d.o.o. — PROBA OBRAZACA A",
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

  await prisma.warehouse.upsert({
    where: { id: SEED.warehouse },
    update: {},
    create: {
      id: SEED.warehouse,
      companyId: SEED.companyId,
      name: "Magacin repromaterijala",
      street: "Dobanovački put 1",
      city: "Zemun",
      managerName: "Petar Petrović",
    },
  });

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
        driverId: null,
        salespersonId: null,
        routeId: null,
        paymentAccountId: null,
        codeTypeCode: null,
      },
    });
  }

  const itemDefs = [
    ["Ležaj kuglični SKF 6205-2RS", "LEZ-6205", "8712345100018", "kom"],
    ["Zaptivka NBR 40×52×7", "ZAP-4052", "8712345100025", "kom"],
    ["Čelična šipka Č.4732 ⌀60", "SIP-4732-60", "8712345100032", "kg"],
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
    date: Date,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.stockDocument.create({
      data: {
        companyId: SEED.companyId,
        kind,
        documentTypeCode: typeCode,
        documentNumber: num,
        year: YEAR,
        warehouseId: SEED.warehouse,
        documentDate: date,
        postingDate: date,
        status,
        ...extra,
      },
    });

  // ── NARUDŽBENICA (izvor „Naručeno" u zapisniku o prijemu) ──────────────
  const po = await prisma.purchaseOrder.upsert({
    where: { id: SEED.purchaseOrder },
    update: {},
    create: {
      id: SEED.purchaseOrder,
      orderNumber: "PROBA-A-0001",
      supplierId: SEED.supplier,
      status: "RECEIVED",
      currency: "RSD",
      orderedAt: new Date(Date.UTC(YEAR, MONTH - 1, 3)),
    },
  });
  const orderedQty = ["120", "2400", "1850.5"];
  for (let i = 0; i < SEED.items.length; i += 1) {
    await prisma.purchaseOrderItem.create({
      data: {
        orderId: po.id,
        articleId: SEED.items[i],
        orderedQuantity: D(orderedQty[i]),
        receivedQuantity: D(orderedQty[i]),
        unitPrice: D("845.5000"),
        unit: "kom",
        lineNo: i + 1,
      },
    });
  }

  // ── ULAZ uz narudžbenicu — primljeno ODSTUPA od naručenog (manjak/višak) ──
  const ulDate = new Date(Date.UTC(YEAR, MONTH - 1, 10));
  const ul = await mkDoc("UL", "UFROB", "PROBA-A-0001", "CALCULATED", ulDate, {
    supplierId: SEED.supplier,
    purchaseOrderId: po.id,
    isCalculated: true,
  });
  const receivedQty = ["118", "2400", "1902.25"]; // −2, 0, +51,75
  for (let i = 0; i < SEED.items.length; i += 1) {
    const net = D(["803.2250", "62.4000", "213.4275"][i]);
    await prisma.stockDocumentItem.create({
      data: {
        documentId: ul.id,
        itemId: SEED.items[i],
        warehouseId: SEED.warehouse,
        lineNo: i + 1,
        quantity: D(receivedQty[i]),
        invoicePrice: net,
        purchasePriceNet: net,
        calculatedWholesalePrice: net.mul("1.22").toDecimalPlaces(4),
        calculatedRetailPrice: net.mul("1.464").toDecimalPlaces(4),
        actualWholesalePrice: net.mul("1.22").toDecimalPlaces(4),
        goodsTaxRateCode: "3",
      },
    });
  }

  // ── ULAZ BEZ narudžbenice — kolona „Naručeno" mora ostati prazna ────────
  const ulNoPo = await mkDoc(
    "UL",
    "UFROB",
    "PROBA-A-0002",
    "POSTED",
    new Date(Date.UTC(YEAR, MONTH - 1, 12)),
    { supplierId: SEED.supplier, isCalculated: true },
  );
  for (let i = 0; i < 2; i += 1) {
    await prisma.stockDocumentItem.create({
      data: {
        documentId: ulNoPo.id,
        itemId: SEED.items[i],
        warehouseId: SEED.warehouse,
        lineNo: i + 1,
        quantity: D(i === 0 ? "40" : "500"),
        invoicePrice: D(i === 0 ? "803.2250" : "62.4000"),
        purchasePriceNet: D(i === 0 ? "803.2250" : "62.4000"),
        goodsTaxRateCode: "3",
      },
    });
  }

  // ── IZLAZ za trebovanje materijala (vezan za radni nalog i predmet) ─────
  const iz = await mkDoc(
    "IZ",
    "MANJR",
    "PROBA-A-0003",
    "POSTED",
    new Date(Date.UTC(YEAR, MONTH - 1, 15)),
    {
      customerId: SEED.customer,
      workOrderId: 4711,
      projectId: 8034,
      isCalculated: true,
      journalEntryId: 987655,
    },
  );
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
        warehouseId: SEED.warehouse,
        lineNo: i + 1,
        quantity: D(l.qty),
        invoicePrice: D(l.vp),
        actualWholesalePrice: D(l.vp),
        calculatedWholesalePrice: D(l.vp),
        goodsTaxRateCode: "3",
      },
    });
  }

  // ── KEP KNJIGA: 20 redova u junu (donos) + 60 u julu (dve strane knjige) ─
  const kepuRows: any[] = [];
  const push = (day: number, month: number, idx: number) => {
    const isCharge = idx % 3 !== 0;
    const value = D((1000 + idx * 137.25).toFixed(4));
    kepuRows.push({
      companyId: SEED.companyId,
      warehouseId: SEED.warehouse,
      documentId: idx % 2 === 0 ? ul.id : iz.id,
      entryDate: new Date(Date.UTC(YEAR, month - 1, day, 8, 0, 0)),
      charge: isCharge ? value : D(0),
      discharge: isCharge ? D(0) : value,
      description: isCharge
        ? `UFROB PROBA-A-${String(idx).padStart(4, "0")} (ulaz robe)`
        : `MANJR PROBA-A-${String(idx).padStart(4, "0")} (izlaz robe)`,
    });
  };
  for (let i = 1; i <= 20; i += 1) push(((i - 1) % 28) + 1, MONTH - 1, i);
  for (let i = 21; i <= 80; i += 1) push(((i - 21) % 28) + 1, MONTH, i);
  await prisma.kepuBookEntry.createMany({ data: kepuRows });

  // ── BLAGAJNA: preneto stanje + promet u dva dana ─────────────────────────
  await prisma.cashJournal.upsert({
    where: { id: SEED.cashJournal },
    update: {},
    create: {
      id: SEED.cashJournal,
      companyId: SEED.companyId,
      name: "Glavna blagajna — PROBA",
      accountCode: "2430",
      currency: "RSD",
    },
  });
  const cashDayPrev = `${YEAR}-${String(MONTH).padStart(2, "0")}-14`;
  const cashDay = `${YEAR}-${String(MONTH).padStart(2, "0")}-15`;
  const cashLines: Array<[string, string, string, string, string, number | null]> = [
    // [datum, smer, iznos, protivkonto, opis, partnerId]
    [`${YEAR}-${String(MONTH).padStart(2, "0")}-01`, "IN", "150000.00", "2040", "Preneto stanje — naplata od kupca", SEED.customer],
    [cashDayPrev, "IN", "42500.00", "2040", "Naplata gotovinskog računa 118/26", SEED.customer],
    [cashDayPrev, "OUT", "12800.50", "5539", "Kancelarijski materijal — račun 4471", null],
    [cashDay, "IN", "68300.00", "2040", "Naplata gotovinskog računa 121/26", SEED.customer],
    [cashDay, "OUT", "25000.00", "5512", "Gorivo — račun NIS 88231", SEED.supplier],
    [cashDay, "OUT", "9450.75", "5540", "Poštanske usluge — račun 991", null],
  ];
  for (let i = 0; i < cashLines.length; i += 1) {
    const [day, dir, amount, contra, desc, partner] = cashLines[i];
    await prisma.cashEntry.create({
      data: {
        cashJournalId: SEED.cashJournal,
        entryNumber: `${String(i + 1).padStart(4, "0")}/${YEAR}`,
        direction: dir,
        amount: D(amount),
        entryDate: new Date(`${day}T10:0${i}:00`),
        partnerId: partner,
        contraAccount: contra,
        description: desc,
        // Poslednja stavka namerno ostaje NACRT — izveštaj mora da to prijavi.
        status: i === cashLines.length - 1 ? "DRAFT" : "POSTED",
        journalEntryId: i === cashLines.length - 1 ? null : 500000 + i,
        createdByUserId: user?.id ?? null,
      },
    });
  }

  return {
    ul: ul.id,
    ulNoPo: ulNoPo.id,
    iz: iz.id,
    ulItemCount: SEED.items.length,
    izItemCount: izLines.length,
    cashDay,
    cashDayPrev,
    userId: user?.id ?? null,
  };
}

async function cleanup(prisma: any) {
  await prisma.kepuBookEntry.deleteMany({ where: { companyId: SEED.companyId } });
  await prisma.cashEntry.deleteMany({
    where: { cashJournalId: SEED.cashJournal },
  });
  await prisma.cashJournal.deleteMany({ where: { id: SEED.cashJournal } });

  const docs = await prisma.stockDocument.findMany({
    where: { companyId: SEED.companyId },
    select: { id: true },
  });
  const docIds = docs.map((d: { id: number }) => d.id);
  if (docIds.length) {
    await prisma.stockDocumentItem.deleteMany({
      where: { documentId: { in: docIds } },
    });
    await prisma.stockDocument.deleteMany({ where: { id: { in: docIds } } });
  }
  await prisma.purchaseOrderItem.deleteMany({
    where: { orderId: SEED.purchaseOrder },
  });
  await prisma.purchaseOrder.deleteMany({ where: { id: SEED.purchaseOrder } });
  await prisma.item.deleteMany({ where: { id: { in: SEED.items } } });
  await prisma.customer.deleteMany({
    where: { id: { in: [SEED.supplier, SEED.customer] } },
  });
  await prisma.warehouse.deleteMany({ where: { id: SEED.warehouse } });
  await prisma.company.deleteMany({ where: { id: SEED.companyId } });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
