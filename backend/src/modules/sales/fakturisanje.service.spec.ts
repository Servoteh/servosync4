import {
  ConflictException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { FakturisanjeService } from "./fakturisanje.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * ZATEČENA 1:1 VEZA AVANSA — brane oko nje (ispravke 02.08.2026).
 * =============================================================================
 * Od commita „odbijeni avans se računa na jednom mestu" veza koja živi SAMO u
 * kolonama (`invoices.advance_invoice_id` + `advance_applied_amount`, bez reda u
 * `invoice_advance_applications`) je PUNOPRAVAN odbitak: ulazi u „za uplatu", na
 * štampu i na e-fakturu. Ovaj spec pokriva mesta na kojima je sistem tu vezu i
 * dalje gledao kao da ne postoji:
 *
 *   1) storno AVR-a je prolazio ako je veza samo u kolonama (guard je gledao
 *      isključivo spojnu tabelu) — račun je posle toga štampao umanjenje za
 *      STORNIRAN poreski dokument;
 *   2) storno konačnog računa nije čistio kolone kad nema šta da reverzira, pa je
 *      AVR ostajao trajno „iskorišćen";
 *   3) `getInvoice` je „prvi avans" imenovao iz kolone-pokazivača, pa je ekran umeo
 *      da pomene avans kojeg u spisku umanjenja nema.
 *
 * Prisma i saradnici su mockovani — logika servisa je čista.
 */

const D = (v: string | number) => new Prisma.Decimal(v);

const ACTOR: AuthUser = {
  userId: 7,
  email: "test@servoteh.com",
  role: "admin",
  workerId: null,
};

/** Račun sa zatečenom vezom, u obliku u kom ga vraća `loadAdvanceLinkedInvoices`. */
interface LinkedRow {
  id: number;
  documentNumber: string;
  status: string;
  advanceInvoiceId: number;
  advanceAppliedAmount: Prisma.Decimal;
  advanceApplications: {
    advanceInvoiceId: number;
    appliedAmount: Prisma.Decimal;
  }[];
}

/** Nalog GK u obliku u kom ga storno čita (provera reverzibilnosti). */
interface EntryRow {
  id: number;
  number: string;
  status: string;
  reversedByEntryId: number | null;
}

function makePrisma(opts: {
  /** Dokument koji se stornira / čita (`invoice.findUnique` po `where.id`). */
  invoice?: Record<string, unknown>;
  /** Aktivne primene (`invoiceAdvanceApplication.findMany`). */
  applications?: unknown[];
  /** Primene NA OVOM računu (`where.invoiceId`) — kad se razlikuju od gornjih. */
  invoiceApplications?: unknown[];
  /** Nalozi GK koje storno proverava pre CAS-a (`journalEntry.findMany`). */
  entries?: EntryRow[];
  /** Računi koji KOLONOM pokazuju na posmatrani AVR. */
  linked?: LinkedRow[];
  /** AVR na koji pokazuje kolona posmatranog računa (za `getInvoice`). */
  legacyAdvance?: { documentNumber: string; advancePaidAt: Date | null } | null;
  claimCount?: number;
}) {
  // `client` je i spoljni Prisma i `tx` unutar transakcije — ISTI mock objekat, pa se sva
  // očekivanja pišu nad `prisma.*` bez obzira gde servis poziv izvodi. (Razdvojeno od
  // `prisma` ispod samo zato što `$transaction` ne može da referencira objekat u kome
  // nastaje — TS bi tip izveo kao `any`.)
  const client = {
    invoice: {
      findUnique: jest
        .fn()
        .mockImplementation((args: { where: { id: number } }) => {
          const inv = opts.invoice as { id?: number } | undefined;
          if (inv && args.where.id === inv.id) return Promise.resolve(inv);
          // Drugi poziv je uvek „AVR na koji pokazuje kolona" (meki ref — sme null).
          return Promise.resolve(opts.legacyAdvance ?? null);
        }),
      // `loadAdvanceLinkedInvoices` traži SAMO nestornirane račune — mock taj filter
      // stvarno primenjuje, inače bi test opisivao bazu koja ne postoji.
      findMany: jest
        .fn()
        .mockImplementation(
          (args: { where?: { status?: { not?: string } } }) => {
            const rows = opts.linked ?? [];
            const excluded = args?.where?.status?.not;
            return Promise.resolve(
              excluded ? rows.filter((r) => r.status !== excluded) : rows,
            );
          },
        ),
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimCount ?? 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    invoiceAdvanceApplication: {
      // Dva različita upita gađaju isti mock: primene JEDNOG AVANSA (`advanceInvoiceId`,
      // guard storna avansa) i primene NA RAČUNU (`invoiceId`, reverzija). Razdvojeni su
      // da test ne bi morao da im podmeće isti oblik reda.
      findMany: jest
        .fn()
        .mockImplementation((args: { where?: { advanceInvoiceId?: number } }) =>
          Promise.resolve(
            args?.where?.advanceInvoiceId != null
              ? (opts.applications ?? [])
              : (opts.invoiceApplications ?? opts.applications ?? []),
          ),
        ),
      update: jest.fn().mockResolvedValue({}),
    },
    journalEntry: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue(opts.entries ?? []),
    },
    // Advisory brave (4003 račun → 4004 avans). Tagged template: prvi argument je
    // niz literala, ostali su vezane vrednosti — testovi gledaju baš njih.
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  // Storno je od 03.08.2026. CEO u jednoj transakciji (N2/N3).
  return {
    ...client,
    $transaction: jest.fn((cb: (tx: typeof client) => unknown) => cb(client)),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const sef = {
    listOutbox: jest.fn().mockResolvedValue([]),
    cancelPendingLocally: jest.fn().mockResolvedValue([]),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const reservation = { release: jest.fn().mockResolvedValue(undefined) };
  const glWrite = {
    reverse: jest.fn(),
    reverseWithin: jest.fn().mockResolvedValue({ stornoEntryId: 900 }),
  };
  const service = new FakturisanjeService(
    prisma as never,
    {} as never, // pricing
    {} as never, // numbering
    {} as never, // posting
    glWrite as never,
    sef as never,
    reservation as never,
  );
  return { service, sef, reservation, glWrite };
}

/** Vezane vrednosti `$executeRaw` poziva (bez niza literala) — advisory brave. */
function lockArgs(mock: jest.Mock): unknown[][] {
  return mock.mock.calls.map((call) => call.slice(1));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) STORNO AVR-a — zatečena veza blokira isto kao primena
// ─────────────────────────────────────────────────────────────────────────────

describe("stornoInvoice(AVR) — zatečena 1:1 veza blokira storno", () => {
  /** AVR 3.000, proknjižen, bez ijednog reda u spojnoj tabeli. */
  const AVR = {
    id: 1,
    status: "POSTED",
    isLocked: true,
    journalEntryId: null,
    note: null,
    documentNumber: "A-1/26",
    documentType: "AVR",
    advanceClosingEntryId: null,
    advanceInvoiceId: null,
  };

  it("veza SAMO u kolonama (bez reda u spojnoj tabeli) → 409, ništa se ne stornira", async () => {
    // Ceo scenario: veza nastala pre N:M migracije (ili uvozom BigBit istorije) drži
    // AVR 3.000 na računu 7/26 SAMO U KOLONAMA. Spojna tabela je prazna, pa je stari
    // guard („ima li aktivnih primena?") propuštao storno — a račun 7/26 je i dalje
    // štampao „Umanjenje za primljeni avans (br. A-1/26): −3.000", slao PrepaidAmount
    // 3.000 sa BillingReference na STORNIRAN poreski dokument i prikazivao 3.000 manje
    // za uplatu.
    const prisma = makePrisma({
      invoice: AVR,
      applications: [],
      linked: [
        {
          id: 7,
          documentNumber: "7/26",
          status: "POSTED",
          advanceInvoiceId: 1,
          advanceAppliedAmount: D("3000"),
          advanceApplications: [],
        },
      ],
    });
    const { service } = makeService(prisma);

    await expect(
      service.stornoInvoice(1, "greška unosa", ACTOR),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.stornoInvoice(1, "greška unosa", ACTOR),
    ).rejects.toThrow(/7\/26/);

    // Nijedan CAS upis: dokument ostaje proknjižen.
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });

  it("veza na STORNIRANOM računu ne blokira (storniran račun ništa ne odbija)", async () => {
    const prisma = makePrisma({
      invoice: AVR,
      applications: [],
      linked: [
        {
          id: 7,
          documentNumber: "7/26",
          status: "CANCELLED",
          advanceInvoiceId: 1,
          advanceAppliedAmount: D("3000"),
          advanceApplications: [],
        },
      ],
    });
    const { service } = makeService(prisma);

    await expect(
      service.stornoInvoice(1, "greška unosa", ACTOR),
    ).resolves.toBeDefined();
    expect(prisma.invoice.updateMany).toHaveBeenCalledTimes(1);
  });

  it("kolonu pokriva N:M primena → nema dvostruke brane, ali primena blokira", async () => {
    // Račun 7/26 ima i primenu istog avansa (3.000) i kolonu (3.000): to je ISTI
    // podatak dvaput, pa pravilo ne daje zatečeni red. Storno mora pasti na primeni,
    // i to sa JEDNIM pominjanjem računa u poruci.
    const prisma = makePrisma({
      invoice: AVR,
      applications: [{ invoice: { documentNumber: "7/26", status: "POSTED" } }],
      linked: [
        {
          id: 7,
          documentNumber: "7/26",
          status: "POSTED",
          advanceInvoiceId: 1,
          advanceAppliedAmount: D("3000"),
          advanceApplications: [
            { advanceInvoiceId: 1, appliedAmount: D("3000") },
          ],
        },
      ],
    });
    const { service } = makeService(prisma);

    const err = await service
      .stornoInvoice(1, "greška unosa", ACTOR)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message.match(/7\/26/g)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) STORNO KONAČNOG RAČUNA — kolone se čiste i kad nema šta da se reverzira
// ─────────────────────────────────────────────────────────────────────────────

describe("stornoInvoice(konačni račun) — čišćenje zatečene veze", () => {
  it("veza samo u kolonama: storno je briše (inače AVR ostaje trajno iskorišćen)", async () => {
    // Bez ovoga `toReverse` ostaje prazan (nema ni primene ni naloga zatvaranja), pa
    // kolone prežive storno: `link-final` i uvoz po njima zaključuju da je avans već
    // odbijen, a jedini račun na kome je bio — storniran. AVR bez izlaza.
    const prisma = makePrisma({
      invoice: {
        id: 7,
        status: "POSTED",
        isLocked: true,
        journalEntryId: null,
        note: null,
        documentNumber: "7/26",
        documentType: "IFR",
        advanceClosingEntryId: null,
        advanceInvoiceId: 1,
      },
      applications: [],
    });
    const { service } = makeService(prisma);

    await service.stornoInvoice(7, "greška unosa", ACTOR);

    expect(prisma.invoice.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        advanceInvoiceId: null,
        advanceClosingEntryId: null,
        // Iznos mora na NULU: kolona je „ukupno odbijeno", a storniran račun ne
        // odbija ništa (inače bi pravilo iz nje i dalje izvodilo zatečeni red).
        advanceAppliedAmount: D(0),
      },
    });
  });

  it("račun bez ijedne veze avansa: kolone se ne diraju (nema praznog upisa)", async () => {
    const prisma = makePrisma({
      invoice: {
        id: 8,
        status: "POSTED",
        isLocked: true,
        journalEntryId: null,
        note: null,
        documentNumber: "8/26",
        documentType: "IFR",
        advanceClosingEntryId: null,
        advanceInvoiceId: null,
      },
      applications: [],
    });
    const { service } = makeService(prisma);

    await service.stornoInvoice(8, "greška unosa", ACTOR);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) getInvoice — „prvi avans" sme da imenuje samo avans koji JE u spisku umanjenja
// ─────────────────────────────────────────────────────────────────────────────

describe("getInvoice — advanceInvoiceNumber prati spisak umanjenja", () => {
  const INVOICE = {
    id: 7,
    documentNumber: "7/26",
    documentType: "IFR",
    grossTotal: D("10000"),
    items: [],
  };

  it("kolona ≤ Σ primena: imenuje se avans IZ SPISKA, ne pokazivač iz kolone", async () => {
    // Zatečena veza na A-1/26 je u međuvremenu pokrivena primenama (kolona 2.000 =
    // Σ primena 2.000), pa pravilo A-1/26 NE daje u `advanceDeductions`. Stari kod je
    // `advanceInvoiceNumber` čitao pravo iz kolone → ekran je pisao „Avans: A-1/26",
    // dokument kojeg u spisku umanjenja nema i čiji iznos nigde ne stoji.
    const prisma = makePrisma({
      invoice: {
        ...INVOICE,
        advanceInvoiceId: 1,
        advanceAppliedAmount: D("2000"),
      },
      applications: [
        {
          id: 11,
          advanceInvoiceId: 2,
          appliedAmount: D("2000"),
          appliedNet: D("1666.67"),
          appliedVat: D("333.33"),
          closingEntryId: 500,
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
          advance: {
            documentNumber: "A-2/26",
            advancePaidAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        },
      ],
      legacyAdvance: {
        documentNumber: "A-1/26",
        advancePaidAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    const { service } = makeService(prisma);

    const res = await service.getInvoice(7);

    expect(res.advanceDeductions.map((d) => d.advanceDocumentNumber)).toEqual([
      "A-2/26",
    ]);
    // Ime mora doći iz spiska — inače ekran pominje avans koji ne postoji u umanjenjima.
    expect(res.advanceInvoiceNumber).toBe("A-2/26");
    expect(res.advanceInvoicePaidAt).toEqual(
      new Date("2026-07-01T00:00:00.000Z"),
    );
    expect(res.advanceAppliedAmount.toFixed(2)).toBe("2000.00");
  });

  it("zatečena veza JE odbitak: ona je prvi red i ona se imenuje", async () => {
    const prisma = makePrisma({
      invoice: {
        ...INVOICE,
        advanceInvoiceId: 1,
        advanceAppliedAmount: D("5000"),
      },
      applications: [
        {
          id: 11,
          advanceInvoiceId: 2,
          appliedAmount: D("2000"),
          appliedNet: D("1666.67"),
          appliedVat: D("333.33"),
          closingEntryId: 500,
          createdAt: new Date("2026-07-20T00:00:00.000Z"),
          advance: {
            documentNumber: "A-2/26",
            advancePaidAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        },
      ],
      legacyAdvance: {
        documentNumber: "A-1/26",
        advancePaidAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    });
    const { service } = makeService(prisma);

    const res = await service.getInvoice(7);

    // 5.000 − 2.000 = 3.000 je deo koji ne pokriva nijedna primena (stari put).
    expect(res.advanceDeductions).toEqual([
      expect.objectContaining({
        advanceDocumentNumber: "A-1/26",
        fromLegacyLink: true,
      }),
      expect.objectContaining({
        advanceDocumentNumber: "A-2/26",
        fromLegacyLink: false,
      }),
    ]);
    expect(res.advanceInvoiceNumber).toBe("A-1/26");
    expect(res.advanceInvoicePaidAt).toEqual(
      new Date("2026-06-01T00:00:00.000Z"),
    );
    expect(res.advanceAppliedAmount.toFixed(2)).toBe("5000.00");
    expect(res.payableAmount.toFixed(2)).toBe("5000.00");
  });

  it("račun bez avansa: nema ni imena ni datuma", async () => {
    const prisma = makePrisma({
      invoice: {
        ...INVOICE,
        advanceInvoiceId: null,
        advanceAppliedAmount: D(0),
      },
      applications: [],
    });
    const { service } = makeService(prisma);

    const res = await service.getInvoice(7);
    expect(res.advanceInvoiceNumber).toBeNull();
    expect(res.advanceInvoicePaidAt).toBeNull();
    expect(res.advanceDeductions).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) KNJIŽENJE — nalog GK nosi IZDAT broj, i ne postoji bez naloga (N1 / N4)
// ─────────────────────────────────────────────────────────────────────────────

/** Stavka 100.000,00 po šifri „3" (= 20 %, v. `gl/posting/vat-rates.ts`). */
const ITEM_20 = { vatRateCode: "3", vatBase: D("100000") };

/** Predračun #300 prepisan u IFUSL — carry-over mu upisuje privremeni `DRAFT-300`. */
function draftInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 300,
    documentType: "IFUSL",
    documentNumber: "DRAFT-300",
    level: 250,
    companyId: 0,
    customerId: 42,
    documentDate: new Date("2026-07-15T00:00:00.000Z"),
    supplyDate: null,
    dueDate: null,
    currency: "RSD",
    isExport: false,
    status: "DRAFT",
    isLocked: false,
    stockDocumentId: null,
    workOrderId: null,
    journalEntryId: null,
    netTotal: D("100000"),
    vatTotal: D("20000"),
    grossTotal: D("120000"),
    items: [ITEM_20],
    ...over,
  };
}

function makePostHarness(opts: {
  invoice?: Record<string, unknown>;
  /** Nalog vezan za robni izlaz (`journalEntry.findFirst`) — `null` = nije proknjižen. */
  stockEntry?: { id: number; status: string } | null;
} = {}) {
  const invoice = opts.invoice ?? draftInvoice();
  const createdEntries: Record<string, unknown>[] = [];

  const client = {
    invoice: {
      findUnique: jest.fn().mockResolvedValue(invoice),
      // Knjiženje od 03.08.2026. PONOVO čita dokument UNUTAR transakcije, posle CAS-a:
      // snapshot pročitan pre transakcije je zastareo, jer drugi operater sme da izmeni
      // isti nacrt sve dok CAS ne prelomi DRAFT → POSTED. Ovde vraća isti red.
      findUniqueOrThrow: jest.fn().mockResolvedValue(invoice),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...invoice, ...data }),
        ),
    },
    // Kupac bez kreditnog limita — `assertCreditLimit` izlazi odmah.
    customer: { findUnique: jest.fn().mockResolvedValue({ creditLimit: null }) },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([ITEM_20]) },
    journalEntry: {
      findFirst: jest.fn().mockResolvedValue(opts.stockEntry ?? null),
      // `nextJournalNumber` traži postojeće naloge po (firma, vrsta, godina).
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          createdEntries.push(data);
          return Promise.resolve({ id: 900 });
        }),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  const prisma = {
    ...client,
    $transaction: jest.fn((cb: (tx: typeof client) => unknown) => cb(client)),
  };

  const numbering = { next: jest.fn().mockResolvedValue("657/26") };
  const service = new FakturisanjeService(
    prisma as never,
    {} as never, // pricing
    numbering as never,
    {} as never, // posting
    { reverse: jest.fn(), reverseWithin: jest.fn() } as never,
    {} as never, // sef
    {} as never, // reservation
  );
  return { service, prisma, numbering, createdEntries };
}

describe("postInvoice — nalog GK nosi IZDAT broj fakture (N1)", () => {
  it("ručni nalog: i `document_number` i opisi nose 657/26, ne DRAFT-300", async () => {
    // Ceo scenario: predračun #300 → IFUSL (carry-over upisuje `DRAFT-300`) → knjiženje
    // izdaje `657/26`. Do ispravke je `postManualLedger` dobijao NEDIRNUT snapshot, pa su
    // sve tri linije naloga (2040 DUG 120.000 / 6140 POT 100.000 / 4702 POT 20.000) nosile
    // `DRAFT-300`. Saldakonti grupišu ISKLJUČIVO po (konto, analitika, broj dokumenta), pa
    // bi kupčeva otvorena stavka glasila na broj koji ne postoji ni na jednom papiru, a
    // uplata sa pozivom na broj `657/26` je ne bi našla.
    const h = makePostHarness();

    await h.service.postInvoice(300, ACTOR);

    const lines = (
      h.createdEntries[0].lines as {
        create: { accountCode: string; documentNumber: string; description: string }[];
      }
    ).create;
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "6140", "4702"]);
    expect(lines.map((l) => l.documentNumber)).toEqual([
      "657/26",
      "657/26",
      "657/26",
    ]);
    // I opisi: „Kupac DRAFT-300" je isti podatak na drugom mestu.
    expect(lines.map((l) => l.description)).toEqual([
      "Kupac 657/26",
      "Prihod 657/26",
      "PDV 20% 657/26",
    ]);
    // Isti broj mora otići i na sam dokument (bez toga bi se GK i papir opet razišli).
    expect(h.prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          documentNumber: "657/26",
          journalEntryId: 900,
        }),
      }),
    );
  });

  it("stopa bez konta izlaznog PDV-a: poruka imenuje broj koji operater VIDI", async () => {
    // Brana `buildSalesLedgerLines` (nema konta za 8 %) se izvršava PRE transakcije, dok
    // dokument još nosi nacrt-broj. Da je prvi susret sa njom bio unutar transakcije,
    // poruka bi glasila na `657/26` — broj koji rollback vraća, pa ga nigde nema.
    const h = makePostHarness({
      invoice: draftInvoice({
        // šifra „5" = POLJO 8 % (v. `vat-rates.ts`), za koju konta nema.
        items: [{ vatRateCode: "5", vatBase: D("100000") }],
        netTotal: D("100000"),
        vatTotal: D("8000"),
        grossTotal: D("108000"),
      }),
    });

    await expect(h.service.postInvoice(300, ACTOR)).rejects.toThrow(/DRAFT-300/);
    // Broj se ne troši i CAS se ne dešava — pad je pre transakcije.
    expect(h.numbering.next).not.toHaveBeenCalled();
    expect(h.prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
});

describe("postInvoice — račun bez naloga GK se NE izdaje (N4)", () => {
  it("izdatnica još nije proknjižena → 422, umesto tihog journalEntryId = null", async () => {
    // Izmereno: IFR sa `stockDocumentId = 55` čija je izdatnica DRAFT → `findFirst` vrati
    // `null` → tiho `journalEntryId = null`. Broj `657/26` potrošen, dokument POSTED i
    // LOCKED, a u glavnoj knjizi NULA redova: nema ga ni u saldakontima, ni u KIF-u, ni u
    // POPDV-u; ponovno knjiženje pada na 409 (isLocked), storno nema šta da reverzira.
    const h = makePostHarness({
      invoice: draftInvoice({ documentType: "IFR", stockDocumentId: 55 }),
      stockEntry: null,
    });

    const err = await h.service.postInvoice(300, ACTOR).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toMatch(/izdatnicu/);
    expect((err as Error).message).toMatch(/#55/);
    // Dokument ostaje nacrt: upis (broj / level 0 / POSTED) se nikad nije desio.
    expect(h.prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("proknjižena izdatnica: nalog se preuzima (put koji radi ostaje netaknut)", async () => {
    const h = makePostHarness({
      invoice: draftInvoice({ documentType: "IFR", stockDocumentId: 55 }),
      stockEntry: { id: 777, status: "POSTED" },
    });

    await h.service.postInvoice(300, ACTOR);

    expect(h.prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ journalEntryId: 777 }),
      }),
    );
    // Auto-robna grana ne pravi ručni nalog.
    expect(h.prisma.journalEntry.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) STORNO — atomičnost, brave i SEF trka (N2 / N3 / N5)
// ─────────────────────────────────────────────────────────────────────────────

/** Proknjižena faktura 101 sa nalogom 500 i jednom aktivnom primenom avansa #9. */
const POSTED_101 = {
  id: 101,
  status: "POSTED",
  isLocked: true,
  journalEntryId: 500,
  note: null,
  documentNumber: "101/26",
  documentType: "IFUSL",
  advanceClosingEntryId: null,
  advanceInvoiceId: null,
  items: [],
};

const APPLICATION_55 = { id: 55, advanceInvoiceId: 9, closingEntryId: 600 };

describe("stornoInvoice — atomičnost (N2)", () => {
  it("zaključan nalog: NIŠTA se ne menja — ni status, ni primena avansa", async () => {
    // ⚠️ IZMERENO na zatečenom kodu: CAS `status → CANCELLED` se commit-ovao PRE
    // reverzije, pa je 409 „Nalog 500 je zaključan" ostavljao fakturu storniranu bez GL
    // storna, primenu #55 ACTIVE, kolone neočišćene i SEF/rezervacije nedirnute. Drugi
    // pokušaj → „već storniran": naplaćen avans od 30.000 trajno potrošen, jer je ovaj
    // storno JEDINI pisač statusa REVERSED.
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [APPLICATION_55],
      entries: [
        { id: 500, number: "0007", status: "LOCKED", reversedByEntryId: null },
        { id: 600, number: "0008", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, glWrite, sef, reservation } = makeService(prisma);

    const err = await service
      .stornoInvoice(101, "greška unosa", ACTOR)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(ConflictException);
    // Poruka mora imenovati BAŠ nalog koji treba otključati.
    expect((err as Error).message).toMatch(/0007/);
    // Nijedan upis: ni CAS, ni primena, ni kolone.
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
    expect(prisma.invoiceAdvanceApplication.update).not.toHaveBeenCalled();
    expect(glWrite.reverseWithin).not.toHaveBeenCalled();
    // Ni spoljni sistemi — oni idu tek posle commit-a.
    expect(sef.cancelPendingLocally).not.toHaveBeenCalled();
    expect(reservation.release).not.toHaveBeenCalled();
  });

  it("uspešan storno: reverzija ide ISTOM transakcijom (reverseWithin, ne reverse)", async () => {
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [APPLICATION_55],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
        { id: 600, number: "0008", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, glWrite } = makeService(prisma);

    const res = await service.stornoInvoice(101, "greška unosa", ACTOR);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Oba naloga (izvorni + zatvaranje avansa) idu kroz tx-svesnu reverziju.
    expect(glWrite.reverse).not.toHaveBeenCalled();
    expect(glWrite.reverseWithin.mock.calls.map((c) => c[1])).toEqual([500, 600]);
    expect(res.stornoEntryId).toBe(900);
    // Primena se gasi (bez toga avans ostaje trajno potrošen).
    expect(prisma.invoiceAdvanceApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 55 } }),
    );
  });
});

describe("stornoInvoice — brave protiv trke sa odbijanjem avansa (N3)", () => {
  it("uzima ISTE advisory brave kao applyAdvance, redom račun → avans", async () => {
    // Izmereno na dev bazi: bez brave `UPDATE status='CANCELLED'` prolazi za 93 ms dok
    // druga sesija drži otvoren INSERT primene (FOR NO KEY UPDATE se ne sudara sa FOR KEY
    // SHARE). Ishod: stornirana faktura sa ACTIVE primenom od 3.000 i nereverziranim
    // nalogom zatvaranja — izlazni PDV umanjen 500 din bez osnova.
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [APPLICATION_55],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
        { id: 600, number: "0008", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service } = makeService(prisma);

    await service.stornoInvoice(101, "greška unosa", ACTOR);

    // 4003 = brava računa, 4004 = brava avansa (`advance-invoice.service.ts`).
    // Redosled je deo ispravke: obrnut daje mrtvu petlju sa `applyAdvance`.
    expect(lockArgs(prisma.$executeRaw)).toEqual([
      [4003, 101],
      [4004, 9],
    ]);
  });

  it("storno AVR-a zaključava STRANU AVANSA pre nego što prebroji primene", async () => {
    const prisma = makePrisma({
      invoice: {
        id: 1,
        status: "POSTED",
        isLocked: true,
        journalEntryId: null,
        note: null,
        documentNumber: "A-1/26",
        documentType: "AVR",
        advanceClosingEntryId: null,
        advanceInvoiceId: null,
        items: [],
      },
      applications: [],
      invoiceApplications: [],
    });
    const { service } = makeService(prisma);

    await service.stornoInvoice(1, "greška unosa", ACTOR);

    expect(lockArgs(prisma.$executeRaw)).toEqual([
      [4003, 1],
      [4004, 1],
    ]);
  });
});

describe("stornoInvoice — SEF red koji je otišao DOK je storno trajao (N5)", () => {
  it("red postao SENT posle lokalnog otkazivanja → drugi prolaz ga otkazuje na SEF-u", async () => {
    // Izmereno (klijent kasni 300 ms): `send()` proveri da faktura nije stornirana, ode na
    // mrežu, storno se u međuvremenu ceo izvrši, `send()` se vrati i upiše SENT +
    // sefInvoiceId + sentAt. Stari kod je gledao SAMO snimak outbox-a iz trenutka storna,
    // pa SEF cancel nikad nije poslat: kupac na portalu ima važeću e-fakturu za dokument
    // koji kod nas ne postoji.
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, sef } = makeService(prisma);
    sef.listOutbox
      .mockResolvedValueOnce([{ id: 5, status: "PENDING" }])
      .mockResolvedValueOnce([{ id: 5, status: "SENT" }]);

    const res = await service.stornoInvoice(101, "greška unosa", ACTOR);

    expect(sef.cancel).toHaveBeenCalledWith(5, "greška unosa");
    expect(res.sefCancelledOutboxIds).toEqual([5]);
  });

  it("red koji je već otkazan u prvom prolazu se ne otkazuje dvaput", async () => {
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, sef } = makeService(prisma);
    sef.listOutbox.mockResolvedValue([{ id: 5, status: "SENT" }]);

    const res = await service.stornoInvoice(101, "greška unosa", ACTOR);

    expect(sef.cancel).toHaveBeenCalledTimes(1);
    expect(res.sefCancelledOutboxIds).toEqual([5]);
  });

  it("neuspeh otkazivanja jednog reda ne preskače ostale (nalaz N2-SEF)", async () => {
    // `SefService.cancel` od 03.08.2026. BACA kad SEF ne potvrdi otkazivanje. Sa golim
    // `await` u petlji prvi neuspeli red obara ceo metod, a faktura je već stornirana —
    // ostali redovi tog dokumenta ostaju neotkazani, bez drugog prolaza kroz ovu putanju.
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, sef } = makeService(prisma);
    sef.listOutbox.mockResolvedValue([
      { id: 5, status: "SENT" },
      { id: 6, status: "SENT" },
    ]);
    sef.cancel.mockImplementation((outboxId: number) =>
      outboxId === 5
        ? Promise.reject(new Error("SEF timeout"))
        : Promise.resolve(undefined),
    );

    const err = await service
      .stornoInvoice(101, "greška unosa", ACTOR)
      .catch((e: Error) => e);

    // Oba reda pokušana, ne samo prvi.
    expect(sef.cancel.mock.calls.map((c) => c[0])).toEqual([5, 6]);
    // Poruka kaže da je račun storniran i imenuje red koji čeka portal.
    expect((err as Error).message).toMatch(/storniran u knjigama/);
    expect((err as Error).message).toMatch(/\b5\b/);
  });

  it("PENDING se gasi lokalno PRE mrežnog cancel-a (pad mreže ne ostavlja red u redu za slanje)", async () => {
    const prisma = makePrisma({
      invoice: POSTED_101,
      invoiceApplications: [],
      entries: [
        { id: 500, number: "0007", status: "POSTED", reversedByEntryId: null },
      ],
    });
    const { service, sef } = makeService(prisma);
    const order: string[] = [];
    sef.cancelPendingLocally.mockImplementation(() => {
      order.push("pending");
      return Promise.resolve([7]);
    });
    sef.cancel.mockImplementation(() => {
      order.push("cancel");
      return Promise.resolve(undefined);
    });
    sef.listOutbox.mockResolvedValue([{ id: 5, status: "DELIVERED" }]);

    const res = await service.stornoInvoice(101, "greška unosa", ACTOR);

    expect(order).toEqual(["pending", "cancel"]);
    expect(res.sefCancelledPendingIds).toEqual([7]);
  });
});

describe("postInvoice — nalog GK se gradi iz SVEŽEG reda, ne iz zastarelog snapshot-a", () => {
  /**
   * REGRESIJA IZ `4f40453a`, nađena u 8. krugu i zatvorena 03.08.2026.
   *
   * Ispravka broja naloga je uz `issued` prosledila i `invoice.items` iz snapshot-a, uz
   * obrazloženje „isti ulaz kao u pred-proveri, pa se dva prolaza ne mogu razići".
   * Obrazloženje je bilo pogrešno: pred-provera radi nad ISTIM zastarelim podatkom.
   *
   * `invoice` se čita PRE transakcije, a CAS claim je tek unutar nje; u tom prozoru
   * (dve provere + agregat nad `ledger_entries` + otvaranje transakcije) drugi operater
   * sme da izmeni isti nacrt — njegov CAS nad `DRAFT & !isLocked` tada još prolazi.
   *
   * IZMERENO: stavke u bazi 2 × 100.000, snapshot 1 × 100.000 → faktura `gross 240.000`,
   * a nalog `2040 DUG 120.000`. Nalog BALANSIRA (ista pogrešna suma s obe strane), pa
   * balans-kontrola ćuti, a kupčev dug u saldakontima je pola fakture.
   */
  it("tuđa izmena nacrta u prozoru pre transakcije NE sme da proizvede nalog na stari iznos", async () => {
    const stari = draftInvoice(); // 1 stavka, gross 120.000
    const h = makePostHarness({ invoice: stari });

    // Sveže čitanje UNUTAR transakcije vidi dokument posle tuđe izmene: dve stavke.
    const svez = {
      ...stari,
      netTotal: new Prisma.Decimal("200000"),
      vatTotal: new Prisma.Decimal("40000"),
      grossTotal: new Prisma.Decimal("240000"),
      items: [ITEM_20, ITEM_20],
    };
    h.prisma.invoice.findUniqueOrThrow.mockResolvedValue(svez);

    await h.service.postInvoice(1, ACTOR);

    // Nalog mora da nosi SVEŽ iznos — inače kupac u saldakontima duguje pola fakture.
    const linije = (h.createdEntries[0]?.lines as { create: Record<string, unknown>[] })
      ?.create;
    const kupac = linije?.find((l) => String(l.accountCode).startsWith("204"));
    expect(String(kupac?.debit)).toBe("240000");
  });

  it("sveže čitanje se proverava istom branom: zaglavlje ≠ stavke → knjiženje pada, ne upisuje pogrešan iznos", async () => {
    const stari = draftInvoice();
    const h = makePostHarness({ invoice: stari });

    // Nedosledan svež red: zaglavlje kaže 240.000, stavke nose 120.000.
    h.prisma.invoice.findUniqueOrThrow.mockResolvedValue({
      ...stari,
      grossTotal: new Prisma.Decimal("240000"),
      items: [ITEM_20],
    });

    await expect(h.service.postInvoice(1, ACTOR)).rejects.toThrow();
  });
});
