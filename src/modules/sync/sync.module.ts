import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { MssqlClient } from "./mssql.client";
import { SyncController } from "./sync.controller";
import { SyncService } from "./sync.service";
import { CustomerSyncer } from "./syncers/customer.syncer";
import { HandoverDerivationSyncer } from "./syncers/handover-derivation.syncer";
import { DrawingHandoverPdfSyncer } from "./syncers/drawing-handover-pdf.syncer";
import { DrawingPlanItemSyncer } from "./syncers/drawing-plan-item.syncer";
import { WorkOrderApprovalSyncer } from "./syncers/work-order-approval.syncer";
import { WorkOrderBlankSyncer } from "./syncers/work-order-blank.syncer";
import { WorkOrderMachinedPartSyncer } from "./syncers/work-order-machined-part.syncer";
import { WorkOrderNonstandardPartSyncer } from "./syncers/work-order-nonstandard-part.syncer";

@Module({
  imports: [PrismaModule],
  controllers: [SyncController],
  providers: [
    MssqlClient,
    SyncService,
    CustomerSyncer,
    HandoverDerivationSyncer,
    // TEMPORARY §5.3 chain-item importers — deleted at cutover (spec §7.2).
    WorkOrderMachinedPartSyncer,
    WorkOrderBlankSyncer,
    WorkOrderNonstandardPartSyncer,
    WorkOrderApprovalSyncer,
    DrawingPlanItemSyncer,
    DrawingHandoverPdfSyncer,
  ],
  exports: [SyncService],
})
export class SyncModule {}
