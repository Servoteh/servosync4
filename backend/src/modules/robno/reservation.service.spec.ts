import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { ReservationService } from "./reservation.service";
import { RESERVATION_STATUS } from "./dto/reservation.dto";

/**
 * Rezervacija zaliha (C3) — scenario iz definicije gotovog:
 *   stanje 12 → predračun na 10 → raspoloživo 2 → pokušaj 5 = 422 („raspoloživo 2")
 *   → release vraća na 12 → consume NE vraća → dvostruki release nije greška ni duplikat.
 *
 * Baza je zamenjena minimalnim in-memory Prisma dvojnikom (bez Docker-a): pokriva tačno one
 * oblike upita koje servis koristi (findMany/groupBy/create/updateMany/count/findUnique/
 * $transaction/$executeRaw) + unique `uq_stock_reservations_source_line` (P2002).
 */

const D = (v: string | number) => new Prisma.Decimal(v);

interface ResRow {
  id: number;
  itemId: number;
  warehouseId: number;
  sourceType: string;
  sourceId: number;
  sourceLine: number | null;
  quantity: Prisma.Decimal;
  status: string;
  releasedAt: Date | null;
  releaseReason: string | null;
  expiresAt: Date | null;
  note: string | null;
  createdByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Poređenje jednog polja sa Prisma filterom (podskup koji servis stvarno koristi). */
function fieldMatches(value: unknown, filter: unknown): boolean {
  if (filter === null || typeof filter !== "object" || filter instanceof Date)
    return value instanceof Date && filter instanceof Date
      ? value.getTime() === filter.getTime()
      : value === filter;
  const f = filter as Record<string, unknown>;
  if ("in" in f) return (f.in as unknown[]).includes(value);
  if ("not" in f) return !fieldMatches(value, f.not);
  if ("lt" in f)
    return (
      value instanceof Date &&
      f.lt instanceof Date &&
      value.getTime() < f.lt.getTime()
    );
  return false;
}

function matches(
  row: Record<string, unknown>,
  where?: Record<string, unknown>,
): boolean {
  if (!where) return true;
  for (const [key, filter] of Object.entries(where)) {
    if (filter === undefined) continue;
    if (key === "NOT") {
      if (matches(row, filter as Record<string, unknown>)) return false;
      continue;
    }
    if (!fieldMatches(row[key], filter)) return false;
  }
  return true;
}

/** In-memory dvojnik `PrismaService` — samo tabele/upiti koje ReservationService dodiruje. */
function makeDb(opts: {
  onHand: Prisma.Decimal;
  invoice?: {
    id: number;
    documentType: string;
    level: number;
    documentNumber: string;
    dueDate: Date | null;
    items: Array<{
      lineNo: number;
      itemId: number | null;
      quantity: Prisma.Decimal;
    }>;
  };
}) {
  const reservations: ResRow[] = [];
  let seq = 0;

  const levels = [{ itemId: 1, warehouseId: 1, onHand: opts.onHand }];
  const items = [
    { id: 1, name: "Artikal A", catalogNumber: "A-001", unit: "kom" },
  ];
  const warehouses = [{ id: 1 }];

  const client = {
    stockReservation: {
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          reservations.filter((r) =>
            matches(r as unknown as Record<string, unknown>, where),
          ),
        ),
      count: ({ where }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          reservations.filter((r) =>
            matches(r as unknown as Record<string, unknown>, where),
          ).length,
        ),
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(reservations.find((r) => r.id === where.id) ?? null),
      groupBy: ({ where }: { where?: Record<string, unknown> } = {}) => {
        const acc = new Map<
          string,
          { itemId: number; warehouseId: number; sum: Prisma.Decimal }
        >();
        for (const r of reservations) {
          if (!matches(r as unknown as Record<string, unknown>, where))
            continue;
          const key = `${r.itemId}:${r.warehouseId}`;
          const cur = acc.get(key);
          if (cur) cur.sum = cur.sum.add(r.quantity);
          else
            acc.set(key, {
              itemId: r.itemId,
              warehouseId: r.warehouseId,
              sum: r.quantity,
            });
        }
        return Promise.resolve(
          [...acc.values()].map((a) => ({
            itemId: a.itemId,
            warehouseId: a.warehouseId,
            _sum: { quantity: a.sum },
          })),
        );
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        const sourceLine = (data.sourceLine as number | null) ?? null;
        // uq_stock_reservations_source_line — PostgreSQL NULL-ove tretira kao različite.
        if (
          sourceLine !== null &&
          reservations.some(
            (r) =>
              r.sourceType === data.sourceType &&
              r.sourceId === data.sourceId &&
              r.sourceLine === sourceLine,
          )
        )
          return Promise.reject(
            new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              {
                code: "P2002",
                clientVersion: "test",
              },
            ),
          );
        const row: ResRow = {
          id: ++seq,
          itemId: data.itemId as number,
          warehouseId: data.warehouseId as number,
          sourceType: data.sourceType as string,
          sourceId: data.sourceId as number,
          sourceLine,
          quantity: data.quantity as Prisma.Decimal,
          status: (data.status as string) ?? RESERVATION_STATUS.OPEN,
          releasedAt: null,
          releaseReason: null,
          expiresAt: (data.expiresAt as Date | null) ?? null,
          note: (data.note as string | null) ?? null,
          createdByUserId: (data.createdByUserId as number | null) ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        reservations.push(row);
        return Promise.resolve(row);
      },
      updateMany: ({
        where,
        data,
      }: {
        where?: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const r of reservations) {
          if (!matches(r as unknown as Record<string, unknown>, where))
            continue;
          Object.assign(r, data);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    },
    stockLevel: {
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          levels.filter((l) =>
            matches(l as unknown as Record<string, unknown>, where),
          ),
        ),
    },
    item: {
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          items.filter((i) =>
            matches(i as unknown as Record<string, unknown>, where),
          ),
        ),
    },
    warehouse: {
      findMany: ({ where }: { where?: Record<string, unknown> } = {}) =>
        Promise.resolve(
          warehouses.filter((w) =>
            matches(w as unknown as Record<string, unknown>, where),
          ),
        ),
    },
    invoice: {
      findUnique: ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          opts.invoice && opts.invoice.id === where.id ? opts.invoice : null,
        ),
    },
    $executeRaw: () => Promise.resolve(0),
    $transaction: (arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: unknown) => Promise<unknown>)(client)
        : Promise.all(arg as Promise<unknown>[]),
  };

  return { client, reservations };
}

const PROFORMA = {
  id: 100,
  documentType: "PROF",
  level: 250,
  documentNumber: "0001/2026",
  dueDate: null as Date | null,
  items: [{ lineNo: 1, itemId: 1, quantity: D(10) }],
};

function makeService(onHand = D(12), invoice = PROFORMA) {
  const { client, reservations } = makeDb({ onHand, invoice });
  const service = new ReservationService(client as unknown as PrismaService);
  return { service, reservations };
}

describe("ReservationService (C3)", () => {
  it("predračun na 10 od stanja 12 → rezervisano 10, raspoloživo 2", async () => {
    const { service } = makeService();
    const res = await service.reserveForProforma({ invoiceId: 100 }, 7);
    expect(res.data.created).toBe(1);
    expect(res.data.skipped).toBe(0);

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.onHand).toBe("12.000");
    expect(av.data.reserved).toBe("10.000");
    expect(av.data.available).toBe("2.000");
  });

  it("pokušaj rezervacije 5 preko raspoloživog 2 → 422 sa porukom koja kaže raspoloživo 2", async () => {
    const { service } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });

    expect.assertions(4);
    try {
      await service.create({ itemId: 1, warehouseId: 1, quantity: 5 });
    } catch (e) {
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      const body = (e as UnprocessableEntityException).getResponse() as {
        code: string;
        message: string;
        shortages: Array<{ requested: string; available: string }>;
      };
      expect(body.code).toBe("RESERVATION_EXCEEDS_AVAILABLE");
      expect(body.message).toContain("raspoloživo 2");
      expect(body.shortages[0]).toMatchObject({
        requested: "5",
        available: "2",
      });
    }
  });

  it("release vraća raspoloživo na 12 (OPEN → RELEASED)", async () => {
    const { service, reservations } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });

    const rel = await service.release({
      sourceType: "invoice",
      sourceId: 100,
      reason: "otkazan predračun",
    });
    expect(rel.data.released).toBe(1);
    expect(reservations[0].status).toBe(RESERVATION_STATUS.RELEASED);
    expect(reservations[0].releaseReason).toBe("otkazan predračun");
    expect(reservations[0].releasedAt).toBeInstanceOf(Date);

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.reserved).toBe("0.000");
    expect(av.data.available).toBe("12.000");
  });

  it("dvostruki release nije greška, ali ne duplira efekat", async () => {
    const { service, reservations } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });
    await service.release({
      sourceType: "invoice",
      sourceId: 100,
      reason: "prvi",
    });

    const second = await service.release({
      sourceType: "invoice",
      sourceId: 100,
      reason: "drugi",
    });
    expect(second.data.released).toBe(0);
    expect(second.data.noop).toBe(true);
    expect(reservations).toHaveLength(1);
    // CAS (`status: 'OPEN'` u where) — drugi poziv NE prepisuje razlog prvog oslobađanja.
    expect(reservations[0].releaseReason).toBe("prvi");

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.available).toBe("12.000");
  });

  it("consume NE vraća količinu u raspoloživo (roba je otišla)", async () => {
    const { service, reservations } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });

    const res = await service.consume({
      sourceType: "invoice",
      sourceId: 100,
      reason: "izdatnica 0007/2026",
    });
    expect(res.data.consumed).toBe(1);
    expect(reservations[0].status).toBe(RESERVATION_STATUS.CONSUMED);

    // onHand u dvojniku ostaje 12 (izdatnica ga umanjuje u robnom toku) — bitno je da
    // potrošena rezervacija VIŠE NE ULAZI u „rezervisano", ali ni ne vraća robu u ponudu.
    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.reserved).toBe("0.000");
  });

  it("reserveForProforma je idempotentan — ponovni poziv preskače postojeće redove", async () => {
    const { service, reservations } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });
    const again = await service.reserveForProforma({ invoiceId: 100 });

    expect(again.data.created).toBe(0);
    expect(again.data.skipped).toBe(1);
    expect(reservations).toHaveLength(1);

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.reserved).toBe("10.000"); // nije 20 — nema dvostruke rezervacije
  });

  it("odbija rezervaciju iz knjiženog računa (nije PON/PROF nacrt)", async () => {
    const { service } = makeService(D(12), {
      ...PROFORMA,
      documentType: "IFR",
      level: 0,
    });
    await expect(
      service.reserveForProforma({ invoiceId: 100 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("expireDue oslobađa istekle rezervacije sa razlogom", async () => {
    const past = new Date("2026-07-01T00:00:00.000Z");
    const { service, reservations } = makeService(D(12), {
      ...PROFORMA,
      dueDate: past,
    });
    await service.reserveForProforma({ invoiceId: 100 });
    expect(reservations[0].expiresAt).toEqual(past);

    const res = await service.expireDue(new Date("2026-07-25T00:00:00.000Z"));
    expect(res.data.released).toBe(1);
    expect(reservations[0].status).toBe(RESERVATION_STATUS.RELEASED);
    expect(reservations[0].releaseReason).toBe("istekla rezervacija");

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.available).toBe("12.000");
  });

  it("ručna rezervacija istog izvora/stavke je 409 (za razliku od bulk preskakanja)", async () => {
    const { service } = makeService();
    await service.create({
      itemId: 1,
      warehouseId: 1,
      quantity: 1,
      sourceType: "manual",
      sourceId: 5,
      sourceLine: 1,
    });
    await expect(
      service.create({
        itemId: 1,
        warehouseId: 1,
        quantity: 1,
        sourceType: "manual",
        sourceId: 5,
        sourceLine: 1,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("release nepostojećeg izvora = 404", async () => {
    const { service } = makeService();
    await expect(
      service.release({ sourceType: "invoice", sourceId: 999 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("availabilityMany radi jednim agregatom (bez N+1)", async () => {
    const { service } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });
    const res = await service.availabilityMany([
      { itemId: 1, warehouseId: 1 },
      { itemId: 2, warehouseId: 1 },
    ]);
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({ onHand: "12.000", available: "2.000" });
    // Artikal bez stanja i bez rezervacija — nula, ne pad.
    expect(res.data[1]).toMatchObject({ onHand: "0.000", available: "0.000" });
  });
});
