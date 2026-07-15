import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrintingModule } from "../../common/printing/printing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PdmModule } from "../pdm/pdm.module";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";

@Module({
  // NotificationsModule: D8 emit — control() šalje in-app notifikaciju za doradu/škart.
  // PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print.
  // PdmModule: PdmService za kiosk PDF rutu (proizvodni_radnik nema PDM_READ).
  imports: [PrismaModule, NotificationsModule, PrintingModule, PdmModule],
  controllers: [TechProcessesController],
  providers: [TechProcessesService],
})
export class TechProcessesModule {}
