/**
 * DOKAZ ŠTAMPE — Nabavka + SEF (grupa „upit / narudžbenica / 3-way match / e-fakture").
 * ====================================================================================
 * Zasejava dev bazu ZAOKRUŽENIM dokumentima SA STAVKAMA, generiše svaki PDF kroz
 * STVARNI servis (isti kod koji vozi HTTP rutu) i ispisuje broj bajtova. Na kraju
 * briše sve što je sam napravio (baza ostaje kakva je bila).
 *
 * Pokretanje:
 *   npx ts-node -T -r tsconfig-paths/register scripts/proof-nabavka-sef-print.ts
 *
 * Servisi se instanciraju direktno (PrismaService extends PrismaClient) — bez
 * AppModule-a, da skripta ne zavisi od stanja ostalih modula u paralelnom radu.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { PdfService } from "../src/modules/documents/pdf.service";
import { RfqPdfService } from "../src/modules/nabavka/rfq-pdf.service";
import { PurchaseOrderPdfService } from "../src/modules/nabavka/print/purchase-order-pdf.service";
import { MatchReportPdfService } from "../src/modules/nabavka/print/match-report-pdf.service";
import { ThreeWayMatchService } from "../src/modules/nabavka/three-way-match.service";
import { SefPrintService } from "../src/modules/sales/sef/sef-print.service";
import { UblBuilderService } from "../src/modules/sales/sef/ubl-builder.service";

const D = (v: string | number) => new Prisma.Decimal(v);
const OUT_DIR = join(process.cwd(), "reports", "proof-print-nabavka-sef");

const DEV_URL =
  process.env.DEV_DATABASE_URL ??
  "postgresql://servosync:servosync_dev@192.168.64.28:5437/servosync";

const results: Array<{ doc: string; bytes: number; file: string }> = [];

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const prisma = new PrismaService({
    datasources: { db: { url: DEV_URL } },
  });
  await prisma.$connect();

  const pdf = new PdfService();
  const rfqPdf = new RfqPdfService(prisma, pdf);
  const orderPdf = new PurchaseOrderPdfService(prisma, pdf);
  const matchSvc = new ThreeWayMatchService(prisma);
  const matchPdf = new MatchReportPdfService(prisma, pdf, matchSvc);
  const sefPrint = new SefPrintService(prisma, pdf);
  const ubl = new UblBuilderService();

  // ── što napravimo, to i obrišemo ──
  const made = {
    companyId: null as number | null,
    supplierId: null as number | null,
    itemIds: [] as number[],
    rfqId: null as number | null,
    orderId: null as number | null,
    emptyOrderId: null as number | null,
    stockDocId: null as number | null,
    outboxId: null as number | null,
    incomingId: null as number | null,
  };

  try {
    // ─────────────────────────────────────────────────────────── 1) zasejavanje
    let company = await prisma.company.findFirst({ orderBy: { id: "asc" } });
    if (!company) {
      company = await prisma.company.create({
        data: {
          id: 1,
          companyName: "SERVOTEH d.o.o. Dobanovci",
          address: "Ugrinovački put 12b",
          city: "11272 Dobanovci",
          taxId: "101017443",
          registrationNumber: "17400169",
          bankAccount: "160-0000000123456-78",
          phone: "011/3175-000",
          email: "office@servoteh.com",
        },
      });
      made.companyId = company.id;
    }

    const supplier = await prisma.customer.create({
      data: {
        name: "PROBA DOBAVLJAČ d.o.o.",
        taxId: "109876543",
        address: "Industrijska 15",
        postalCode: "21000",
        city: "Novi Sad",
        country: "Srbija",
        bankAccount1: "265-1234567890123-45",
        email: "prodaja@proba-dobavljac.rs",
        phone: "021/555-100",
        codeTypeCode: null,
        // Šifarnički meki ref-ovi imaju FK u bazi; podrazumevana 0 nema red → null.
        driverId: null,
        routeId: null,
        salespersonId: null,
        paymentAccountId: null,
        region: null,
      },
    });
    made.supplierId = supplier.id;

    const itemSpecs = [
      {
        catalogNumber: "PRB-LEZ-6205",
        name: "Ležaj kuglični 6205 2RS",
        unit: "kom",
      },
      {
        catalogNumber: "PRB-CEV-40",
        name: "Cev bešavna Ø40x3 S235",
        unit: "m",
      },
      {
        catalogNumber: "PRB-ULJ-46",
        name: "Hidraulično ulje HLP 46 (20 l)",
        unit: "kant",
      },
    ];
    for (const s of itemSpecs) {
      const it = await prisma.item.create({
        data: {
          catalogNumber: s.catalogNumber,
          name: s.name,
          unit: s.unit,
          // Šifarničke vrednosti se preuzimaju od postojećeg artikla dev baze
          // (FK-ovi na grupe/tarife/poreklo su živi).
          groupCode: "01",
          subgroupCode: "001",
          originCode: "D",
          goodsTaxRateCode: "3",
          serviceTaxRateCode: "3",
          accountingCode: "0",
          accountingCode2: "0",
          hps: "O",
          barCode: `860${Math.floor(Math.random() * 1_000_000_0)}`,
        },
      });
      made.itemIds.push(it.id);
    }
    const [i1, i2, i3] = made.itemIds;

    // — upit (RFQ) sa 3 stavke —
    const rfq = await prisma.supplierRfq.create({
      data: {
        rfqNumber: `PROBA-UPIT-${Date.now() % 100000}`,
        supplierId: supplier.id,
        status: "SENT",
        sentAt: new Date(),
        note: "Molimo ponudu sa rokom isporuke i uslovima plaćanja; isporuka FCO naš magacin Dobanovci.",
        items: {
          create: [
            {
              articleId: i1,
              quantity: D("120"),
              unit: "kom",
              lineNo: 1,
              offeredLeadTimeDays: 7,
            },
            {
              articleId: i2,
              quantity: D("48.5"),
              unit: "m",
              lineNo: 2,
              offeredLeadTimeDays: 14,
            },
            {
              articleId: i3,
              description: "Hidraulično ulje HLP 46 (20 l)",
              quantity: D("6"),
              unit: "kant",
              lineNo: 3,
            },
          ],
        },
      },
    });
    made.rfqId = rfq.id;

    // — narudžbenica sa 3 stavke i cenama —
    const order = await prisma.purchaseOrder.create({
      data: {
        orderNumber: `PROBA-NAR-${Date.now() % 100000}`,
        rfqId: rfq.id,
        supplierId: supplier.id,
        status: "SIGNED",
        orderedAt: new Date(),
        currency: "RSD",
        note: "Isporuka do 15 dana; obavezno navesti broj narudžbenice na otpremnici i fakturi.",
        items: {
          create: [
            {
              articleId: i1,
              orderedQuantity: D("120"),
              receivedQuantity: D("120"),
              unitPrice: D("1450.0000"),
              unit: "kom",
              lineNo: 1,
            },
            {
              articleId: i2,
              orderedQuantity: D("48.5"),
              receivedQuantity: D("48.5"),
              unitPrice: D("2380.5000"),
              unit: "m",
              lineNo: 2,
            },
            {
              articleId: i3,
              description: "Hidraulično ulje HLP 46 (20 l)",
              orderedQuantity: D("6"),
              receivedQuantity: D("5"),
              unitPrice: D("18990.0000"),
              unit: "kant",
              lineNo: 3,
            },
          ],
        },
      },
    });
    made.orderId = order.id;

    // — prazna narudžbenica (otpornost: štampa BEZ stavki ne sme da pukne) —
    const emptyOrder = await prisma.purchaseOrder.create({
      data: {
        orderNumber: `PROBA-PRAZNA-${Date.now() % 100000}`,
        supplierId: supplier.id,
        status: "DRAFT",
        currency: "RSD",
      },
    });
    made.emptyOrderId = emptyOrder.id;

    // — robni ulaz vezan za narudžbenicu (izvor „fakturisano" za 3-way match) —
    const warehouse = await prisma.warehouse.findFirst({
      select: { id: true },
    });
    if (warehouse) {
      const year = new Date().getFullYear();
      const stockDoc = await prisma.stockDocument.create({
        data: {
          companyId: company.id,
          kind: "UL",
          documentTypeCode: "UFROB",
          documentNumber: `P${Date.now() % 100000}`,
          year,
          warehouseId: warehouse.id,
          supplierId: supplier.id,
          purchaseOrderId: order.id,
          documentDate: new Date(),
          postingDate: new Date(),
          status: "CALCULATED",
          isCalculated: true,
          items: {
            create: [
              {
                itemId: i1,
                warehouseId: warehouse.id,
                lineNo: 1,
                quantity: D("120"),
                invoicePrice: D("1450.0000"),
              },
              {
                itemId: i2,
                warehouseId: warehouse.id,
                lineNo: 2,
                quantity: D("48.5"),
                // svesno odstupanje cene → nalaz PRICE_VARIANCE u izveštaju
                invoicePrice: D("2650.0000"),
              },
              {
                itemId: i3,
                warehouseId: warehouse.id,
                lineNo: 3,
                // fakturisano više nego primljeno → nalaz QTY_OVER_RECEIPT
                quantity: D("6"),
                invoicePrice: D("18990.0000"),
              },
            ],
          },
        },
      });
      made.stockDocId = stockDoc.id;
    }

    // — SEF izlazna: pravi UBL kroz UblBuilderService (ono što se šalje na SEF) —
    const ublXml = ubl.build({
      invoice: {
        documentType: "IF",
        documentNumber: `PROBA-FAK-${Date.now() % 100000}`,
        documentDate: new Date(),
        dueDate: new Date(Date.now() + 30 * 86_400_000),
        currency: "RSD",
        isExport: false,
        netTotal: D("289860.00"),
        vatTotal: D("57972.00"),
        grossTotal: D("347832.00"),
        note: "Promet dobara po ugovoru 118/2026.",
      },
      items: [
        {
          lineNo: 1,
          description: "Ležaj kuglični 6205 2RS",
          quantity: D("120"),
          unitPrice: D("1450.00"),
          discountPercent: D("0"),
          vatRateCode: "3",
          vatBase: D("174000.00"),
          vatAmount: D("34800.00"),
          lineTotal: D("174000.00"),
        },
        {
          lineNo: 2,
          description: "Cev bešavna Ø40x3 S235",
          quantity: D("48.5"),
          unitPrice: D("2380.50"),
          discountPercent: D("0"),
          vatRateCode: "3",
          vatBase: D("115454.25"),
          vatAmount: D("23090.85"),
          lineTotal: D("115454.25"),
        },
      ],
      supplier: {
        name: company.companyName,
        taxId: company.taxId ?? "101017443",
        registrationNumber: company.registrationNumber,
        address: company.address,
        city: company.city,
        bankAccount: company.bankAccount,
      },
      customer: {
        name: "PROBA KUPAC a.d.",
        taxId: "100200300",
        registrationNumber: "08000111",
        address: "Bulevar oslobođenja 100",
        city: "Novi Sad",
      },
    });

    const outbox = await prisma.sefOutbox.create({
      data: {
        invoiceId: 999_999,
        requestId: `proba-${Date.now()}`,
        ublXml,
        status: "SENT",
        sefInvoiceId: "SEF-TEST-778899",
        sentAt: new Date(),
      },
    });
    made.outboxId = outbox.id;

    // — SEF ulazna: isti oblik UBL-a, ali kao dokument dobavljača —
    const incomingXml = ubl.build({
      invoice: {
        documentType: "UF",
        documentNumber: `DOB-2026-0455`,
        documentDate: new Date(Date.now() - 3 * 86_400_000),
        dueDate: new Date(Date.now() + 27 * 86_400_000),
        currency: "RSD",
        isExport: false,
        netTotal: D("212400.00"),
        vatTotal: D("42480.00"),
        grossTotal: D("254880.00"),
        note: "Isporuka po narudžbenici 118/2026.",
      },
      items: [
        {
          lineNo: 1,
          description: "Hidraulično ulje HLP 46 (20 l)",
          quantity: D("6"),
          unitPrice: D("18990.00"),
          discountPercent: D("0"),
          vatRateCode: "3",
          vatBase: D("113940.00"),
          vatAmount: D("22788.00"),
          lineTotal: D("113940.00"),
        },
        {
          lineNo: 2,
          description: "Cev bešavna Ø40x3 S235",
          quantity: D("48.5"),
          unitPrice: D("2030.00"),
          discountPercent: D("5"),
          vatRateCode: "3",
          vatBase: D("98460.00"),
          vatAmount: D("19692.00"),
          lineTotal: D("98460.00"),
        },
      ],
      supplier: {
        name: supplier.name,
        taxId: supplier.taxId,
        address: supplier.address,
        city: supplier.city,
        bankAccount: supplier.bankAccount1,
      },
      customer: {
        name: company.companyName,
        taxId: company.taxId,
        registrationNumber: company.registrationNumber,
        address: company.address,
        city: company.city,
      },
    });

    const incoming = await prisma.sefIncomingInvoice.create({
      data: {
        sefPurchaseId: `proba-in-${Date.now()}`,
        supplierPib: supplier.taxId,
        supplierName: supplier.name,
        invoiceNumber: "DOB-2026-0455",
        issueDate: new Date(Date.now() - 3 * 86_400_000),
        // Datum PRIJEMA na SEF (osnov roka od 15 dana). Kolona se do 02.08.2026. zvala
        // `deliveryDate`, što je isto ime kao datum PROMETA — preimenovana je da ime
        // prati značenje (v. `SefIncomingInvoice` u schema.prisma).
        sefReceivedAt: new Date(Date.now() - 3 * 86_400_000),
        dueDate: new Date(Date.now() + 27 * 86_400_000),
        totalAmount: D("254880.00"),
        vatAmount: D("42480.00"),
        currency: "RSD",
        status: "NEW",
        acceptDeadline: new Date(Date.now() + 12 * 86_400_000),
        rawXml: incomingXml,
      },
    });
    made.incomingId = incoming.id;

    // ────────────────────────────────────────────────────── 2) generisanje PDF-ova
    await emit("Upit za ponudu (RFQ)", () =>
      rfqPdf.buildRfqPdf(rfq.id, new Date(Date.now() + 7 * 86_400_000)),
    );
    await emit("Narudžbenica (sa cenama)", () =>
      orderPdf.buildPurchaseOrderPdf(order.id, {
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );
    await emit("Narudžbenica (bez cena — magacin)", () =>
      orderPdf.buildPurchaseOrderPdf(order.id, {
        variant: "withoutPrices",
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );
    await emit("Narudžbenica BEZ STAVKI (otpornost)", () =>
      orderPdf.buildPurchaseOrderPdf(emptyOrder.id, {
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );
    await emit("3-way match — detalj narudžbenice", () =>
      matchPdf.buildOrderMatchPdf(order.id, {
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );
    await emit("3-way match — pregled odstupanja", () =>
      matchPdf.buildMatchSummaryPdf(
        { supplierId: supplier.id },
        { printedBy: "nenad.jarakovic@servoteh.com" },
      ),
    );
    await emit("SEF izlazna e-faktura (prikaz UBL-a)", () =>
      sefPrint.buildOutboundPdf(outbox.id, {
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );
    await emit("SEF ulazna e-faktura (prikaz UBL-a)", () =>
      sefPrint.buildIncomingPdf(incoming.id, {
        printedBy: "nenad.jarakovic@servoteh.com",
      }),
    );

    console.log("\n── REZULTAT ─────────────────────────────────────────────");
    for (const r of results)
      console.log(
        `  ${String(r.bytes).padStart(7)} B   ${r.doc}   →  ${r.file}`,
      );
    console.log("─────────────────────────────────────────────────────────\n");
  } finally {
    // ───────────────────────────────────────────────────────── 3) čišćenje
    const del = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        console.warn(
          `  čišćenje ${label}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    };
    if (made.incomingId)
      await del("sefIncoming", () =>
        prisma.sefIncomingInvoice.delete({ where: { id: made.incomingId! } }),
      );
    if (made.outboxId)
      await del("sefOutbox", () =>
        prisma.sefOutbox.delete({ where: { id: made.outboxId! } }),
      );
    if (made.stockDocId)
      await del("stockDocument", () =>
        prisma.stockDocument.delete({ where: { id: made.stockDocId! } }),
      );
    if (made.emptyOrderId)
      await del("purchaseOrder(prazna)", () =>
        prisma.purchaseOrder.delete({ where: { id: made.emptyOrderId! } }),
      );
    if (made.orderId)
      await del("purchaseOrder", () =>
        prisma.purchaseOrder.delete({ where: { id: made.orderId! } }),
      );
    if (made.rfqId)
      await del("supplierRfq", () =>
        prisma.supplierRfq.delete({ where: { id: made.rfqId! } }),
      );
    for (const id of made.itemIds)
      await del(`item ${id}`, () => prisma.item.delete({ where: { id } }));
    if (made.supplierId)
      await del("customer", () =>
        prisma.customer.delete({ where: { id: made.supplierId! } }),
      );
    if (made.companyId)
      await del("company", () =>
        prisma.company.delete({ where: { id: made.companyId! } }),
      );
    await prisma.$disconnect();
  }
}

/** Generiši jedan PDF, upiši ga na disk i zapamti broj bajtova. */
async function emit(
  label: string,
  fn: () => Promise<{ buffer: Buffer; fileName: string }>,
): Promise<void> {
  const { buffer, fileName } = await fn();
  const path = join(OUT_DIR, fileName);
  writeFileSync(path, buffer);
  results.push({ doc: label, bytes: buffer.length, file: fileName });
  console.log(`OK  ${label} — ${buffer.length} B → ${fileName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
