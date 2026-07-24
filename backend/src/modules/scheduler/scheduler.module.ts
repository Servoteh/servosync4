import { Module, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Sy15Module } from "../../common/sy15/sy15.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";

/**
 * Talas A — scheduler pogon + registar poslova. Poslovi su tanki pozivi
 * postojećih sy15 SECURITY DEFINER funkcija (vidi sy15-cron-jobs.ts);
 * pogon/dnevnik je u glavnoj bazi (scheduled_job_runs).
 */
@Module({
  imports: [Sy15Module],
  controllers: [SchedulerController],
  providers: [SchedulerService, Sy15CronJobs],
  exports: [SchedulerService],
})
export class SchedulerModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sy15Jobs: Sy15CronJobs,
  ) {}

  onModuleInit(): void {
    for (const job of this.sy15Jobs.buildJobs()) this.scheduler.register(job);
  }

  onApplicationBootstrap(): void {
    // Posle SVIH onModuleInit-a (registar pun) — tek tada pogon sme da krene.
    this.scheduler.start();
  }
}
