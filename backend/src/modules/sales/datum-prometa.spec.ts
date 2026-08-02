import { BadRequestException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { GlWriteService } from "../gl/gl-write.service";
import { ReservationService } from "../robno/reservation.service";
import { DocumentNumberSequenceService } from "./numbering.service";
import { PricingService } from "./pricing.service";
import { SefService } from "./sef/sef.service";
import { FakturisanjeService } from "./fakturisanje.service";
import { DocumentCarryOverService } from "./carry-over.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * DATUM PROMETA — ceo tok (mera M1 iz docs/FAKTURE_ZAKONSKA_USKLADJENOST.md).
 *
 * Nalaz N1 je bio: kolona za datum prometa postoji u šemi i tri obrasca je čitaju, ali
 * je NIJEDNA ruta ne upisuje → uvek `null` → obavezan element računa po Zakonu o PDV
 * strukturno nedostaje na svakoj fakturi. Ovi testovi su brana da se to ne vrati:
 *
 *   1) unos      — DTO polje stiže do baze,
 *   2) predračun — ostaje `null` kad nije unet (predračun prethodi prometu),
 *   3) knjiženje — podrazumeva se datum izdavanja, ali VIDLJIVO (WARN u logu),
 *   4) prepis    — predračun → račun prenosi datum (kao salespersonId/paymentMethod),
 *   5) značenje  — datum prometa ima TAČNO JEDNO ime u šemi: `Invoice.supplyDate`.
 */

const D = Prisma.Decimal;

const actor: AuthUser = {
  userId: 7,
  email: "fakturista@servoteh",
  role: "racunovodja",
  workerId: null,
};

interface PrismaMock {
  invoice: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  invoiceItem: { findMany: jest.Mock };
  customer: { findUnique: jest.Mock };
  journalEntry: { findMany: jest.Mock; findFirst: jest.Mock; create: jest.Mock };
  $executeRaw: jest.Mock;
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
}

function prismaMock(): PrismaMock {
  const mock: PrismaMock = {
    invoice: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      // `create`/`update` vraćaju ono što su primili — testovi gledaju ARGUMENT
      // (šta bi se upisalo), a ne izmišljeni povratni red.
      create: jest.fn().mockImplementation((args: { data: unknown }) => ({
        id: 1,
        items: [],
        ...(args.data as object),
      })),
      update: jest.fn().mockImplementation((args: { data: unknown }) => ({
        id: 1,
        items: [],
        ...(args.data as object),
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([]) },
    // Kupac bez kreditnog limita (assertCreditLimit propušta) i bez komercijaliste.
    customer: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 5, salespersonId: null, paymentMethod: "virmanom" }),
    },
    journalEntry: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 77 }),
    },
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([{ balance: new D(0) }]),
    $transaction: jest.fn(),
  };
  mock.$transaction.mockImplementation((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (tx: PrismaMock) => unknown)(mock),
  );
  return mock;
}

/** `data` prvog poziva mock-a `create`/`update` — ono što bi otišlo u bazu. */
function writtenData<T>(fn: jest.Mock): T {
  return (fn.mock.calls as unknown as [{ data: T }][])[0][0].data;
}

/** Proknjižen-spreman nacrt računa (level 0, DRAFT). */
function draftInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100,
    documentType: "IFR",
    documentNumber: "DRAFT-10",
    level: 0,
    status: "DRAFT",
    isLocked: false,
    companyId: 0,
    customerId: 5,
    documentDate: new Date("2026-07-05T00:00:00Z"),
    dueDate: null,
    supplyDate: null,
    currency: "RSD",
    isExport: false,
    workOrderId: null,
    stockDocumentId: null,
    netTotal: new D(10000),
    vatTotal: new D(2000),
    grossTotal: new D(12000),
    items: [
      { lineNo: 1, vatRateCode: "3", vatBase: new D(10000), vatAmount: new D(2000) },
    ],
    ...overrides,
  };
}

describe("Datum prometa — unos i knjiženje (FakturisanjeService)", () => {
  let service: FakturisanjeService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = prismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FakturisanjeService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PricingService,
          useValue: {
            priceItem: jest.fn().mockResolvedValue({
              quantity: new D(1),
              unitPrice: new D(10000),
              discountPercent: new D(0),
              cashDiscountPercent: new D(0),
              vatRateCode: "3",
              vatBase: new D(10000),
              vatAmount: new D(2000),
            }),
          },
        },
        {
          provide: DocumentNumberSequenceService,
          useValue: { next: jest.fn().mockResolvedValue("12/26") },
        },
        { provide: PostingEngineService, useValue: { postManualEntry: jest.fn() } },
        { provide: GlWriteService, useValue: { reverse: jest.fn() } },
        { provide: SefService, useValue: { enqueue: jest.fn() } },
        { provide: ReservationService, useValue: { release: jest.fn() } },
      ],
    }).compile();

    service = module.get(FakturisanjeService);
  });

  it("uneti datum prometa se UPISUJE na predračun (N1: ranije se gubio)", async () => {
    await service.createProforma(
      {
        customerId: 5,
        documentDate: "2026-07-01",
        supplyDate: "2026-06-28",
        items: [{ description: "Usluga", quantity: 1 }],
      },
      actor,
    );

    const data = writtenData<{ supplyDate: Date | null }>(prisma.invoice.create);
    expect(data.supplyDate).toEqual(new Date("2026-06-28"));
  });

  it("predračun BEZ unetog datuma prometa ostaje null — ne izmišlja se datum", async () => {
    // Predračun/ponuda se izdaje PRE prometa; podmetnut datum bi se prepisom preneo
    // na račun kao da je stvaran podatak.
    await service.createProforma(
      { customerId: 5, documentDate: "2026-07-01", items: [{ description: "Usluga", quantity: 1 }] },
      actor,
    );

    const data = writtenData<{ supplyDate: Date | null }>(prisma.invoice.create);
    expect(data.supplyDate).toBeNull();
  });

  it("neispravan datum prometa se odbija na validaciji", async () => {
    // validateCreateProforma pakuje SVE poruke u telo BadRequest-a (niz), pa se
    // proverava telo, ne `message` (koji je generički „Bad Request Exception").
    const call = service.createProforma(
      {
        customerId: 5,
        supplyDate: "nije-datum",
        items: [{ description: "Usluga", quantity: 1 }],
      },
      actor,
    );
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await call.catch((err: BadRequestException) => {
      expect(err.getResponse()).toMatchObject({
        message: expect.arrayContaining(["Datum prometa nije ispravan."]),
      });
    });
  });

  it("knjiženje BEZ unetog datuma prometa podrazumeva DATUM IZDAVANJA", async () => {
    const row = draftInvoiceRow({ supplyDate: null });
    prisma.invoice.findUnique.mockResolvedValue(row);

    await service.postInvoice(100, actor);

    const data = writtenData<{ supplyDate: Date }>(prisma.invoice.update);
    expect(data.supplyDate).toEqual(row.documentDate);
  });

  it("podrazumevanje NIJE tiho — piše WARN sa brojem računa", async () => {
    prisma.invoice.findUnique.mockResolvedValue(draftInvoiceRow({ supplyDate: null }));
    const warn = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);

    await service.postInvoice(100, actor);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("datum prometa"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("100"));
  });

  it("uneti datum prometa knjiženje NE pregazi datumom izdavanja", async () => {
    const entered = new Date("2026-06-28T00:00:00Z");
    prisma.invoice.findUnique.mockResolvedValue(
      draftInvoiceRow({ supplyDate: entered }),
    );

    await service.postInvoice(100, actor);

    const data = writtenData<{ supplyDate: Date }>(prisma.invoice.update);
    expect(data.supplyDate).toEqual(entered);
  });
});

describe("Datum prometa — prepis predračuna u račun (DocumentCarryOverService)", () => {
  let service: DocumentCarryOverService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = prismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentCarryOverService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(DocumentCarryOverService);
  });

  it("datum prometa se prenosi sa predračuna na račun (kao salespersonId/paymentMethod)", async () => {
    const supplyDate = new Date("2026-06-28T00:00:00Z");
    prisma.invoice.findUnique.mockResolvedValue({
      id: 10,
      level: 250,
      isLocked: false,
      linkedInvoiceDocId: null,
      companyId: 0,
      customerId: 5,
      dueDate: null,
      supplyDate,
      currency: "RSD",
      exchangeRate: new D(1),
      accountingExchangeRate: new D(1),
      fxInvoiceValue: null,
      netTotal: new D(10000),
      vatTotal: new D(2000),
      grossTotal: new D(12000),
      isExport: false,
      poNumber: null,
      salespersonId: null,
      paymentMethod: "virmanom",
      note: null,
      items: [],
    });

    await service.createInvoiceFromProforma(10, "IFR");

    const data = writtenData<{ supplyDate: Date | null }>(prisma.invoice.create);
    expect(data.supplyDate).toEqual(supplyDate);
  });
});

/**
 * JEDNO IME ZA JEDAN PODATAK — brana protiv ponovnog sudara (razrešeno 02.08.2026).
 *
 * Ime `deliveryDate` / kolona `delivery_date` je u ovom repou u jednom trenutku značilo
 * TRI stvari: datum prometa našeg računa, datum PRIJEMA ulazne fakture na SEF, i (u
 * paralelnoj grani) drugu kolonu za isti datum prometa. Prvi sudar je već proizveo
 * pogrešan zakonski rok od 15 dana na ulaznim fakturama.
 *
 * PRESUDA: ime prati značenje.
 *   • datum prometa   → `Invoice.supplyDate` / `supply_date` (jedina kolona za taj podatak),
 *   • prijem na SEF   → `SefIncomingInvoice.sefReceivedAt` / `sef_received_at`,
 *   • ime `deliveryDate` / `delivery_date` se NE koristi ni za šta.
 *
 * Test čita SAMU šemu (Prisma DMMF), pa pada čim neko vrati staro ime ili doda drugu
 * kolonu za isti podatak — bez obzira na to šta piše u komentarima.
 */
describe("Datum prometa — jedno ime za jedan podatak", () => {
  const models = Prisma.dmmf.datamodel.models;
  const fieldsNamed = (name: string) =>
    models
      .filter((m) => m.fields.some((f) => f.name === name))
      .map((m) => m.name);

  it("`supplyDate` postoji SAMO na Invoice i znači datum prometa", () => {
    expect(fieldsNamed("supplyDate")).toEqual(["Invoice"]);
  });

  it("ulazna SEF faktura nosi `sefReceivedAt` (prijem na SEF)", () => {
    const incoming = models.find((m) => m.name === "SefIncomingInvoice");
    expect(incoming).toBeDefined();
    const names = incoming?.fields.map((f) => f.name) ?? [];
    expect(names).toContain("sefReceivedAt");
    expect(names).not.toContain("supplyDate");
  });

  it("dvoznačno ime `deliveryDate` ne postoji nigde u šemi", () => {
    expect(fieldsNamed("deliveryDate")).toEqual([]);
  });

  it("kolona `delivery_date` ne postoji ni na jednoj tabeli", () => {
    const withColumn = models
      .filter((m) =>
        m.fields.some((f) => (f.dbName ?? f.name) === "delivery_date"),
      )
      .map((m) => m.name);
    expect(withColumn).toEqual([]);
  });
});
