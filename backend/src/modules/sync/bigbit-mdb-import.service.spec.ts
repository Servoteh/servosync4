import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BigbitMdbConflictError,
  BigbitMdbDropStaleError,
  BigbitMdbImportService,
} from "./bigbit-mdb-import.service";
import { BigbitMdbJobs } from "./bigbit-mdb-jobs";
import {
  SyncSwitchService,
  // Ključ koji EKRAN čita — uvozi se baš iz modula podešavanja da bi test pao
  // ako se dve strane ikad ponovo raziđu.
  BIGBIT_MDB_SYNC_JOB_KEY as SCREEN_JOB_KEY,
} from "../podesavanja/sync-switch.service";
import { SchedulerService } from "../scheduler/scheduler.service";
import type { ScheduledJob } from "../scheduler/scheduler.types";
import {
  BIGBIT_MDB_SYNC_JOB_KEY,
  BIGBIT_MDB_SYNC_SWITCH,
  BIGBIT_MDB_WATCHDOG_JOB_KEY,
} from "../../common/switches/bigbit-sync";

/**
 * Fokus testova: ODLUKE oko uvoza i putevi kojima bi kvar prošao NEPRIMEĆENO.
 *
 * Sadržaj preslikavanja (GK stavke, normalizacija valute, negativni iznosi,
 * nebalansiranost) dokazan je NA STVARNOM .mdb-u i DEV BAZI — brojevi su u
 * docs/migration/BIGBIT_NOCNI_SYNC.md. Ovde se pinuje ono što bi tiho otkazalo:
 * brane svežine, prekidač, mutex, glasnoća sudara i brojači koji moraju da se
 * zbrajaju (red koji izvor ima, a 4.0 nema, ne sme da izgleda kao „nepromenjen").
 */

/**
 * `expect.objectContaining` vraća `any`; ugnežden u literal to je
 * `no-unsafe-assignment`. Ova omotnica ga vraća kao vrednost sa tipom, pa
 * ugnežđeno poređenje ostaje čitko bez gašenja pravila.
 */
const like = (o: Record<string, unknown>): Record<string, unknown> =>
  expect.objectContaining(o) as Record<string, unknown>;

describe("BigbitMdbImportService", () => {
  const HOUR = 60 * 60 * 1000;

  function makeDrop(overrides: Record<string, unknown> = {}) {
    return {
      id: 7,
      fileName: "BB_T_26.mdb",
      fileMtime: new Date(Date.now() - 2 * HOUR),
      fileSize: BigInt(375754752),
      fileSha256: "abc123",
      stageStatus: "LOADED",
      stageError: null,
      importStatus: "PENDING",
      importStartedAt: null,
      importedAt: null,
      ...overrides,
    };
  }

  interface Opts {
    drop?: ReturnType<typeof makeDrop> | null;
    /** Drop sa istim sha koji je već uvezen (lažna svežina). */
    twin?: ReturnType<typeof makeDrop> | null;
    switchRow?: { enabled: boolean } | null;
    switchThrows?: boolean;
    /** false = claim ne prolazi (drugi uvoz je u toku). */
    claim?: boolean;
    stageCounts?: { gk: number; nalozi: number; konta: number };
    /** Brojači koje vraća svaki „veliki" korak. */
    step?: Partial<{
      staged: number;
      inserted: number;
      updated: number;
      skipped: number;
      fetched: number;
    }>;
    vanished?: { je: number; le: number };
  }

  /** `$queryRaw` je tagged template — mock razlikuje upite po tekstu. */
  function makePrisma(opts: Opts) {
    const counts = opts.stageCounts ?? { gk: 10, nalozi: 5, konta: 8 };
    const step = {
      staged: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      fetched: 0,
      ...(opts.step ?? {}),
    };
    const update = jest.fn().mockResolvedValue({});
    const syncStateUpsert = jest.fn().mockResolvedValue({});

    const queryRaw = jest.fn(
      (strings: TemplateStringsArray): Promise<unknown[]> => {
        const sql = Array.isArray(strings)
          ? strings.join(" ")
          : String(strings);
        // MUTEX claim
        if (sql.includes("UPDATE bb_mdb_drops"))
          return Promise.resolve(opts.claim === false ? [] : [{ id: 7 }]);
        // „nestalo iz BigBita"
        if (sql.includes("FROM journal_entries j"))
          return Promise.resolve([{ c: BigInt(opts.vanished?.je ?? 0) }]);
        if (sql.includes("FROM ledger_entries l"))
          return Promise.resolve([{ c: BigInt(opts.vanished?.le ?? 0) }]);
        // razlozi odbacivanja naloga
        if (sql.includes("AS no_id"))
          return Promise.resolve([
            { no_id: 0n, no_date: 0n, too_long: 0n, dupe_id: 0n },
          ]);
        // primeri sudara
        if (sql.includes("LIMIT 10"))
          return Promise.resolve([
            { number: "0452", order_type_code: "IZV", year: 2026 },
          ]);
        // GK stranica — page_rows=0 prekida keyset petlju odmah
        if (sql.includes("WITH page AS"))
          return Promise.resolve([
            {
              page_rows: 0,
              eligible: 0,
              inserted: 0,
              updated: 0,
              max_key: 0,
            },
          ]);
        return Promise.resolve([step]);
      },
    );

    return {
      prisma: {
        appSwitch: {
          findUnique: jest.fn(() =>
            opts.switchThrows
              ? Promise.reject(
                  new Error('relation "app_switches" does not exist'),
                )
              : Promise.resolve(opts.switchRow ?? null),
          ),
        },
        bbMdbDrop: {
          findFirst: jest.fn((args: { where?: { fileSha256?: string } }) =>
            Promise.resolve(
              args?.where?.fileSha256 !== undefined
                ? (opts.twin ?? null)
                : opts.drop === undefined
                  ? makeDrop()
                  : opts.drop,
            ),
          ),
          update,
        },
        bbMdbStageGk: { count: jest.fn().mockResolvedValue(counts.gk) },
        bbMdbStageNalog: { count: jest.fn().mockResolvedValue(counts.nalozi) },
        bbMdbStageAccount: { count: jest.fn().mockResolvedValue(counts.konta) },
        bbSyncState: { upsert: syncStateUpsert },
        $queryRaw: queryRaw,
      } as unknown as PrismaService,
      update,
      queryRaw,
      syncStateUpsert,
    };
  }

  const svc = (p: PrismaService) => new BigbitMdbImportService(p);

  describe("brana svežine — bajat drop NE SME tiho da prođe", () => {
    it("baca kad drop-a uopšte nema (dostava nikad nije proradila)", async () => {
      const { prisma } = makePrisma({ drop: null });
      await expect(svc(prisma).runImport()).rejects.toBeInstanceOf(
        BigbitMdbDropStaleError,
      );
    });

    it("baca kad je fajl stariji od praga, sa starošću i pragom u poruci", async () => {
      const { prisma } = makePrisma({
        drop: makeDrop({ fileMtime: new Date(Date.now() - 365 * HOUR) }),
      });
      await expect(svc(prisma).runImport()).rejects.toThrow(
        /nisu stigli[\s\S]*365\.\d h[\s\S]*24 h/,
      );
    });

    it("poruka o bajatom drop-u kaže ŠTA DA SE URADI i da kvar nije u 4.0", async () => {
      const { prisma } = makePrisma({
        drop: makeDrop({ fileMtime: new Date(Date.now() - 365 * HOUR) }),
      });
      await expect(svc(prisma).runImport()).rejects.toThrow(
        /javite osobi zaduženoj za BigBit[\s\S]*NIJE u 4\.0/,
      );
    });

    it("prolazi kad je fajl svež (2 h) i radi korake tačnim redosledom", async () => {
      const { prisma } = makePrisma({});
      const res = await svc(prisma).runImport();
      expect(res.status).toBe("DONE");
      expect(res.steps.map((s) => s.entity)).toEqual([
        // redosled je obavezan zbog FK lanca accounts -> ... -> ledger_entries
        "accounts",
        "order_types",
        "saldakonto_accounts",
        "journal_entries",
        "ledger_entries",
      ]);
    });

    it("baca kad je korak 1 pao (stage_status != LOADED) i nosi grešku koraka 1", async () => {
      const { prisma } = makePrisma({
        drop: makeDrop({ stageStatus: "FAILED", stageError: "copy pao" }),
      });
      await expect(svc(prisma).runImport({ dropId: 7 })).rejects.toThrow(
        /stage_status=FAILED[\s\S]*copy pao/,
      );
    });

    it("maxAgeHours override dozvoljava ručno vraćanje starijeg drop-a", async () => {
      const { prisma } = makePrisma({
        drop: makeDrop({ fileMtime: new Date(Date.now() - 100 * HOUR) }),
      });
      expect((await svc(prisma).runImport({ maxAgeHours: 500 })).status).toBe(
        "DONE",
      );
    });

    it("LAŽNA SVEŽINA: isti sha256 kao već uvezen drop = pad, iako je mtime nov", async () => {
      const { prisma } = makePrisma({
        twin: makeDrop({
          id: 6,
          fileName: "BB_T_26_staro.mdb",
          importStatus: "DONE",
          importedAt: new Date(Date.now() - 24 * HOUR),
        }),
      });
      await expect(svc(prisma).runImport()).rejects.toThrow(
        /ponovo isporučio ISTI fajl[\s\S]*BB_T_26_staro\.mdb/,
      );
    });

    it("PRAZAN/NEPOTPUN IZVOZ nije uspeh — nula redova obara posao", async () => {
      const { prisma, update } = makePrisma({
        stageCounts: { gk: 0, nalozi: 0, konta: 0 },
      });
      await expect(svc(prisma).runImport()).rejects.toBeInstanceOf(
        BigbitMdbDropStaleError,
      );
      // i to se upisuje kao FAILED, ne kao DONE sa „+0/~0/=0"
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: like({ importStatus: "FAILED" }),
        }),
      );
    });
  });

  describe("prekidač iz Podešavanja", () => {
    it("ugašen prekidač = DISABLED bez ijednog upisa (nije kvar)", async () => {
      const { prisma, update } = makePrisma({ switchRow: { enabled: false } });
      const res = await svc(prisma).runImport();
      expect(res.status).toBe("DISABLED");
      expect(res.steps).toHaveLength(0);
      expect(update).not.toHaveBeenCalled();
    });

    it("upaljen prekidač = uvoz radi", async () => {
      const { prisma } = makePrisma({ switchRow: { enabled: true } });
      expect((await svc(prisma).runImport()).status).toBe("DONE");
    });

    it("NEMA reda u app_switches = UKLJUČENO (odsustvo reda ne sme tiho da ugasi uvoz)", async () => {
      const { prisma } = makePrisma({ switchRow: null });
      expect((await svc(prisma).runImport()).status).toBe("DONE");
    });

    it("greška pri čitanju prekidača = UKLJUČENO, ali se LOGUJE (ne nemi catch)", async () => {
      const { prisma } = makePrisma({ switchThrows: true });
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      expect((await svc(prisma).runImport()).status).toBe("DONE");
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("ne može pročitati"),
      );
      spy.mockRestore();
    });
  });

  describe("idempotencija i jednokratnost", () => {
    it("već uvezen drop se preskače — bez force nema drugog prolaza", async () => {
      const { prisma, update } = makePrisma({
        drop: makeDrop({
          importStatus: "DONE",
          importedAt: new Date("2026-07-26T01:30:00Z"),
        }),
      });
      const res = await svc(prisma).runImport();
      expect(res.status).toBe("SKIPPED");
      expect(res.steps).toHaveLength(0);
      expect(update).not.toHaveBeenCalled();
    });

    it("force ponovo prolazi kroz sve korake (upsert je bezbedan)", async () => {
      const { prisma } = makePrisma({
        drop: makeDrop({ importStatus: "DONE", importedAt: new Date() }),
      });
      const res = await svc(prisma).runImport({ force: true });
      expect(res.status).toBe("DONE");
      expect(res.steps).toHaveLength(5);
    });

    it("MUTEX: kad drugi uvoz već drži drop, drugi poziv ne piše NIŠTA", async () => {
      const { prisma, update } = makePrisma({
        claim: false,
        drop: makeDrop({ importStartedAt: new Date(Date.now() - 60_000) }),
      });
      const res = await svc(prisma).runImport();
      expect(res.status).toBe("BUSY");
      expect(res.steps).toHaveLength(0);
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe("ništa tiho — brojači i glasni kvarovi", () => {
    it("SUDAR BROJA NALOGA obara uvoz (ne DONE sa fusnotom) i imenuje sudar", async () => {
      const { prisma, update } = makePrisma({
        step: { staged: 100, fetched: 100, inserted: 99, skipped: 1 },
      });
      await expect(svc(prisma).runImport()).rejects.toBeInstanceOf(
        BigbitMdbConflictError,
      );
      await expect(svc(prisma).runImport()).rejects.toThrow(
        /IZV\/2026\/0452|1 BigBit nalog/,
      );
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: like({ importStatus: "FAILED" }),
        }),
      );
    });

    it("ODBAČENI redovi se broje u `filtered`, ne u „nepromenjeno“", async () => {
      // 100 stagovano, 90 prošlo filter, 88 novo → 2 nepromenjena, 10 odbačenih
      const { prisma } = makePrisma({
        step: {
          staged: 100,
          fetched: 90,
          inserted: 88,
          updated: 0,
          skipped: 0,
        },
      });
      const res = await svc(prisma).runImport();
      const acc = res.steps.find((s) => s.entity === "accounts")!;
      expect(acc.filtered).toBe(10);
      expect(acc.unchanged).toBe(2);
      // invarijanta: ništa ne sme da nestane iz zbira
      expect(
        acc.inserted + acc.updated + acc.unchanged + acc.skipped + acc.filtered,
      ).toBe(acc.staged);
    });

    it("NESTALO IZ BIGBITA se broji i ulazi u summary (uvoz nikad ne briše)", async () => {
      const { prisma } = makePrisma({ vanished: { je: 2, le: 37 } });
      const res = await svc(prisma).runImport();
      expect(res.vanished).toEqual({ journalEntries: 2, ledgerEntries: 37 });
      expect(res.summary).toMatch(
        /nestalo iz BigBita: 2 nalog\(a\) \/ 37 stavki/,
      );
    });
  });

  describe("heartbeat za ekran (ugovor sa Podešavanjima)", () => {
    it("uspešan uvoz upisuje bb_sync_state sa imenom i datumom IZVORNOG fajla", async () => {
      const { prisma, syncStateUpsert } = makePrisma({});
      await svc(prisma).runImport();
      expect(syncStateUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { entity: "bigbit-mdb" },
          update: like({
            lastSuccessAt: expect.any(Date),
            cursor: like({
              sourceFile: "BB_T_26.mdb",
              sourceFileModifiedAt: expect.any(String) as unknown,
            }),
          }),
        }),
      );
    });

    it("pad upisuje lastAttemptAt + lastErrorMessage (ekran ume da kaže ZAŠTO)", async () => {
      const { prisma, syncStateUpsert, queryRaw } = makePrisma({});
      queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings)
          ? strings.join(" ")
          : String(strings);
        if (sql.includes("UPDATE bb_mdb_drops"))
          return Promise.resolve([{ id: 7 }]);
        return Promise.reject(new Error("deadlock detected"));
      });
      await expect(svc(prisma).runImport()).rejects.toThrow(
        "deadlock detected",
      );
      expect(syncStateUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: like({
            lastErrorMessage: expect.stringContaining("deadlock"),
          }),
        }),
      );
    });

    it("rezultat nosi ime, datum i veličinu izvornog fajla + trajanje", async () => {
      const { prisma, update } = makePrisma({});
      const res = await svc(prisma).runImport();
      expect(res.fileName).toBe("BB_T_26.mdb");
      expect(res.fileSizeBytes).toBe("375754752");
      expect(res.dropAgeHours).toBeGreaterThan(0);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 7 },
          data: like({
            importStatus: "DONE",
            // mutex se OSLOBAĐA po završetku, inače sledeća noć zatekne zauzet drop
            importStartedAt: null,
          }),
        }),
      );
    });
  });
});

describe("BigbitMdbJobs — definicija poslova", () => {
  const build = () =>
    new BigbitMdbJobs(
      {} as BigbitMdbImportService,
      {} as SyncSwitchService,
      {} as never,
    ).buildJobs();

  it("KLJUČ POSLA je isti string koji ekran Podešavanja čita iz scheduled_job_runs", () => {
    // Ovo je regresioni test za stvarni kvar: uvoz se registrovao kao
    // „bigbit-mdb-import", a ekran je tražio „bigbit-mdb-sync" — pa upozorenje
    // o padu nije moglo da se pojavi NIKAD.
    const [imp] = build();
    expect(imp.key).toBe(BIGBIT_MDB_SYNC_JOB_KEY);
    expect(BIGBIT_MDB_SYNC_JOB_KEY).toBe(SCREEN_JOB_KEY);
  });

  it("uvoz je vezan za korisnički prekidač, a NADZORNIK namerno nije", () => {
    const [imp, watchdog] = build();
    expect(imp.switchKey).toBe(BIGBIT_MDB_SYNC_SWITCH);
    expect(watchdog.key).toBe(BIGBIT_MDB_WATCHDOG_JOB_KEY);
    // nadzornik mora da radi i kad je uvoz ugašen — „ugašen mesec dana, a niko
    // ne zna" je upravo kvar zbog kog postoji
    expect(watchdog.switchKey).toBeUndefined();
  });

  it("termini ne gaze backup (02:30) ni retention (03:30)", () => {
    const [imp, watchdog] = build();
    expect(imp.schedule).toEqual({ kind: "daily", at: "03:45" });
    expect(imp.catchUpMinutes).toBe(240);
    expect(watchdog.schedule).toEqual({ kind: "daily", at: "07:15" });
  });

  it("summary uvoza ide u dnevnik scheduler-a", async () => {
    const importer = {
      runImport: jest.fn().mockResolvedValue({ summary: "sve ok" }),
    } as unknown as BigbitMdbImportService;
    const [job] = new BigbitMdbJobs(
      importer,
      {} as SyncSwitchService,
      {} as never,
    ).buildJobs();
    await expect(job.run({ scheduledFor: new Date() })).resolves.toBe("sve ok");
  });
});

/**
 * Kapija prekidača je u SCHEDULER-u, na jednom mestu za sve poslove — da nijedan
 * budući ulaz ne može da je zaobiđe zaboravivši poziv. Ovo pinuje da ugašen
 * prekidač STVARNO ne pokreće posao (ranije prekidač nije gasio ništa: nijedan
 * poziv `runIfEnabled`/`assertEnabled` nije postojao van modula podesavanja).
 */
describe("SchedulerService — prekidač stvarno gasi posao", () => {
  function makeJob(run: jest.Mock): ScheduledJob {
    return {
      key: BIGBIT_MDB_SYNC_JOB_KEY,
      description: "test",
      schedule: { kind: "daily", at: "03:45" },
      switchKey: BIGBIT_MDB_SYNC_SWITCH,
      run,
    };
  }

  function makePrisma(enabled: boolean | null) {
    const update = jest.fn().mockResolvedValue({});
    return {
      prisma: {
        $queryRaw: jest.fn(() =>
          Promise.resolve(enabled === null ? [] : [{ enabled }]),
        ),
        scheduledJobRun: {
          update,
          findFirst: jest.fn().mockResolvedValue(null),
        },
      } as unknown as PrismaService,
      update,
    };
  }

  it("ugašen prekidač: job.run se NE poziva, run je DONE sa razlogom (ne FAILED)", async () => {
    const run = jest.fn();
    const { prisma, update } = makePrisma(false);
    const res = await new SchedulerService(prisma).execute(
      makeJob(run),
      new Date(),
      1,
      1,
    );
    expect(run).not.toHaveBeenCalled();
    expect(res.status).toBe("DONE");
    expect(res.summary).toMatch(/isključen u Podešavanjima/);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: like({ status: "DONE" }),
      }),
    );
  });

  it("upaljen prekidač: job.run se poziva", async () => {
    const run = jest.fn().mockResolvedValue("ok");
    const { prisma } = makePrisma(true);
    await new SchedulerService(prisma).execute(makeJob(run), new Date(), 1, 1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("nema reda u app_switches = posao RADI (fail-open)", async () => {
    const run = jest.fn().mockResolvedValue("ok");
    const { prisma } = makePrisma(null);
    await new SchedulerService(prisma).execute(makeJob(run), new Date(), 1, 1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("RUČNI run-now uz ugašen prekidač baca grešku (ne tiha 200)", async () => {
    const { prisma } = makePrisma(false);
    const scheduler = new SchedulerService(prisma);
    scheduler.register(makeJob(jest.fn()));
    await expect(scheduler.runNow(BIGBIT_MDB_SYNC_JOB_KEY)).rejects.toThrow(
      /isključen u Podešavanjima/,
    );
  });
});
