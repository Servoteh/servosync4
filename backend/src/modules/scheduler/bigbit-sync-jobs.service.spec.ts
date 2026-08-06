import { PrismaService } from "../../prisma/prisma.service";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import { PbSourceService } from "../../common/sy15/pb-source.service";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import {
  BigbitSyncJobs,
  BIGBIT_NIGHTLY_SYNC_JOB_KEY,
  DEFAULT_SYNC_EXCLUDED,
} from "./bigbit-sync-jobs.service";
import type { SyncService } from "../sync/sync.service";
import { GenericSyncer } from "../sync/generic.syncer";
import { MssqlClient } from "../sync/mssql.client";
import { SYNC_MAP } from "../sync/sync-map.generated";
import type { TableMapping } from "../sync/sync.types";
import {
  additiveDedupFieldFor,
  isAdditiveRefreshTable,
} from "../sync/table-ownership";
import type { ScheduledJob } from "./scheduler.types";

/*
 * Pruga P — BigBit noćni sync (presuda Nenada 26.07.2026). Pinuje: registraciju
 * iza prekidača, isključene tokove, ishod u dnevniku sa brojevima, semantiku
 * pada (retry) vs `partial` (preskočeni redovi = normalno stanje), atomski claim
 * i — najvažnije — da paritet-guard predmeta ostaje na snazi u noćnom putu.
 */

const FLAG = "BIGBIT_NIGHTLY_SYNC";

/**
 * `SyncService` mock: registar entiteta + `run` koji vraća `bb_sync_log` red.
 * Registar namerno meša isključene tokove (customers/projects/items —
 * DEFAULT_SYNC_EXCLUDED, reopen 061/26) i tokove koji ostaju u prolazu.
 */
function syncMock(
  log: Record<string, unknown> = {},
  entities = [
    "customers",
    "projects",
    "document_types",
    "items",
    "global_config",
    "salespeople",
  ],
) {
  const run = jest.fn().mockResolvedValue({
    id: 1,
    status: "success",
    rowsFetched: 0,
    rowsUpserted: 0,
    rowsSkipped: 0,
    errorMessage: null,
    metadata: {},
    ...log,
  });
  return {
    svc: { availableEntities: entities, run } as unknown as SyncService,
    run,
  };
}

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

/** Jedini posao iz registra (uz upaljen prekidač). */
function nightlyJob(jobs: BigbitSyncJobs): ScheduledJob {
  const built = withFlag("true", () => jobs.buildJobs());
  return built[0];
}

describe("BigbitSyncJobs — prekidač i registracija", () => {
  it("BIGBIT_NIGHTLY_SYNC nije 'true' → posao se NE registruje (ni run-now)", () => {
    const { svc } = syncMock();
    const jobs = new BigbitSyncJobs(svc);
    expect(withFlag(undefined, () => jobs.buildJobs())).toEqual([]);
    expect(withFlag("false", () => jobs.buildJobs())).toEqual([]);
    expect(withFlag("1", () => jobs.buildJobs())).toEqual([]);
    expect(withFlag(undefined, () => jobs.enabled)).toBe(false);
  });

  it("flag 'true' → tačno 1 posao, ključ i raspored 03:30 (posle backupa 02:30)", () => {
    const { svc } = syncMock();
    const built = withFlag("true", () => new BigbitSyncJobs(svc).buildJobs());
    expect(built).toHaveLength(1);
    expect(built[0].key).toBe(BIGBIT_NIGHTLY_SYNC_JOB_KEY);
    expect(built[0].schedule).toEqual({ kind: "daily", at: "03:30" });
  });

  // Review 26.07 [7][8][14]: default pragovi scheduler-a su krojeni za kratke
  // sy15 pozive i za dug posao su OPASNI (sam bi sebe pokrenuo drugi put).
  it("dug posao nosi svoje pragove: catch-up 120, stale 60, run-now blok 60", () => {
    const { svc } = syncMock();
    const job = nightlyJob(new BigbitSyncJobs(svc));
    expect(job.catchUpMinutes).toBe(120);
    expect(job.staleAfterMinutes).toBe(60);
    expect(job.runNowBlockMinutes).toBe(60);
    // Prag zaglavljenog RUNNING-a mora biti VEĆI od trajanja koje posao uopšte
    // dopušta sync-u (45 min), inače re-claim udari u živ prolaz.
    expect(job.staleAfterMinutes!).toBeGreaterThan(45);
  });

  it("ključ posla se ne sudara sa postojećim scheduler poslovima", () => {
    const sy15 = {
      db: { $queryRawUnsafe: jest.fn().mockResolvedValue([]) },
    } as unknown as ConstructorParameters<typeof Sy15CronJobs>[0];
    // Seoba sastanaka (05.08): registar poslova od sada zna i za prekidače
    // `SASTANCI_IZVOR` / `PB_IZVOR` (razdvojeni 06.08.) + 3.0 prepis fn-ova.
    // Ovde se testiraju SAMO ključevi, pa su ostale zavisnosti prazni stub-ovi.
    const keys = new Sy15CronJobs(
      sy15,
      new SastanciSourceService(),
      {} as unknown as ConstructorParameters<typeof Sy15CronJobs>[2],
      {} as unknown as ConstructorParameters<typeof Sy15CronJobs>[3],
      new PbSourceService(),
    )
      .buildJobs()
      .map((j) => j.key);
    expect(keys).not.toContain(BIGBIT_NIGHTLY_SYNC_JOB_KEY);
  });

  it("isključeni tokovi ne ulaze u noćni prolaz (zamrznuti MSSQL izvor)", () => {
    const { svc } = syncMock();
    const entities = new BigbitSyncJobs(svc).nightlyEntities();
    // Reopen 061/26 (04.08.2026): `items`/`customers`/`projects` od 30.07 vozi
    // noćni .mdb uvoz (03:45); MSSQL kopija je zamrznuta na 22.07, pa bi ih ovaj
    // posao (03:30) svako jutro vraćao na staro. Zato NE ulaze u prolaz.
    expect(entities).not.toContain("customers");
    expect(entities).not.toContain("projects");
    expect(entities).not.toContain("items");
    expect(entities).toContain("document_types");
    // Skup NIJE prazan — prazan bi značio „ništa nije isključeno" i tiho vratio
    // ceo kvar (zato je stari `NIGHTLY_SYNC_EXCLUDED`, koji bi ostao prazan,
    // ukinut umesto ispražnjen).
    expect(DEFAULT_SYNC_EXCLUDED.size).toBeGreaterThan(0);
  });

  // Tarife se NE rešavaju isključenjem iz noćnog posla (to bi ostavilo ručni
  // „sync all" da ih briše) — mapiranje je uklonjeno, pa ih SyncService i ne zna.
  it("tax_rates nisu ni isključenje ni tok — mapiranja više nema", () => {
    expect(DEFAULT_SYNC_EXCLUDED.has("tax_rates")).toBe(false);
    expect(SYNC_MAP.some((m) => m.targetDb === "tax_rates")).toBe(false);
  });
});

describe("BigbitSyncJobs — izvršenje i ishod u dnevniku", () => {
  it("zove POSTOJEĆI SyncService.run (trigger cron, BEZ force i BEZ strategy)", async () => {
    const { svc, run } = syncMock();
    const job = nightlyJob(new BigbitSyncJobs(svc));
    await job.run({ scheduledFor: new Date() });

    expect(run).toHaveBeenCalledTimes(1);
    const calls = run.mock.calls as unknown as [Record<string, unknown>][];
    const arg = calls[0][0];
    expect(arg.trigger).toBe("cron");
    // customers/projects/items su van prolaza (DEFAULT_SYNC_EXCLUDED, reopen 061/26).
    expect(arg.entities).toEqual([
      "document_types",
      "global_config",
      "salespeople",
    ]);
    expect(arg.force).toBeUndefined();
    expect(arg.strategy).toBeUndefined();
  });

  it("summary nosi ukupne i PO-TOKU brojeve (povučeno/upisano/preskočeno)", async () => {
    const { svc } = syncMock({
      id: 42,
      status: "partial",
      rowsFetched: 120,
      rowsUpserted: 118,
      rowsSkipped: 2,
      metadata: {
        global_config: { rowsFetched: 20, rowsUpserted: 20, rowsSkipped: 0 },
        document_types: { rowsFetched: 60, rowsUpserted: 58, rowsSkipped: 2 },
        salespeople: { rowsFetched: 40, rowsUpserted: 40, rowsSkipped: 0 },
      },
    });
    const job = nightlyJob(new BigbitSyncJobs(svc));
    const summary = (await job.run({ scheduledFor: new Date() })) as string;

    expect(summary).toContain("sync #42 partial");
    expect(summary).toContain("povučeno=120");
    expect(summary).toContain("upisano=118");
    expect(summary).toContain("preskočeno=2");
    expect(summary).toContain("global_config=20/20");
    expect(summary).toContain("document_types=60/58,presk=2");
    expect(summary.length).toBeLessThanOrEqual(2000);
  });

  it("'partial' SAMO zbog preskočenih redova (paritet-guard) NE baca — nema retry-ja", async () => {
    const { svc } = syncMock({
      status: "partial",
      rowsSkipped: 3,
      metadata: {
        global_config: { rowsFetched: 1, rowsUpserted: 1, rowsSkipped: 0 },
        document_types: { rowsFetched: 5, rowsUpserted: 2, rowsSkipped: 3 },
        salespeople: { rowsFetched: 1, rowsUpserted: 1, rowsSkipped: 0 },
      },
    });
    const job = nightlyJob(new BigbitSyncJobs(svc));
    await expect(job.run({ scheduledFor: new Date() })).resolves.toContain(
      "presk=3",
    );
  });

  it("entitet sa greškom → baca (scheduler upiše FAILED i ponavlja)", async () => {
    const { svc } = syncMock({
      status: "partial",
      metadata: {
        global_config: { rowsFetched: 1, rowsUpserted: 1, rowsSkipped: 0 },
        document_types: { error: "relation does not exist" },
        salespeople: { rowsFetched: 1, rowsUpserted: 1, rowsSkipped: 0 },
      },
    });
    const job = nightlyJob(new BigbitSyncJobs(svc));
    await expect(job.run({ scheduledFor: new Date() })).rejects.toThrow(
      /document_types: relation does not exist/,
    );
  });

  it("BigBit nedostupan (status failed) → baca sa porukom iz dnevnika", async () => {
    const { svc } = syncMock({
      status: "failed",
      errorMessage: "Cannot connect to BigBit SQL Server: ETIMEDOUT",
      metadata: {},
    });
    const job = nightlyJob(new BigbitSyncJobs(svc));
    await expect(job.run({ scheduledFor: new Date() })).rejects.toThrow(
      /ETIMEDOUT/,
    );
  });

  it("ConflictException iz SyncService (ručni sync u toku) se propagira kao pad posla", async () => {
    const { svc, run } = syncMock();
    run.mockRejectedValueOnce(new Error("A sync run is already in progress"));
    const job = nightlyJob(new BigbitSyncJobs(svc));
    await expect(job.run({ scheduledFor: new Date() })).rejects.toThrow(
      /already in progress/,
    );
  });
});

describe("BigbitSyncJobs — u pogonu scheduler-a", () => {
  function prismaMock() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      scheduledJobRun: {
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    } as unknown as PrismaService & {
      $queryRaw: jest.Mock;
      scheduledJobRun: { update: jest.Mock; findFirst: jest.Mock };
    };
  }

  it("atomski claim: drugi pokušaj ISTOG termina ne pokreće sync ponovo", async () => {
    const prisma = prismaMock();
    const scheduler = new SchedulerService(prisma);
    const { svc, run } = syncMock();
    const job = nightlyJob(new BigbitSyncJobs(svc));
    scheduler.register(job);

    const slot = new Date("2026-07-27T01:30:00Z"); // 03:30 lokalno (leto)
    const claimAndRun = (
      scheduler as unknown as {
        claimAndRun(j: ScheduledJob, s: Date): Promise<void>;
      }
    ).claimAndRun.bind(scheduler);

    prisma.$queryRaw.mockResolvedValueOnce([{ id: 5, attempts: 1 }]); // 1. claim prolazi
    await claimAndRun(job, slot);
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]); // 2. INSERT conflict + nema re-claim-a
    await claimAndRun(job, slot);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("pad sync-a NE ruši scheduler — samo FAILED red u scheduled_job_runs", async () => {
    const prisma = prismaMock();
    const scheduler = new SchedulerService(prisma);
    const { svc, run } = syncMock();
    run.mockRejectedValueOnce(new Error("Cannot connect to BigBit SQL Server"));
    const job = nightlyJob(new BigbitSyncJobs(svc));

    const res = await scheduler.execute(job, new Date(), 9, 1);
    expect(res.status).toBe("FAILED");
    expect(prisma.scheduledJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 9 },
        data: expect.objectContaining({
          status: "FAILED",
          error: expect.stringContaining("BigBit"),
        }),
      }),
    );
  });
});

/*
 * PARITET-GUARD PREDMETA u noćnom putu. Noćni posao ne pravi svoj syncer — ide
 * kroz isti `GenericSyncer`, pa se ovde pinuje da konfiguracija zaštite stoji i
 * da se stvarni prolaz nad `projects` ponaša kako je Nenad presudio 22.07.
 */
describe("BigbitSyncJobs — paritet-guard predmeta ostaje", () => {
  const mapping: TableMapping = {
    source: "Predmeti",
    model: "Project",
    targetDb: "projects",
    pk: { kind: "single", field: "id" },
    watermark: null,
    columns: [
      {
        src: "IDPredmet",
        field: "id",
        type: "Int",
        nullable: false,
        isId: true,
      },
      {
        src: "BrojPredmeta",
        field: "projectNumber",
        type: "String",
        nullable: false,
        isId: false,
      },
    ],
  };

  it("konfiguracija zaštite je na mestu (aditivni refresh + dedup po broju)", () => {
    expect(isAdditiveRefreshTable("projects")).toBe(true);
    expect(additiveDedupFieldFor("projects")).toBe("projectNumber");
    // Reopen 061/26 (04.08.2026): `projects` je namerno VAN noćnog MSSQL prolaza
    // (frozen kopija bi gazila noćni .mdb uvoz) — zaštita ostaje za
    // admin-eksplicitni prolaz (`entities: ["projects"]`), pa se i dalje pinuje.
    const { svc } = syncMock();
    expect(new BigbitSyncJobs(svc).nightlyEntities()).not.toContain("projects");
  });

  it("noćni prolaz NE briše 3.0-native predmet i preskače BigBit kopiju istog broja", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx = {
      project: { deleteMany, createMany },
      $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      project: {
        count: jest.fn().mockResolvedValue(0),
        // 3.0-native predmet: broj 10001, id 10476 (izvor ga NE vraća).
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 10476, projectNumber: "10001" }]),
      },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (t: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaService;
    const mssql = {
      query: jest.fn().mockResolvedValue([
        { IDPredmet: 7620, BrojPredmeta: "10001" }, // BigBit kopija native predmeta
        { IDPredmet: 102, BrojPredmeta: "P102" }, // običan BigBit predmet
      ]),
    } as unknown as MssqlClient;

    const result = await new GenericSyncer(mapping, mssql, prisma).sync({
      strategy: "full_refresh",
      cursor: null,
      // Noćni posao NIKAD ne šalje force — isto i ovde.
    });

    // Brisanje pokriva SAMO izvorne id-jeve (native 10476 ostaje netaknut)…
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [7620, 102] } },
    });
    expect(deleteMany).not.toHaveBeenCalledWith({});
    // …a kopija se ne reinsertuje (broj 10001 već stoji na 3.0-native redu).
    const insertCalls = createMany.mock.calls as unknown as [
      { data: { id: number }[] },
    ][];
    const inserted = insertCalls.flatMap((c) => c[0].data);
    expect(inserted.map((r) => r.id)).toEqual([102]);
    expect(result.rowsSkipped).toBe(1);
    expect(result.errors[0]).toContain("paritet brojeva");
  });
});
