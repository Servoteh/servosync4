import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { PrismaModule } from "./prisma/prisma.module";
import { SyncModule } from "./modules/sync/sync.module";
import { AuthModule } from "./modules/auth/auth.module";
import { TechProcessesModule } from "./modules/tech-processes/tech-processes.module";
import { WorkOrdersModule } from "./modules/work-orders/work-orders.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    SyncModule,
    TechProcessesModule,
    WorkOrdersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
