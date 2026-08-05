import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { CarryOverService } from "./carry-over.service";
import { RobnoService } from "./robno.service";
import { ReservationService } from "./reservation.service";

/**
 * R1 (review 25.07) — LANAC REZERVACIJA NE SME DA SE PREKINE.
 *
 * „Rezerviši robu" upisuje rezervacije na PREDRAČUN (`sourceId` = predračun), a
 * `DocumentCarryOverService.createInvoiceFromProforma` pravi NOV level-0 račun i rezervacije
 * ostavlja na predračunu (`copiedFromDocId` je jedina veza). Izdatnica se posle pravi iz
 * KONAČNOG računa — sa izvorom `{invoice, račun}` nijedan red se ne poklapa, pa je:
 *   • guard oduzimao rezervisanu količinu od stanja → 422 „nedovoljno stanje" na robi koja
 *     fizički stoji u magacinu,
 *   • `consume` padao sa 404 i bio progutan u `.catch` → rezervacije zauvek OPEN.
 *
 * Ovde se dokazuje da izdatnica iz konačnog računa izuzima i troši rezervacije OBA izvora
 * (račun + predračun), i to u ISTOJ transakciji sa upisom izdatnice (review B).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

/** Predračun 100 → račun 200 (prepis), stavka: artikal 1, 10 kom. */
function makePrisma(invoice: {
  id: number;
  copiedFromDocId: number | null;
  stockDocumentId?: number | null;
}) {
  // ⚠️ Brojevi su u obliku koji numeracija STVARNO izdaje (O-F1/O-F7): predračun
  // `PROF-1/26`, račun `1/26`. Ranije je ovde stajao treći, nepostojeći oblik
  // (`PROF-0001/2026` / `0001/2026`) — ni stari BigBit ni novi naš, pa je fixture
  // prikrivao razliku između zatečenih i novih brojeva (nalaz N1, 02.08.2026).
  const invoices: Record<number, Record<string, unknown>> = {
    100: {
      id: 100,
      documentNumber: "PROF-1/26",
      copiedFromDocId: null,
      stockDocumentId: null,
      customerId: 7,
      items: [
        { id: 1, lineNo: 1, itemId: 1, quantity: D(10), unitPrice: D(500) },
      ],
    },
    200: {
      id: 200,
      documentNumber: "1/26",
      copiedFromDocId: 100,
      stockDocumentId: null,
      customerId: 7,
      items: [
        { id: 2, lineNo: 1, itemId: 1, quantity: D(10), unitPrice: D(500) },
      ],
    },
  };
  invoices[invoice.id] = {
    ...invoices[invoice.id],
    copiedFromDocId: invoice.copiedFromDocId,
    stockDocumentId: invoice.stockDocumentId ?? null,
  };

  return {
    invoice: {
      findUnique: jest.fn(({ where }: { where: { id: number } }) =>
        Promise.resolve(invoices[where.id] ?? null),
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    stockDocument: {
      findUnique: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
    },
    stockDocumentItem: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

/** RobnoService dvojnik: pamti `opts` i pušta `afterCreate` kroz „tx". */
function makeRobno() {
  const tx = { marker: "tx" };
  const createStockDocument = jest.fn(
    async (
      _kind: string,
      _dto: unknown,
      opts?: {
        afterCreate?: (tx: unknown, doc: unknown) => Promise<void>;
      },
    ) => {
      const doc = { id: 900, documentNumber: "IZ-0007/2026" };
      if (opts?.afterCreate) await opts.afterCreate(tx, doc);
      return { data: doc };
    },
  );
  return { robno: { createStockDocument }, createStockDocument, tx };
}

/** Opcije prosleđene `createStockDocument` (tipizovano — `mock.calls` je `any[]`). */
function createOpts(fn: jest.Mock): {
  reservationSource: Array<{ sourceType: string; sourceId: number }>;
} {
  const calls = fn.mock.calls as unknown as Array<
    [
      string,
      unknown,
      { reservationSource: Array<{ sourceType: string; sourceId: number }> },
    ]
  >;
  return calls[0][2];
}

/** Pozivi `consumeWithin` (tx, referenca izvora) — tipizovano. */
function consumeCalls(
  fn: jest.Mock,
): Array<[unknown, { sourceId: number; reason: string }]> {
  return fn.mock.calls as Array<
    [unknown, { sourceId: number; reason: string }]
  >;
}

describe("CarryOverService.fromInvoice — lanac rezervacija (R1)", () => {
  it("izdatnica iz KONAČNOG računa izuzima i troši rezervacije računa I predračuna", async () => {
    const prisma = makePrisma({ id: 200, copiedFromDocId: 100 });
    const { robno, createStockDocument, tx } = makeRobno();
    const consumeWithin = jest
      .fn()
      .mockResolvedValue({ data: { noop: false } });

    const service = new CarryOverService(
      prisma as unknown as PrismaService,
      robno as unknown as RobnoService,
      { consumeWithin } as unknown as ReservationService,
    );

    await service.fromInvoice(200, {}, 42);

    // 1) Guard mora da izuzme OBA izvora — inače 422 „nedovoljno stanje".
    const opts = createOpts(createStockDocument);
    expect(opts.reservationSource).toEqual([
      { sourceType: "invoice", sourceId: 200 },
      { sourceType: "invoice", sourceId: 100 },
    ]);

    // 2) Oba izvora se troše, u ISTOJ transakciji (dobijeni `tx`, ne `this.prisma`).
    expect(consumeWithin).toHaveBeenCalledTimes(2);
    const consumed = consumeCalls(consumeWithin);
    expect(consumed[0][0]).toBe(tx);
    expect(consumed.map((c) => c[1].sourceId)).toEqual([200, 100]);
    expect(consumed[0][1]).toMatchObject({
      reason: "izdatnica IZ-0007/2026",
    });
  });

  it("izdatnica direktno iz predračuna i dalje troši svoj (jedini) izvor", async () => {
    const prisma = makePrisma({ id: 100, copiedFromDocId: null });
    const { robno, createStockDocument } = makeRobno();
    const consumeWithin = jest.fn().mockResolvedValue({ data: { noop: true } });

    const service = new CarryOverService(
      prisma as unknown as PrismaService,
      robno as unknown as RobnoService,
      { consumeWithin } as unknown as ReservationService,
    );

    await service.fromInvoice(100, {}, 42);

    expect(createOpts(createStockDocument).reservationSource).toEqual([
      { sourceType: "invoice", sourceId: 100 },
    ]);
    expect(consumeWithin).toHaveBeenCalledTimes(1);
  });

  it("pad zatvaranja rezervacija ruši ceo prepis (nema izdatnice sa večno OPEN rezervacijama)", async () => {
    const prisma = makePrisma({ id: 200, copiedFromDocId: 100 });
    const { robno } = makeRobno();
    const consumeWithin = jest
      .fn()
      .mockRejectedValue(new Error("baza nedostupna"));

    const service = new CarryOverService(
      prisma as unknown as PrismaService,
      robno as unknown as RobnoService,
      { consumeWithin } as unknown as ReservationService,
    );

    await expect(service.fromInvoice(200, {}, 42)).rejects.toThrow(
      "baza nedostupna",
    );
    // Veza na fakturu se NE upisuje kad prepis nije uspeo.
    expect(prisma.invoice.updateMany).not.toHaveBeenCalled();
  });
});
