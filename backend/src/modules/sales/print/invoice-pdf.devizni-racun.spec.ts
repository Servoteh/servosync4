import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { TDocumentDefinitions } from "pdfmake/interfaces";
import { BarcodeService } from "../../documents/barcode.service";
import { PdfService } from "../../documents/pdf.service";
import type { PrismaService } from "../../../prisma/prisma.service";
import { InvoicePdfService } from "./invoice-pdf.service";

/**
 * DEVIZNI RAČUN NA IZVOZNOJ FAKTURI — da podatak stvarno stigne do papira, i da njegov
 * IZOSTANAK ne prođe tiho.
 *
 * ZAŠTO ZASEBAN SPEC: kvar je bio lanac od tri karike koje su sve „postojale" a nijedna
 * nije radila — šablon je crtao blok banke, `PrintIssuer` je imao polja, kolone su dodate
 * migracijom, ali ih niko nije punio. Takav kvar se ne hvata testom obrasca (šablon dobije
 * podatke iz test-vektora i uredno ih nacrta) nego SAMO testom celog puta: baza → servis →
 * pdfmake stablo. Zato ovde ide pun `InvoicePdfService` nad lažnim Prisma klijentom.
 *
 * Dva stanja koja se dokazuju:
 *   1. devizni račun popunjen  → IBAN, SWIFT, banka i njena adresa IZLAZE na papir;
 *   2. devizni račun prazan    → štampa PUCA sa uputstvom gde se podatak unosi,
 *      umesto da izađe uredan PDF bez ijedne bankarske instrukcije.
 *
 * Drugo stanje je suština zadatka: dok je blok banke bio uslovan (`if (!iban && !swift)
 * return []`), izvozna faktura bez podataka za uplatu izgledala je savršeno ispravno.
 */

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);

const COMPANY_BEZ_DEVIZNIH = {
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
  aprText: "BD. 222785/2006",
  // Rezerva iz „Podešavanja → Firma" — prazna, da bi se merio SAMO devizni račun.
  iban: null,
  swift: null,
};

/** Devizni račun tačno kako je na donetom papiru (Invoice 228/25). */
const EUR_RACUN = {
  iban: "RS35160005010003501186",
  swift: "DBDBRSBG",
  bankName: "Banca Intesa a.d.",
  bankAddress: "Milentija Popovića 7b, 11070 New Belgrade\nRepublic of Serbia",
  currency: "EUR",
  isDefault: true,
  sortOrder: 0,
};

/** Dinarski račun bez ijednog deviznog podatka — ono što BigBit sync donese sam od sebe. */
const RSD_RACUN = {
  iban: null,
  swift: null,
  bankName: "Banca Intesa a.d.",
  bankAddress: null,
  currency: "RSD",
  isDefault: true,
  sortOrder: 0,
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

const ITEM = {
  id: 100,
  name: "INSERT HME 212",
  foreignName: "INSERT HME 212 EN",
  unit: "Kom",
  catalogNumber: "TO.44140391",
  customsTariff: "84314980",
};

/**
 * Izvozni račun u EUR. `vatTotal` je NULA jer izvoz nema PDV — to nije kozmetika testa
 * nego uslov obrasca (izvozni papir tvrdi da je promet oslobođen PDV-a).
 */
function makeExportInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    documentType: "IZVRO",
    documentNumber: "228/25",
    level: 0,
    companyId: 1,
    customerId: 10,
    documentDate: new Date(2025, 11, 25),
    dueDate: new Date(2025, 11, 25),
    supplyDate: new Date(2025, 11, 25),
    currency: "EUR",
    netTotal: D("10530.75"),
    vatTotal: D("0"),
    grossTotal: D("10530.75"),
    advanceInvoiceId: null,
    advanceAppliedAmount: D("0"),
    status: "POSTED",
    isExport: true,
    note: null,
    salespersonId: 7,
    warehouseId: null,
    fco: "magacin kupca",
    paymentMethod: "virmanom",
    shipmentMethod: "lično",
    customsDeclarationNo: "25-0401-000005",
    deliveryTerm: null,
    packageDescription: null,
    packageDimensions: null,
    grossWeightKg: null,
    netWeightKg: null,
    unloadingPlace: null,
    forwarderContact: null,
    items: [
      {
        id: 1,
        invoiceId: 1,
        lineNo: 1,
        itemId: 100,
        description: null,
        unit: null,
        quantity: D("1"),
        unitPrice: D("10530.75"),
        discountPercent: D("0"),
        cashDiscountPercent: D("0"),
        vatRateCode: "0",
        vatBase: D("10530.75"),
        vatAmount: D("0"),
        lineTotal: D("10530.75"),
        copiedFromItemId: null,
      },
    ],
    ...over,
  };
}

/** Lažni Prisma klijent — tačno one metode koje štampa zove. */
function makePrisma(
  invoice: Record<string, unknown>,
  accounts: unknown[],
  company: Record<string, unknown> = COMPANY_BEZ_DEVIZNIH,
) {
  return {
    invoice: {
      findUnique: jest.fn((args: { where: { id: number } }) =>
        Promise.resolve(args.where.id === invoice.id ? invoice : null),
      ),
    },
    customer: { findUnique: jest.fn(() => Promise.resolve(CUSTOMER)) },
    company: { findUnique: jest.fn(() => Promise.resolve(company)) },
    paymentAccount: { findMany: jest.fn(() => Promise.resolve(accounts)) },
    item: { findMany: jest.fn(() => Promise.resolve([ITEM])) },
    taxRate: { findMany: jest.fn(() => Promise.resolve([])) },
    salesperson: {
      findUnique: jest.fn(() =>
        Promise.resolve({ name: "Korkut", firstName: "Dragana" }),
      ),
    },
    documentType: {
      findUnique: jest.fn(() => Promise.resolve({ defaultWarehouseId: 0 })),
    },
    warehouse: { findUnique: jest.fn(() => Promise.resolve(null)) },
  };
}

/** Sav `text` iz pdfmake stabla — tvrdnje se pišu nad ravnim spiskom. */
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

const realPdf = new PdfService();

function makeService(prisma: ReturnType<typeof makePrisma>): {
  service: InvoicePdfService;
  captured: () => TDocumentDefinitions | undefined;
} {
  const pdf = new PdfService();
  let captured: TDocumentDefinitions | undefined;
  jest.spyOn(pdf, "render").mockImplementation(async (dd) => {
    captured = dd;
    return realPdf.render(dd);
  });
  const service = new InvoicePdfService(
    prisma as unknown as PrismaService,
    pdf,
    new BarcodeService(),
  );
  return { service, captured: () => captured };
}

describe("Izvozna faktura — devizni račun stiže do papira", () => {
  it("blok banke IZLAZI kad je devizni račun popunjen", async () => {
    const prisma = makePrisma(makeExportInvoice(), [EUR_RACUN]);
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).toContain("Beneficiary Customer:");
    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).toContain("Bank of beneficiary:");
    expect(body).toContain("SWIFT: DBDBRSBG");
    // Naziv banke nosi valutu dokumenta („Banca Intesa a.d. EUR") — spaja ih `loadIssuer`.
    expect(body).toContain("Banca Intesa a.d. EUR");
    // Adresa banke je višered; drugi red mora da preživi prelom.
    expect(body).toContain("Milentija Popovića 7b, 11070 New Belgrade");
    expect(body).toContain("Republic of Serbia");
  });

  /**
   * SUŠTINA ZADATKA. Bez brane ovo bi vratilo uredan PDF bez ijedne bankarske
   * instrukcije — papir koji izgleda ispravno, a kupac nema gde da plati.
   */
  it("izostanak NE prolazi tiho — štampa puca sa uputstvom gde se unosi", async () => {
    const prisma = makePrisma(makeExportInvoice(), [RSD_RACUN]);
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).rejects.toThrow(
      UnprocessableEntityException,
    );
    await expect(service.buildInvoicePdf(1)).rejects.toThrow(
      /Podešavanja → Firma → Devizni računi/,
    );
  });

  it("poruka imenuje ŠTA fali i za koju valutu", async () => {
    const prisma = makePrisma(makeExportInvoice(), []);
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).rejects.toThrow(/IBAN/);
    await expect(service.buildInvoicePdf(1)).rejects.toThrow(/SWIFT\/BIC/);
    await expect(service.buildInvoicePdf(1)).rejects.toThrow(/valutu EUR/);
  });

  it("SWIFT bez IBAN-a je i dalje nepotpun — traži se oboje", async () => {
    const prisma = makePrisma(makeExportInvoice(), [
      { ...EUR_RACUN, iban: null },
    ]);
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).rejects.toThrow(/IBAN/);
  });

  /**
   * Rezerva iz „Podešavanja → Firma → Podaci za plaćanje". Ta dva polja se unose od
   * 27.07.2026, ali ih ovaj obrazac nije čitao — administrator je mogao uredno da ih
   * upiše i da NIŠTA ne stigne na papir. Sada su poslednja odbrana pre greške.
   */
  it("kad devizni račun nije unet, uzima IBAN/SWIFT sa podataka firme", async () => {
    const prisma = makePrisma(makeExportInvoice(), [RSD_RACUN], {
      ...COMPANY_BEZ_DEVIZNIH,
      iban: "RS35160005010003501186",
      swift: "DBDBRSBG",
    });
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).toContain("SWIFT: DBDBRSBG");
  });

  /**
   * Uredno popunjen devizni račun NE SME da bude potisnut starijim podatkom sa firme —
   * inače bi pun blok (sa bankom i adresom) tiho pao na krnji.
   */
  it("devizni račun ima prednost nad rezervom sa firme", async () => {
    const prisma = makePrisma(makeExportInvoice(), [EUR_RACUN], {
      ...COMPANY_BEZ_DEVIZNIH,
      iban: "RS35265000000247149695",
      swift: "RZBSRSBG",
    });
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).not.toContain("RZBSRSBG");
  });

  /**
   * Otpremnica (`withoutPrices`) na sebi nema nijedan iznos, pa ni podatke za uplatu ne
   * očekuje. Blokirati njeno štampanje zbog praznog IBAN-a značilo bi zaustaviti isporuku
   * robe zbog polja u podešavanjima — zato brana važi samo za račun SA cenama.
   */
  it("otpremnica bez cena se štampa i bez deviznog računa", async () => {
    const prisma = makePrisma(makeExportInvoice(), [RSD_RACUN]);
    const { service } = makeService(prisma);

    await expect(
      service.buildInvoicePdf(1, "withoutPrices"),
    ).resolves.toBeDefined();
  });

  /** Domaći račun blok banke nema — brana ne sme da ga dotakne. */
  it("domaći račun se štampa bez ijednog deviznog podatka", async () => {
    const prisma = makePrisma(
      makeExportInvoice({
        documentType: "IFUSL",
        documentNumber: "653/25",
        isExport: false,
        currency: "RSD",
      }),
      [RSD_RACUN],
    );
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).resolves.toBeDefined();
  });
});
