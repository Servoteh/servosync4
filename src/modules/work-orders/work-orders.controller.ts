import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { WorkOrdersService } from "./work-orders.service";
import type { ListWorkOrdersQuery } from "./work-orders.service";
import type { CreateWorkOrderDto } from "./dto/create-work-order.dto";

/**
 * API za radne naloge (Radni nalozi / RN).
 *   GET  /api/v1/work-orders            — lista (filteri: q, statusId, projectId, workerId, customerId, from, to)
 *   GET  /api/v1/work-orders/:id        — detalj (operacije, sve stavke, odobravanja, lansiranja)
 *   POST /api/v1/work-orders            — kreiranje (ručno; server generiše broj)
 *   POST /api/v1/work-orders/:id/approve  { approve?: boolean }  — odobri/odbij
 *   POST /api/v1/work-orders/:id/launch                          — lansiraj (mora biti saglasan)
 *   POST /api/v1/work-orders/:id/lock     { locked?: boolean }   — zaključaj/otključaj
 *
 * Traži JWT. RBAC (ko sme odobri/lansiraj) je V2 — vidi TODO(auth) u servisu.
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

  @Post()
  create(@Body() dto: CreateWorkOrderDto) {
    return this.workOrders.create(dto);
  }

  @Post(":id/approve")
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { approve?: boolean },
  ) {
    return this.workOrders.approve(id, body?.approve !== false);
  }

  @Post(":id/launch")
  launch(@Param("id", ParseIntPipe) id: number) {
    return this.workOrders.launch(id);
  }

  @Post(":id/lock")
  lock(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { locked?: boolean },
  ) {
    return this.workOrders.setLock(id, body?.locked !== false);
  }
}
