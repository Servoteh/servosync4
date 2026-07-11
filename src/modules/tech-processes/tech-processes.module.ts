import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";

@Module({
  // NotificationsModule: D8 emit — control() šalje in-app notifikaciju za doradu/škart.
  imports: [PrismaModule, NotificationsModule],
  controllers: [TechProcessesController],
  providers: [TechProcessesService],
})
export class TechProcessesModule {}
