import { Module, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Sy15Module } from "../../common/sy15/sy15.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import { NotifyDispatchService } from "./dispatch/notify-dispatch.service";
import { SastanciDispatchService } from "./dispatch/sastanci-dispatch.service";
import { RetentionJobsService } from "./retention-jobs.service";
import { RobnoModule } from "../robno/robno.module";
import { ReservationService } from "../robno/reservation.service";

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
  // RobnoModule → ReservationService: dnevno oslobađanje isteklih rezervacija
  // (bez toga `expiresAt` ne radi ništa i rezervacija večno drži zalihu).
  imports: [Sy15Module, RobnoModule],
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    Sy15CronJobs,
    NotifyDispatchService,
    SastanciDispatchService,
    RetentionJobsService,
  ],
  // NotifyDispatchService se izvozi da bi Kadrovska/Moj profil mogli da okinu
  // ISTI dispečer sinhrono („Pošalji čekaće" / pulse posle mutacije) umesto da
  // zovu 1.0 edge `hr-notify-dispatch` — dva dispečera nad istim outboxom su
  // slala duple poruke (AUDIT-K3).
  exports: [SchedulerService, NotifyDispatchService],
})
export class SchedulerModule implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly scheduler: SchedulerService,
    private readonly sy15Jobs: Sy15CronJobs,
    private readonly dispatchJobs: NotifyDispatchService,
    private readonly sastanciDispatchJobs: SastanciDispatchService,
    private readonly retentionJobs: RetentionJobsService,
    private readonly reservation: ReservationService,
  ) {}

  onModuleInit(): void {
    for (const job of this.sy15Jobs.buildJobs()) this.scheduler.register(job);
    for (const job of this.dispatchJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.sastanciDispatchJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.retentionJobs.buildJobs())
      this.scheduler.register(job);

    // Istekle rezervacije zaliha (Batch C). `expiresAt` puni rok važenja
    // predračuna; bez ovog posla istekla rezervacija večno drži robu jer je
    // ništa ne oslobađa. Poziv je idempotentan (CAS OPEN → RELEASED) i jeftin.
    this.scheduler.register({
      key: "robno-expire-reservations",
      description: "Rezervacije zaliha: oslobodi istekle (expiresAt < danas)",
      schedule: { kind: "daily", at: "02:15" },
      run: async () => {
        const res = (await this.reservation.expireDue()) as {
          released?: number;
        };
        return `oslobođeno isteklih rezervacija: ${res?.released ?? 0}`;
      },
    });
  }

  onApplicationBootstrap(): void {
    // Posle SVIH onModuleInit-a (registar pun) — tek tada pogon sme da krene.
    this.scheduler.start();
  }
}
