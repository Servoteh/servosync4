import { Module, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Sy15Module } from "../../common/sy15/sy15.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import { NotifyDispatchService } from "./dispatch/notify-dispatch.service";
import { SastanciDispatchService } from "./dispatch/sastanci-dispatch.service";
import { RetentionJobsService } from "./retention-jobs.service";

/**
 * Talas A — scheduler pogon + registar poslova. Poslovi su tanki pozivi
 * postojećih sy15 SECURITY DEFINER funkcija (vidi sy15-cron-jobs.ts);
 * pogon/dnevnik je u glavnoj bazi (scheduled_job_runs).
 *
 * Talas A-2a — uz ENQUEUE poslove registruju se i DISPATCH poslovi (kadr/maint/pb
 * outbox → mejl/WhatsApp, vidi dispatch/notify-dispatch.service.ts). Oni imaju
 * DODATAN prekidač `DISPATCH_ENABLED` (bez njega su no-op), pa aktivacija
 * scheduler-a ne uključuje automatski i slanje.
 *
 * Talas A-2b — sastanci outbox (dispatch/sastanci-dispatch.service.ts) na
 * ZASEBNOM prekidaču `DISPATCH_SASTANCI_ENABLED`, jer se i na sy15 gasi zasebno
 * (druga stavka u dispatch petlji) — preklop mora da bude nezavisan.
 *
 * DB audit Faza 3 — retention-jobs.service.ts (DB-043): noćno čišćenje
 * audit_log/notifikacija/job-runova po rokovima iz odluke 25.07.
 */
@Module({
  imports: [Sy15Module],
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    Sy15CronJobs,
    NotifyDispatchService,
    SastanciDispatchService,
    RetentionJobsService,
  ],
  exports: [SchedulerService],
})
export class SchedulerModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sy15Jobs: Sy15CronJobs,
    private readonly dispatchJobs: NotifyDispatchService,
    private readonly sastanciDispatchJobs: SastanciDispatchService,
    private readonly retentionJobs: RetentionJobsService,
  ) {}

  onModuleInit(): void {
    for (const job of this.sy15Jobs.buildJobs()) this.scheduler.register(job);
    for (const job of this.dispatchJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.sastanciDispatchJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.retentionJobs.buildJobs())
      this.scheduler.register(job);
  }

  onApplicationBootstrap(): void {
    // Posle SVIH onModuleInit-a (registar pun) — tek tada pogon sme da krene.
    this.scheduler.start();
  }
}
