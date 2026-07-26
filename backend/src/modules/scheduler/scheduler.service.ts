import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  belgradeParts,
  belgradeTimeToUtc,
  shiftBelgradeDate,
} from "./belgrade-time";
import {
  DEFAULT_STALE_AFTER_MINUTES,
  JOB_STATUS,
  MAX_ATTEMPTS,
  type JobSchedule,
  type ScheduledJob,
} from "./scheduler.types";

/*
 * Talas A — scheduler POGON u 3.0 (paritet-audit X-EMAIL-AUTOMATIKE-01).
 *
 * ODLUKA (vidi ODLUKE.md #39): in-process tik u NestJS-u BEZ novih zavisnosti
 * (obrazac = KadrovskaGridAutofillService setInterval), umesto pg_cron na
 * glavnoj bazi (traži shared_preload_libraries + restart PROD Postgres-a) ili
 * @nestjs/schedule (nova zavisnost, §10). Garancije koje pg_cron daje ovde
 * obezbeđuju: `scheduled_job_runs` UNIQUE(job_key, scheduled_for) = atomski
 * claim (tačno-jednom po terminu, i sa više instanci), catch-up prozor
 * (deploy/restart preko termina ne guta posao) i retry (MAX_ATTEMPTS).
 *
 * Pogon se pali ISKLJUČIVO uz `SCHEDULER_ENABLED=true` (backend.env) — deploy
 * koda je bezbedan bez aktivacije; gašenje = ukloni env red + restart.
 * Ručno okidanje pojedinačnog posla radi i bez flag-a (POST /scheduler/:key/run-now).
 */
@Injectable()
export class SchedulerService implements OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly jobs = new Map<string, ScheduledJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickBusy = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Poslovi se registruju iz SchedulerModule.onModuleInit (pre start()). */
  register(job: ScheduledJob): void {
    if (this.jobs.has(job.key))
      throw new Error(`Scheduler: dupli job key '${job.key}'`);
    this.jobs.set(job.key, job);
  }

  list(): ScheduledJob[] {
    return [...this.jobs.values()];
  }

  get enabled(): boolean {
    return process.env.SCHEDULER_ENABLED === "true";
  }

  /**
   * Pali pogon — zove SchedulerModule.onApplicationBootstrap (POSLE registracije
   * poslova u onModuleInit; provider-ov onModuleInit bi trkao sa registracijom).
   */
  start(): void {
    if (this.timer) return;
    if (!this.enabled) {
      this.logger.log(
        `Scheduler ISKLJUČEN (SCHEDULER_ENABLED != 'true') — ${this.jobs.size} poslova registrovano, samo ručno okidanje.`,
      );
      return;
    }
    // 30s tik: minutna preciznost rasporeda uz toleranciju na spor tick.
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref?.();
    this.logger.log(
      `Scheduler UKLJUČEN — ${this.jobs.size} poslova, tik na 30s (Europe/Belgrade rasporedi).`,
    );
    // Prvi prolaz odmah (catch-up posle deploy-a bez čekanja tika).
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Poslednji dospeo termin posla ≤ now (UTC), ili null ako je van catch-up
   * prozora. everyMinutes vraća samo POSLEDNJI slot (bez backfill-a istorije).
   */
  computeDueSlot(schedule: JobSchedule, catchUpMinutes: number, now: Date): Date | null {
    if (schedule.kind === "everyMinutes") {
      const periodMs = schedule.minutes * 60_000;
      const slot = new Date(Math.floor(now.getTime() / periodMs) * periodMs);
      return now.getTime() - slot.getTime() <= catchUpMinutes * 60_000 ? slot : null;
    }
    const [hh, mm] = schedule.at.split(":").map(Number);
    const p = belgradeParts(now);
    // Kandidati: današnji lokalni termin, pa unazad do 7 dana (weekly pokriva
    // celu sedmicu; daily realno koristi samo danas/juče unutar prozora).
    for (let back = 0; back <= 7; back++) {
      const d = shiftBelgradeDate(p, -back);
      if (schedule.kind === "weekly") {
        const dowParts = belgradeParts(belgradeTimeToUtc(d.year, d.month, d.day, 12, 0));
        if (dowParts.isoDow !== schedule.isoDow) continue;
      }
      const slot = belgradeTimeToUtc(d.year, d.month, d.day, hh, mm);
      if (slot.getTime() > now.getTime()) continue; // još nije dospeo
      const lateMs = now.getTime() - slot.getTime();
      return lateMs <= catchUpMinutes * 60_000 ? slot : null;
    }
    return null;
  }

  private catchUpFor(job: ScheduledJob): number {
    if (job.catchUpMinutes != null) return job.catchUpMinutes;
    return job.schedule.kind === "everyMinutes" ? job.schedule.minutes : 180;
  }

  private async tick(): Promise<void> {
    if (this.tickBusy) return; // spor posao ne sme da nagomila paralelne tikove
    this.tickBusy = true;
    try {
      const now = new Date();
      for (const job of this.jobs.values()) {
        try {
          const slot = this.computeDueSlot(job.schedule, this.catchUpFor(job), now);
          if (slot) await this.claimAndRun(job, slot);
        } catch (e) {
          // Greška JEDNOG posla ne sme da obori tik za ostale.
          this.logger.error(
            `Scheduler tik za '${job.key}' pao: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    } finally {
      this.tickBusy = false;
    }
  }

  /**
   * Atomski claim termina pa izvršenje. Claim = INSERT (conflict → već izvršeno/
   * u toku negde) ILI re-claim FAILED reda (retry do MAX_ATTEMPTS).
   */
  private async claimAndRun(job: ScheduledJob, scheduledFor: Date): Promise<void> {
    const claimed = await this.prisma.$queryRaw<{ id: number; attempts: number }[]>`
      INSERT INTO scheduled_job_runs (job_key, scheduled_for, status)
      VALUES (${job.key}, ${scheduledFor}, ${JOB_STATUS.RUNNING})
      ON CONFLICT (job_key, scheduled_for) DO NOTHING
      RETURNING id, attempts`;
    let runId = claimed[0]?.id ?? null;
    let attempt = claimed[0]?.attempts ?? 1;

    if (runId == null) {
      // Termin već postoji. Re-claim (atomski UPDATE — samo jedan dobije red):
      //  • FAILED sa preostalim pokušajima — uz BACKOFF 10min×attempts (bez ovoga
      //    bi sva 3 pokušaja izgorela za ~90s pa kratak sy15 ispad pojede slot);
      //  • zaglavljeni RUNNING stariji od `staleAfterMinutes` (crash/SIGTERM usred
      //    izvršenja bi inače TRAJNO progutao slot — sy15 fn su idempotentne pa je
      //    re-run bezbedan). Prag je PO POSLU: default 10 min važi za kratke sy15
      //    pozive, a dug posao (npr. BigBit sync) ga mora podići iznad svog
      //    najdužeg trajanja, inače bi sam sebe pokrenuo drugi put (review [7]).
      // ⚠️ `${staleAfter}::int` — Prisma vezuje JS broj kao int8/bigint, a
      // `make_interval(mins => …)` prima int, pa je bez cast-a upit padao na
      // `42883: function make_interval(mins => bigint) does not exist` i RUSIO
      // SVAKI TIK pogona (532 greske za sat vremena na produ, 26.07). Susedni
      // `mins => 10 * attempts` radi jer je `attempts` KOLONA (int), ne parametar.
      const staleAfter = job.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
      const retried = await this.prisma.$queryRaw<{ id: number; attempts: number }[]>`
        UPDATE scheduled_job_runs
           SET status = ${JOB_STATUS.RUNNING}, attempts = attempts + 1,
               started_at = now(), finished_at = NULL, error = NULL
         WHERE job_key = ${job.key} AND scheduled_for = ${scheduledFor}
           AND attempts < ${MAX_ATTEMPTS}
           AND (
             (status = ${JOB_STATUS.FAILED}
               AND finished_at < now() - make_interval(mins => 10 * attempts))
             OR (status = ${JOB_STATUS.RUNNING}
               AND started_at < now() - make_interval(mins => ${staleAfter}::int))
           )
        RETURNING id, attempts`;
      runId = retried[0]?.id ?? null;
      attempt = retried[0]?.attempts ?? 0;
      if (runId == null) return; // DONE / svež RUNNING / backoff / iscrpljeni pokušaji
    }

    await this.execute(job, scheduledFor, runId, attempt);
  }

  /** Izvrši posao i upiši ishod u dnevnik (koristi i run-now iz kontrolera). */
  async execute(
    job: ScheduledJob,
    scheduledFor: Date,
    runId: number,
    attempt: number,
  ): Promise<{ status: string; summary?: string; error?: string }> {
    const t0 = Date.now();
    try {
      const summary = (await job.run({ scheduledFor })) || "ok";
      await this.prisma.scheduledJobRun.update({
        where: { id: runId },
        data: {
          status: JOB_STATUS.DONE,
          finishedAt: new Date(),
          summary: String(summary).slice(0, 2000),
          error: null,
        },
      });
      this.logger.log(
        `Posao '${job.key}' (${scheduledFor.toISOString()}) OK za ${Date.now() - t0}ms: ${summary}`,
      );
      return { status: JOB_STATUS.DONE, summary: String(summary) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.scheduledJobRun
        .update({
          where: { id: runId },
          data: {
            status: JOB_STATUS.FAILED,
            finishedAt: new Date(),
            error: msg.slice(0, 2000),
          },
        })
        .catch(() => undefined);
      this.logger.error(
        `Posao '${job.key}' (${scheduledFor.toISOString()}) PAO (pokušaj ${attempt}/${MAX_ATTEMPTS}): ${msg}`,
      );
      return { status: JOB_STATUS.FAILED, error: msg };
    }
  }

  /**
   * Ručno okidanje (POST /scheduler/jobs/:key/run-now) — radi i kad je pogon
   * isključen. Termin = sada zaokruženo na sekund (dva brza klika → conflict
   * umesto duplog pokretanja), a svež RUNNING red istog posla blokira pokretanje
   * (paralelni run iste sy15 fn zaobilazi njihove NOT EXISTS dedup guardove).
   */
  async runNow(key: string): Promise<{ status: string; summary?: string; error?: string }> {
    const job = this.jobs.get(key);
    if (!job) throw new Error(`Nepoznat posao '${key}'`);
    const blockMinutes =
      job.runNowBlockMinutes ??
      job.staleAfterMinutes ??
      DEFAULT_STALE_AFTER_MINUTES;
    const running = await this.prisma.scheduledJobRun.findFirst({
      where: {
        jobKey: job.key,
        status: JOB_STATUS.RUNNING,
        startedAt: { gt: new Date(Date.now() - blockMinutes * 60_000) },
      },
      select: { id: true },
    });
    if (running) throw new Error("Posao upravo radi — sačekaj da se završi.");
    const scheduledFor = new Date(Math.floor(Date.now() / 1000) * 1000);
    const claimed = await this.prisma.$queryRaw<{ id: number }[]>`
      INSERT INTO scheduled_job_runs (job_key, scheduled_for, status)
      VALUES (${job.key}, ${scheduledFor}, ${JOB_STATUS.RUNNING})
      ON CONFLICT (job_key, scheduled_for) DO NOTHING
      RETURNING id`;
    const runId = claimed[0]?.id;
    if (runId == null) throw new Error("Termin zauzet — pokušaj ponovo.");
    return this.execute(job, scheduledFor, runId, 1);
  }
}
