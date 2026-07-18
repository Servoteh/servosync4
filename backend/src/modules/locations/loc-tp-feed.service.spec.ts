import { ConflictException } from "@nestjs/common";
import {
  LocTpFeedService,
  cleanCacheDate,
  cutAtHoldback,
  woIdentFallback,
  type TpFeedRow,
} from "./loc-tp-feed.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";

/**
 * B1 loc-most feeder — mapiranje/watermark/guard testovi (Prisma-MOCK, bez baze).
 * Živa verifikacija upserta ide kroz runbook korake (feed-run + spot-check SQL).
 */

describe("cleanCacheDate (legacy cleanDate paritet)", () => {
  it("propušta validan datum netaknut", () => {
    const d = new Date("2026-07-18T10:00:00Z");
    expect(cleanCacheDate(d)).toBe(d);
  });

  it("null/undefined → null", () => {
    expect(cleanCacheDate(null)).toBeNull();
    expect(cleanCacheDate(undefined)).toBeNull();
  });

  it("BigTehn sentinel (godina <= 1901) → null", () => {
    expect(cleanCacheDate(new Date("1899-12-30T00:00:00Z"))).toBeNull();
    expect(cleanCacheDate(new Date("1901-06-01T00:00:00Z"))).toBeNull();
    expect(cleanCacheDate(new Date("1902-01-01T00:00:00Z"))).not.toBeNull();
  });

  it("nevalidan Date → null", () => {
    expect(cleanCacheDate(new Date("nije-datum"))).toBeNull();
  });
});

describe("cutAtHoldback (id-gap trka, verify B1-DATA-4)", () => {
  const cutoff = new Date("2026-07-18T12:00:00Z");
  const row = (id: number, startedAt: string | null) => ({
    id,
    started_at: startedAt ? new Date(startedAt) : null,
  });

  it("svi stariji od cutoff-a → svi se hrane", () => {
    const rows = [
      row(1, "2026-07-18T11:00:00Z"),
      row(2, "2026-07-18T11:30:00Z"),
    ];
    expect(cutAtHoldback(rows, cutoff)).toEqual({ fed: rows, held: 0 });
  });

  it("prvi mlad red seče I SVE IZA njega (redosled id-jeva se ne buši)", () => {
    const rows = [
      row(1, "2026-07-18T11:00:00Z"),
      row(2, "2026-07-18T12:30:00Z"), // mlad
      row(3, "2026-07-18T11:45:00Z"), // stariji, ali IZA mladog → čeka
    ];
    const { fed, held } = cutAtHoldback(rows, cutoff);
    expect(fed.map((r) => r.id)).toEqual([1]);
    expect(held).toBe(2);
  });

  it("mlad red na početku → ništa se ne hrani", () => {
    const rows = [
      row(1, "2026-07-18T12:30:00Z"),
      row(2, "2026-07-18T11:00:00Z"),
    ];
    expect(cutAtHoldback(rows, cutoff)).toEqual({ fed: [], held: 2 });
  });

  it("null started_at se tretira kao star (hrani se)", () => {
    const rows = [row(1, null), row(2, "2026-07-18T11:00:00Z")];
    expect(cutAtHoldback(rows, cutoff).fed).toHaveLength(2);
  });
});

describe("woIdentFallback (syncWorkOrders paritet)", () => {
  it("prazan ident → (no-<id>) jer je kolona NOT NULL", () => {
    expect(woIdentFallback(null, 42)).toBe("(no-42)");
    expect(woIdentFallback("1839/10-1", 42)).toBe("1839/10-1");
  });
});

describe("LocTpFeedService.run", () => {
  const tpRow = (id: number, komada: number): TpFeedRow => ({
    id,
    work_order_id: 7,
    item_id: 3,
    worker_id: 5,
    quality_type_id: null,
    operacija: 10,
    machine_code: "8.2",
    komada,
    prn_timer_seconds: null,
    started_at: new Date("2026-07-18T09:00:00Z"),
    finished_at: null,
    is_completed: false,
    ident_broj: "9400/1/165",
    varijanta: 0,
    toznaka: null,
    potpis: "MP",
    napomena: null,
    dorada_operacije: 0,
  });

  const stateRow = {
    last_tp_id: 1000n,
    last_wo_modified_at: new Date("2026-07-14T00:00:00Z"),
    last_line_modified_at: new Date("2026-07-14T00:00:00Z"),
    last_run_at: new Date("2026-07-18T08:00:00Z"),
  };

  function build(opts: { state?: unknown[]; tpBatches?: TpFeedRow[][] }) {
    const prismaQueue = [...(opts.tpBatches ?? [[]])];
    const prisma = {
      // Redom: TP novi redovi (1+ batch-a), TP refresh, WO delta, lines delta.
      $queryRaw: jest.fn().mockImplementation(() => {
        return Promise.resolve(prismaQueue.shift() ?? []);
      }),
    } as unknown as PrismaService;

    const sy15QueryResults: unknown[][] = [
      opts.state ?? [stateRow], // loadState
      [{ id: 1n }], // bridge_sync_log INSERT (TP job)
      [{ id: 2n }], // bridge_sync_log INSERT (WO job)
      [{ id: 3n }], // bridge_sync_log INSERT (lines job)
    ];
    // `$executeRaw` se zove i kao tagged template (`sql`...`) i sa Prisma.sql
    // objektom — hvatamo OBA oblika u jedinstvenu listu vrednosti po pozivu.
    const executeCalls: { values: unknown[] }[] = [];
    const sy15 = {
      db: {
        $queryRaw: jest
          .fn()
          .mockImplementation(() =>
            Promise.resolve(sy15QueryResults.shift() ?? []),
          ),
        $executeRaw: jest
          .fn()
          .mockImplementation((first: unknown, ...rest: unknown[]) => {
            // Tagged template → prvi arg je TemplateStringsArray, vrednosti su `rest`.
            // Prisma.sql objekat → vrednosti su u `first.values`. (Array ima `values`
            // kroz prototip, zato Array.isArray provera ide PRVA.)
            const values =
              !Array.isArray(first) &&
              first &&
              typeof first === "object" &&
              Array.isArray((first as { values?: unknown }).values)
                ? (first as { values: unknown[] }).values
                : rest;
            executeCalls.push({ values: [...values] });
            return Promise.resolve(1);
          }),
      },
    } as unknown as Sy15Service;

    return { service: new LocTpFeedService(prisma, sy15), executeCalls, sy15 };
  }

  it("state red ne postoji → ConflictException sa pokazivačem na init skriptu", async () => {
    // Svež servis po tvrdnji — `build` puni jednokratni red odgovora.
    await expect(build({ state: [] }).service.run()).rejects.toThrow(
      ConflictException,
    );
    await expect(build({ state: [] }).service.run()).rejects.toThrow(
      /10_feed_state_init/,
    );
  });

  it("storno redovi (komada<0) se NE upisuju, ali pomeraju watermark", async () => {
    const { service, executeCalls } = build({
      tpBatches: [[tpRow(1010, 5), tpRow(1011, -3), tpRow(1012, 0)]],
    });
    const result = await service.run();

    expect(result.data.tp.fed).toBe(2);
    expect(result.data.tp.stornoSkipped).toBe(1);
    expect(result.data.tp.lastTpId).toBe(1012);

    // Cache INSERT sadrži 1010 i 1012, NE 1011 (storno).
    const cacheInsert = executeCalls.find((c) =>
      c.values.includes("9400/1/165"),
    );
    expect(cacheInsert).toBeDefined();
    expect(cacheInsert!.values).toContain(1010);
    expect(cacheInsert!.values).toContain(1012);
    expect(cacheInsert!.values).not.toContain(1011);

    // Poslednji executeRaw = state UPDATE sa novim TP watermarkom.
    const stateUpdate = executeCalls[executeCalls.length - 1];
    expect(stateUpdate.values).toContain(1012);
  });

  it("komada=0 red SE hrani (START-sken = deo je stigao na mašinu)", async () => {
    const { service, executeCalls } = build({ tpBatches: [[tpRow(2020, 0)]] });
    const result = await service.run();
    expect(result.data.tp.fed).toBe(1);
    const cacheInsert = executeCalls.find((c) => c.values.includes(2020));
    expect(cacheInsert).toBeDefined();
  });

  it("overlap guard: drugi paralelni run → 409", async () => {
    const { service } = build({ tpBatches: [[]] });
    const first = service.run();
    await expect(service.run()).rejects.toThrow(ConflictException);
    await first;
  });
});
