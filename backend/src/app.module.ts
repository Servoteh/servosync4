import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthzModule } from "./common/authz/authz.module";
import { MailModule } from "./common/mail/mail.module";
import { AuditInterceptor } from "./common/audit/audit.interceptor";
import { ReadOnlyInterceptor } from "./common/authz/read-only.interceptor";
import { SyncModule } from "./modules/sync/sync.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TechProcessesModule } from "./modules/tech-processes/tech-processes.module";
import { WorkOrdersModule } from "./modules/work-orders/work-orders.module";
import { LookupsModule } from "./modules/lookups/lookups.module";
import { StructuresModule } from "./modules/structures/structures.module";
import { PdmModule } from "./modules/pdm/pdm.module";
import { DirectoryModule } from "./modules/directory/directory.module";
import { HandoversModule } from "./modules/handovers/handovers.module";
import { PartLocationsModule } from "./modules/part-locations/part-locations.module";
import { CncProgramsModule } from "./modules/cnc-programs/cnc-programs.module";
import { QualityModule } from "./modules/kvalitet/kvalitet.module";
import { MrpModule } from "./modules/mrp/mrp.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { Sy15Module } from "./common/sy15/sy15.module";
import { AiModule } from "./common/ai/ai.module";
import { ReversiModule } from "./modules/reversi/reversi.module";
import { SastanciModule } from "./modules/sastanci/sastanci.module";
import { AiChatModule } from "./modules/ai-chat/ai-chat.module";
import { MediaAiModule } from "./modules/media-ai/media-ai.module";
import { PlanMontazeModule } from "./modules/plan-montaze/plan-montaze.module";
import { PlanProizvodnjeModule } from "./modules/plan-proizvodnje/plan-proizvodnje.module";
import { PracenjeModule } from "./modules/pracenje/pracenje.module";
import { ProjektniBiroModule } from "./modules/projektni-biro/projektni-biro.module";
import { MojProfilModule } from "./modules/moj-profil/moj-profil.module";
import { PodesavanjaModule } from "./modules/podesavanja/podesavanja.module";
import { OdrzavanjeModule } from "./modules/odrzavanje/odrzavanje.module";
import { EnergetikaModule } from "./modules/energetika/energetika.module";
import { LocationsModule } from "./modules/locations/locations.module";
import { KadrovskaModule } from "./modules/kadrovska/kadrovska.module";
import { NabavkaModule } from "./modules/nabavka/nabavka.module";
import { ProjectsWriteModule } from "./modules/projects-write/projects-write.module";
import { PostingModule } from "./modules/gl/posting/posting.module";
import { RobnoModule } from "./modules/robno/robno.module";
import { SaldakontiModule } from "./modules/saldakonti/saldakonti.module";
import { IzvodiModule } from "./modules/izvodi/izvodi.module";
import { PlacanjaModule } from "./modules/placanja/placanja.module";
import { SalesModule } from "./modules/sales/sales.module";
import { SefModule } from "./modules/sales/sef/sef.module";
import { SalesPrintModule } from "./modules/sales/print/sales-print.module";
import { PdvModule } from "./modules/pdv/pdv.module";
import { ZavrsniModule } from "./modules/zavrsni/zavrsni.module";
import { GlModule } from "./modules/gl/gl.module";
import { ZahteviModule } from "./modules/zahtevi/zahtevi.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthzModule,
    MailModule,
    AuthModule,
    SyncModule,
    TechProcessesModule,
    WorkOrdersModule,
    LookupsModule,
    StructuresModule,
    PdmModule,
    DirectoryModule,
    HandoversModule,
    // Nabavka (4.0 Traka B — zahtev → upit dobavljaču → narudžbenica → prijem)
    NabavkaModule,
    // Predmeti write-path + RFQ kupca (4.0 Traka B — 2.0 master za predmete)
    ProjectsWriteModule,
    PartLocationsModule,
    CncProgramsModule,
    // Kontrola kvaliteta (K1 — evidencija škart/dorada; MODULE_SPEC_kontrola_kvaliteta §4/§7).
    QualityModule,
    MrpModule,
    NotificationsModule,
    // 3.0 pilot — podaci u sy15 (1.0) bazi (MODULE_SPEC_reversi.md §0)
    Sy15Module,
    // Zajednički AI provider (OpenAI/Anthropic) — Talas B; C/D/G reuse.
    AiModule,
    ReversiModule,
    // 3.0 TALAS B — Sastanci + AI asistent (MODULE_SPEC_sastanci_ai_30.md §0)
    SastanciModule,
    AiChatModule,
    // Zajednički media/AI (STT + refine) — presuda B4; C/D/G reuse.
    MediaAiModule,
    // 3.0 TALAS C — Plan montaže + Plan proizvodnje + Praćenje (MODULE_SPEC_planovi_pracenje_30.md §0)
    PlanMontazeModule,
    PlanProizvodnjeModule,
    PracenjeModule,
    // 3.0 TALAS D — Projektni biro + Moj profil + Podešavanja/RBAC
    // (MODULE_SPEC_pb_profil_podesavanja_30.md §3; R1 = read sloj).
    ProjektniBiroModule,
    MojProfilModule,
    PodesavanjaModule,
    // 3.0 TALAS F — Održavanje (CMMS) read sloj (MODULE_SPEC_odrzavanje_30.md §0)
    OdrzavanjeModule,
    // 3.0 Talas E — Energetika/SCADA read sloj (MODULE_SPEC_scada_30.md §3)
    EnergetikaModule,
    // 3.0 Talas A — Lokacije delova (loc_*; MODULE_SPEC_lokacije_30.md §0)
    LocationsModule,
    // 3.0 TALAS G — Kadrovska/HR (MODULE_SPEC_kadrovska_30.md §0); PII + zarade.
    KadrovskaModule,
    // 4.0 Faza 3 — Robno/magacin (kalkulacija landed cost + nivelacija/uprosečavanje, doc 39).
    RobnoModule,
    // 4.0 Faza 2/3 — GL auto-kontiranje robnog dokumenta (StockDocument → nalog GK).
    PostingModule,
    // 4.0 Faza 4 — Saldakonti (otvorene stavke/aging/reconcile/kompenzacija),
    // Izvodi (TXT import → auto-knjiženje), Priprema plaćanja (virmani + FX TXT export).
    SaldakontiModule,
    IzvodiModule,
    PlacanjaModule,
    // 4.0 Faza 5 — Fakturisanje (izlazni računi PROF→IFR + knjiženje), SEF e-fakture (UBL), štampa/mail.
    SalesModule,
    SefModule,
    SalesPrintModule,
    // 4.0 Faza 2 — Glavna knjiga READ (dnevnik naloga + kartica konta).
    GlModule,
    // 4.0 Faza 6 — PDV / POPDV / KEPU (obračun iz glavne knjige, KIF/KUF).
    PdvModule,
    // 4.0 Faza 7 — Završni račun / bilansi (GKEval formule nad saldima konta).
    ZavrsniModule,
    // Zahtevi — AI PM modul (bug/dorada/nova funkcija + AI trijaža + Decision Log +
    // nagrađivanje; MODULE_SPEC_zahtevi §0). Platformski modul, nezavisan od 4.0 talasa.
    ZahteviModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Globalni audit mutacija -> audit_log (BACKEND_RULES §8).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Read-only (test) nalozi: mutacije -> 403 (AUTHZ_READONLY_USER_IDS).
    // Registrovan POSLE audita = unutrašnji, pa blokirani pokušaj ne ulazi u audit_log.
    { provide: APP_INTERCEPTOR, useClass: ReadOnlyInterceptor },
  ],
})
export class AppModule {}
