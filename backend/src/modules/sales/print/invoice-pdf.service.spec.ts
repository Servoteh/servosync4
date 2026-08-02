import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { BarcodeService } from "../../documents/barcode.service";
import { PdfService } from "../../documents/pdf.service";
import type { PrismaService } from "../../../prisma/prisma.service";
import { InvoicePdfService } from "./invoice-pdf.service";

/**
 * INTEGRACIONI TEST VEZIVANJA ČETIRI OBRASCA.
 *
 * Šablone same za sebe pokrivaju `templates/*.spec.ts` (test-vektori su prepisani sa
 * donetih papira). Ovde se dokazuje ono što oni ne mogu: da `InvoicePdfService` za
 * DATU VRSTU DOKUMENTA izabere TAČAN obrazac, da mu isporuči pune podatke i da ga
 * obmota memorandumom.
 *
 * Zašto baš ovako: do sada se obrazac birao po `invoice.isExport`, pa je faktura za
 * uslugu izlazila na robnom papiru — sa „Kat. br.", pogrešnim sudom i četiri potpisa.
 * Testovi ispod zato uvek proveravaju i ono čega NE SME biti na papiru.
 *
 * Baza se ne dira: `PrismaService` je lažni objekat sa tačno onim metodama koje štampa
 * zove, a `PdfService.render` se presreće da bi se tvrdnje pisale nad pdfmake stablom.
 */

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

// ───────────────────────────────────────────────────────────── lažni redovi baze

const COMPANY = {
  companyName: "Servoteh d.o.o. Dobanovci",
  address: "Ugrinovačka 163",
  city: "11272 Dobanovci",
  taxId: "101017443",
  registrationNumber: "17400169",
  bankAccount: "160-110610-83",
  phone: "+381 11 31 41 564",
  fax: "+381 11 2399 265",
  email: "office@servoteh.rs",
  webAddress: "www.servoteh.rs",
  invoiceIssuingPlace: "Beograd",
  registryNumber: "01117400169",
  businessActivityCode: "3320",
  aprText:
    '"Servoteh" d.o.o. je jednočlano privredno društvo upisano u Agenciji za privredne registre pod brojem BD. 222785/2006',
};

const CUSTOMER = {
  name: "HAP FLUID D.O.O.",
  address: "Ugrinovačka 163",
  city: "Dobanovci",
  postalCode: "11272",
  country: "Srbija",
  taxId: "107136558",
  registrationNumber: "20748346",
};

/** Devizni račun — do sada nije postojao, pa je blok banke na ino fakturi bio mrtav kod. */
const EUR_ACCOUNT = {
  iban: "RS35160005010003501186",
  swift: "DBDBRSBG",
  bankName: "Banca Intesa a.d.",
  bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
  currency: "EUR",
  isDefault: true,
  sortOrder: 0,
};

const ITEM_MASTERS = [
  {
    id: 100,
    name: "INSERT HME 212",
    foreignName: "INSERT HME 212 EN",
    unit: "Kom",
    catalogNumber: "TO.44140391",
    customsTariff: "84314980",
  },
  {
    id: 200,
    name: "Zakup poslovnog prostora",
    foreignName: null,
    unit: "mes",
    catalogNumber: "USL.001",
    customsTariff: null,
  },
];

const WAREHOUSES: Record<number, string> = {
  3: "Magacin robe",
  5: "Gotovi proizvodi",
};

/** Podrazumevani magacin po vrsti dokumenta — koristi se kad račun nema svoj. */
const DOCUMENT_TYPES: Record<string, number> = { IFR: 3, IFGP: 5 };

function makeItem(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    invoiceId: 1,
    lineNo: 1,
    itemId: 100,
    description: null,
    unit: null,
    quantity: D("5"),
    unitPrice: D("16099.54"),
    discountPercent: D("0"),
    cashDiscountPercent: D("0"),
    vatRateCode: "3",
    // ⚠️ `vatBase` (bez PDV-a) je ono što ide u kolonu VREDNOST; `lineTotal` u bazi
    // nosi osnovicu + PDV. Brojevi su namerno različiti da se zamena vidi.
    vatBase: D("80497.70"),
    vatAmount: D("16099.54"),
    lineTotal: D("96597.24"),
    copiedFromItemId: null,
    ...over,
  };
}

function makeInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    documentType: "IFR",
    documentNumber: "657/25",
    level: 0,
    companyId: 1,
    customerId: 10,
    documentDate: new Date(2025, 11, 25),
    dueDate: new Date(2025, 11, 25),
    supplyDate: new Date(2025, 11, 25),
    currency: "RSD",
    netTotal: D("80497.70"),
    vatTotal: D("16099.54"),
    grossTotal: D("96597.24"),
    advanceInvoiceId: null,
    advanceAppliedAmount: D("0"),
    status: "POSTED",
    isExport: false,
    note: null,
    salespersonId: 7,
    warehouseId: 3,
    fco: "magacin kupca",
    paymentMethod: "virmanom",
    shipmentMethod: "lično",
    customsDeclarationNo: null,
    deliveryTerm: null,
    packageDescription: null,
    packageDimensions: null,
    grossWeightKg: null,
    netWeightKg: null,
    unloadingPlace: null,
    forwarderContact: null,
    items: [makeItem()],
    ...over,
  };
}

/**
 * Avansni računi na koje `advance_invoice_id` ume da pokaže (zatečena 1:1 veza, pre N:M
 * migracije). Bez njih bi rezervni put učitavanja umanjenja ostao bez broja dokumenta.
 */
const ADVANCE_INVOICES: Record<number, { documentNumber: string }> = {
  55: { documentNumber: "A-1/26" },
};

/**
 * Jedna aktivna primena avansa, u obliku u kom je vraća `invoice_advance_applications`.
 *
 * `advanceInvoiceId` NIJE ukras: po njemu se prepoznaje da zatečena 1:1 veza iz kolone
 * `invoice.advance_invoice_id` već ima svoj red u spojnoj tabeli (pa se ne štampa dvaput).
 */
function makeApplication(
  documentNumber: string,
  amount: string,
  advanceInvoiceId = 0,
) {
  return {
    advanceInvoiceId,
    appliedAmount: D(amount),
    advance: { documentNumber },
  };
}

/** Lažni Prisma klijent — tačno one metode koje štampa zove, ništa više. */
function makePrisma(
  invoice: Record<string, unknown>,
  applications: unknown[] = [],
) {
  return {
    invoice: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(
          args.where.id === invoice.id
            ? invoice
            : (ADVANCE_INVOICES[args.where.id] ?? null),
        ),
      ),
    },
    invoiceAdvanceApplication: {
      findMany: jest.fn(() => Promise.resolve(applications)),
    },
    customer: { findUnique: jest.fn(() => Promise.resolve(CUSTOMER)) },
    company: { findUnique: jest.fn(() => Promise.resolve(COMPANY)) },
    paymentAccount: { findMany: jest.fn(() => Promise.resolve([EUR_ACCOUNT])) },
    item: {
      findMany: jest.fn((args: { where: { id: { in: number[] } } }) =>
        Promise.resolve(
          ITEM_MASTERS.filter((i) => args.where.id.in.includes(i.id)),
        ),
      ),
    },
    // ⚠️ `taxRate` NAMERNO NEDOSTAJE (nalaz S2, ispravka 02.08.2026). Štampa je stopu
    // čitala iz tabele `tax_rates` dok je IZNOS poreza računat iz mape u kodu
    // (`VAT_RATE_BY_CODE`). Tabela nema seed ni u jednoj migraciji — na produkciji ima
    // 0 redova — pa je papir štampao „PDV po stopi 0% X 500,05 = 100,01". Ako bilo ko
    // vrati čitanje iz baze, ovaj lažni klijent pukne umesto da tiho odštampa nulu.
    salesperson: {
      findUnique: jest.fn(() =>
        Promise.resolve({ name: "Korkut", firstName: "Dragana" }),
      ),
    },
    documentType: {
      findUnique: jest.fn((args: { where: { code: string } }) =>
        Promise.resolve({
          defaultWarehouseId: DOCUMENT_TYPES[args.where.code] ?? 0,
        }),
      ),
    },
    warehouse: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(
          WAREHOUSES[args.where.id]
            ? { name: WAREHOUSES[args.where.id] }
            : null,
        ),
      ),
    },
  };
}

// ───────────────────────────────────────────────────────────────── pomoćnici

/** Skuplja sav `text` iz pdfmake stabla, da se tvrdnje pišu nad ravnim spiskom. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.text === "string") out.push(o.text);
    else if (o.text != null) collectText(o.text, out);
    for (const key of ["stack", "columns", "table", "body"])
      if (o[key] != null) collectText(o[key], out);
  }
  return out;
}

/** Skuplja `image` čvorove — za proveru da logo nije odštampan dvaput. */
function collectImages(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  if (Array.isArray(node)) {
    for (const n of node) collectImages(n, out);
    return out;
  }
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.image === "string") out.push(o.image.slice(0, 32));
    for (const key of ["stack", "columns", "table", "body"])
      if (o[key] != null) collectImages(o[key], out);
  }
  return out;
}

interface Built {
  dd: TDocumentDefinitions;
  fileName: string;
  buffer: Buffer;
  /** Sav tekst tela dokumenta. */
  body: string;
  /** Tekst zaglavlja strane (memorandum + eventualno zaglavlje računa). */
  header: string;
  /** Tekst podnožja strane, za `Strana X od Y`. */
  footer: string;
  warnings: string[];
}

/** Jedan pravi renderer za ceo fajl; špijun ispod poziva NJEGA, ne sam sebe. */
const realPdf = new PdfService();

/**
 * Sagradi PDF preko servisa i vrati i pdfmake definiciju. Render je STVARAN (pdfmake
 * mora da proguta stablo), a `dd` se usput presretne — tako jedan poziv daje i dokaz
 * da se dokument renderuje i sadržaj nad kojim se pišu tvrdnje.
 */
async function build(
  invoice: Record<string, unknown>,
  variant?: "withPrices" | "withoutPrices",
  applications: unknown[] = [],
): Promise<Built> {
  const prisma = makePrisma(invoice, applications);
  const pdf = new PdfService();
  let captured: TDocumentDefinitions | undefined;
  jest.spyOn(pdf, "render").mockImplementation(async (dd) => {
    captured = dd;
    return realPdf.render(dd);
  });

  const warnings: string[] = [];
  const service = new InvoicePdfService(
    prisma as unknown as PrismaService,
    pdf,
    new BarcodeService(),
  );
  jest
    .spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      "warn",
    )
    .mockImplementation((m: string) => {
      warnings.push(String(m));
    });

  const { buffer, fileName } = await service.buildInvoicePdf(
    invoice.id as number,
    variant,
  );
  if (!captured) throw new Error("pdfmake definicija nije presretnuta.");

  const headerFn = captured.header as
    | ((page: number, count: number) => unknown)
    | undefined;
  const footerFn = captured.footer as
    | ((page: number, count: number) => unknown)
    | undefined;

  return {
    dd: captured,
    fileName,
    buffer,
    body: collectText(captured.content).join("\n"),
    header: headerFn ? collectText(headerFn(1, 3)).join("\n") : "",
    footer: footerFn ? collectText(footerFn(1, 3)).join("\n") : "",
    warnings,
  };
}

// ──────────────────────────────────────────────────────────────────── testovi

describe("InvoicePdfService — izbor obrasca po vrsti dokumenta", () => {
  afterEach(() => jest.restoreAllMocks());

  describe("IFR / IFGP → domaći obrazac za robu", () => {
    it("štampa traku uslova, `Kat. br.`, Privredni sud i četiri potpisa", async () => {
      const out = await build(makeInvoice());
      expect(out.body).toContain("Roba je FCO");
      expect(out.body).toContain("magacin kupca");
      expect(out.body).toContain("Kat. br.");
      expect(out.body).toContain("TO.44140391");
      expect(out.body).toContain("N A Z I V   R O B E");
      expect(out.body).toContain("Za sve sporove nadležan je Privredni sud.");
      expect(out.body).toContain("Robu primio");
      expect(out.body).toContain("Preuzeo za prevoz");
      expect(out.body).toContain("Robu izdao");
      expect(out.body).toContain("Odgovorno lice");
      // Uslužni obrazac ne sme da procuri.
      expect(out.body).not.toContain("Trgovinski sud");
      expect(out.body).not.toContain("O P I S");
      expect(out.fileName).toBe("FAK-657-25.pdf");
    });

    it("nosi magacin sa računa (jedina razlika IFR od IFGP)", async () => {
      const ifr = await build(makeInvoice());
      expect(ifr.body).toContain("iz magacina Magacin robe");

      const ifgp = await build(
        makeInvoice({
          documentType: "IFGP",
          documentNumber: "650/25",
          warehouseId: 5,
        }),
      );
      expect(ifgp.body).toContain("iz magacina Gotovi proizvodi");
      // Sve ostalo je isti papir.
      expect(ifgp.body).toContain("Roba je FCO");
      expect(ifgp.body).toContain("Kat. br.");
    });

    it("kad račun nema magacin, uzima podrazumevani te vrste dokumenta", async () => {
      const out = await build(
        makeInvoice({ documentType: "IFGP", warehouseId: null }),
      );
      expect(out.body).toContain("iz magacina Gotovi proizvodi");
    });

    it("„Odgovorno lice“ je komercijalista sa računa (O-F2), bez broja l.k. (O-F3)", async () => {
      const out = await build(makeInvoice());
      expect(out.body).toContain("Dragana Korkut");
      // O-F3 sprovedena do kraja (02.08.2026): ne štampa se ni broj lične karte ni NATPIS
      // uz praznu liniju — v. `templates/domaca-roba.ts` i FAKTURE_ZAKONSKA_USKLADJENOST §2.2.
      expect(out.body.toLowerCase()).not.toContain("l.k.");
      // Potpisne linije ostaju sve četiri (dokaz o isporuci, ne potpis računa).
      expect(out.body).toContain("Robu izdao");
      expect(out.body).toContain("Robu primio");
    });
  });

  describe("IFUSL → domaći obrazac za uslugu", () => {
    const uslugaInvoice = () =>
      makeInvoice({
        documentType: "IFUSL",
        documentNumber: "653/25",
        warehouseId: null,
        items: [
          makeItem({
            itemId: 200,
            quantity: D("1"),
            unitPrice: D("16000"),
            vatBase: D("16000"),
            vatAmount: D("3200"),
            lineTotal: D("19200"),
          }),
        ],
        netTotal: D("16000"),
        vatTotal: D("3200"),
        grossTotal: D("19200"),
      });

    it("daje „Trgovinski sud“ i NEMA kolonu `Kat. br.` ni traku uslova", async () => {
      const out = await build(uslugaInvoice());
      expect(out.body).toContain(
        "Za sve sporove nadležan je Trgovinski sud u Beogradu.",
      );
      expect(out.body).toContain("O P I S");
      expect(out.body).toContain("Ukupno za uplatu (RSD):");
      expect(out.body).not.toContain("Kat. br.");
      expect(out.body).not.toContain("Roba je FCO");
      expect(out.body).not.toContain("Način otpreme robe");
      expect(out.body).not.toContain("Privredni sud");
      expect(out.body).not.toContain("N A Z I V   R O B E");
    });

    it("ima JEDAN potpisni blok, ne četiri", async () => {
      const out = await build(uslugaInvoice());
      expect(out.body).toContain("Odgovorno lice");
      expect(out.body).toContain("Dragana Korkut");
      expect(out.body).not.toContain("Robu primio");
      expect(out.body).not.toContain("Preuzeo za prevoz");
      expect(out.body).not.toContain("Robu izdao");
    });

    it("nosi „Rok za plaćanje“ i „Datum prometa“ umesto valute plaćanja", async () => {
      const out = await build(uslugaInvoice());
      expect(out.body).toContain("Rok za plaćanje: 25-12-25");
      expect(out.body).toContain("Datum prometa: 25-12-25");
      expect(out.body).not.toContain("Valuta za plaćanje:");
    });
  });

  describe("IZVRO / IZVGP → ino obrazac za robu", () => {
    /**
     * ⚠️ IZVOZ JE BEZ PDV-a. Do 02.08.2026. je ovaj vektor nasleđivao domaće zbirove
     * (`vatTotal 16.099,54`, `grossTotal` sa PDV-om) uz `isExport: true` — dakle
     * izvoznu fakturu koja nosi obračunat PDV. Takav dokument od sada obara štampu
     * (`templates/totals.ts`, `assertExportWithoutVat`): ino obrazac je štampao PDV
     * unutar „TOTAL AMOUNT" na papiru koji tvrdi da je promet oslobođen. Vektor se
     * zato poravnava sa stvarnošću — osnovica = bruto, PDV = 0, i na stavci.
     */
    const inoRoba = (over: Record<string, unknown> = {}) =>
      makeInvoice({
        documentType: "IZVRO",
        documentNumber: "228/25",
        isExport: true,
        currency: "EUR",
        customsDeclarationNo: "25-0401-000005",
        warehouseId: null,
        items: [makeItem({ vatAmount: D("0"), lineTotal: D("80497.70") })],
        netTotal: D("80497.70"),
        vatTotal: D("0"),
        grossTotal: D("80497.70"),
        ...over,
      });

    it("štampa engleski obrazac sa `Stat. goods No.` i carinskom tarifom", async () => {
      const out = await build(inoRoba());
      expect(out.body).toContain("Invoice No. 228/25");
      expect(out.body).toContain("Catalog No.");
      expect(out.body).toContain("Stat. goods No.");
      expect(out.body).toContain("84314980");
      expect(out.body).toContain("TOTAL AMOUNT ( EUR)");
      expect(out.body).toContain(
        "Napomena o poreskom oslobodjenju: Oslobodjeno PDV na osnovu člana 24. stav 1 tačka 2 Zakona o PDV.",
      );
      // Domaći blokovi ne smeju da procure.
      expect(out.body).not.toContain("K u p a c:");
      expect(out.body).not.toContain("Tekući račun:");
    });

    /**
     * Regresija na zatečeni bag: grana za IBAN/SWIFT je postojala, ali ih `loadIssuer`
     * nikad nije popunjavao — nijedna ino faktura nije izašla sa instrukcijama za plaćanje.
     */
    it("ZAISTA štampa IBAN i SWIFT iz deviznog računa", async () => {
      const out = await build(inoRoba());
      expect(out.body).toContain("Beneficiary Customer:");
      expect(out.body).toContain("IBAN : RS35160005010003501186");
      expect(out.body).toContain("Bank of beneficiary:");
      expect(out.body).toContain("SWIFT: DBDBRSBG");
      expect(out.body).toContain("Banca Intesa a.d. EUR");
      expect(out.body).toContain("Republic of Serbia");
    });

    it("uzima engleski naziv artikla kad ga ima", async () => {
      const out = await build(inoRoba());
      expect(out.body).toContain("INSERT HME 212 EN");
    });

    it("broj izvozne deklaracije izlazi na papir", async () => {
      const out = await build(inoRoba());
      expect(out.body).toContain("25-0401-000005");
    });
  });

  describe("IZVUS → ino obrazac za uslugu (višestran)", () => {
    const inoUsluga = () =>
      makeInvoice({
        documentType: "IZVUS",
        documentNumber: "060/26",
        isExport: true,
        currency: "EUR",
        warehouseId: null,
        deliveryTerm: "FCA Dobanovci-Beograd",
        packageDescription: "1 paleta",
        packageDimensions: "400 x 800 x 2400 mm",
        grossWeightKg: D("1720"),
        netWeightKg: D("1700"),
        unloadingPlace: "Hidraulika Flex d.o.o.\nJovana Cvijića 3",
        forwarderContact: "Evrounija d.o.o., CI Banja Luka",
        items: [
          makeItem({
            itemId: 200,
            quantity: D("1"),
            unitPrice: D("10530.75"),
            vatBase: D("10530.75"),
            vatAmount: D("0"),
            lineTotal: D("10530.75"),
          }),
        ],
        netTotal: D("10530.75"),
        vatTotal: D("0"),
        grossTotal: D("10530.75"),
      });

    it("daje TRI strane — stavke, zbir + otprema, blok banke", async () => {
      const out = await build(inoUsluga());
      const pdf = await PDFDocument.load(out.buffer);
      expect(pdf.getPageCount()).toBe(3);
    }, 30000);

    it("ponavlja zaglavlje računa i zaglavlje tabele na svakoj strani", async () => {
      const out = await build(inoUsluga());
      expect(out.header).toMatch(/Invoice\s+No\.\s+060\/26/);
      expect(out.header).toContain("Date of delivery:");
      expect(out.header).toContain("Description");
      expect(out.header).toContain("Quantity");
      // Zaglavlje računa NIJE u telu — inače bi se odštampalo dvaput na prvoj strani.
      expect(out.body).not.toContain("Date of delivery:");
    });

    it("nosi „Strana X od Y“ dole desno i otpremni blok", async () => {
      const out = await build(inoUsluga());
      expect(out.footer).toContain("Strana 1 od 3");
      expect(out.body).toContain("Paritet: FCA Dobanovci-Beograd");
      expect(out.body).toContain("Ukupna brutto: 1.720,00 kg");
      expect(out.body).toContain(
        "Napomena: Oslobodjeno PDV-a na osnovu člana 24. stav 2 Zakona o pdv.",
      );
    });

    it("koristi svoje (visoke) margine, ostali obrasci ne", async () => {
      const ino = await build(inoUsluga());
      expect(ino.dd.pageMargins).toEqual([32, 200, 32, 104]);
      const domaci = await build(makeInvoice());
      expect(domaci.dd.pageMargins).toEqual([32, 104, 32, 96]);
      // „Strana X od Y" je samo na ino usluzi (GAP §5 t.12 — prelom domaćeg je otvoren).
      expect(domaci.footer).not.toContain("Strana");
    });
  });

  describe("memorandum", () => {
    // Ino vektori idu bez PDV-a: izvoz je oslobođen, a izvozni obrazac od 02.08.2026.
    // odbija da odštampa dokument sa obračunatim PDV-om (v. `assertExportWithoutVat`).
    const bezPdv = { netTotal: D("80497.70"), vatTotal: D("0"), grossTotal: D("80497.70") };
    it.each([
      ["IFR", {}],
      ["IFUSL", { documentType: "IFUSL" }],
      [
        "IZVRO",
        { documentType: "IZVRO", isExport: true, currency: "EUR", ...bezPdv },
      ],
      [
        "IZVUS",
        { documentType: "IZVUS", isExport: true, currency: "EUR", ...bezPdv },
      ],
    ])("stoji u zaglavlju i podnožju strane za %s", async (_type, over) => {
      const out = await build(makeInvoice(over));
      expect(out.header).toContain("Servoteh d.o.o. Dobanovci");
      expect(out.header).toContain("web:: www.servoteh.rs");
      expect(out.footer).toContain("Matični broj: 17400169");
      expect(out.footer).toContain("PIB: 101017443");
      expect(out.footer).toContain("google mapa");
      expect(out.footer).toContain("Agenciji za privredne registre");
    });

    /**
     * Zatečeni `buildHeader` je crtao logo u TELU dokumenta. Da je ostao, sa memorandumom
     * u `header:` funkciji bi na svakoj strani bila DVA logotipa.
     */
    it("logo je SAMO u zaglavlju strane, nijednom u telu", async () => {
      const out = await build(makeInvoice());
      expect(collectImages(out.dd.content)).toHaveLength(0);
      const headerFn = out.dd.header as (p: number, c: number) => unknown;
      // Zaglavlje nosi tačno dve slike: Servoteh logo i TÜV/ISO znak.
      expect(collectImages(headerFn(1, 1))).toHaveLength(2);
    });
  });

  describe("podaci stavke", () => {
    it("kolona VREDNOST nosi iznos BEZ PDV-a (`vatBase`), ne `lineTotal` iz baze", async () => {
      const out = await build(makeInvoice());
      expect(out.body).toContain("80,497.70");
      // 96.597,24 je osnovica + PDV — to je „Za uplatu", ne vrednost stavke.
      expect(out.body).not.toMatch(/96,597\.24[\s\S]*Kat\. br\./);
    });

    it("j.m. se čita sa stavke, pa sa artikla", async () => {
      const saArtikla = await build(makeInvoice());
      expect(saArtikla.body).toContain("Kom");

      const saStavke = await build(
        makeInvoice({ items: [makeItem({ unit: "m2" })] }),
      );
      expect(saStavke.body).toContain("m2");
    });

    it("slobodna uslužna stavka (bez artikla) nosi svoj opis i svoju j.m.", async () => {
      const out = await build(
        makeInvoice({
          documentType: "IFUSL",
          items: [
            makeItem({
              itemId: null,
              description: "Servis hidrauličnog agregata",
              unit: "h",
            }),
          ],
        }),
      );
      expect(out.body).toContain("Servis hidrauličnog agregata");
      expect(out.body).toContain("h");
    });

    /**
     * 🔴 NALAZ S2 (šesti krug, 02.08.2026): STOPA I IZNOS SU DOLAZILI IZ DVA ŠIFARNIKA.
     *
     * Red „PDV po stopi {stopa}% X {osnovica} = {porez}" je i nastao zato da se ta
     * jednačina može proveriti na papiru — ali je `{stopa}` čitana iz tabele
     * `tax_rates` (baza), a `{porez}` iz mape `VAT_RATE_BY_CODE` (kod). Tabela `tax_rates`
     * NEMA SEED ni u jednoj migraciji i na produkciji ima **0 redova**, pa je stopa
     * ispadala `null → 0` i papir je štampao „PDV po stopi **0%** X 500,05 = 100,01".
     *
     * Lažni Prisma klijent zato NEMA `taxRate` (v. `makePrisma`): kad bi štampa i dalje
     * čitala bazu, ovaj test bi pukao na nepostojećoj metodi umesto da odštampa nulu.
     */
    it("stopa PDV-a dolazi iz ISTE mape kao i iznos — i bez ijednog reda u `tax_rates`", async () => {
      const out = await build(makeInvoice());
      expect(out.body).toContain("20%");
      expect(out.body).toContain("PDV po stopi 20% X 80,497.70 =");
      expect(out.body).not.toContain("PDV po stopi 0% X");
    });

    /**
     * CENA PRE RABATA ZAISTA STIŽE DO PAPIRA (02.08.2026).
     *
     * Kolona `invoice_items.unit_price_before_discount` postoji, ali dok je učitavanje ne
     * prosledi u `PrintCtx`, štampa je ne vidi — a rabat od 100 % se bez nje ne može
     * izračunati. Ovaj test cilja baš tu sponu: 10 kom × 1.000,00 uz rabat 100 %, osnovica
     * 0,00 → red „Rabat" mora da pokaže 10.000,00, a ne 0,00.
     */
    it("cena PRE rabata sa stavke stiže do reda „Rabat“ (rabat 100 %)", async () => {
      const out = await build(
        makeInvoice({
          netTotal: D("0"),
          vatTotal: D("0"),
          grossTotal: D("0"),
          items: [
            makeItem({
              quantity: D("10"),
              unitPrice: D("0"),
              unitPriceBeforeDiscount: D("1000.00"),
              discountPercent: D("100"),
              vatBase: D("0"),
              vatAmount: D("0"),
              lineTotal: D("0"),
            }),
          ],
        }),
      );
      expect(out.body).toContain("10,000.00");
    });

    /**
     * KOEFICIJENT DOKUMENTA (§8/O1) važi i za punu cenu. U bazi je ona, kao i
     * `base_unit_price`, zapisana PRE koeficijenta; `unitPrice` je već pomnožen. Da
     * učitavanje koeficijent zaboravi, bruto bi bio manji od osnovice i „Rabat" bi na
     * papiru ispao negativan.
     */
    it("koeficijent dokumenta se primenjuje i na cenu PRE rabata", async () => {
      const out = await build(
        makeInvoice({
          priceCoefficient: D("1.1"),
          netTotal: D("9900.00"),
          vatTotal: D("1980.00"),
          grossTotal: D("11880.00"),
          items: [
            makeItem({
              quantity: D("10"),
              // 900,00 × 1,1 — cena posle rabata i posle koeficijenta.
              unitPrice: D("990.00"),
              // 1.000,00 PRE koeficijenta → bruto 10 × 1.100 = 11.000,00.
              unitPriceBeforeDiscount: D("1000.00"),
              discountPercent: D("10"),
              vatBase: D("9900.00"),
              vatAmount: D("1980.00"),
              lineTotal: D("11880.00"),
            }),
          ],
        }),
      );
      expect(out.body).toContain("11,000.00"); // bruto
      expect(out.body).toContain("1,100.00"); // rabat = 11.000 − 9.900
    });
  });

  /**
   * ODBIJENI AVANSI DO PAPIRA (02.08.2026) — spona koju šabloni ne mogu da dokažu sami:
   * oni crtaju ono što im `PrintCtx` donese, a kvar je bio baš u tome ŠTA im se donosi.
   *
   * Do ove izmene je učitavanje slalo `advanceInvoiceNumber` (broj iz kolone
   * `advance_invoice_id`, koja se upisuje SAMO pri prvoj primeni), a obrazac je uz njega
   * štampao `advanceAppliedAmount` = zbir SVIH primena. Opšti renderer (AVR/KO/KZ) je tu
   * grešku već imao ispravljenu — četiri obrasca su je zaobišla kroz `PrintCtx`.
   */
  describe("odbijeni avansi (N:M) na donetom obrascu", () => {
    const saAvansom = (over: Record<string, unknown> = {}) =>
      makeInvoice({
        netTotal: D("10000.00"),
        vatTotal: D("0"),
        grossTotal: D("10000.00"),
        items: [
          makeItem({
            quantity: D("1"),
            unitPrice: D("10000.00"),
            vatBase: D("10000.00"),
            vatAmount: D("0"),
            lineTotal: D("10000.00"),
          }),
        ],
        ...over,
      });

    /** Izmereni ulaz: račun 10.000 zatvara `A-1/26` (3.000) i `A-2/26` (2.000). */
    it("dva avansa → dva reda; nijedan ne nosi tuđi zbir", async () => {
      const out = await build(
        saAvansom({ advanceInvoiceId: 55, advanceAppliedAmount: D("5000.00") }),
        undefined,
        [
          makeApplication("A-1/26", "3000.00", 55),
          makeApplication("A-2/26", "2000.00", 56),
        ],
      );
      const lines = out.body.split("\n");
      const prvi = lines.indexOf("Umanjenje za primljeni avans (br. A-1/26):");
      const drugi = lines.indexOf("Umanjenje za primljeni avans (br. A-2/26):");
      expect(prvi).toBeGreaterThanOrEqual(0);
      expect(drugi).toBeGreaterThan(prvi);
      expect(lines[prvi + 1]).toBe("− 3,000.00");
      expect(lines[drugi + 1]).toBe("− 2,000.00");
      // Ono što je papir tvrdio pre ispravke: jedan broj uz zbir svih primena.
      expect(out.body).not.toContain("− 5,000.00");
      // `A-1/26` ima i vezu u koloni i svoj red u spojnoj tabeli — sme samo JEDNOM.
      expect(
        lines.filter((l) =>
          l.startsWith("Umanjenje za primljeni avans (br. A-1/26)"),
        ),
      ).toHaveLength(1);
    });

    /**
     * 🔴 IZMEREN KVAR (treći krug): pdv modul (`link-final`) veže avans upisom u kolone
     * `advance_invoice_id` + `advance_applied_amount`, BEZ reda u spojnoj tabeli. Kad na
     * isti račun stigne i N:M primena, kolona nosi UNIJU (5.000), a spojna tabela samo
     * 2.000. Dok je učitavanje radilo „ima primena → kolona se ne gleda", papir je tražio
     * 8.000 umesto 5.000, a `A-1/26` na njemu nije postojao — kupcu je poslat VEĆI dug
     * nego što ga ima, i to sa poreskim dokumentom koji prećutkuje jedan avans.
     *
     * Pravilo je UNIJA — isto ono iz `advance-invoice.service.ts` i `advance-vat.service.ts`.
     */
    it("stara veza iz kolone se štampa kao SVOJ red uz N:M primenu", async () => {
      const out = await build(
        saAvansom({ advanceInvoiceId: 55, advanceAppliedAmount: D("5000.00") }),
        undefined,
        [makeApplication("A-2/26", "2000.00", 56)],
      );
      const lines = out.body.split("\n");
      // Stara veza je hronološki prva (`advance_invoice_id` se upisuje pri PRVOM vezivanju).
      const prvi = lines.indexOf("Umanjenje za primljeni avans (br. A-1/26):");
      const drugi = lines.indexOf("Umanjenje za primljeni avans (br. A-2/26):");
      expect(prvi).toBeGreaterThanOrEqual(0);
      expect(drugi).toBeGreaterThan(prvi);
      // 5.000 − 2.000: iznos stare veze se IZVODI iz kolone, ne uzima cela kolona.
      expect(lines[prvi + 1]).toBe("− 3,000.00");
      expect(lines[drugi + 1]).toBe("− 2,000.00");
      // 10.000,00 − 3.000,00 − 2.000,00 — tačno onoliko koliko kupac duguje.
      expect(lines[lines.indexOf("Za uplatu (RSD):") + 1]).toBe("5,000.00");
    });

    /**
     * Kolona ume da zaostane za spojnom tabelom (ručna ispravka u bazi, storno primene).
     * Razlika `kolona − Σ primena` je tada nula ili negativna — papir NE SME da izmisli
     * red umanjenja od 0,00 ni da oduzme minus (koji bi kupcu povećao dug).
     */
    it("zaostala kolona ne pravi lažni red umanjenja", async () => {
      const out = await build(
        saAvansom({ advanceInvoiceId: 55, advanceAppliedAmount: D("2000.00") }),
        undefined,
        [makeApplication("A-2/26", "2000.00", 56)],
      );
      const lines = out.body.split("\n");
      expect(out.body).not.toContain(
        "Umanjenje za primljeni avans (br. A-1/26):",
      );
      expect(lines[lines.indexOf("Za uplatu (RSD):") + 1]).toBe("8,000.00");
    });

    /**
     * Rezerva za dokumente knjižene PRE N:M migracije: veza postoji samo u koloni
     * `advance_invoice_id`, spojna tabela je prazna. Papir i dalje mora da nosi broj
     * avansa i iznos iz kolone.
     */
    it("bez ijedne primene pada na zatečenu 1:1 vezu iz kolone", async () => {
      const out = await build(
        saAvansom({ advanceInvoiceId: 55, advanceAppliedAmount: D("3000.00") }),
        undefined,
        [],
      );
      const lines = out.body.split("\n");
      const at = lines.indexOf("Umanjenje za primljeni avans (br. A-1/26):");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines[at + 1]).toBe("− 3,000.00");
      expect(lines[lines.indexOf("Za uplatu (RSD):") + 1]).toBe("7,000.00");
    });
  });

  describe("vrste bez donetog obrasca i nepoznate vrste", () => {
    it("predračun (PROF) se štampa na najbližem obrascu UZ upozorenje", async () => {
      const out = await build(
        makeInvoice({ documentType: "PROF", documentNumber: "12/26" }),
      );
      expect(out.warnings.join("\n")).toMatch(/PROF/);
      expect(out.warnings.join("\n")).toMatch(/nema doneti/i);
      // Papir i dalje izlazi — štampa predračuna se ne obara.
      expect(out.body).toContain("Kat. br.");
    });

    it("nepoznata vrsta BACA umesto da tiho odabere pogrešan obrazac", async () => {
      const prisma = makePrisma(makeInvoice({ documentType: "XYZ" }));
      const service = new InvoicePdfService(
        prisma as unknown as PrismaService,
        new PdfService(),
        new BarcodeService(),
      );
      await expect(service.buildInvoicePdf(1)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      await expect(service.buildInvoicePdf(1)).rejects.toThrow(/XYZ/);
    });

    it("račun koji ne postoji i dalje daje 404", async () => {
      const prisma = makePrisma(makeInvoice());
      const service = new InvoicePdfService(
        prisma as unknown as PrismaService,
        new PdfService(),
        new BarcodeService(),
      );
      await expect(service.buildInvoicePdf(999)).rejects.toThrow(/ne postoji/);
    });
  });

  describe("varijante i pozivaoci", () => {
    it("otpremnica (`withoutPrices`) izostavlja novčane kolone i zbir", async () => {
      const out = await build(makeInvoice(), "withoutPrices");
      expect(out.fileName).toBe("OTP-657-25.pdf");
      expect(out.body).toContain("N A Z I V   R O B E");
      expect(out.body).not.toContain("C E N A");
      expect(out.body).not.toContain("Za uplatu (RSD):");
    });

    it("`buildDeliveryNotePdf` i dalje daje otpremnicu", async () => {
      const prisma = makePrisma(makeInvoice());
      const pdf = new PdfService();
      const service = new InvoicePdfService(
        prisma as unknown as PrismaService,
        pdf,
        new BarcodeService(),
      );
      const { fileName } = await service.buildDeliveryNotePdf(1);
      expect(fileName).toBe("OTP-657-25.pdf");
    }, 30000);

    /**
     * 🔴 NALAZ Z1 (sedmi krug, 02.08.2026) — KONTROLNI RED NA DONESENOM OBRASCU.
     *
     * Rekapitulacija sa kontrolnim redom postoji samo na opštem rendereru (AVR/KO/KZ), a
     * REDOVAN račun se štampa baš ovde. Dok su grupe ćutke preuzimale `vat_total`, papir
     * je uvek „zatvarao"; od kad se preuzima samo na dokumentu koji porez izvodi iz bruta,
     * pogrešan `vat_total` daje `osnovica + Σ PDV redova ≠` uokvireno „Za uplatu" — a bez
     * ovog reda nigde ne bi pisalo zašto.
     *
     * ULAZ: osnovica 80.497,70 uz 20 % → tačan porez 16.099,54; zaglavlje nosi 16.098,54.
     * Zaglavlje je INTERNO DOSLEDNO (`bruto = neto + porez`) — baš zato ga staro merilo
     * (`Σosn + Σpdv − bruto`) nije moglo videti: taj izraz je bio identički nula.
     */
    it("🔴 Z1 — pogrešan `vat_total` daje kontrolni red, a redovi TAČAN porez", async () => {
      const out = await build(
        makeInvoice({
          vatTotal: D("16098.54"),
          grossTotal: D("96596.24"),
        }),
      );
      expect(out.body).toContain("PDV po stopi 20% X 80,497.70 =");
      expect(out.body).toContain("16,099.54"); // NE 16.098,54
      expect(out.body).toContain("NEUSKLAĐENO");
      // Natpis imenuje OBE strane: osnovica se poklapa, porez ne (u zbiru bi se poništili).
      expect(out.body).toContain("osnovica 0.00");
      expect(out.body).toContain("PDV 1.00");
    }, 30000);

    it("zdrav račun nema kontrolni red (crveno se pali samo kad ima zašto)", async () => {
      const out = await build(makeInvoice());
      expect(out.body).not.toContain("NEUSKLAĐENO");
    }, 30000);

    /**
     * `buildExportInvoicePdf` je ostao zbog rute `?variant=export`, ali obrazac više ne
     * bira on nego vrsta dokumenta — na domaćem računu namerno daje DOMAĆI papir.
     */
    it("`buildExportInvoicePdf` na domaćem računu daje domaći obrazac", async () => {
      const prisma = makePrisma(makeInvoice());
      const pdf = new PdfService();
      let captured: TDocumentDefinitions | undefined;
      jest.spyOn(pdf, "render").mockImplementation((dd) => {
        captured = dd;
        return Promise.resolve(Buffer.from("%PDF-"));
      });
      const service = new InvoicePdfService(
        prisma as unknown as PrismaService,
        pdf,
        new BarcodeService(),
      );
      await service.buildExportInvoicePdf(1);
      const body = collectText(captured?.content).join("\n");
      expect(body).toContain("K u p a c:");
      expect(body).not.toContain("Invoice No.");
    });
  });
});
