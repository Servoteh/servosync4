import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { Sy15StorageService } from "../../common/sy15/sy15-storage.service";

/**
 * Idempotency + payload/merge paritet — Plan proizvodnje mutacije (MODULE_SPEC §3).
 * reassign koristi `p_client_event_uuid` (postojeći mehanizam; bulk = JEDAN deljen);
 * overlay je merge-upsert (samo poslata polja + audit stamp email).
 */
const UUID = "3b241101-e2bb-4255-8caf-4136c566a962";

describe("PlanProizvodnjeService mutacije (idempotency + merge)", () => {
  const email = "pm@servoteh.com";

  /** Sy15 mock koji `withUserRls` pokreće sa fake tx (hvata poslednji Prisma.Sql / upsert). */
  const makeService = () => {
    const captured: { sql?: { values: unknown[] }; upsert?: unknown } = {};
    const tx = {
      $queryRaw: jest.fn(async (sql: { values: unknown[] }) => {
        captured.sql = sql;
        return [{ r: { ok: true } }];
      }),
      ppOverlay: {
        upsert: jest.fn(async (args: unknown) => {
          captured.upsert = args;
          return { id: 1 };
        }),
      },
      ppUrgency: {
        upsert: jest.fn(async (args: unknown) => {
          captured.upsert = args;
          return { workOrderId: 9400n, isUrgent: false };
        }),
      },
    };
    const withUserRls = jest.fn(
      async (_email: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const storage = {} as Sy15StorageService;
    const svc = new PlanProizvodnjeService(sy15, storage);
    return { svc, captured, tx };
  };

  it("reassign: prosleđen clientEventId ide u p_client_event_uuid", async () => {
    const { svc, captured } = makeService();
    await svc.reassign(email, {
      workOrderId: "40681",
      lineId: "5",
      targetMachine: "3.9.1",
      force: false,
      clientEventId: UUID,
    });
    expect(captured.sql?.values).toContain(UUID);
    expect(captured.sql?.values).toContain(40681n);
    expect(captured.sql?.values).toContain(5n);
  });

  it("reassign: bez clientEventId generiše UUID (idempotency ključ)", async () => {
    const { svc, captured } = makeService();
    await svc.reassign(email, { workOrderId: "1", lineId: "1" });
    const cev = captured.sql?.values?.[5];
    expect(typeof cev).toBe("string");
    expect(cev).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("bulkReassign: p_pairs = [{wo,line}] (NE work_order_id/camelCase); JEDAN deljen uuid", async () => {
    const { svc, captured } = makeService();
    await svc.bulkReassign(email, {
      pairs: [
        { workOrderId: "10", lineId: "2" },
        { workOrderId: "11", lineId: "3" },
      ],
      targetMachine: "2.10",
      clientEventId: UUID,
    });
    expect(captured.sql?.values).toContain(
      JSON.stringify([
        { wo: 10, line: 2 },
        { wo: 11, line: 3 },
      ]),
    );
    expect(captured.sql?.values).toContain(UUID); // jedan deljen za ceo bulk
  });

  it("overlay merge: create stampuje created_by+updated_by; update SAMO updated_by + audit stamp", async () => {
    const { svc, captured } = makeService();
    await svc.upsertOverlay(email, {
      workOrderId: "5",
      lineId: "7",
      localStatus: "blocked",
      camReady: true,
    });
    const args = captured.upsert as {
      where: { workOrderId_lineId: { workOrderId: bigint; lineId: bigint } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.where.workOrderId_lineId).toEqual({
      workOrderId: 5n,
      lineId: 7n,
    });
    expect(args.create.localStatus).toBe("blocked");
    expect(args.create.camReady).toBe(true);
    expect(args.create.camReadyBy).toBe(email);
    expect(args.create.camReadyAt).toBeInstanceOf(Date);
    expect(args.create.createdBy).toBe(email);
    expect(args.create.updatedBy).toBe(email);
    // update NE sme da nosi created_by (merge — ne prepisuje autora reda).
    expect(args.update).not.toHaveProperty("createdBy");
    expect(args.update.updatedBy).toBe(email);
    expect(args.update.camReadyBy).toBe(email);
  });

  it("clearUrgent: flag off + cleared_* (NIKAD ne briše red)", async () => {
    const { svc, captured } = makeService();
    await svc.clearUrgent(email, "9400");
    const args = captured.upsert as { update: Record<string, unknown> };
    expect(args.update.isUrgent).toBe(false);
    expect(args.update.clearedBy).toBe(email);
    expect(args.update.clearedAt).toBeInstanceOf(Date);
  });

  /**
   * Pin-to-top kanon (GAP-PM-10): klijent šalje shiftSortOrder=-1, BE upisuje
   * MIN(ručnih iste mašine)−1 → svaki novi pin ide IZNAD prethodnog.
   * Mock vraća redom MIN=null (nema ručnih) pa MIN=-1 (posle prvog pina).
   */
  const makePinService = (mins: (number | null)[]) => {
    const upserts: unknown[] = [];
    let i = 0;
    const tx = {
      $queryRaw: jest.fn(async () => [{ min_order: mins[i++] ?? null }]),
      ppOverlay: {
        upsert: jest.fn(async (args: unknown) => {
          upserts.push(args);
          return { id: upserts.length };
        }),
      },
    };
    const withUserRls = jest.fn(
      async (_e: string, fn: (t: unknown) => Promise<unknown>) => fn(tx),
    );
    const sy15 = { withUserRls } as unknown as Sy15Service;
    const svc = new PlanProizvodnjeService(sy15, {} as Sy15StorageService);
    return { svc, upserts };
  };

  it("pin-to-top: 2 uzastopna pina → prvi=1 (nema ručnih), drugi=−2 (min(−1)−1) — svaki iznad", async () => {
    // 1) prazan skup ručnih → MIN=null → fallback 1
    const { svc, upserts } = makePinService([null, -1]);
    await svc.upsertOverlay(email, {
      workOrderId: "40681",
      lineId: "5",
      shiftSortOrder: -1,
    });
    const first = upserts[0] as { create: Record<string, unknown> };
    expect(first.create.shiftSortOrder).toBe(1);

    // 2) sada postoji ručni red sa −1 → MIN=−1 → novi pin = −2 (iznad prethodnog)
    await svc.upsertOverlay(email, {
      workOrderId: "40682",
      lineId: "9",
      shiftSortOrder: -1,
    });
    const second = upserts[1] as { create: Record<string, unknown> };
    expect(second.create.shiftSortOrder).toBe(-2);
  });

  it("pin-to-top: shiftSortOrder != -1 (drag redosled / null unpin) prolazi DOSLOVNO, bez min upita", async () => {
    const { svc, upserts } = makePinService([]);
    await svc.upsertOverlay(email, {
      workOrderId: "1",
      lineId: "1",
      shiftSortOrder: 7,
    });
    const a = upserts[0] as { create: Record<string, unknown> };
    expect(a.create.shiftSortOrder).toBe(7);

    await svc.upsertOverlay(email, {
      workOrderId: "1",
      lineId: "1",
      shiftSortOrder: null,
    });
    const b = upserts[1] as { create: Record<string, unknown> };
    expect(b.create.shiftSortOrder).toBeNull();
  });
});
