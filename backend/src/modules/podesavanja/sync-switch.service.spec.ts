import { ConflictException } from "@nestjs/common";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  BIGBIT_MDB_SYNC_JOB_KEY,
  BIGBIT_MDB_SYNC_STATE_ENTITY,
  BIGBIT_MDB_SYNC_SWITCH,
  SyncSwitchService,
} from "./sync-switch.service";

/**
 * Stavka B — prekidač noćnog BigBit uvoza. Pinuje ono što je vlasnik tražio:
 *  (1) ugašen prekidač → posao se NE izvršava i vraća JASAN razlog (ne tiho ništa),
 *  (2) upaljen prekidač → posao se izvršava,
 *  (3) ručni ulaz uz ugašen prekidač → 409 sa istom porukom (ne tiha 200),
 *  (4) nedostatak reda = uključeno (OFF-prekidač; neprimenjen seed ne sme da ugasi uvoz),
 *  (5) stanje na ekranu: poslednji uvoz, broj redova, upozorenje za zastareo izvorni fajl.
 */

function makeSvc(
  overrides: {
    sw?: unknown;
    state?: unknown;
    runs?: unknown[];
  } = {},
) {
  const prisma = {
    appSwitch: {
      findUnique: jest.fn().mockResolvedValue(overrides.sw ?? null),
      upsert: jest
        .fn()
        .mockImplementation((args: { create: unknown }) =>
          Promise.resolve(args.create),
        ),
    },
    bbSyncState: {
      findUnique: jest.fn().mockResolvedValue(overrides.state ?? null),
    },
    scheduledJobRun: {
      findMany: jest.fn().mockResolvedValue(overrides.runs ?? []),
    },
  };
  const svc = new SyncSwitchService(prisma as unknown as PrismaService);
  return { svc, prisma };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

/** Oblik `prisma.appSwitch.upsert` argumenta — tipizovano da `mock.calls` ne bude `any`. */
interface UpsertArgs {
  where: { key: string };
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

describe("SyncSwitchService — prekidač (stavka B)", () => {
  // ---------- (1)/(2) zakazani posao ----------

  it("ugašen prekidač: posao se NE izvršava i vraća razlog na srpskom", async () => {
    const { svc } = makeSvc({
      sw: { key: BIGBIT_MDB_SYNC_SWITCH, enabled: false },
    });
    const run = jest.fn().mockResolvedValue("uvezeno");

    const res = await svc.runIfEnabled(BIGBIT_MDB_SYNC_SWITCH, run);

    expect(run).not.toHaveBeenCalled();
    expect(res.skipped).toBe(true);
    if (res.skipped) {
      expect(res.reason).toContain("Noćni uvoz iz BigBita");
      expect(res.reason).toContain("isključen");
      expect(res.reason).toContain("Podešavanjima");
    }
  });

  it("upaljen prekidač: posao se izvršava i vraća svoj rezultat", async () => {
    const { svc } = makeSvc({
      sw: { key: BIGBIT_MDB_SYNC_SWITCH, enabled: true },
    });
    const run = jest.fn().mockResolvedValue("uvezeno 20366 redova");

    const res = await svc.runIfEnabled(BIGBIT_MDB_SYNC_SWITCH, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(res.skipped).toBe(false);
    if (!res.skipped) expect(res.result).toBe("uvezeno 20366 redova");
  });

  // ---------- (3) ručni ulaz ----------

  it("ručni ulaz uz ugašen prekidač: 409 sa istim razlogom", async () => {
    const { svc } = makeSvc({
      sw: { key: BIGBIT_MDB_SYNC_SWITCH, enabled: false },
    });
    await expect(
      svc.assertEnabled(BIGBIT_MDB_SYNC_SWITCH),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.assertEnabled(BIGBIT_MDB_SYNC_SWITCH)).rejects.toThrow(
      /Noćni uvoz iz BigBita/,
    );
  });

  it("ručni ulaz uz upaljen prekidač: prolazi bez greške", async () => {
    const { svc } = makeSvc({
      sw: { key: BIGBIT_MDB_SYNC_SWITCH, enabled: true },
    });
    await expect(
      svc.assertEnabled(BIGBIT_MDB_SYNC_SWITCH),
    ).resolves.toBeUndefined();
  });

  // ---------- (4) nedostatak reda ----------

  it("nema reda u app_switches = UKLJUČENO (OFF-prekidač, ne gasi se tiho)", async () => {
    const { svc } = makeSvc({ sw: null });
    await expect(svc.isEnabled(BIGBIT_MDB_SYNC_SWITCH)).resolves.toBe(true);
    const run = jest.fn().mockResolvedValue(1);
    await svc.runIfEnabled(BIGBIT_MDB_SYNC_SWITCH, run);
    expect(run).toHaveBeenCalled();
  });

  // ---------- upis ----------

  it("setEnabled: upisuje stanje, ko je menjao i napomenu (trim; prazno → null)", async () => {
    const { svc, prisma } = makeSvc();
    await svc.setEnabled(
      BIGBIT_MDB_SYNC_SWITCH,
      false,
      { userId: 7, email: "nenad@servoteh.com" },
      "  BigBit u održavanju  ",
    );
    const upsertCalls = prisma.appSwitch.upsert.mock
      .calls as unknown as UpsertArgs[][];
    const args = upsertCalls[0][0];
    expect(args.where.key).toBe(BIGBIT_MDB_SYNC_SWITCH);
    expect(args.update).toMatchObject({
      enabled: false,
      note: "BigBit u održavanju",
      updatedByUserId: 7,
      updatedByEmail: "nenad@servoteh.com",
    });

    await svc.setEnabled(
      BIGBIT_MDB_SYNC_SWITCH,
      true,
      { userId: 7, email: "x@y.rs" },
      "   ",
    );
    expect(upsertCalls[1][0].update.note).toBeNull();
  });

  // ---------- (5) stanje za ekran ----------

  it("bigbitStatus: bez ijednog uvoza — upozorenje da uvoz nijednom nije uspeo", async () => {
    const { svc, prisma } = makeSvc();
    const res = await svc.bigbitStatus();

    expect(prisma.bbSyncState.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
      }),
    );
    expect(prisma.scheduledJobRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { jobKey: BIGBIT_MDB_SYNC_JOB_KEY } }),
    );
    expect(res.data.enabled).toBe(true);
    expect(res.data.lastSuccessAt).toBeNull();
    expect(res.data.rowsImported).toBeNull();
    // „nikad nije proradilo" MORA da bude `danger`, ne blago `warn`: inače
    // sistem koji uopšte nije prohodao izgleda mirnije od onog koji je jednom
    // zakasnio, a jutarnji nadzornik (okida na `danger`) nikad ne bi javio.
    const never = res.data.warnings.find((w) =>
      /NIJE PRORADIO NIJEDNOM/i.test(w.message),
    );
    expect(never).toBeDefined();
    expect(never?.level).toBe("danger");
  });

  it("bigbitStatus: svež uvoz — broj redova iz sync loga, bez upozorenja", async () => {
    const { svc } = makeSvc({
      sw: {
        key: BIGBIT_MDB_SYNC_SWITCH,
        enabled: true,
        note: null,
        updatedAt: hoursAgo(100),
      },
      state: {
        entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
        lastSuccessAt: hoursAgo(6),
        lastAttemptAt: hoursAgo(6),
        lastErrorMessage: null,
        cursor: {
          sourceFile: "BB_T_26.mdb",
          sourceFileModifiedAt: hoursAgo(8).toISOString(),
        },
        lastSuccessSyncLog: { rowsUpserted: 20366 },
      },
      runs: [
        {
          status: "DONE",
          startedAt: hoursAgo(6),
          finishedAt: hoursAgo(6),
          summary: "uvezeno 20366",
          error: null,
        },
      ],
    });

    const res = await svc.bigbitStatus();
    expect(res.data.rowsImported).toBe(20366);
    expect(res.data.source?.fileName).toBe("BB_T_26.mdb");
    expect(res.data.lastRun?.status).toBe("DONE");
    expect(res.data.warnings).toHaveLength(0);
  });

  it("bigbitStatus: ugašen prekidač + zastareo izvorni fajl → dva upozorenja", async () => {
    const { svc } = makeSvc({
      sw: {
        key: BIGBIT_MDB_SYNC_SWITCH,
        enabled: false,
        note: "ručno",
        updatedAt: hoursAgo(1),
      },
      state: {
        entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
        lastSuccessAt: hoursAgo(2),
        lastAttemptAt: hoursAgo(2),
        lastErrorMessage: null,
        cursor: {
          sourceFile: "BB_T_26_11-07-26.mdb",
          sourceFileModifiedAt: hoursAgo(15 * 24).toISOString(),
          rowsImported: 20366,
        },
        lastSuccessSyncLog: null,
      },
    });

    const res = await svc.bigbitStatus();
    expect(res.data.enabled).toBe(false);
    expect(res.data.warnings.some((w) => w.message.includes("ISKLJUČEN"))).toBe(
      true,
    );
    // Fajl star 15 dana je PREKO tvrdog praga (24 h) — poruka mora reći da se
    // uvoz ZAUSTAVLJA, ne blago „može da radi, ali…". Ranije je postojao prozor
    // u kome posao svake noći puca a ekran pokazuje umireno upozorenje.
    const stale = res.data.warnings.find((w) =>
      w.message.includes("Podaci iz BigBita nisu stigli"),
    );
    expect(stale).toBeDefined();
    expect(stale?.level).toBe("danger");
    expect(stale?.message).toContain("pre 15 dana");
    expect(stale?.message).toMatch(/ZAUSTAVLJA/);
    // rowsImported iz kursora ima prednost nad log fallback-om
    expect(res.data.rowsImported).toBe(20366);
  });

  it("bigbitStatus: uvoz stariji od praga → upozorenje o zastarelosti", async () => {
    const { svc } = makeSvc({
      sw: {
        key: BIGBIT_MDB_SYNC_SWITCH,
        enabled: true,
        updatedAt: hoursAgo(500),
      },
      state: {
        entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
        lastSuccessAt: hoursAgo(40),
        lastAttemptAt: hoursAgo(40),
        lastErrorMessage: null,
        cursor: null,
        lastSuccessSyncLog: null,
      },
    });
    const res = await svc.bigbitStatus();
    const w = res.data.warnings.find((x) =>
      x.message.includes("Poslednji uspešan uvoz"),
    );
    expect(w).toBeDefined();
    expect(w?.level).toBe("warn");
  });

  it("bigbitStatus: pao poslednji pokušaj → danger upozorenje sa greškom", async () => {
    const { svc } = makeSvc({
      sw: {
        key: BIGBIT_MDB_SYNC_SWITCH,
        enabled: true,
        updatedAt: hoursAgo(500),
      },
      state: {
        entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
        lastSuccessAt: hoursAgo(3),
        lastAttemptAt: hoursAgo(1),
        lastErrorMessage: "mdb-export pao",
        cursor: null,
        lastSuccessSyncLog: null,
      },
      runs: [
        {
          status: "FAILED",
          startedAt: hoursAgo(1),
          finishedAt: hoursAgo(1),
          summary: null,
          error: "mdb-export pao",
        },
      ],
    });
    const res = await svc.bigbitStatus();
    const w = res.data.warnings.find((x) => x.message.includes("pao"));
    expect(w?.level).toBe("danger");
  });

  it("bigbitStatus: pokvaren kursor ne ruši ekran", async () => {
    const { svc } = makeSvc({
      state: {
        entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
        lastSuccessAt: hoursAgo(1),
        lastAttemptAt: hoursAgo(1),
        lastErrorMessage: null,
        cursor: { sourceFileModifiedAt: "nije-datum", rowsImported: "puno" },
        lastSuccessSyncLog: null,
      },
    });
    const res = await svc.bigbitStatus();
    expect(res.data.source).toBeNull();
    expect(res.data.rowsImported).toBeNull();
  });
});
