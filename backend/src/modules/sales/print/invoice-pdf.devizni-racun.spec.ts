import { UnprocessableEntityException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
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
    invoiceAdvanceApplication: {
      findMany: jest.fn(() => Promise.resolve([])),
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
  warnings: string[];
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
  const warnings: string[] = [];
  jest
    .spyOn(
      (service as unknown as { logger: { warn: (m: string) => void } }).logger,
      "warn",
    )
    .mockImplementation((m: string) => {
      warnings.push(String(m));
    });
  return { service, captured: () => captured, warnings };
}

/** Poruka izuzetka, bez obzira na vrstu — za tvrdnje „koji je uzrok imenovan". */
async function errorMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("Očekivan je izuzetak, a poziv je prošao.");
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
   * 🔴 NALAZ N6 (02.08.2026): prvi krug izbora je uzimao PRVI red čija se valuta poklapa i
   * tu stao — pa ako je baš taj bio prazan, drugi krug („bilo koji sa bankarskim
   * podacima") se uopšte nije izvršio.
   *
   * IZMEREN ULAZ: EUR faktura; red A `currency='EUR'` bez IBAN-a i SWIFT-a (nastane sam od
   * sebe — dovoljno je uneti valutu i naziv banke pa snimiti), red B `currency=null` sa
   * punim IBAN-om i SWIFT-om. Ishod je bio 422 „za valutu EUR nije unet IBAN ni SWIFT/BIC",
   * nad bazom u kojoj podatak POSTOJI i vidi se u Podešavanjima — operater nema šta da
   * ispravi.
   */
  it("prazan račun u valuti fakture ne sme da zakloni popunjen račun", async () => {
    const prazanEur = {
      iban: null,
      swift: null,
      bankName: "Banca Intesa a.d.",
      bankAddress: null,
      currency: "EUR",
      isDefault: true,
      sortOrder: 0,
    };
    const punBezValute = { ...EUR_RACUN, currency: null, isDefault: false, sortOrder: 1 };
    const prisma = makePrisma(makeExportInvoice(), [prazanEur, punBezValute]);
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).toContain("SWIFT: DBDBRSBG");
  });

  /**
   * 🔴 NALAZ N7 (02.08.2026): `composeBankName` NAMERNO ne lepi valutu kad izabrani račun
   * nije u valuti fakture, ali je ino ROBA valutu posle toga lepila ponovo i bez tog
   * uslova. IZMEREN ISHOD: USD faktura koja padne na EUR račun (drugi krug izbora) dobijala
   * je red „Banca Intesa a.d. EUR" uz taj IBAN, dakle valutu koja nije valuta fakture ni
   * dokaz da je račun u njoj. Ino USLUGA valutu nije lepila uopšte — isti podaci, dva reda.
   */
  it("naziv banke ne dobija valutu kad račun nije u valuti fakture", async () => {
    const prisma = makePrisma(
      makeExportInvoice({ currency: "USD" }),
      [EUR_RACUN],
    );
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).toContain("Banca Intesa a.d.");
    expect(body).not.toContain("Banca Intesa a.d. EUR");
    expect(body).not.toContain("Banca Intesa a.d. USD");
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

/**
 * ⚠️ DRUGA STRANA BRANE (02.08.2026): brana za IBAN je bila SUVIŠE ŠIROKA i ostavljala
 * bez papira dokumente kojima bankarske instrukcije uopšte ne trebaju.
 *
 * `loadForeignAccount` za valutu RSD namerno preskače i drugi krug i rezervu sa firme
 * (dinarskom dokumentu se ne sme podmetnuti devizni IBAN), ali je `assertBankDetails`
 * ipak pucao — pa je poruka slala operatera u „Podešavanja → Firma → Devizni računi",
 * gde problem NE MOŽE da se reši: i uredno upisan IBAN se za RSD ne čita.
 */
describe("brana za IBAN ne sme da zaustavi papir kome banka ne treba", () => {
  /**
   * IZMEREN VEKTOR: domaći predračun (RSD) → `from-proforma` → IZVRO. Carry-over
   * postavi `isExport`, a valutu ostavi dinarsku; `companies.iban/swift` su uredno uneti.
   * Do ispravke: 422 „za valutu RSD nije unet IBAN…". Sada: papir izlazi.
   */
  it("IZVRO u dinarima se ODŠTAMPA (i kad su podaci firme uredno uneti)", async () => {
    const prisma = makePrisma(
      makeExportInvoice({ currency: "RSD" }),
      [RSD_RACUN],
      {
        ...COMPANY_BEZ_DEVIZNIH,
        iban: "RS35160005010003501186",
        swift: "DBDBRSBG",
      },
    );
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).resolves.toBeDefined();
  });

  it("IZVRO u dinarima izlazi i bez ijednog bankarskog podatka", async () => {
    const prisma = makePrisma(makeExportInvoice({ currency: "RSD" }), []);
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).resolves.toBeDefined();
  });

  /**
   * 🔴 IZMEREN KVAR (treći krug): `IZVRO 228/25` u RSD, sa OBIČNIM DINARSKIM redom u
   * `payment_accounts` (iban/swift `null`, `bankName` popunjen) — dakle onim što BigBit
   * sync donese sam od sebe — štampao je zaglavlja „Beneficiary Customer:" i „Bank of
   * beneficiary:" i naziv banke, a NIJEDAN broj računa: IBAN i SWIFT su prazni, a domaći
   * `bankAccount` ino obrazac nikad ne štampa. To je baš artefakt zbog kog je brana i
   * pisana — papir izgleda ispravno, a kupac nema gde da uplati.
   *
   * ODLUKA: blok izostaje u celini. Naziv banke bez broja računa nije upotrebljiv podatak,
   * a dinarski dokument uplatu prima na domaći tekući račun, koji na ino obrascu nema šta
   * da traži (STAMPA_IZLAZNIH_FAKTURA.md §6 t.3, „nikad oboje na istom papiru").
   */
  it("dinarski račun bez IBAN-a ne sme da odštampa prazan blok banke", async () => {
    const prisma = makePrisma(makeExportInvoice({ currency: "RSD" }), [
      RSD_RACUN,
    ]);
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).not.toContain("Beneficiary Customer:");
    expect(body).not.toContain("Bank of beneficiary:");
    // Naziv banke je jedini podatak koji je taj red imao — bez broja računa ne izlazi.
    expect(body).not.toContain("Banca Intesa");
    // Papir i dalje postoji i pošteno kaže u kojoj je valuti.
    expect(body).toContain("TOTAL AMOUNT ( RSD)");
  });

  /**
   * Ista provera na ino USLUZI, gde je posledica bila i vidljivija: blok banke tamo ima
   * SVOJU stranu (`pageBreak: "before"`), pa je dokument bez IBAN-a dobijao celu treću
   * stranu sa dve prazne labele.
   */
  it("ino usluga bez IBAN-a nema stranu banke (nema prazne treće strane)", async () => {
    const prisma = makePrisma(
      makeExportInvoice({
        documentType: "IZVUS",
        documentNumber: "060/26",
        currency: "RSD",
      }),
      [RSD_RACUN],
    );
    const { service, captured } = makeService(prisma);

    const { buffer } = await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).not.toContain("Beneficiary Customer:");
    expect(body).not.toContain("Bank of beneficiary:");
    const pdf = await PDFDocument.load(buffer);
    expect(pdf.getPageCount()).toBe(2);
  }, 30000);

  /**
   * Izvozni dokument u domaćoj valuti je sumnjivo stanje i mora da bude IMENOVANO —
   * ali upozorenjem, jer bi izuzetak značio dokument bez papira.
   */
  it("dinarski izvozni dokument dobija jasno upozorenje o pravom stanju", async () => {
    const prisma = makePrisma(makeExportInvoice({ currency: "RSD" }), []);
    const { service, warnings } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const joined = warnings.join("\n");
    expect(joined).toContain("228/25");
    expect(joined).toContain("IZVOZNI, a valuta mu je domaća (RSD)");
    // Poruka NE sme da pominje unos IBAN-a — to ovde nije ni uzrok ni lek.
    expect(joined).not.toContain("Devizni računi");
  });

  /**
   * Revers je zapis o zaduženju/vraćanju opreme — po njemu se ne uplaćuje ništa, pa mu
   * bankarske instrukcije ne trebaju. Na ino obrazac pada samo kroz `resolveForm` fallback
   * (papir mu nije ni donet), a ostati bez papira bi za njega bila čista šteta.
   */
  it("izvozni revers se štampa bez deviznog računa", async () => {
    const prisma = makePrisma(
      makeExportInvoice({ documentType: "REV", documentNumber: "8/26" }),
      [],
    );
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).resolves.toBeDefined();
  });

  /**
   * 🔴 NALAZ N9 (02.08.2026): revers je bio izuzet od brane za IBAN, ali NIJE od
   * `assertExportWithoutVat` — spisak izuzetih vrsta postojao je u dva primerka, pa je
   * važio samo za jednu branu. Revers nastao prepisom (`carry-over`) nosi PREPISAN
   * `vatTotal` sa izvorne fakture i, ako je uz to `isExport`, pada na ino obrazac kroz
   * `resolveForm` fallback — pa je ostajao bez papira zbog PDV-a koji na njemu nikoga ne
   * obavezuje: po reversu se ne uplaćuje ništa.
   */
  it("izvozni revers sa prepisanim PDV-om se ipak štampa", async () => {
    const prisma = makePrisma(
      makeExportInvoice({
        documentType: "REV",
        documentNumber: "8/26",
        vatTotal: D("2106.15"),
        grossTotal: D("12636.90"),
      }),
      [EUR_RACUN],
    );
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).resolves.toBeDefined();
  });

  /**
   * 🔴 NALAZ N5 (02.08.2026): u šablonu je uslov za blok banke bio „IBAN ILI SWIFT", pa je
   * SWIFT SAM otvarao ceo blok — a SWIFT je oznaka BANKE, ne broj računa. Dinarski red iz
   * `payment_accounts` sa unetim SWIFT-om (banka ga ima, broj računa je domaći i na ino
   * obrazac ne ide) davao je papir sa „Beneficiary Customer:", imenom banke i SWIFT-om, a
   * nijednim brojem na koji kupac uplaćuje. Brana `requireBankDetails` ovde ne važi (RSD),
   * pa je jedina odbrana sam obrazac.
   */
  it("SWIFT bez IBAN-a ne otvara blok banke (dinarski izvozni dokument)", async () => {
    const prisma = makePrisma(makeExportInvoice({ currency: "RSD" }), [
      { ...RSD_RACUN, swift: "DBDBRSBG" },
    ]);
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");

    expect(body).not.toContain("Beneficiary Customer:");
    expect(body).not.toContain("Bank of beneficiary:");
    expect(body).not.toContain("DBDBRSBG");
  });

  /**
   * 🔴 IZMEREN KVAR (treći krug): brana je gledala SPISAK VRSTA (IZVRO/IZVGP/IZVUS), pa su
   * `PROF` i `PON` sa `isExport` prolazili kroz `resolveForm` fallback pravo na ino obrazac
   * i zaobilazili je. Izmereno: `PROF-12/26`, EUR, bez ijednog reda u `payment_accounts` →
   * PDF se napravi, a bloka `Beneficiary Customer:` / IBAN / SWIFT NEMA UOPŠTE.
   *
   * A PREDRAČUN U EUR JE TAČNO DOKUMENT PO KOME STRANI KUPAC PLAĆA — po njemu se novac
   * šalje pre isporuke. Merilo brane je zato valuta i cene, ne vrsta dokumenta.
   */
  it.each([
    ["predračun", "PROF", "12/26"],
    ["ponuda", "PON", "5/26"],
  ])(
    "izvozni %s u EUR bez deviznog računa PUCA (po njemu se plaća)",
    async (_n, type, number) => {
      const prisma = makePrisma(
        makeExportInvoice({ documentType: type, documentNumber: number }),
        [],
      );
      const { service } = makeService(prisma);

      await expect(service.buildInvoicePdf(1)).rejects.toThrow(
        UnprocessableEntityException,
      );
      await expect(service.buildInvoicePdf(1)).rejects.toThrow(
        /Podešavanja → Firma → Devizni računi/,
      );
    },
  );

  /** Ista ta vrsta sa urednim deviznim računom izlazi, i nosi instrukcije za uplatu. */
  it("izvozni predračun sa deviznim računom izlazi SA instrukcijama", async () => {
    const prisma = makePrisma(
      makeExportInvoice({ documentType: "PROF", documentNumber: "12/26" }),
      [EUR_RACUN],
    );
    const { service, captured } = makeService(prisma);

    await service.buildInvoicePdf(1);
    const body = collectText(captured()?.content).join("\n");
    expect(body).toContain("IBAN : RS35160005010003501186");
    expect(body).toContain("SWIFT: DBDBRSBG");
  });

  /** Predračun bez cena (otpremnica) i dalje ne traži ništa — nema iznos za uplatu. */
  it("izvozni predračun bez cena se štampa i bez deviznog računa", async () => {
    const prisma = makePrisma(
      makeExportInvoice({ documentType: "PROF", documentNumber: "12/26" }),
      [],
    );
    const { service } = makeService(prisma);

    await expect(
      service.buildInvoicePdf(1, "withoutPrices"),
    ).resolves.toBeDefined();
  });

  /**
   * IZDATA izvozna faktura u stranoj valuti je JEDINI papir po kom strani kupac plaća —
   * na njoj brana ostaje. Ovo je granica: menja se samo valuta iz testa iznad.
   */
  it("IZVRO u EUR bez bankarskih podataka i dalje PUCA", async () => {
    const prisma = makePrisma(makeExportInvoice(), []);
    const { service } = makeService(prisma);

    await expect(service.buildInvoicePdf(1)).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  /**
   * REDOSLED BRANA: `loadPrintCtx` se izvršava PRE šablona, pa je brana za IBAN gutala
   * tačniju poruku `assertExportWithoutVat`. Operater je nad prepisanim domaćim
   * predračunom dobijao uputstvo za unos IBAN-a, umesto da mu se kaže da izvozna faktura
   * nosi obračunat PDV — a to je ono što se stvarno mora ispraviti.
   */
  it("izvozni dokument sa PDV-om imenuje PDV kao uzrok, ne prazan IBAN", async () => {
    const prisma = makePrisma(
      makeExportInvoice({
        currency: "EUR",
        vatTotal: D("2106.15"),
        grossTotal: D("12636.90"),
      }),
      [],
    );
    const { service } = makeService(prisma);

    const message = await errorMessage(service.buildInvoicePdf(1));
    expect(message).toContain("nosi obračunat PDV");
    expect(message).not.toContain("IBAN");
  });
});
