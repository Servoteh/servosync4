import { Module, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Sy15Module } from "../../common/sy15/sy15.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import { NotifyDispatchService } from "./dispatch/notify-dispatch.service";

/**
 * Talas A — scheduler pogon + registar poslova. Poslovi su tanki pozivi
 * postojećih sy15 SECURITY DEFINER funkcija (vidi sy15-cron-jobs.ts);
 * pogon/dnevnik je u glavnoj bazi (scheduled_job_runs).
 *
 * Talas A-2a — uz ENQUEUE poslove registruju se i DISPATCH poslovi (kadr/maint/pb
 * outbox → mejl/WhatsApp, vidi dispatch/notify-dispatch.service.ts). Oni imaju
 * DODATAN prekidač `DISPATCH_ENABLED` (bez njega su no-op), pa aktivacija
 * scheduler-a ne uključuje automatski i slanje. Sastanci se NE diraju (A-2b).
 */
@Module({
  imports: [Sy15Module],
  controllers: [SchedulerController],
  providers: [SchedulerService, Sy15CronJobs, NotifyDispatchService],
  exports: [SchedulerService],
})
export class SchedulerModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sy15Jobs: Sy15CronJobs,
    private readonly dispatchJobs: NotifyDispatchService,
  ) {}

  onModuleInit(): void {
    for (const job of this.sy15Jobs.buildJobs()) this.scheduler.register(job);
    for (const job of this.dispatchJobs.buildJobs()) this.scheduler.register(job);
  }

  onApplicationBootstrap(): void {
    // Posle SVIH onModuleInit-a (registar pun) — tek tada pogon sme da krene.
    this.scheduler.start();
  }
}
