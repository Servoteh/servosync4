import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { PrintingModule } from "../../common/printing/printing.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { PdmModule } from "../pdm/pdm.module";
import { QualityModule } from "../kvalitet/kvalitet.module";
import { WorkOrdersModule } from "../work-orders/work-orders.module";
import { TechProcessesController } from "./tech-processes.controller";
import { TechProcessesService } from "./tech-processes.service";

@Module({
  // NotificationsModule: D8 emit — control() šalje in-app notifikaciju za doradu/škart.
  // PrintingModule: deljeni RAW TSPL2 transport (LabelPrintService) za labels/print.
  // PdmModule: PdmService za kiosk PDF rutu (proizvodni_radnik nema PDM_READ).
  // QualityModule: K2 auto-draft — control() iz dorade/škarta kreira DRAFT neusaglašenosti.
  // WorkOrdersModule: A3 — control() dorade/škarta AUTOMATSKI kreira child RN (-D/-S)
  //   preko WorkOrdersService.createQualityChildOrder (WorkOrdersModule ga eksportuje).
  //   Nema cirkularne zavisnosti: WorkOrdersModule NE importuje TechProcessesModule.
  imports: [
    PrismaModule,
    NotificationsModule,
    PrintingModule,
    PdmModule,
    QualityModule,
    WorkOrdersModule,
  ],
  controllers: [TechProcessesController],
  providers: [TechProcessesService],
})
export class TechProcessesModule {}
