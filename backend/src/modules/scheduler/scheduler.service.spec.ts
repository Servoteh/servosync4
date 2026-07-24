import { PrismaService } from "../../prisma/prisma.service";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import type { ScheduledJob } from "./scheduler.types";
import { Sy15Service } from "../../common/sy15/sy15.service";

function prismaMock() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    scheduledJobRun: {
      update: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService & {
    $queryRaw: jest.Mock;
    scheduledJobRun: { update: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
  };
}

function makeService() {
  const prisma = prismaMock();
  const svc = new SchedulerService(prisma);
  return { svc, prisma };
}

describe("SchedulerService — computeDueSlot (Europe/Belgrade)", () => {
  const { svc } = makeService();

  it("daily 09:00: dospeo u 09:05 lokalno (leto) → slot 07:00Z; posle prozora → null", () => {
    const now = new Date("2026-07-24T07:05:00Z"); // 09:05 lokalno
    const slot = svc.computeDueSlot({ kind: "daily", at: "09:00" }, 180, now);
    expect(slot?.toISOString()).toBe("2026-07-24T07:00:00.000Z");
    const late = new Date("2026-07-24T13:01:00Z"); // 15:01 lokalno — 6h posle
    expect(svc.computeDueSlot({ kind: "daily", at: "09:00" }, 180, late)).toBeNull();
  });

  it("daily: pre termina danas vraća JUČERAŠNJI samo unutar prozora (inače null)", () => {
    const now = new Date("2026-07-24T06:30:00Z"); // 08:30 lokalno, pre 09:00
    expect(svc.computeDueSlot({ kind: "daily", at: "09:00" }, 180, now)).toBeNull();
  });

  it("weekly pet 08:00: petak 08:10 lokalno → slot 06:00Z; subota → null (van prozora)", () => {
    const fri = new Date("2026-07-24T06:10:00Z"); // petak 08:10 lokalno
    const slot = svc.computeDueSlot({ kind: "weekly", isoDow: 5, at: "08:00" }, 180, fri);
    expect(slot?.toISOString()).toBe("2026-07-24T06:00:00.000Z");
    const sat = new Date("2026-07-25T09:00:00Z");
    expect(svc.computeDueSlot({ kind: "weekly", isoDow: 5, at: "08:00" }, 180, sat)).toBeNull();
  });

  it("everyMinutes 30: vraća poslednji slot (floor), bez backfill-a", () => {
    const now = new Date("2026-07-24T07:17:00Z");
    const slot = svc.computeDueSlot({ kind: "everyMinutes", minutes: 30 }, 30, now);
    expect(slot?.toISOString()).toBe("2026-07-24T07:00:00.000Z");
  });

  it("DST: daily 06:00 postoji i na dan prolećnog preskoka (29.03)", () => {
    const now = new Date("2026-03-29T04:20:00Z"); // 06:20 lokalno (CEST od 03:00)
    const slot = svc.computeDueSlot({ kind: "daily", at: "06:00" }, 180, now);
    expect(slot?.toISOString()).toBe("2026-03-29T04:00:00.000Z");
  });
});

describe("SchedulerService — claim/retry/izvršenje", () => {
  function job(over: Partial<ScheduledJob> = {}): ScheduledJob {
    return {
      key: "test-job",
      description: "t",
      schedule: { kind: "daily", at: "09:00" },
      run: jest.fn().mockResolvedValue("enqueued=1"),
      ...over,
    };
  }

  it("claim uspešan → izvršenje → DONE sa summary", async () => {
    const { svc, prisma } = makeService();
    const jb = job();
    svc.register(jb);
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 7, attempts: 1 }]);
    // pristup privatnoj metodi radi testa claim toka
    await (svc as unknown as { claimAndRun(j: ScheduledJob, s: Date): Promise<void> }).claimAndRun(
      jb,
      new Date("2026-07-24T07:00:00Z"),
    );
    expect(jb.run).toHaveBeenCalledTimes(1);
    expect(prisma.scheduledJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({ status: "DONE", summary: "enqueued=1" }),
      }),
    );
  });

  it("conflict (termin već izvršen/u toku) → posao se NE pokreće", async () => {
    const { svc, prisma } = makeService();
    const jb = job();
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await (svc as unknown as { claimAndRun(j: ScheduledJob, s: Date): Promise<void> }).claimAndRun(
      jb,
      new Date("2026-07-24T07:00:00Z"),
    );
    expect(jb.run).not.toHaveBeenCalled();
  });

  it("FAILED red sa preostalim pokušajima → re-claim (UPDATE) pa izvršenje", async () => {
    const { svc, prisma } = makeService();
    const jb = job();
    prisma.$queryRaw
      .mockResolvedValueOnce([]) // INSERT conflict
      .mockResolvedValueOnce([{ id: 9, attempts: 2 }]); // UPDATE re-claim
    await (svc as unknown as { claimAndRun(j: ScheduledJob, s: Date): Promise<void> }).claimAndRun(
      jb,
      new Date("2026-07-24T07:00:00Z"),
    );
    expect(jb.run).toHaveBeenCalledTimes(1);
  });

  it("pad posla → FAILED sa porukom greške", async () => {
    const { svc, prisma } = makeService();
    const jb = job({ run: jest.fn().mockRejectedValue(new Error("sy15 down")) });
    const res = await svc.execute(jb, new Date(), 3, 1);
    expect(res.status).toBe("FAILED");
    expect(prisma.scheduledJobRun.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED", error: "sy15 down" }),
      }),
    );
  });

  it("runNow: nepoznat ključ baca; poznat se izvršava odmah", async () => {
    const { svc, prisma } = makeService();
    const jb = job();
    svc.register(jb);
    await expect(svc.runNow("nema-me")).rejects.toThrow("Nepoznat posao");
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 11 }]);
    const res = await svc.runNow("test-job");
    expect(res.status).toBe("DONE");
  });

  it("runNow: svež RUNNING red istog posla BLOKIRA paralelno pokretanje", async () => {
    const { svc, prisma } = makeService();
    const jb = job();
    svc.register(jb);
    prisma.scheduledJobRun.findFirst.mockResolvedValueOnce({ id: 4 });
    await expect(svc.runNow("test-job")).rejects.toThrow("upravo radi");
    expect(jb.run).not.toHaveBeenCalled();
  });

  it("dupli job key pri registraciji baca (zaštita registra)", () => {
    const { svc } = makeService();
    svc.register(job());
    expect(() => svc.register(job())).toThrow("dupli job key");
  });
});

describe("Sy15CronJobs — registar poslova (Talas A/A2)", () => {
  function sy15Mock(rows: unknown[] = [{ enqueued: 2, skipped: 5 }]) {
    return {
      db: { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) },
    } as unknown as Sy15Service;
  }

  it("12 poslova, jedinstveni ključevi, validni rasporedi", () => {
    const jobs = new Sy15CronJobs(sy15Mock()).buildJobs();
    expect(jobs).toHaveLength(12);
    expect(new Set(jobs.map((x) => x.key)).size).toBe(12);
    for (const jb of jobs) {
      if (jb.schedule.kind === "everyMinutes") {
        expect(jb.schedule.minutes).toBeGreaterThan(0);
      } else {
        expect(jb.schedule.at).toMatch(/^\d{2}:\d{2}$/);
      }
    }
  });

  it("guard-poslovi zakazani TAČNO u sat unutrašnjeg fn guarda (06h/pon 06h/pet 08h)", () => {
    const byKey = new Map(new Sy15CronJobs(sy15Mock()).buildJobs().map((x) => [x.key, x]));
    expect(byKey.get("kadr-attendance-alerts")?.schedule).toEqual({ kind: "daily", at: "06:00" });
    expect(byKey.get("kadr-attendance-digest")?.schedule).toEqual({
      kind: "weekly",
      isoDow: 1,
      at: "06:30",
    });
    expect(byKey.get("sast-weekly-auto")?.schedule).toEqual({
      kind: "weekly",
      isoDow: 5,
      at: "08:00",
    });
  });

  it("summary sažima rezultat fn-a (enqueued/skipped); BigInt bez 'n'; jsonb kao JSON", async () => {
    const jobs = new Sy15CronJobs(sy15Mock([{ enqueued: 2n, skipped: 5 }])).buildJobs();
    const maint = jobs.find((x) => x.key === "maint-deadlines")!;
    await expect(maint.run({ scheduledFor: new Date() })).resolves.toBe("enqueued=2 skipped=5");

    const jsonJobs = new Sy15CronJobs(
      sy15Mock([{ kadr_schedule_corrective_reminders: { overdue: 1, followup: 0 } }]),
    ).buildJobs();
    const corr = jsonJobs.find((x) => x.key === "kadr-corrective")!;
    await expect(corr.run({ scheduledFor: new Date() })).resolves.toBe(
      'kadr_schedule_corrective_reminders={"overdue":1,"followup":0}',
    );
  });

  it("void fn se zovu sa ::text cast-om, TABLE fn kroz SELECT * FROM (Prisma raw ograničenja)", async () => {
    const sy15 = sy15Mock([]);
    const jobs = new Sy15CronJobs(sy15).buildJobs();
    const sqlOf = async (key: string): Promise<string> => {
      (sy15.db.$queryRawUnsafe as jest.Mock).mockClear();
      await jobs.find((x) => x.key === key)!.run({ scheduledFor: new Date() });
      return (sy15.db.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string;
    };
    expect(await sqlOf("kadr-attendance-alerts")).toContain("::text");
    expect(await sqlOf("kadr-attendance-digest")).toContain("::text");
    expect(await sqlOf("kadr-qbt-cards")).toContain("::text");
    expect(await sqlOf("kadr-hr-reminders")).toMatch(/^SELECT \* FROM/);
    expect(await sqlOf("maint-deadlines")).toMatch(/^SELECT \* FROM/);
  });

  it("guard-poslovi imaju catch-up ograničen na guard-sat (55/25/55 min)", () => {
    const byKey = new Map(new Sy15CronJobs(sy15Mock()).buildJobs().map((x) => [x.key, x]));
    expect(byKey.get("kadr-attendance-alerts")?.catchUpMinutes).toBe(55);
    expect(byKey.get("kadr-attendance-digest")?.catchUpMinutes).toBe(25);
    expect(byKey.get("sast-weekly-auto")?.catchUpMinutes).toBe(55);
  });
});
