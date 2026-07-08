import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "./prisma/prisma.module";
import { AuditInterceptor } from "./common/audit/audit.interceptor";
import { SyncModule } from "./modules/sync/sync.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TechProcessesModule } from "./modules/tech-processes/tech-processes.module";
import { WorkOrdersModule } from "./modules/work-orders/work-orders.module";
import { LookupsModule } from "./modules/lookups/lookups.module";
import { StructuresModule } from "./modules/structures/structures.module";
import { PdmModule } from "./modules/pdm/pdm.module";
import { DirectoryModule } from "./modules/directory/directory.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    SyncModule,
    TechProcessesModule,
    WorkOrdersModule,
    LookupsModule,
    StructuresModule,
    PdmModule,
    DirectoryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Globalni audit mutacija -> audit_log (BACKEND_RULES §8).
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
