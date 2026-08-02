import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { SefService } from "./sef.service";

/**
 * SEF ENQUEUE — AVANS NA E-FAKTURI (ispravka N4, 02.08.2026).
 * =============================================================================
 * `PrepaidAmount` i `cac:BillingReference` opisuju ISTU činjenicu: „ovoliko je već
 * plaćeno, po ovom avansnom računu". Do ove ispravke su se razdvajali — reference su
 * se filtrirale (`.filter(Boolean)`), a iznos je i dalje išao ceo. Rezultat: e-faktura
 * tvrdi avansnu uplatu koju ne referencira nijedan dokument.
 *
 * Do toga se dolazi bez ijedne greške korisnika: `invoices.advance_invoice_id` je MEK
 * ref (nema FK), a spojna tabela ima ON DELETE CASCADE — obrisan AVR (čišćenje
 * test-podataka 4.0) ostavlja pokazivač i iznos bez broja dokumenta.
 *
 * Odluka: takav dokument se NE ŠALJE (400), jer su obe tihe varijante netačan poreski
 * dokument — bez iznosa kupac plaća više nego što duguje (i to na e-fakturi koja se
 * razilazi sa PDF prilogom istog slanja), sa iznosom bez reference tvrdi nedokazan avans.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const COMPANY = {
  id: 1,
  companyName: "SERVOTEH DOO",
  taxId: "100000000",
  registrationNumber: "07000000",
  address: "Ulica 1",
  city: "Beograd",
  bankAccount: "160-0000000000000-00",
  iban: null,
  swift: null,
};

const CUSTOMER = {
  id: 501,
  name: "KUPAC DOO",
  taxId: "101010101",
  registrationNumber: "08000000",
  address: "Ulica 2",
  city: "Novi Sad",
  publicSectorId: null,
};

/** Knjižen domaći račun 10.000 sa jednom uslužnom stavkom (bez artikla → bez JM upita). */
function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    documentType: "IFUSL",
    documentNumber: "7/26",
    level: 0,
    status: "POSTED",
    companyId: 1,
    customerId: 501,
    documentDate: new Date("2026-07-15T00:00:00.000Z"),
    dueDate: new Date("2026-07-30T00:00:00.000Z"),
    currency: "RSD",
    isExport: false,
    netTotal: D("8333.33"),
    vatTotal: D("1666.67"),
    grossTotal: D("10000"),
    note: null,
    poNumber: null,
    supplyDate: new Date("2026-07-15T00:00:00.000Z"),
    paymentReference: null,
    advanceInvoiceId: null as number | null,
    advanceAppliedAmount: D(0),
    items: [
      {
        lineNo: 1,
        description: "Usluga",
        itemId: null,
        quantity: D(1),
        unitPrice: D("8333.33"),
        discountPercent: D(0),
        vatRateCode: "3",
        vatBase: D("8333.33"),
        vatAmount: D("1666.67"),
        lineTotal: D("10000"),
      },
    ],
    ...overrides,
  };
}

function makeService(opts: {
  invoice?: Record<string, unknown>;
  /** AVR na koji pokazuje kolona — `null` = obrisan (meki ref bez FK). */
  legacyAdvance?: { documentNumber: string } | null;
  applications?: unknown[];
}) {
  const invoice = opts.invoice ?? makeInvoice();
  const prisma = {
    invoice: {
      findUnique: jest
        .fn()
        .mockImplementation((args: { where: { id: number } }) =>
          Promise.resolve(
            args.where.id === (invoice as { id: number }).id
              ? invoice
              : (opts.legacyAdvance ?? null),
          ),
        ),
    },
    company: { findUnique: jest.fn().mockResolvedValue(COMPANY) },
    customer: { findUnique: jest.fn().mockResolvedValue(CUSTOMER) },
    item: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceAdvanceApplication: {
      findMany: jest.fn().mockResolvedValue(opts.applications ?? []),
    },
    sefOutbox: {
      create: jest.fn().mockResolvedValue({ id: 900, status: "PENDING" }),
    },
    sefStatusLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const ubl = { build: jest.fn().mockReturnValue("<Invoice/>") };
  const invoicePdf = {
    buildInvoicePdf: jest
      .fn()
      .mockResolvedValue({ buffer: Buffer.from("pdf"), fileName: "7-26.pdf" }),
  };
  const service = new SefService(
    prisma as never,
    {} as never, // SefClientService — enqueue ne šalje
    ubl as never,
    invoicePdf as never,
  );
  return { service, prisma, ubl };
}

describe("SefService.enqueue — PrepaidAmount i BillingReference idu zajedno", () => {
  it("odbitak avansa bez broja avansnog računa → 400, ništa ne ulazi u outbox", async () => {
    // Zatečena 1:1 veza pokazuje na AVR #99 koji je obrisan: kolone nose 3.000, broja
    // dokumenta nema. Stari kod je slao PrepaidAmount 3.000 i PRAZNU listu referenci —
    // e-faktura sa umanjenjem koje ničim nije potkrepljeno.
    const { service, prisma, ubl } = makeService({
      invoice: makeInvoice({
        advanceInvoiceId: 99,
        advanceAppliedAmount: D("3000"),
      }),
      legacyAdvance: null,
    });

    await expect(service.enqueue(7, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.enqueue(7, 1)).rejects.toThrow(/#99/);

    expect(ubl.build).not.toHaveBeenCalled();
    expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
  });

  it("zatečena veza sa brojem: iznos I referenca idu na e-fakturu", async () => {
    const { service, prisma, ubl } = makeService({
      invoice: makeInvoice({
        advanceInvoiceId: 99,
        advanceAppliedAmount: D("3000"),
      }),
      legacyAdvance: { documentNumber: "A-1/26" },
    });

    await service.enqueue(7, 1);

    const arg = (ubl.build.mock.calls as unknown[][])[0][0] as {
      invoice: {
        prepaidAmount: Prisma.Decimal | null;
        prepaymentReferences: string[];
      };
    };
    expect(arg.invoice.prepaymentReferences).toEqual(["A-1/26"]);
    expect(arg.invoice.prepaidAmount?.toFixed(2)).toBe("3000.00");
    expect(prisma.sefOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("račun bez avansa: nema ni iznosa ni reference", async () => {
    const { service, ubl } = makeService({});

    await service.enqueue(7, 1);

    const arg = (ubl.build.mock.calls as unknown[][])[0][0] as {
      invoice: {
        prepaidAmount: Prisma.Decimal | null;
        prepaymentReferences: string[];
      };
    };
    expect(arg.invoice.prepaymentReferences).toEqual([]);
    expect(arg.invoice.prepaidAmount).toBeNull();
  });
});
