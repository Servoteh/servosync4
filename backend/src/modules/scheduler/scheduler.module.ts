import { Module, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Sy15Module } from "../../common/sy15/sy15.module";
import { SchedulerController } from "./scheduler.controller";
import { SchedulerService } from "./scheduler.service";
import { Sy15CronJobs } from "./sy15-cron-jobs";
import { NotifyDispatchService } from "./dispatch/notify-dispatch.service";
import { SastanciDispatchService } from "./dispatch/sastanci-dispatch.service";
import { RetentionJobsService } from "./retention-jobs.service";
import { SastanciPeriodicniService } from "./sastanci-periodicni.service";
import { BigbitSyncJobs } from "./bigbit-sync-jobs.service";
import { DailyBriefService } from "./daily-brief.service";
import { SecurityAuditService } from "./security-audit.service";
import { RobnoModule } from "../robno/robno.module";
import { ReservationService } from "../robno/reservation.service";
import { SyncModule } from "../sync/sync.module";
import { BigbitMdbJobs } from "../sync/bigbit-mdb-jobs";
import { SastanciModule } from "../sastanci/sastanci.module";
import { OdrzavanjeModule } from "../odrzavanje/odrzavanje.module";
import { PbSourceService } from "../../common/sy15/pb-source.service";
import { ScadaSourceService } from "../../common/sy15/scada-source.service";
import { ScadaJobsService } from "./scada-jobs.service";

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
 *
 * Pruga P (26.07) — bigbit-sync-jobs.service.ts: noćno povlačenje BigBit master
 * podataka umesto ručnog dugmeta. Ima SVOJ prekidač `BIGBIT_NIGHTLY_SYNC`; bez
 * njega `buildJobs()` vraća prazno pa se posao ni ne registruje.
 *
 * Talas AI-3 (27.07) — daily-brief.service.ts: proaktivan jutarnji brief
 * direktoru/menadžmentu (mejl, rangirano, izvor uz svaku stavku). SVOJ prekidač
 * `DAILY_BRIEF_ENABLED`; bez njega `buildJobs()` vraća prazno (posao se ne
 * registruje). Deli isti @Global infrastrukturni sloj (Prisma/Mail/AI) + Sy15Module.
 *
 * Bezbednost (31.07) — security-audit.service.ts: nedeljna provera da li je ijedan
 * sy15 objekat otvoren roli `anon`. BEZ prekidača namerno (za razliku od gornjih):
 * posao SAMO ČITA sistemske kataloge i ne šalje ništa dok ne nađe nalaz, pa nema
 * šta da se „aktivira" — a prekidač na bezbednosnoj proveri je samo još jedno
 * mesto na kome ona može tiho da ostane ugašena.
 *
 * Seoba sastanaka (05.08.2026) — SastanciModule daje `SastanciFnService` (prepis
 * sy15 DEFINER fn nad 3.0 bazom) i `SastanciSourceService` (prekidač
 * `SASTANCI_IZVOR`). Poslovi domena sastanaka pod `3.0` idu kroz ISTU logiku
 * kao kontroler, ne kroz kopiju. SastanciModule ne uvozi scheduler → nema ciklusa.
 *
 * 🔴 Razdvajanje prekidača (06.08.2026, runbook §7h) — scheduler je JEDINO mesto
 * kome trebaju OBA: `Sy15CronJobs` drži tri posla sastanaka (`SASTANCI_IZVOR`) i
 * `pb-enqueue` (`PB_IZVOR`), a `NotifyDispatchService` drži `pb-notify-dispatch`
 * (`PB_IZVOR`). Zato `PbSourceService` stoji ovde u providers — dok su prekidači
 * bili jedan, preklop sastanaka je obarao oba PB posla.
 *
 * Seoba održavanja (07.08.2026) — `OdrzavanjeModule` daje `OdrzavanjeFnService`
 * (prepis sy15 DEFINER fn nad 3.0 bazom) poslovima `maint-deadlines` i
 * `maint-notify-dispatch`. Isti razlog kao kod `SastanciModule`: pod `3.0` posao
 * ide kroz ISTU logiku kao kontroler, ne kroz kopiju.
 *
 * 🔴 KOLATERAL NA TUĐE DOMENE (incident 06.08.2026) — uvoz novog modula menja
 * redosled inicijalizacije: Nest diže uvezene module PRE ovog, pa `OdrzavanjeModule`
 * (i njegovi Prisma/Idempotency/Notifications) sada ustaje pre scheduler-a. To je
 * bezopasno jer se poslovi registruju u `onModuleInit`, a pogon kreće tek u
 * `onApplicationBootstrap` (posle SVIH modula) — ali je razlog zašto boot-smoke ide
 * u OBA položaja prekidača i zašto specovi pinuju da `sast-*`/`pb-*`/`kadr-*`
 * poslovi ostaju netaknuti. `OdrzavanjeModule` ne uvozi scheduler → nema ciklusa.
 */
@Module({
  // RobnoModule → ReservationService: dnevno oslobađanje isteklih rezervacija
  // (bez toga `expiresAt` ne radi ništa i rezervacija večno drži zalihu).
  // SyncModule → SyncService: noćni BigBit sync zove ISTI servis kao /sync/run
  // (bez duplirane logike). SyncModule ne uvozi scheduler → nema ciklusa.
  imports: [
    Sy15Module,
    RobnoModule,
    SyncModule,
    SastanciModule,
    OdrzavanjeModule,
  ],
  controllers: [SchedulerController],
  providers: [
    SchedulerService,
    Sy15CronJobs,
    NotifyDispatchService,
    SastanciDispatchService,
    SastanciPeriodicniService,
    RetentionJobsService,
    BigbitSyncJobs,
    DailyBriefService,
    SecurityAuditService,
    PbSourceService,
    // 🔴 Treći prekidač (`ODRZAVANJE_IZVOR`) NAMERNO VIŠE NIJE ovde: od kad se
    // uvozi `OdrzavanjeModule` (koji ga i izvozi), lokalni provider bi napravio
    // DRUGU instancu. `IzvorPrekidac` čita env u KONSTRUKTORU i tu jednom loguje
    // upozorenje — dve instance znače dvostruko upozorenje na startu i dva
    // odvojena keša iste vrednosti. Poslovi `maint-deadlines` i
    // `maint-notify-dispatch` dobijaju prekidač iz uvezenog modula, isti onaj koji
    // vide kontroler održavanja, AI-chat i Reversi.
    // Četvrti prekidač (korak 5 gašenja sy15): `ScadaJobsService` drži watchdog i
    // retenciju istorije, i OBA se registruju samo pod `SCADA_IZVOR=3.0`. Isti
    // razlog kao gore — svaki domen nosi svoj prekidač, da preklop jednog ne
    // dodirne poslove drugog.
    ScadaSourceService,
    ScadaJobsService,
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
    private readonly sastanciPeriodicni: SastanciPeriodicniService,
    private readonly retentionJobs: RetentionJobsService,
    private readonly bigbitSyncJobs: BigbitSyncJobs,
    private readonly dailyBrief: DailyBriefService,
    private readonly securityAudit: SecurityAuditService,
    private readonly reservation: ReservationService,
    private readonly bigbitMdbJobs: BigbitMdbJobs,
    private readonly scadaJobs: ScadaJobsService,
  ) {}

  onModuleInit(): void {
    for (const job of this.sy15Jobs.buildJobs()) this.scheduler.register(job);
    // BigBit .mdb noćni uvoz + jutarnji nadzornik (26.07.2026). Bez ove dve
    // linije je ceo kanal mrtav kod: `buildJobs()` postoji, ali nikad se ne zove.
    for (const job of this.bigbitMdbJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.dispatchJobs.buildJobs())
      this.scheduler.register(job);
    for (const job of this.sastanciDispatchJobs.buildJobs())
      this.scheduler.register(job);
    // Periodični sastanci (024/26): dnevni nastavak serija — no-op dok sy15
    // skripta (sastanci-024-periodicni-2026-08-04) nije primenjena.
    for (const job of this.sastanciPeriodicni.buildJobs())
      this.scheduler.register(job);
    for (const job of this.retentionJobs.buildJobs())
      this.scheduler.register(job);
    // POSLE retention-a namerno: oba su na 03:30, a u tiku se poslovi izvršavaju
    // redom registracije — brza brisanja prva, pa dugačak sync.
    for (const job of this.bigbitSyncJobs.buildJobs())
      this.scheduler.register(job);
    // Talas AI-3 — dnevni brief (iza DAILY_BRIEF_ENABLED; bez flag-a prazno).
    for (const job of this.dailyBrief.buildJobs()) this.scheduler.register(job);
    // Nedeljna bezbednosna provera sy15 (ponedeljak 07:15) — samo čitanje.
    for (const job of this.securityAudit.buildJobs())
      this.scheduler.register(job);
    // SCADA watchdog + retencija istorije (seoba korak 5, 07.08.2026). Pod
    // `SCADA_IZVOR=sy15` `buildJobs()` vraća PRAZNO — dok je izvor sy15, taj posao
    // tamo radi pg_cron `scada_watchdog_every_5_min` i ne sme da se duplira.
    for (const job of this.scadaJobs.buildJobs())
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
