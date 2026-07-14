import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthzModule } from "./common/authz/authz.module";
import { MailModule } from "./common/mail/mail.module";
import { AuditInterceptor } from "./common/audit/audit.interceptor";
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
import { MrpModule } from "./modules/mrp/mrp.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { Sy15Module } from "./common/sy15/sy15.module";
import { AiModule } from "./common/ai/ai.module";
import { ReversiModule } from "./modules/reversi/reversi.module";
import { SastanciModule } from "./modules/sastanci/sastanci.module";
import { AiChatModule } from "./modules/ai-chat/ai-chat.module";
import { MediaAiModule } from "./modules/media-ai/media-ai.module";

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
    PartLocationsModule,
    CncProgramsModule,
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
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Globalni audit mutacija -> audit_log (BACKEND_RULES §8).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
