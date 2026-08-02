/**
 * DOKAZ — GRUPA B: polja koja su obrasci štampali prazna (ili izmišljena).
 *
 * Vozi STVARNE servise nad dev bazom, bez AppModule-a (paralelni rad u istom worktree-u
 * ne sme da obori ovaj dokaz) i tvrdi tri stvari koje su do 27.07.2026. bile pogrešne:
 *
 *   1. OTPREMNICA VIŠE NE LAŽE. Ranije je štampala četiri tvrde konstante („FCO magacin
 *      isporučioca", „sopstveni prevoz", „mesto prometa: magacin", datum otpreme = datum
 *      dokumenta). Sada: uneto → štampa se uneto; neuneto → LINIJA ZA RUČNI UPIS.
 *   2. TRAG ŠTAMPE RADI. Druga štampa istog obrasca nosi `copyNo = 2`, žig „KOPIJA",
 *      značku i „primerak br. 2" u nozi; red postoji u `document_prints`.
 *   3. IBAN/SWIFT SE MOGU UNETI I PROVERAVAJU SE. MOD-97 kontrola odbija pogrešno
 *      prepisan IBAN umesto da ga tiho odštampa na ino fakturi.
 *
 * Pokretanje:  npx ts-node -T scripts/smoke-grupa-b.ts     (DATABASE_URL = dev baza)
 */
import { PrismaClient, Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { PdfService } from "../src/modules/documents/pdf.service";
import { BarcodeService } from "../src/modules/documents/barcode.service";
import { DocumentPrintService } from "../src/modules/documents/document-print.service";
import { StockDocumentPdfService } from "../src/modules/robno/print/stock-document-pdf.service";
import { RobnoService } from "../src/modules/robno/robno.service";
import { CostingService } from "../src/modules/robno/costing.service";
import { StockDocumentNumberingService } from "../src/modules/robno/stock-document-numbering.service";
import { CompanyDetailsService } from "../src/modules/podesavanja/company-details.service";

/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

const SEED = {
  companyId: 991001,
  warehouse: 991001,
  customer: 991001,
  item: 991001,
};

let pass = 0;
let fail = 0;
const lines: string[] = [];

function ok(name: string, detail = "") {
  pass += 1;
  lines.push(`  OK   ${name}${detail ? " — " + detail : ""}`);
}
function bad(name: string, detail: unknown) {
  fail += 1;
  lines.push(`  FAIL ${name} — ${String(detail)}`);
}
function check(name: string, cond: boolean, detail = "") {
  if (cond) ok(name, detail);
  else bad(name, detail || "uslov nije ispunjen");
}
async function expectStatus(name: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(name, `očekivan ${status}, prošlo bez greške`);
  } catch (e: any) {
    const s = e?.status ?? e?.getStatus?.();
    if (s === status) ok(name, String(status));
    else bad(name, `očekivan ${status}, dobijen ${s}: ${e?.message}`);
  }
}

/** Rekurzivno pokupi sav tekst iz docDefinition-a (uključujući ugnežđene tabele). */
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
    for (const v of Object.values(node as Record<string, unknown>)) allText(v, acc);
  }
  return acc;
}

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL } },
  }) as any;

  // PdfService se ne menja — samo se presreće `render` da se uz bajtove dobije i
  // docDefinition, jer se nad NJIM tvrdi sadržaj (iz PDF bajtova se tekst ne čita pouzdano).
  const pdf = new PdfService();
  let lastDef: TDocumentDefinitions | null = null;
  const origRender = pdf.render.bind(pdf);
  (pdf as any).render = (dd: TDocumentDefinitions) => {
    lastDef = dd;
    return origRender(dd);
  };

  const prints = new DocumentPrintService(prisma);
  const barcode = new BarcodeService();
  const costing = new CostingService(prisma);
  const numbering = new StockDocumentNumberingService();
  const robno = new RobnoService(prisma, numbering, costing);
  const stockPdf = new StockDocumentPdfService(prisma, pdf, barcode, prints);
  const companyDetails = new CompanyDetailsService(prisma);

  const ids: { withShip?: number; without?: number } = {};

  try {
    await seed(prisma);

    // ─────────────────────────────────────────────── 1. UPIS USLOVA OTPREME
    const created = await robno.createStockDocument("IZ", {
      documentTypeCode: "MANJR",
      warehouseId: SEED.warehouse,
      customerId: SEED.customer,
      fco: "FCO kupac — Novi Sad",
      shippingMethod: "kurir (Bex)",
      shippingDate: "2026-07-29",
      deliveryPlace: "Bulevar oslobođenja 12, Novi Sad",
      route: "Beograd — Novi Sad",
      customerOrderRef: "PO-2026/443 od 20.07.2026.",
      note: "Roba se isporučuje u dve palete; ambalaža povratna.",
      items: [{ itemId: SEED.item, quantity: "5", actualWholesalePrice: "1200" }],
    } as any);
    ids.withShip = created.data.id;
    const row = created.data as any;
    check(
      "createStockDocument čuva sva 4 uslova otpreme + rutu + porudžbinu + napomenu",
      row.fco === "FCO kupac — Novi Sad" &&
        row.shippingMethod === "kurir (Bex)" &&
        row.shippingDate != null &&
        row.deliveryPlace === "Bulevar oslobođenja 12, Novi Sad" &&
        row.route === "Beograd — Novi Sad" &&
        row.customerOrderRef === "PO-2026/443 od 20.07.2026." &&
        row.note?.startsWith("Roba se isporučuje"),
      `doc #${row.id}`,
    );
    check(
      "shippingDate se NE izjednačava sa documentDate (odvojeni datumi)",
      new Date(row.shippingDate).toISOString().slice(0, 10) === "2026-07-29" &&
        new Date(row.documentDate).toISOString().slice(0, 10) !== "2026-07-29",
      `otprema ${new Date(row.shippingDate).toISOString().slice(0, 10)}`,
    );

    // ─────────────────────────────────────────── 2. OTPREMNICA ŠTAMPA UNETO
    const p1 = await stockPdf.buildPdf(ids.withShip!, "otpremnica", null);
    const t1 = allText(lastDef).join(" | ");
    check(
      "otpremnica štampa UNETE uslove otpreme",
      t1.includes("FCO kupac — Novi Sad") &&
        t1.includes("kurir (Bex)") &&
        t1.includes("29.07.2026.") &&
        t1.includes("Bulevar oslobođenja 12, Novi Sad") &&
        t1.includes("Beograd — Novi Sad") &&
        t1.includes("PO-2026/443 od 20.07.2026."),
      `${p1.buffer.length} B`,
    );
    check(
      "otpremnica štampa napomenu sa dokumenta",
      t1.includes("NAPOMENA") && t1.includes("ambalaža povratna"),
    );
    check(
      "IZMIŠLJENE KONSTANTE VIŠE NE POSTOJE na papiru",
      !t1.includes("magacin isporučioca") &&
        !t1.includes("sopstveni prevoz") &&
        !/Mesto prometa/.test(t1),
    );
    check("prva štampa NEMA žig KOPIJA", !t1.includes("KOPIJA"));

    // ──────────────────────────────────────────────── 3. DRUGA ŠTAMPA = KOPIJA
    await stockPdf.buildPdf(ids.withShip!, "otpremnica", null);
    const t2 = allText(lastDef).join(" | ");
    const wm2 = (lastDef as any)?.watermark?.text;
    check(
      "druga štampa nosi značku „KOPIJA · primerak br. 2" + '" i trag u nozi',
      t2.includes("KOPIJA · primerak br. 2") && t2.includes("primerak br. 2"),
    );
    check(
      "na NACRTU žig „NACRT" + '" ima prvenstvo nad „KOPIJA" (pdfmake nosi jedan žig)',
      wm2 === "NACRT — nije knjiženo",
      `watermark=${wm2}`,
    );
    // Isti dokument van nacrta → žig je „KOPIJA".
    await prisma.stockDocument.update({
      where: { id: ids.withShip },
      data: { status: "POSTED" },
    });
    await stockPdf.buildPdf(ids.withShip!, "otpremnica", null);
    const wm3 = (lastDef as any)?.watermark?.text;
    const t3b = allText(lastDef).join(" | ");
    check(
      "treći primerak proknjiženog dokumenta nosi žig KOPIJA",
      wm3 === "KOPIJA" && t3b.includes("primerak br. 3"),
      `watermark=${wm3}`,
    );
    await prisma.stockDocument.update({
      where: { id: ids.withShip },
      data: { status: "DRAFT" },
    });
    const printRows = await prisma.documentPrint.findMany({
      where: { documentKind: "STOCK", documentId: ids.withShip, variant: "otpremnica" },
      orderBy: { copyNo: "asc" },
    });
    check(
      "document_prints ima 3 reda sa copyNo 1, 2 i 3",
      printRows.length === 3 &&
        printRows[0].copyNo === 1 &&
        printRows[2].copyNo === 3,
      `${printRows.length} red(a)`,
    );

    // Drugi OBRAZAC istog dokumenta broji se ODVOJENO (izdatnica je svoj original).
    await stockPdf.buildPdf(ids.withShip!, "izdatnica", null);
    const t3 = allText(lastDef).join(" | ");
    check(
      "drugi obrazac istog dokumenta je SVOJ original (bez KOPIJA)",
      !t3.includes("KOPIJA"),
    );

    // Brana od duplog primerka (`uq_document_prints_copy`) — ručni pokušaj mora pući.
    // Zbog toga je `variant` NOT NULL sa default '': nullable kolona bi u Postgresu
    // propustila duplikate i „KOPIJA" se ne bi nikad pojavila.
    try {
      await prisma.documentPrint.create({
        data: {
          documentKind: "STOCK",
          documentId: ids.withShip,
          variant: "otpremnica",
          copyNo: 1,
        },
      });
      bad("uq_document_prints_copy odbija dupli primerak", "upis je prošao");
    } catch (e: any) {
      check(
        "uq_document_prints_copy odbija dupli primerak",
        String(e?.code) === "P2002",
        String(e?.code),
      );
    }

    // ─────────────────────────── 4. NEUNETO = LINIJA ZA UPIS, NE PRETPOSTAVKA
    const plain = await robno.createStockDocument("IZ", {
      documentTypeCode: "MANJR",
      warehouseId: SEED.warehouse,
      customerId: SEED.customer,
      items: [{ itemId: SEED.item, quantity: "1", actualWholesalePrice: "100" }],
    } as any);
    ids.without = plain.data.id;
    await stockPdf.buildPdf(ids.without, "otpremnica", null);
    const t4 = allText(lastDef).join(" | ");
    check(
      "prazna otpremnica ima LINIJE ZA RUČNI UPIS, a ne izmišljene vrednosti",
      t4.includes("____________________") &&
        t4.includes("Roba je FCO") &&
        t4.includes("Način otpreme") &&
        t4.includes("Datum otpreme") &&
        t4.includes("Mesto isporuke") &&
        !t4.includes("magacin isporučioca") &&
        !t4.includes("sopstveni prevoz"),
    );
    // Na IZDATNICI se prazna polja NE prikazuju (obrazac nije prateća isprava).
    await stockPdf.buildPdf(ids.without, "izdatnica", null);
    const t5 = allText(lastDef).join(" | ");
    check(
      "izdatnica ne dodaje prazne linije otpreme (samo otpremnica ih traži)",
      !t5.includes("Roba je FCO"),
    );

    // ────────────────────────────────────────── 5. PATCH uslova otpreme + guard
    const patched = await robno.updateShipping(ids.without, {
      fco: "  FCO magacin kupca  ",
      shippingMethod: "",
      note: null,
    });
    check(
      "updateShipping: trim upisuje, prazan string i null BRIŠU",
      (patched.data as any).fco === "FCO magacin kupca" &&
        (patched.data as any).shippingMethod === null &&
        (patched.data as any).note === null,
    );
    await expectStatus("updateShipping bez polja = 422", 422, () =>
      robno.updateShipping(ids.without!, {}),
    );
    await expectStatus("updateShipping nad nepostojećim = 404", 404, () =>
      robno.updateShipping(-1, { fco: "x" }),
    );
    await prisma.stockDocument.update({
      where: { id: ids.without },
      data: { status: "LOCKED" },
    });
    await expectStatus("updateShipping na ZAKLJUČANOM = 409", 409, () =>
      robno.updateShipping(ids.without!, { fco: "x" }),
    );
    await prisma.stockDocument.update({
      where: { id: ids.without },
      data: { status: "DRAFT" },
    });

    // ─────────────────────────────────────────────── 6. IBAN / SWIFT na firmi
    // Ispravan srpski IBAN (MOD-97 proveren): RS + 66 + 18 cifara BBAN-a.
    const upd = await companyDetails.update(SEED.companyId, {
      iban: "rs66 1600 0000 0012 3456 78",
      swift: "dbdbrsbg",
      bankAccount: "160-0000000123456-78",
    });
    check(
      "IBAN/SWIFT se čuvaju kanonski (bez razmaka, velikim slovima)",
      (upd.data as any).iban === "RS66160000000012345678" &&
        (upd.data as any).swift === "DBDBRSBG",
      `${(upd.data as any).iban} / ${(upd.data as any).swift}`,
    );
    await expectStatus("pogrešno prepisan IBAN (MOD-97) = 422", 422, () =>
      companyDetails.update(SEED.companyId, { iban: "RS66160000000012345679" }),
    );
    await expectStatus("SWIFT pogrešne dužine = 422", 422, () =>
      companyDetails.update(SEED.companyId, { swift: "DBDB" }),
    );
    await expectStatus("prazan naziv firme = 422 (zaglavlje bi ostalo bez imena)", 422, () =>
      companyDetails.update(SEED.companyId, { companyName: "   " }),
    );
    const got = await companyDetails.get(SEED.companyId);
    check(
      "GET firma vraća upisan IBAN (izvor za ino fakturu)",
      (got.data as any).iban === "RS66160000000012345678",
    );
  } catch (e) {
    bad("neočekivani pad smoke-a", e);
  } finally {
    await cleanup(prisma, ids);
    await prisma.$disconnect();
  }

  console.log("\n=== SMOKE — GRUPA B (uslovi otpreme · trag štampe · IBAN/SWIFT) ===");
  for (const l of lines) console.log(l);
  console.log(`\n${pass} prošlo, ${fail} palo.`);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function seed(prisma: any) {
  await prisma.company.upsert({
    where: { id: SEED.companyId },
    update: {},
    create: {
      id: SEED.companyId,
      companyName: "SERVOTEH d.o.o. — SMOKE GRUPA B",
      address: "Dobanovački put 1",
      city: "11080 Zemun",
      taxId: "101017443",
      registrationNumber: "17400169",
      bankAccount: "160-0000000123456-78",
    },
  });
  await prisma.warehouse.upsert({
    where: { id: SEED.warehouse },
    update: {},
    create: {
      id: SEED.warehouse,
      companyId: SEED.companyId,
      name: "Magacin — smoke B",
      street: "Dobanovački put 1",
      city: "Zemun",
    },
  });
  await prisma.customer.upsert({
    where: { id: SEED.customer },
    update: {},
    create: {
      id: SEED.customer,
      name: "KUPAC SMOKE B d.o.o.",
      address: "Bulevar oslobođenja 12",
      city: "Novi Sad",
      postalCode: "21000",
      taxId: "100991001",
      registrationNumber: "20991001",
      // Meke FK kolone (vozač / komercijalista / šifarnici) — probni komitent ih nema;
      // bez eksplicitnog null-a Prisma povlači default 0 i pada na fk_customers_driver.
      driverId: null,
      salespersonId: null,
      routeId: null,
      paymentAccountId: null,
      codeTypeCode: null,
    },
  });
  await prisma.item.upsert({
    where: { id: SEED.item },
    update: {},
    create: {
      id: SEED.item,
      name: "Ležaj kuglični SKF 6205-2RS",
      catalogNumber: "SMOKE-B-1",
      barCode: "8712345991001",
      unit: "kom",
      groupCode: "PROBA",
      goodsTaxRateCode: "3",
    },
  });
  // Ulaz da izlaz od 5 kom prođe guard raspoloživog stanja.
  const year = new Date().getFullYear();
  const ul = await prisma.stockDocument.findFirst({
    where: { companyId: SEED.companyId, kind: "UL" },
  });
  if (!ul) {
    await prisma.stockDocument.create({
      data: {
        companyId: SEED.companyId,
        kind: "UL",
        documentTypeCode: "UFROB",
        documentNumber: "9901/" + year,
        year,
        warehouseId: SEED.warehouse,
        documentDate: new Date("2026-07-01"),
        postingDate: new Date("2026-07-01"),
        status: "POSTED",
        items: {
          create: [
            {
              itemId: SEED.item,
              warehouseId: SEED.warehouse,
              lineNo: 1,
              quantity: new Prisma.Decimal(100),
              purchasePriceNet: new Prisma.Decimal(800),
            },
          ],
        },
      },
    });
  }
}

async function cleanup(prisma: any, ids: { withShip?: number; without?: number }) {
  try {
    const docs = await prisma.stockDocument.findMany({
      where: { companyId: SEED.companyId },
      select: { id: true },
    });
    const docIds = docs.map((d: any) => d.id);
    await prisma.documentPrint.deleteMany({
      where: { documentKind: "STOCK", documentId: { in: docIds } },
    });
    await prisma.stockDocumentItem.deleteMany({
      where: { documentId: { in: docIds } },
    });
    await prisma.stockDocument.deleteMany({ where: { id: { in: docIds } } });
    await prisma.item.deleteMany({ where: { id: SEED.item } });
    await prisma.customer.deleteMany({ where: { id: SEED.customer } });
    await prisma.warehouse.deleteMany({ where: { id: SEED.warehouse } });
    await prisma.company.deleteMany({ where: { id: SEED.companyId } });
  } catch (e) {
    console.error("[cleanup] ", e);
  }
  void ids;
}

void main();
