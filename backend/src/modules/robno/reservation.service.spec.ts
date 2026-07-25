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
 * $transaction/$queryRaw/$executeRaw) + unique `uq_stock_reservations_source_line` (P2002).
 *
 * STANJE (`onHand`) dolazi iz `$queryRaw` agregata nad kretanjima (review A) — dvojnik zato
 * vraća agregatne redove, NE `stock_levels` (ta tabela nema pisca i uvek je prazna).
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
    // `AND: [{ NOT: … }, { NOT: … }]` — izuzimanje VIŠE izvora rezervacije (R1).
    if (key === "AND") {
      const clauses = (Array.isArray(filter) ? filter : [filter]) as Array<
        Record<string, unknown>
      >;
      if (!clauses.every((c) => matches(row, c))) return false;
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

  // Agregat kretanja (`computeOnHand`) — jedini izvor stanja; `stock_levels` se ne čita.
  const movementState = [{ item_id: 1, warehouse_id: 1, state: opts.onHand }];
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
    // Jedini `$queryRaw` u ovom servisu je agregat stanja iz kretanja (`computeOnHand`).
    $queryRaw: () => Promise.resolve(movementState),
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

  it("artikal bez ijednog kretanja → stanje 0 (ne pad)", async () => {
    const { service } = makeService();
    const av = await service.availability({ itemId: 2, warehouseId: 1 });
    expect(av.data).toMatchObject({ onHand: "0.000", available: "0.000" });
  });
});

// ────────────────────────────────────────── regresija: nalazi review-a 25.07

describe("ReservationService — regresije (review 25.07)", () => {
  /**
   * A: stanje se čita iz AGREGATA KRETANJA, ne iz `stock_levels`. Dvojnik uopšte nema
   * `stockLevel` model — da poziv na njega padne testom, ne tek na produkciji (gde je tabela
   * prazna pa je `onHand` uvek bio 0 i svaka rezervacija padala sa „raspoloživo 0").
   */
  it("A — raspoloživo se računa iz kretanja (stock_levels se ne dira)", async () => {
    const { client } = makeDb({ onHand: D(12), invoice: PROFORMA });
    expect((client as Record<string, unknown>).stockLevel).toBeUndefined();

    const service = new ReservationService(client as unknown as PrismaService);
    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.onHand).toBe("12.000");

    const res = await service.reserveForProforma({ invoiceId: 100 });
    expect(res.data.created).toBe(1);
  });

  /**
   * D + bezbednosni nalaz: `{ sourceType: 'manual', sourceId: 0 }` je oslobađalo SVE ručne
   * rezervacije u sistemu jednim pozivom (podrazumevani `sourceId` ručnih rezervacija).
   */
  it("D — masovno oslobađanje ručnih rezervacija je odbijeno (422), redovi ostaju OPEN", async () => {
    const { service, reservations } = makeService();
    await service.create({ itemId: 1, warehouseId: 1, quantity: 1 });
    await service.create({ itemId: 1, warehouseId: 1, quantity: 2 });

    await expect(
      service.release({ sourceType: "manual", sourceId: 0 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(
      reservations.every((r) => r.status === RESERVATION_STATUS.OPEN),
    ).toBe(true);

    // Pojedinačno oslobađanje (dugme na listi) i dalje radi.
    const one = await service.releaseById(reservations[0].id, "greška unosa");
    expect(one.data.released).toBe(1);
  });

  it("D — oslobađanje po izvoru radi za pravi dokument i za tačnu stavku", async () => {
    const { service, reservations } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });
    const res = await service.release({ sourceType: "invoice", sourceId: 100 });
    expect(res.data.released).toBe(1);
    expect(reservations[0].status).toBe(RESERVATION_STATUS.RELEASED);
  });

  /**
   * E: izmenjena količina na stavci predračuna se USKLAĐUJE. Ranije je ponovni „Rezerviši"
   * javljao uspeh (`skipped: 1`) a red je i dalje držao staru količinu.
   */
  it("E — izmenjena količina na predračunu se usklađuje pri ponovnom rezervisanju", async () => {
    const invoice = {
      ...PROFORMA,
      items: [{ lineNo: 1, itemId: 1, quantity: D(2) }],
    };
    const { service, reservations } = makeService(D(12), invoice);

    await service.reserveForProforma({ invoiceId: 100 });
    expect(reservations[0].quantity.toString()).toBe("2");

    invoice.items[0].quantity = D(8); // korisnik promenio količinu na stavci
    const again = await service.reserveForProforma({ invoiceId: 100 });
    expect(again.data.updated).toBe(1);
    expect(again.data.created).toBe(0);
    expect(again.data.skipped).toBe(0);
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity.toString()).toBe("8");

    const av = await service.availability({ itemId: 1, warehouseId: 1 });
    expect(av.data.reserved).toBe("8.000");
    expect(av.data.available).toBe("4.000");
  });

  it("E — nepromenjena količina se i dalje samo preskače", async () => {
    const { service } = makeService();
    await service.reserveForProforma({ invoiceId: 100 });
    const again = await service.reserveForProforma({ invoiceId: 100 });
    expect(again.data).toMatchObject({ created: 0, updated: 0, skipped: 1 });
  });

  it("E — usklađivanje preko raspoloživog je 422 (poruka nosi i sopstvenu količinu)", async () => {
    const invoice = {
      ...PROFORMA,
      items: [{ lineNo: 1, itemId: 1, quantity: D(2) }],
    };
    const { service, reservations } = makeService(D(12), invoice);
    await service.reserveForProforma({ invoiceId: 100 });

    invoice.items[0].quantity = D(80); // preko stanja
    await expect(
      service.reserveForProforma({ invoiceId: 100 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(reservations[0].quantity.toString()).toBe("2"); // nije dirano
  });

  /**
   * B: izdatnica se pravi i iz dokumenata koji nikad nisu rezervisali robu — `consume` tada
   * NE sme da baci 404 (inače upozorenje u logu na svakom prepisu utopi pravu grešku).
   */
  it("B — consume bez ijedne rezervacije je noop, ne 404", async () => {
    const { service } = makeService();
    const res = await service.consume({ sourceType: "invoice", sourceId: 777 });
    expect(res.data.noop).toBe(true);
    expect(res.data.consumed).toBe(0);
  });
});
