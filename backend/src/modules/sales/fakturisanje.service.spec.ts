import { ConflictException } from "@nestjs/common";
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

function makePrisma(opts: {
  /** Dokument koji se stornira / čita (`invoice.findUnique` po `where.id`). */
  invoice?: Record<string, unknown>;
  /** Aktivne primene (`invoiceAdvanceApplication.findMany`). */
  applications?: unknown[];
  /** Računi koji KOLONOM pokazuju na posmatrani AVR. */
  linked?: LinkedRow[];
  /** AVR na koji pokazuje kolona posmatranog računa (za `getInvoice`). */
  legacyAdvance?: { documentNumber: string; advancePaidAt: Date | null } | null;
  claimCount?: number;
}) {
  const prisma = {
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
      findMany: jest.fn().mockResolvedValue(opts.applications ?? []),
      update: jest.fn().mockResolvedValue({}),
    },
    journalEntry: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  return prisma;
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  const sef = {
    listOutbox: jest.fn().mockResolvedValue([]),
    cancelPendingLocally: jest.fn().mockResolvedValue([]),
    cancel: jest.fn().mockResolvedValue(undefined),
  };
  const reservation = { release: jest.fn().mockResolvedValue(undefined) };
  const glWrite = { reverse: jest.fn() };
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
