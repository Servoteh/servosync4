import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { WorkOrdersController } from "./work-orders.controller";
import { WorkOrdersService } from "./work-orders.service";
import { WorkOrderNumberingService } from "./work-order-numbering.service";

@Module({
  imports: [PrismaModule],
  controllers: [WorkOrdersController],
  providers: [WorkOrdersService, WorkOrderNumberingService],
})
export class WorkOrdersModule {}
