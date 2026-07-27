import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { DocumentsModule } from "../documents/documents.module";
import { LaunchNotifyModule } from "../handovers/launch-notify.module";
import { WorkOrdersController } from "./work-orders.controller";
import { WorkOrdersService } from "./work-orders.service";
import { WorkOrderNumberingService } from "./work-order-numbering.service";
import { WorkOrderPrintService } from "./work-order-print.service";
import { TimeEstimateController } from "./time-estimate.controller";
import { TimeEstimateService } from "./time-estimate.service";
import { TechnologySuggestController } from "./technology-suggest.controller";
import { TechnologySuggestService } from "./technology-suggest.service";

// LaunchNotifyModule (016/26 dopuna): launch() RN-a nastalog iz primopredaje šalje
// isto obaveštenje planerima kao i handovers.launch. Uvezen je MINI-modul, ne ceo
// HandoversModule — zavisnost ostaje jednosmerna (nema cirkularnog import-a).
@Module({
  imports: [PrismaModule, DocumentsModule, LaunchNotifyModule],
  controllers: [
    WorkOrdersController,
    TimeEstimateController,
    TechnologySuggestController,
  ],
  providers: [
    WorkOrdersService,
    WorkOrderNumberingService,
    WorkOrderPrintService,
    // TALAS AI-5: statistička procena vremena po radnom mestu (read-only).
    TimeEstimateService,
    // TALAS AI-6: predlog tehnologije iz istorije crteža (read-only, draft).
    TechnologySuggestService,
  ],
  // Exportovan za TechProcessesModule: control() kreira child RN (-S/-D) preko
  // WorkOrdersService.createQualityChildOrder (batch5, Nenad 16.07).
  exports: [WorkOrdersService],
})
export class WorkOrdersModule {}
