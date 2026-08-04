import { BadRequestException, ConflictException } from "@nestjs/common";
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
    // Registar vrsta — kapija `enqueue`-a od 03.08.2026. pita njega sme li vrsta na SEF
    // (`post_in_vat_ledger`, v. `assertDocumentTypeMayGoToSef`). `IFUSL` je izlazna
    // faktura i po seed-u migracije nosi TRUE.
    documentType: {
      findUnique: jest.fn().mockResolvedValue({
        code: "IFUSL",
        description: "Izlazna faktura — usluge",
        isInbound: false,
        postInVatLedger: true,
      }),
    },
    item: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceAdvanceApplication: {
      findMany: jest.fn().mockResolvedValue(opts.applications ?? []),
    },
    sefOutbox: {
      // `enqueue` od 04.08.2026. prvo pita ima li ŽIV outbox red za tu fakturu
      // (parnjak parcijalnog unique-a `uq_sef_outbox_live`). `null` = nema živog reda,
      // tj. zatečeno stanje svih ovih testova; test koji meri BAŠ tu branu ga postavlja sam.
      findFirst: jest.fn().mockResolvedValue(null),
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

/**
 * SEF RED — JEDAN ŽIV RED PO FAKTURI (nalaz revizije 04.08.2026).
 * =============================================================================
 * `enqueue` je pravio nov `sef_outbox` red bez ijedne provere postojećeg. Deklarisana
 * „idempotencija po `requestId`" po konstrukciji ne može da radi — `requestId` je
 * `randomUUID()` PO REDU, ne po dokumentu, pa dva klika daju dva PENDING reda, oba
 * prohodna kroz `send()`. Ista faktura ode Poreskoj upravi DVAPUT, a ispravka duplikata
 * na SEF-u je vanjska procedura sa kupcem i PU — posledica se NE MOŽE poništiti unutar
 * sistema.
 *
 * Brana je dvoslojna: `enqueue` odbija rano i sa čitljivom porukom, a parcijalni unique
 * `uq_sef_outbox_live` (migracija 20260804140000) zaustavlja dva paralelna klika koji oba
 * prođu proveru pre nego što ijedan upiše red. Testovi mere OBA sloja.
 */
describe("SefService.enqueue — jedan živ red po fakturi", () => {
  /** Živi statusi blokiraju; CANCELLED i REJECTED su namerno izuzeti (ponovno slanje je normalan tok). */
  it.each(["PENDING", "SENT", "DELIVERED", "CANCEL_PENDING"])(
    "postojeći red u statusu %s blokira nov red (409, UBL se ne gradi)",
    async (status) => {
      const { service, prisma, ubl } = makeService({});
      prisma.sefOutbox.findFirst.mockResolvedValue({ id: 41, status });

      await expect(service.enqueue(7, 1)).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(service.enqueue(7, 1)).rejects.toThrow(/već u SEF redu/);

      expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
      expect(ubl.build).not.toHaveBeenCalled();
    },
  );

  it.each(["CANCELLED", "REJECTED"])(
    "posle %s je nov red DOZVOLJEN (ispravka i ponovno slanje su normalan tok)",
    async (status) => {
      const { service, prisma } = makeService({});
      // Upit gleda samo ŽIVE statuse, pa za CANCELLED/REJECTED ne vraća ništa —
      // dubler to verno predstavlja `null`-om, a test tvrdi da red NASTAJE.
      prisma.sefOutbox.findFirst.mockResolvedValue(null);
      void status;

      await service.enqueue(7, 1);
      expect(prisma.sefOutbox.create).toHaveBeenCalledTimes(1);
    },
  );

  it("upit za živi red gleda TAČNO propisane statuse (ne 'sve osim CANCELLED')", async () => {
    const { service, prisma } = makeService({});
    await service.enqueue(7, 1);

    const where = (
      prisma.sefOutbox.findFirst.mock.calls as unknown[][]
    )[0][0] as { where: { invoiceId: number; status: { in: string[] } } };
    expect(where.where.invoiceId).toBe(7);
    // Ako se spisak ikad promeni, ovo pada — a promena spiska MORA ići uz migraciju
    // `uq_sef_outbox_live`, inače kod i baza počnu da tvrde različito.
    expect([...where.where.status.in].sort()).toEqual([
      "CANCEL_PENDING",
      "DELIVERED",
      "PENDING",
      "SENT",
    ]);
  });

  it("trka dva klika: P2002 iz baze postaje 409, ne 500", async () => {
    const { service, prisma } = makeService({});
    prisma.sefOutbox.findFirst.mockResolvedValue(null); // oba poziva prošla proveru
    prisma.sefOutbox.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("unique", {
        code: "P2002",
        clientVersion: "6.19.3",
      }),
    );

    await expect(service.enqueue(7, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.enqueue(7, 1)).rejects.toThrow(/u istom trenutku/);
  });

  it("stornirana faktura ne ulazi u red", async () => {
    const { service, prisma, ubl } = makeService({
      invoice: makeInvoice({ status: "CANCELLED" }),
    });

    await expect(service.enqueue(7, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.enqueue(7, 1)).rejects.toThrow(/stornirana/);

    expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
    expect(ubl.build).not.toHaveBeenCalled();
  });
});

/**
 * SEF SLANJE — TRKA „poslato POSLE storna" (nalaz N5, zatvoreno 03.08.2026).
 * =============================================================================
 * `send()` proveri da faktura nije stornirana, PA ode na mrežu. Mrežni poziv traje
 * (izmereno 300 ms sa lažnim klijentom). Ako storno prođe tačno u tom razmaku, stari
 * kod je BEZUSLOVNIM `update`-om vraćao u `SENT` red koji je storno već prebacio u
 * `CANCELLED`. Ishod: faktura CANCELLED, outbox SENT, status-log „CANCELLED" → „SENT",
 * a SEF cancel nikad poslat — kupac na portalu ima važeću e-fakturu za dokument koji
 * kod nas ne postoji.
 *
 * `cancelSefOutbox` je taj razmak SUZIO (gasi PENDING pre mreže + drugi prolaz), ali ga
 * ne može zatvoriti: bez uslova na statusu upis uvek pobeđuje. Zato je upis USLOVAN
 * (`updateMany where {id, status:'PENDING'}`) — baza presuđuje ko je stigao prvi.
 */
function makeSendService(opts: {
  /** Koliko redova zahvati uslovni upis: 1 = mi smo prvi, 0 = storno je bio brži. */
  claimed: number;
  /** Da li SEF potvrdi otkazivanje u koraku sanacije. */
  cancelOk?: boolean;
}) {
  const rows: Record<string, unknown> = {
    id: 900,
    invoiceId: 7,
    status: "PENDING",
    sefInvoiceId: null,
  };
  const prisma = {
    sefOutbox: {
      // `enqueue` od 04.08.2026. prvo pita ima li ŽIV outbox red za tu fakturu
      // (parnjak parcijalnog unique-a `uq_sef_outbox_live`). `null` = nema živog reda,
      // tj. zatečeno stanje svih ovih testova; test koji meri BAŠ tu branu ga postavlja sam.
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(rows)),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimed }),
      update: jest.fn().mockImplementation((args: { data: object }) => {
        Object.assign(rows, args.data);
        return Promise.resolve(rows);
      }),
    },
    invoice: {
      findUnique: jest.fn().mockResolvedValue({ status: "POSTED" }),
    },
    sefStatusLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const client = {
    sendInvoice: jest
      .fn()
      .mockResolvedValue({ ok: true, sefInvoiceId: "555111", dryRun: false }),
    cancelInvoice: jest.fn().mockResolvedValue(
      opts.cancelOk === false
        ? { ok: false, httpStatus: -1, errorMessage: "timeout" }
        : { ok: true },
    ),
  };
  const service = new SefService(
    prisma as never,
    client as never,
    { build: jest.fn() } as never,
    {} as never,
  );
  return { service, prisma, client, rows };
}

describe("SefService.send — uslovan upis statusa SENT", () => {
  it("normalan tok: red je još PENDING → uslovni upis zahvati tačno 1 red i status je SENT", async () => {
    const { service, prisma } = makeSendService({ claimed: 1 });

    await service.send(900, 1);

    const where = (prisma.sefOutbox.updateMany.mock.calls as unknown[][])[0][0] as {
      where: { id: number; status: string };
    };
    // Uslov MORA da nosi status — bez njega je trka otvorena.
    expect(where.where).toEqual({ id: 900, status: "PENDING" });
    expect(prisma.sefOutbox.updateMany).toHaveBeenCalledTimes(1);
  });

  it("storno je stigao prvi: SENT se NE upisuje, red ide u CANCEL_PENDING sa SEF ID-om, otkazivanje se šalje, poziv baca", async () => {
    const { service, prisma, client, rows } = makeSendService({ claimed: 0 });

    await expect(service.send(900, 1)).rejects.toThrow(/storniran kod nas/i);

    // Status NIJE vraćen u SENT.
    expect(rows.status).not.toBe("SENT");
    // `sefInvoiceId` MORA biti upisan — bez njega e-faktura kod kupca ostaje živa
    // bez ijednog ključa kojim bismo je povukli.
    expect(rows.sefInvoiceId).toBe("555111");
    // Otkazivanje na portalu je stvarno pokušano, ne samo zabeleženo.
    expect(client.cancelInvoice).toHaveBeenCalled();
    expect(prisma.sefStatusLog.create).toHaveBeenCalled();
  });

  it("storno je stigao prvi a SEF ne potvrdi otkazivanje: red ostaje CANCEL_PENDING za ponovni pokušaj", async () => {
    const { service, rows } = makeSendService({ claimed: 0, cancelOk: false });

    await expect(service.send(900, 1)).rejects.toThrow();

    expect(rows.status).toBe("CANCEL_PENDING");
    expect(rows.sefInvoiceId).toBe("555111");
  });
});

describe("SefService.send — ponovno slanje NE SME da otkaže kupčevu e-fakturu", () => {
  /**
   * REGRESIJA IZ `2893e051`, nađena u 8. krugu i zatvorena 03.08.2026.
   *
   * Uslovni upis (`where status:'PENDING'`) je uveden zbog trke sa stornom. Ali `count = 0`
   * ne razlikuje „storno me je pretekao" od „red uopšte nije bio za slanje": za red koji je
   * već `SENT`, `send()` je odlazio na SEF DRUGI PUT, dobijao `count = 0`, ulazio u granu
   * otkazivanja i POVLAČIO kupčevu e-fakturu — za fakturu koja je kod nas živa i POSTED —
   * uz poruku da je dokument storniran. Frontend to dozvoljava jednim klikom (`canSend`
   * propušta sve osim `CANCELLED`).
   *
   * Do uslovnog upisa je isti klik bio bezopasan (SENT → SENT).
   */
  it.each(["SENT", "DELIVERED", "REJECTED"])(
    "red u stanju %s se odbija PRE mreže — SEF se ne poziva nijednom",
    async (status) => {
      const { service, prisma, client, rows } = makeSendService({ claimed: 0 });
      rows.status = status;
      rows.sefInvoiceId = "555111";

      await expect(service.send(900, 1)).rejects.toThrow(/samo iz stanja PENDING/i);

      // Ni slanje ni otkazivanje ne smeju da se dese.
      expect(client.sendInvoice).not.toHaveBeenCalled();
      expect(client.cancelInvoice).not.toHaveBeenCalled();
      // Status ostaje netaknut — dokument je i dalje kod kupca.
      expect(rows.status).toBe(status);
      expect(prisma.sefOutbox.updateMany).not.toHaveBeenCalled();
    },
  );

  it("SEF potvrdi slanje BEZ identifikatora: poruka kaže da otkazivanje NIJE izvedeno", async () => {
    const { service, client, rows } = makeSendService({ claimed: 0 });
    // `extractInvoiceId` sme da vrati `undefined` uz `ok: true` — tada `cancel` ne ide na
    // mrežu, pa je tvrdnja „otkazan je i na SEF-u" tačno obrnuta od istine (nalaz S4).
    client.sendInvoice.mockResolvedValue({ ok: true, dryRun: false });

    await expect(service.send(900, 1)).rejects.toThrow(
      /OTKAZIVANJE NA PORTALU NIJE IZVEDENO/,
    );
    expect(client.cancelInvoice).not.toHaveBeenCalled();
    expect(rows.sefInvoiceId).toBeNull();
  });
});
