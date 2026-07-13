import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrintingModule } from "../../common/printing/printing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";

@Module({
  // NotificationsModule: D8 emit — control() šalje in-app notifikaciju za doradu/škart.
  // PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print.
  imports: [PrismaModule, NotificationsModule, PrintingModule],
  controllers: [TechProcessesController],
  providers: [TechProcessesService],
})
export class TechProcessesModule {}
