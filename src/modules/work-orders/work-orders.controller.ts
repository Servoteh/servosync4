import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WorkOrdersService } from "./work-orders.service";
import type { ListWorkOrdersQuery } from "./work-orders.service";

/**
 * Read-only API for work orders (Radni nalozi / RN).
 *   GET /api/v1/work-orders        — paginated list (+ q / status filter)
 *   GET /api/v1/work-orders/:id    — single RN with operations, worker, quality/handover status
 *
 * Requires a valid JWT. Mutations (launch/approve/…) come later under RBAC.
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "work-orders", version: "1" })
export class WorkOrdersController {
  constructor(private readonly workOrders: WorkOrdersService) {}

  @Get()
  list(@Query() query: ListWorkOrdersQuery) {
    return this.workOrders.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.findOne(id);
  }
}
