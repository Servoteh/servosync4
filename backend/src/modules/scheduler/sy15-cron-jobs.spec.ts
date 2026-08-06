import { Logger } from "@nestjs/common";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import { SastanciSourceService } from "../../common/sy15/sastanci-source.service";
import { PbSourceService } from "../../common/sy15/pb-source.service";
import type { Sy15Service } from "../../common/sy15/sy15.service";
import type { PrismaService } from "../../prisma/prisma.service";
import type { SastanciFnService } from "../sastanci/sastanci-fn.service";
import type { ScheduledJob } from "./scheduler.types";

/*
 * Seoba sastanaka (05.08.2026, docs/SEOBA_SASTANCI_PB_2026-08-05.md).
 *
 * ŠTA OVI TESTOVI ČUVAJU:
 *  1. TRI posla domena sastanaka poštuju `SASTANCI_IZVOR` — pod `3.0` idu kroz
 *     `SastanciFnService` (3.0 baza), pod `sy15` NEPROMENJENIM SQL-om na sy15.
 *     Bez ovoga bi prekidač bio „poluprekidač": rute bi čitale 3.0, a scheduler
 *     bi u istoj sekundi kvačio mejlove u sy15 outbox → dve istine.
 *  2. Summary string je ISTOG OBLIKA na oba puta (`<ime_fn>=<vrednost>`), da se
 *     dnevnik `scheduled_job_runs` može porediti pre i posle preklopa.
 *  3. Praznici pod `3.0` dolaze READ-ONLY sa sy15 (`kadr_holidays` je kadrovska,
 *     korak 4) i njihov IZOSTANAK ne obara posao — sedmični se samo ne pomera.
 *  4. `pb-enqueue` pod `PB_IZVOR=3.0` GLASNO pada (PB nije prenet), a
 *     kadrovska/održavanje poslovi ostaju netaknuti — oni nisu ovaj domen.
 *  5. 🔴 PREKIDAČI SU NEZAVISNI (incident 06.08.2026): pod `SASTANCI_IZVOR=3.0`
 *     + `PB_IZVOR=sy15` `pb-enqueue` MORA da radi normalno. Dok je prekidač bio
 *     jedan (`SASTANCI_PB_IZVOR`), preklop sastanaka ga je obarao u 503.
 */

const OLD_ENV = { ...process.env };
beforeEach(() => {
  delete process.env.SASTANCI_IZVOR;
  delete process.env.PB_IZVOR;
  delete process.env.SASTANCI_PB_IZVOR;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  jest.restoreAllMocks();
});

/** sy15 mock: hvata `$queryRawUnsafe` SQL i servira praznike. */
function sy15Mock(opts: { praznici?: Date[]; nemaBaze?: boolean } = {}) {
  const sql: string[] = [];
  // ⚠️ Rezultati idu kroz FIFO red UNUTAR implementacije, ne kroz
  // `mockResolvedValueOnce` — taj bi zamenio implementaciju i `sql` bi ostao prazan.
  const queue: unknown[][] = [];
  const $queryRawUnsafe = jest.fn((q: string): Promise<unknown[]> => {
    sql.push(q);
    return Promise.resolve(queue.length ? (queue.shift() as unknown[]) : []);
  });
  const findMany = jest
    .fn()
    .mockResolvedValue((opts.praznici ?? []).map((d) => ({ holidayDate: d })));
  const db = { $queryRawUnsafe, kadrHoliday: { findMany } };
  const sy15 = {} as { db: unknown };
  Object.defineProperty(sy15, "db", {
    get: () => {
      // Paritet `Sy15Service.db`: bez `SY15_DATABASE_URL` geter BACA 503.
      if (opts.nemaBaze) throw new Error("sy15 baza nije konfigurisana");
      return db;
    },
  });
  return {
    sy15: sy15 as unknown as Sy15Service,
    sql,
    $queryRawUnsafe,
    findMany,
    /** Sledeći `$queryRawUnsafe` vraća ove redove (za summary assert-e). */
    vrati: (rows: unknown[]) => queue.push(rows),
  };
}

/** 3.0 Prisma mock: `$transaction(cb)` samo izvrši callback. */
function prismaMock() {
  const tx = { marker: "tx3.0" };
  const $transaction = jest.fn((cb: (t: unknown) => unknown) =>
    Promise.resolve(cb(tx)),
  );
  return {
    prisma: { $transaction } as unknown as PrismaService,
    $transaction,
    tx,
  };
}

/** `SastanciFnService` mock — samo tri metode koje scheduler dodiruje. */
function sastFnMock(
  over: {
    action?: number;
    meeting?: number;
    weekly?: string | null;
  } = {},
) {
  const enqueueActionReminders = jest.fn().mockResolvedValue(over.action ?? 0);
  const enqueueMeetingReminders = jest
    .fn()
    .mockResolvedValue(over.meeting ?? 0);
  const autoCreateWeekly = jest
    .fn()
    .mockResolvedValue(over.weekly === undefined ? null : over.weekly);
  return {
    sastFn: {
      enqueueActionReminders,
      enqueueMeetingReminders,
      autoCreateWeekly,
    } as unknown as SastanciFnService,
    enqueueActionReminders,
    enqueueMeetingReminders,
    autoCreateWeekly,
  };
}

function make(
  sy15 = sy15Mock(),
  p = prismaMock(),
  fn = sastFnMock(),
): {
  jobs: Map<string, ScheduledJob>;
  sy15: ReturnType<typeof sy15Mock>;
  p: ReturnType<typeof prismaMock>;
  fn: ReturnType<typeof sastFnMock>;
} {
  const svc = new Sy15CronJobs(
    sy15.sy15,
    new SastanciSourceService(),
    p.prisma,
    fn.sastFn,
    new PbSourceService(),
  );
  return {
    jobs: new Map(svc.buildJobs().map((j) => [j.key, j])),
    sy15,
    p,
    fn,
  };
}

const run = (job: ScheduledJob): Promise<string | void> =>
  job.run({ scheduledFor: new Date() });

describe("registar poslova — oblik se NE menja seobom", () => {
  it("ključevi i rasporedi ostaju isti (ključ ide u scheduled_job_runs)", () => {
    const { jobs } = make();
    expect([...jobs.keys()]).toEqual([
      "kadr-hr-reminders",
      "kadr-corrective",
      "kadr-onboarding",
      "kadr-attendance-alerts",
      "kadr-attendance-digest",
      "kadr-weekly-risk",
      "kadr-qbt-cards",
      "sast-action-reminders",
      "sast-meeting-reminders",
      "sast-weekly-auto",
      "maint-deadlines",
      "pb-enqueue",
    ]);
    expect(jobs.get("sast-action-reminders")!.schedule).toEqual({
      kind: "daily",
      at: "09:00",
    });
    // Kadenca 5 min je SPREGNUTA sa prozorom 25–35 min u fn — ne dirati odvojeno.
    expect(jobs.get("sast-meeting-reminders")!.schedule).toEqual({
      kind: "everyMinutes",
      minutes: 5,
    });
    expect(jobs.get("sast-weekly-auto")!.schedule).toEqual({
      kind: "weekly",
      isoDow: 5,
      at: "08:00",
    });
    // Catch-up sedmičnog ostaje 55 min (fn guard je pet+08h, u oba izvora).
    expect(jobs.get("sast-weekly-auto")!.catchUpMinutes).toBe(55);
  });
});

describe("SASTANCI_IZVOR=sy15 (podrazumevano) — ponašanje NETAKNUTO", () => {
  it("sast-action-reminders zove sy15 fn, prepis se ne dodiruje", async () => {
    const { jobs, sy15, fn, p } = make();
    sy15.vrati([{ sastanci_enqueue_action_reminders: 7 }]);

    const summary = await run(jobs.get("sast-action-reminders")!);
    expect(summary).toBe("sastanci_enqueue_action_reminders=7");
    expect(sy15.sql).toEqual([
      "SELECT public.sastanci_enqueue_action_reminders();",
    ]);
    expect(fn.enqueueActionReminders).not.toHaveBeenCalled();
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("sast-meeting-reminders zove sy15 fn", async () => {
    const { jobs, sy15, fn } = make();
    sy15.vrati([{ sastanci_enqueue_meeting_reminders: 2 }]);

    const summary = await run(jobs.get("sast-meeting-reminders")!);
    expect(summary).toBe("sastanci_enqueue_meeting_reminders=2");
    expect(sy15.sql).toEqual([
      "SELECT public.sastanci_enqueue_meeting_reminders();",
    ]);
    expect(fn.enqueueMeetingReminders).not.toHaveBeenCalled();
  });

  it("sast-weekly-auto zove sy15 fn i NE čita praznike (fn ih čita sama)", async () => {
    const { jobs, sy15, fn } = make();
    sy15.vrati([{ sast_auto_create_weekly: "uuid-1" }]);

    const summary = await run(jobs.get("sast-weekly-auto")!);
    expect(summary).toBe("sast_auto_create_weekly=uuid-1");
    expect(sy15.sql).toEqual(["SELECT public.sast_auto_create_weekly();"]);
    // Suvišan upit u `kadr_holidays` pod sy15 putem bi bio čist trošak.
    expect(sy15.findMany).not.toHaveBeenCalled();
    expect(fn.autoCreateWeekly).not.toHaveBeenCalled();
  });

  it("pb-enqueue prolazi kroz branjeni geter i normalno zove sy15", async () => {
    const { jobs, sy15 } = make();
    await run(jobs.get("pb-enqueue")!);
    expect(sy15.sql).toEqual(["SELECT public.pb_enqueue_notifications();"]);
  });
});

describe("SASTANCI_IZVOR=3.0 — sastanci idu kroz SastanciFnService", () => {
  it("sast-action-reminders: prepis u 3.0 transakciji, NIJEDAN sy15 poziv", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { jobs, sy15, fn, p } = make(
      sy15Mock(),
      prismaMock(),
      sastFnMock({ action: 7 }),
    );

    const summary = await run(jobs.get("sast-action-reminders")!);
    // ISTI oblik summary-ja kao sy15 put — dnevnik ostaje uporediv.
    expect(summary).toBe("sastanci_enqueue_action_reminders=7");
    expect(fn.enqueueActionReminders).toHaveBeenCalledTimes(1);
    // Prvi argument je transakcioni klijent (kao što je sy15 fn bila u tx).
    expect(fn.enqueueActionReminders.mock.calls[0][0]).toBe(p.tx);
    expect(p.$transaction).toHaveBeenCalledTimes(1);
    expect(sy15.sql).toEqual([]);
  });

  it("sast-meeting-reminders: prepis u 3.0 transakciji, NIJEDAN sy15 poziv", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { jobs, sy15, fn } = make(
      sy15Mock(),
      prismaMock(),
      sastFnMock({ meeting: 3 }),
    );

    const summary = await run(jobs.get("sast-meeting-reminders")!);
    expect(summary).toBe("sastanci_enqueue_meeting_reminders=3");
    expect(fn.enqueueMeetingReminders).toHaveBeenCalledTimes(1);
    expect(sy15.sql).toEqual([]);
  });

  it("sast-weekly-auto: praznici se čitaju READ-ONLY sa sy15 i stižu kao Set 'YYYY-MM-DD'", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const s = sy15Mock({
      praznici: [
        new Date("2026-11-11T00:00:00Z"),
        new Date("2027-01-01T00:00:00Z"),
      ],
    });
    const { jobs, fn } = make(
      s,
      prismaMock(),
      sastFnMock({ weekly: "novi-uuid" }),
    );

    const summary = await run(jobs.get("sast-weekly-auto")!);
    expect(summary).toBe("sast_auto_create_weekly=novi-uuid");
    expect(s.sql).toEqual([]);

    // 🔴 JEDINA preostala cross-baza zavisnost: `kadr_holidays` je kadrovska
    // (korak 4). Prozor je ~90 dana i traže se SAMO neradni dani.
    expect(s.findMany).toHaveBeenCalledTimes(1);
    const args = s.findMany.mock.calls[0][0] as {
      where: { isWorkday: boolean; holidayDate: { gte: Date; lte: Date } };
    };
    expect(args.where.isWorkday).toBe(false);
    const dana =
      (args.where.holidayDate.lte.getTime() -
        args.where.holidayDate.gte.getTime()) /
      86_400_000;
    expect(Math.round(dana)).toBe(90);

    const praznici = fn.autoCreateWeekly.mock.calls[0][1] as Set<string>;
    expect(praznici).toBeInstanceOf(Set);
    expect([...praznici].sort()).toEqual(["2026-11-11", "2027-01-01"]);
  });

  it("sast-weekly-auto: bez sedmičnog termina summary je `=null` (kao NULL kolona na sy15)", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { jobs } = make(
      sy15Mock(),
      prismaMock(),
      sastFnMock({ weekly: null }),
    );
    expect(await run(jobs.get("sast-weekly-auto")!)).toBe(
      "sast_auto_create_weekly=null",
    );
  });

  it("sy15 nedostupna (nema SY15_DATABASE_URL): posao NE pada — praznici prazni + upozorenje", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const warn = jest
      .spyOn(Logger.prototype, "warn")
      .mockImplementation((): void => undefined);
    const { jobs, fn } = make(
      sy15Mock({ nemaBaze: true }),
      prismaMock(),
      sastFnMock({ weekly: "uuid-2" }),
    );

    // Sedmični se i dalje kreira (samo bez pomeranja sa praznika) — bolje nego
    // preskočena automatika, jer termin ljudi mogu ručno da pomere.
    expect(await run(jobs.get("sast-weekly-auto")!)).toBe(
      "sast_auto_create_weekly=uuid-2",
    );
    const praznici = fn.autoCreateWeekly.mock.calls[0][1] as Set<string>;
    expect(praznici.size).toBe(0);
    expect(warn.mock.calls.map((c) => String(c[0])).join(" || ")).toContain(
      "NEĆE biti pomeren sa praznika",
    );
  });

  it("kadrovska i održavanje NISU ovaj domen — idu na sy15 kao i do sad", async () => {
    process.env.SASTANCI_IZVOR = "3.0";
    const { jobs, sy15, p } = make();

    await run(jobs.get("kadr-hr-reminders")!);
    await run(jobs.get("kadr-attendance-alerts")!);
    await run(jobs.get("maint-deadlines")!);
    expect(sy15.sql).toEqual([
      "SELECT * FROM public.kadr_schedule_hr_reminders();",
      "SELECT public.kadr_schedule_attendance_alerts()::text AS result;",
      "SELECT * FROM public.maint_check_all_deadlines(30);",
    ]);
    expect(p.$transaction).not.toHaveBeenCalled();
  });

  it("nepoznata vrednost prekidača NE pali 3.0 granu (pada na bezbedan sy15)", async () => {
    process.env.SASTANCI_IZVOR = "3";
    const { jobs, sy15, fn } = make();

    await run(jobs.get("sast-action-reminders")!);
    expect(sy15.sql).toEqual([
      "SELECT public.sastanci_enqueue_action_reminders();",
    ]);
    expect(fn.enqueueActionReminders).not.toHaveBeenCalled();
  });
});

/*
 * 🔴 INCIDENT 06.08.2026 — ZBOG ČEGA POSTOJI OVAJ BLOK.
 *
 * Prekidač je bio JEDAN (`SASTANCI_PB_IZVOR`). Čim je na produkciji stao na
 * `3.0` (sastanci su bili spremni), `pb-enqueue` je počeo da pada sa 503 iako se
 * projektni biro uopšte ne seli. Ova četiri testa su pin za sve četiri
 * kombinacije — treći je tačno scenario koji je pao.
 */
describe("prekidači su NEZAVISNI — sve 4 kombinacije (incident 06.08.2026)", () => {
  const kombinacija = (
    sastanci: string | undefined,
    pb: string | undefined,
  ) => {
    if (sastanci) process.env.SASTANCI_IZVOR = sastanci;
    if (pb) process.env.PB_IZVOR = pb;
    const { jobs, sy15, fn } = make(
      sy15Mock(),
      prismaMock(),
      sastFnMock({ action: 1 }),
    );
    return { jobs, sy15, fn };
  };

  it("sy15 / sy15 (podrazumevano): oba posla na sy15", async () => {
    const { jobs, sy15, fn } = kombinacija(undefined, undefined);
    await run(jobs.get("sast-action-reminders")!);
    await run(jobs.get("pb-enqueue")!);
    expect(sy15.sql).toEqual([
      "SELECT public.sastanci_enqueue_action_reminders();",
      "SELECT public.pb_enqueue_notifications();",
    ]);
    expect(fn.enqueueActionReminders).not.toHaveBeenCalled();
  });

  it("sy15 / 3.0: PB pada sa 503, sastanci NETAKNUTI na sy15", async () => {
    const { jobs, sy15, fn } = kombinacija(undefined, "3.0");
    await run(jobs.get("sast-action-reminders")!);
    await expect(run(jobs.get("pb-enqueue")!)).rejects.toThrow(
      /projektni biro: enqueue notifikacija kroz sy15/,
    );
    // Brana je PRE poziva — nijedan PB upis ne sme da procuri u sy15.
    expect(sy15.sql).toEqual([
      "SELECT public.sastanci_enqueue_action_reminders();",
    ]);
    expect(fn.enqueueActionReminders).not.toHaveBeenCalled();
  });

  it("🔴 3.0 / sy15 (scenario koji je pao): sastanci u 3.0, pb-enqueue RADI", async () => {
    const { jobs, sy15, fn } = kombinacija("3.0", undefined);
    expect(await run(jobs.get("sast-action-reminders")!)).toBe(
      "sastanci_enqueue_action_reminders=1",
    );
    expect(fn.enqueueActionReminders).toHaveBeenCalledTimes(1);
    // Ovaj red je cela poenta razdvajanja: PB posao ne sme ni da zna za preklop.
    await expect(run(jobs.get("pb-enqueue")!)).resolves.toBeDefined();
    expect(sy15.sql).toEqual(["SELECT public.pb_enqueue_notifications();"]);
  });

  it("3.0 / 3.0: sastanci u 3.0, PB i dalje pada sa 503", async () => {
    const { jobs, sy15, fn } = kombinacija("3.0", "3.0");
    await run(jobs.get("sast-action-reminders")!);
    expect(fn.enqueueActionReminders).toHaveBeenCalledTimes(1);
    await expect(run(jobs.get("pb-enqueue")!)).rejects.toThrow(
      /projektni biro: enqueue notifikacija kroz sy15/,
    );
    expect(sy15.sql).toEqual([]);
  });

  it("zastareli SASTANCI_PB_IZVOR=3.0 pomera SAMO sastanke — PB ostaje živ", async () => {
    process.env.SASTANCI_PB_IZVOR = "3.0";
    const { jobs, sy15, fn } = make(
      sy15Mock(),
      prismaMock(),
      sastFnMock({ action: 4 }),
    );
    expect(await run(jobs.get("sast-action-reminders")!)).toBe(
      "sastanci_enqueue_action_reminders=4",
    );
    expect(fn.enqueueActionReminders).toHaveBeenCalledTimes(1);
    // Stari naziv više NE MOŽE da obori PB — to je bila poenta incidenta.
    await expect(run(jobs.get("pb-enqueue")!)).resolves.toBeDefined();
    expect(sy15.sql).toEqual(["SELECT public.pb_enqueue_notifications();"]);
  });
});
