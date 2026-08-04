import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { SefService, SEF_OUTBOX_CANCEL_PENDING } from "./sef.service";

/**
 * SEF SLOJ NIKAD NE BACA → GREŠKA SE PRETVARA U TIŠINU ILI U LAŽ.
 * =============================================================================
 * Tri izmerena nalaza (02.–03.08.2026), jedan zajednički obrazac: svaki neuspeh na
 * SEF-u je do ove ispravke izlazio kroz isti izlaz kao uspeh, pa ni jedan sloj iznad
 * nije imao po čemu da ih razlikuje.
 *
 *   N1  kapija `enqueue`-a nije gledala VRSTU dokumenta → revers je otišao kupcu kao
 *       komercijalna faktura (`InvoiceTypeCode 380`, `PayableAmount 10.000,00`);
 *   N2  prekid veze pri otkazivanju → red ostajao `SENT`, a ekran javljao
 *       „Račun storniran. Otkazano SEF redova: 1.";
 *   N3  otkazivanje PRIHVAĆENE (`DELIVERED`) e-fakture išlo je na rutu koja to ne ume,
 *       SEF vraćao 400, a status ostajao `DELIVERED` bez ijednog znaka korisniku.
 *
 * Tvrdnje idu kroz PRAVE ulazne tačke servisa (`enqueue`, `cancel`, `send`,
 * `refreshStatus`) sa lažnom Prismom i lažnim mrežnim klijentom — isti obrazac kao
 * `sef.service.spec.ts`.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const COMPANY = {
  id: 1,
  companyName: "SERVOTEH DOO",
  taxId: "100000000",
  registrationNumber: "07000000",
  address: "Ulica 1",
  city: "Kragujevac",
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

/** Red registra vrsta — samo kolone koje kapija čita. */
interface RegistryRow {
  code: string;
  description: string;
  isInbound: boolean;
  postInVatLedger: boolean | null;
}

/**
 * Izmeren dokument iz nalaza N1: revers `REV-8/26`, knjižen (level 0, POSTED), domaći,
 * 10.000. Sve što je stara kapija gledala (`level`, `status`, `isExport`) je ispravno —
 * jedino što ga diskvalifikuje je VRSTA.
 */
function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 8,
    documentType: "REV",
    documentNumber: "REV-8/26",
    level: 0,
    status: "POSTED",
    companyId: 1,
    customerId: 501,
    documentDate: new Date("2026-07-20T00:00:00.000Z"),
    dueDate: null,
    currency: "RSD",
    isExport: false,
    netTotal: D("8333.33"),
    vatTotal: D("1666.67"),
    grossTotal: D("10000"),
    note: null,
    poNumber: null,
    supplyDate: new Date("2026-07-20T00:00:00.000Z"),
    paymentReference: null,
    advanceInvoiceId: null as number | null,
    advanceAppliedAmount: D(0),
    advanceDirection: null as string | null,
    items: [
      {
        lineNo: 1,
        description: "Oprema na revers",
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

function makeEnqueueService(opts: {
  invoice?: Record<string, unknown>;
  /** `null` = vrste nema u registru vrsta. */
  registry?: RegistryRow | null;
}) {
  const invoice = opts.invoice ?? makeInvoice();
  const registry =
    opts.registry === undefined
      ? {
          code: "REV",
          description: "Revers",
          isInbound: false,
          // Seed migracije `20260728150000` — revers se NE knjiži u PDV evidenciju.
          postInVatLedger: false,
        }
      : opts.registry;

  const prisma = {
    invoice: { findUnique: jest.fn().mockResolvedValue(invoice) },
    documentType: { findUnique: jest.fn().mockResolvedValue(registry) },
    company: { findUnique: jest.fn().mockResolvedValue(COMPANY) },
    customer: { findUnique: jest.fn().mockResolvedValue(CUSTOMER) },
    item: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceAdvanceApplication: { findMany: jest.fn().mockResolvedValue([]) },
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
      .mockResolvedValue({ buffer: Buffer.from("pdf"), fileName: "r.pdf" }),
  };
  const service = new SefService(
    prisma as never,
    {} as never, // mreža se ne dodiruje — enqueue ne šalje
    ubl as never,
    invoicePdf as never,
  );
  return { service, prisma, ubl };
}

/** Outbox red + lažni klijent za `cancel`/`send`/`refreshStatus`. */
function makeCancelService(opts: {
  outbox?: Record<string, unknown>;
  cancelResult?: Record<string, unknown>;
  pollResult?: Record<string, unknown>;
  /** Status same fakture — `send()` ima i zasebnu branu nad storniranim dokumentom. */
  invoiceStatus?: string;
}) {
  const row = {
    id: 901,
    invoiceId: 8,
    requestId: "r-901",
    status: "SENT",
    sefInvoiceId: "555111",
    errorMessage: null as string | null,
    ...opts.outbox,
  };
  const prisma = {
    sefOutbox: {
      // `enqueue` od 04.08.2026. prvo pita ima li ŽIV outbox red za tu fakturu
      // (parnjak parcijalnog unique-a `uq_sef_outbox_live`). `null` = nema živog reda,
      // tj. zatečeno stanje svih ovih testova; test koji meri BAŠ tu branu ga postavlja sam.
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(row)),
      update: jest
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...row, ...args.data }),
        ),
    },
    invoice: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ status: opts.invoiceStatus ?? "CANCELLED" }),
    },
    sefStatusLog: { create: jest.fn().mockResolvedValue({ id: 1 }) },
  };
  const client = {
    cancelInvoice: jest
      .fn()
      .mockResolvedValue(opts.cancelResult ?? { ok: true, httpStatus: 200 }),
    pollStatus: jest
      .fn()
      .mockResolvedValue(opts.pollResult ?? { ok: true, httpStatus: 200 }),
    sendInvoice: jest.fn().mockResolvedValue({ ok: true, httpStatus: 200 }),
  };
  const service = new SefService(
    prisma as never,
    client as never,
    {} as never,
    {} as never,
  );
  /** Podaci poslednjeg `update`-a nad outbox redom. */
  const lastUpdate = () => {
    const calls = prisma.sefOutbox.update.mock.calls as {
      data: Record<string, unknown>;
    }[][];
    return calls.length ? calls[calls.length - 1][0].data : null;
  };
  return { service, prisma, client, row, lastUpdate };
}

// ─────────────────────────────────────────────────────────────────────────────
// N1 — kapija gleda VRSTU dokumenta, a spisak vrsta dolazi iz registra
// ─────────────────────────────────────────────────────────────────────────────

describe("N1 · na SEF ide samo poreski dokument (registar vrsta)", () => {
  it("REVERS ne prolazi kapiju — ni UBL se ne gradi, ni red ne nastaje", async () => {
    // Izmereno pre ispravke: `enqueue` je prošao, outbox `PENDING`, XML sa
    // `cbc:ID = REV-8/26`, `InvoiceTypeCode = 380`, `PayableAmount = 10000.00`.
    const { service, prisma, ubl } = makeEnqueueService({});

    await expect(service.enqueue(8, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service.enqueue(8, 1)).rejects.toThrow(/PDV evidenciju/);

    expect(ubl.build).not.toHaveBeenCalled();
    expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
  });

  it("odgovor daje REGISTAR, ne spisak u kodu — ista vrsta uz TRUE prolazi", async () => {
    // Isti dokument, ista šifra, jedina promena je red u šifarniku. Da je spisak
    // prepisan u kodu, ovaj test ne bi mogao da postoji.
    const { service, prisma } = makeEnqueueService({
      registry: {
        code: "REV",
        description: "Revers",
        isInbound: false,
        postInVatLedger: true,
      },
    });

    await service.enqueue(8, 1);

    expect(prisma.documentType.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { code: "REV" } }),
    );
    expect(prisma.sefOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("vrsta koje NEMA u registru se odbija (fail-closed)", async () => {
    const { service, prisma } = makeEnqueueService({
      invoice: makeInvoice({ documentType: "XYZ", documentNumber: "XYZ-1/26" }),
      registry: null,
    });

    await expect(service.enqueue(8, 1)).rejects.toThrow(/ne postoji u registru/);
    expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
  });

  it("ULAZNI avansni račun (tuđi dokument) ne ide u izlazni tok", async () => {
    // `AVR` je u registru TRUE — a ulazni avans je dobavljačev dokument koji smo samo
    // evidentirali. Vrsta ga ne razlikuje; smer (`advance_direction`) ga razlikuje.
    const { service, prisma } = makeEnqueueService({
      invoice: makeInvoice({
        documentType: "AVR",
        documentNumber: "A-3/26",
        advanceDirection: "in",
      }),
      registry: {
        code: "AVR",
        description: "Avansni račun",
        isInbound: false,
        postInVatLedger: true,
      },
    });

    await expect(service.enqueue(8, 1)).rejects.toThrow(/ULAZNI avansni račun/);
    expect(prisma.sefOutbox.create).not.toHaveBeenCalled();
  });

  it("ULAZNA vrsta iz registra se odbija", async () => {
    const { service } = makeEnqueueService({
      invoice: makeInvoice({ documentType: "UFROB", documentNumber: "U-1/26" }),
      registry: {
        code: "UFROB",
        description: "Ulazna faktura — roba",
        isInbound: true,
        postInVatLedger: true,
      },
    });

    await expect(service.enqueue(8, 1)).rejects.toThrow(/ULAZNI dokument/);
  });

  /**
   * IZVOR PODELE — seed registra, a ne spisak u kodu. Ovaj test čita SQL migracije i
   * pokazuje da traženo pravilo („fakture i avansi da; ponuda/predračun/revers ne")
   * već stoji u šifarniku. Kad neko promeni seed, pukne ovde — a ne tiho na SEF-u.
   */
  it("seed registra već nosi traženu podelu (izvor, ne prepis)", () => {
    const sql = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "prisma",
        "migrations",
        "20260728150000_registar_vrsta_i_koeficijent_dokumenta",
        "migration.sql",
      ),
      "utf8",
    );
    /**
     * Red `_reg_vrsta`: `('IFR', 'opis', is_inbound, affects_stock, post_in_vat_ledger, …)`.
     * Traži se TREĆA logička vrednost posle opisa — `post_in_vat_ledger`.
     */
    const vatLedgerFlag = (code: string): string => {
      const row = new RegExp(
        `\\('${code}',\\s*'[^']*',\\s*\\w+,\\s*\\w+,\\s*(\\w+)`,
      ).exec(sql);
      if (!row) throw new Error(`Seed red za vrstu ${code} ne postoji.`);
      return row[1];
    };

    for (const code of ["IFR", "IFGP", "IFUSL", "IZVRO", "IZVGP", "IZVUS", "AVR"]) {
      expect(vatLedgerFlag(code)).toBe("TRUE");
    }
    for (const code of ["PON", "PROF", "REV"]) {
      expect(vatLedgerFlag(code)).toBe("FALSE");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N2 — neuspeh otkazivanja se vidi i ponavlja
// ─────────────────────────────────────────────────────────────────────────────

describe("N2 · prekid veze pri otkazivanju nije uspeh", () => {
  it("timeout → status CANCEL_PENDING i IZUZETAK (ne tiho 200)", async () => {
    // Izmereno pre ispravke: status je ostajao `SENT`, greška samo u `error_message`,
    // a `stornoInvoice` je id reda ipak upisao u `sefCancelledOutboxIds`.
    const { service, lastUpdate } = makeCancelService({
      cancelResult: {
        ok: false,
        httpStatus: -1,
        errorMessage: "Nema komunikacije sa SEF serverom: timeout",
      },
    });

    await expect(service.cancel(901, "greška u iznosu", 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const data = lastUpdate();
    expect(data?.status).toBe(SEF_OUTBOX_CANCEL_PENDING);
    expect(String(data?.errorMessage)).toMatch(/timeout/);
  });

  it("poruka govori šta je stvarno stanje (kupac ima živu e-fakturu)", async () => {
    const { service } = makeCancelService({
      cancelResult: { ok: false, httpStatus: -1, errorMessage: "timeout" },
    });

    await expect(service.cancel(901, undefined, 1)).rejects.toThrow(
      /storniran kod nas.*i dalje vidi važeću e-fakturu/s,
    );
  });

  it("DRY-RUN je isti ishod: nije otkazano, pa ne sme da izgleda kao da jeste", async () => {
    const { service, lastUpdate } = makeCancelService({
      cancelResult: { ok: false, httpStatus: 0, dryRun: true },
    });

    await expect(service.cancel(901, undefined, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(lastUpdate()?.status).toBe(SEF_OUTBOX_CANCEL_PENDING);
  });

  it("uspešno otkazivanje i dalje prolazi tiho (CANCELLED, bez izuzetka)", async () => {
    const { service, lastUpdate } = makeCancelService({
      cancelResult: { ok: true, httpStatus: 200 },
    });

    await expect(service.cancel(901, "storno", 1)).resolves.toBeDefined();
    expect(lastUpdate()?.status).toBe("CANCELLED");
  });

  it("red u CANCEL_PENDING sme ponovo da se otkazuje (red za ponovni pokušaj)", async () => {
    const { service, client, lastUpdate } = makeCancelService({
      outbox: { status: SEF_OUTBOX_CANCEL_PENDING, errorMessage: "timeout" },
      cancelResult: { ok: true, httpStatus: 200 },
    });

    await service.cancel(901, undefined, 1);

    expect(client.cancelInvoice).toHaveBeenCalledWith(901);
    expect(lastUpdate()?.status).toBe("CANCELLED");
  });

  it("polling ne gazi CANCEL_PENDING dok SEF ne potvrdi otkazivanje", async () => {
    const { service, lastUpdate } = makeCancelService({
      outbox: { status: SEF_OUTBOX_CANCEL_PENDING, errorMessage: "timeout" },
      pollResult: { ok: true, httpStatus: 200, sefStatus: "Sent" },
    });

    await service.refreshStatus(901, 1);

    // `status` se NE upisuje (ostaje CANCEL_PENDING), a poruka o grešci se ne briše.
    expect(lastUpdate()?.status).toBeUndefined();
    expect(lastUpdate()?.errorMessage).toBeUndefined();
  });

  it("polling PRIHVATA potvrdu otkazivanja sa SEF-a", async () => {
    const { service, lastUpdate } = makeCancelService({
      outbox: { status: SEF_OUTBOX_CANCEL_PENDING, errorMessage: "timeout" },
      pollResult: { ok: true, httpStatus: 200, sefStatus: "Cancelled" },
    });

    await service.refreshStatus(901, 1);

    expect(lastUpdate()?.status).toBe("CANCELLED");
    expect(lastUpdate()?.errorMessage).toBeNull();
  });

  it("red koji čeka potvrdu otkazivanja se ne sme (ponovo) poslati", async () => {
    // Faktura je namerno POSTED: brana mora da bude STATUS REDA, ne zatečena provera
    // „faktura je stornirana" — inače bi red koji čeka potvrdu mogao da se ponovo
    // pošalje čim se dokument iz nekog razloga ne vodi kao storniran.
    const { service, client } = makeCancelService({
      outbox: { status: SEF_OUTBOX_CANCEL_PENDING },
      invoiceStatus: "POSTED",
    });

    await expect(service.send(901, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(client.sendInvoice).not.toHaveBeenCalled();
  });

  it("red koji nikada nije stigao na SEF se otkazuje LOKALNO, bez 503", async () => {
    // Bez ovog izuzetka bi red bez `sefInvoiceId` završio u CANCEL_PENDING uz poruku
    // „SEF nije potvrdio" — a SEF nije ni pitan.
    const { service, client, lastUpdate } = makeCancelService({
      outbox: { status: "PENDING", sefInvoiceId: null },
    });

    await expect(service.cancel(901, "storno", 1)).resolves.toBeDefined();

    expect(client.cancelInvoice).not.toHaveBeenCalled();
    expect(lastUpdate()?.status).toBe("CANCELLED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// N3 — prihvaćena e-faktura se ne otkazuje
// ─────────────────────────────────────────────────────────────────────────────

describe("N3 · brana za PRIHVAĆENU (DELIVERED) e-fakturu", () => {
  it("otkazivanje DELIVERED reda pada odmah — SEF se ne zove", async () => {
    // Izmereno pre ispravke: poziv je odlazio na `/cancel`, SEF vraćao HTTP 400,
    // `cancel()` NIJE bacao, status ostajao `DELIVERED` uz `error_message`.
    const { service, client, prisma } = makeCancelService({
      outbox: { status: "DELIVERED" },
      cancelResult: {
        ok: false,
        httpStatus: 400,
        errorMessage: "SEF HTTP 400: invoice cannot be cancelled",
      },
    });

    await expect(service.cancel(901, "storno", 1)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(client.cancelInvoice).not.toHaveBeenCalled();
    expect(prisma.sefOutbox.update).not.toHaveBeenCalled();
  });

  it("poruka imenuje pravi put (storniranje) i ne izmišlja rutu", async () => {
    const { service } = makeCancelService({ outbox: { status: "DELIVERED" } });

    await expect(service.cancel(901, undefined, 1)).rejects.toThrow(
      /STORNIRANJE.*nije\s+implementirano/s,
    );
  });

  /**
   * ŠTA NEDOSTAJE, ZAPISANO IZVRŠNO. Doc 07 §8.2 popisuje DVE izlazne rute sa DVA
   * guard-a — `/sales-invoice/cancel` (`ER_FakturaMozeDaSeOtkaze`) i
   * `/sales-invoice/storno` (`ER_FakturaMozeDaSeStornira`) — a klijent zna samo prvu.
   * Ovaj test to stanje pribija: kad neko doda storno rutu, pukne ovde i natera ga da
   * uz nju vrati i `DELIVERED` u dozvoljene statuse (i da obriše zapis iz PREOSTALE_FAZE).
   */
  it("ruta za storniranje u klijentu NE POSTOJI — brana stoji dok je ne bude", () => {
    const client = readFileSync(
      join(__dirname, "sef-client.service.ts"),
      "utf8",
    );
    const spec = readFileSync(
      join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "docs",
        "migration",
        "07-bigbit-sef-efaktura.md",
      ),
      "utf8",
    );

    expect(spec).toContain("sales-invoice/storno");
    expect(spec).toContain("sales-invoice/cancel");
    expect(client).toContain("sales-invoice/cancel");
    expect(client).not.toContain("sales-invoice/storno");
  });
});
