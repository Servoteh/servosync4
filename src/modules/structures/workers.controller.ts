import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { WorkersService } from "./workers.service";
import type { ListWorkersQuery } from "./workers.service";
import type { CreateWorkerDto, UpdateWorkerDto } from "./dto/worker.dto";

/**
 * Radnici — šifarnik (MODULE_SPEC_structures §6.1).
 *   GET   /api/v1/structures/workers               — lista (q, workUnitCode, workerTypeId, active)
 *   GET   /api/v1/structures/workers/:id           — detalj + machineAccess
 *   POST  /api/v1/structures/workers               — kreiranje
 *   PATCH /api/v1/structures/workers/:id           — izmena
 *   POST  /api/v1/structures/workers/:id/deactivate — soft delete (active=false)
 *
 * NIKAD ne vraća/prima `password` / `workerPassword` (spec §5.5).
 * Traži JWT; read=STRUKTURE_READ, mutacije=STRUKTURE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STRUKTURE_READ)
@Controller({ path: "structures/workers", version: "1" })
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Get()
  list(@Query() query: ListWorkersQuery) {
    return this.workers.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.workers.findOne(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  create(@Body() dto: CreateWorkerDto) {
    return this.workers.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateWorkerDto) {
    return this.workers.update(id, dto);
  }

  @Post(":id/deactivate")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  deactivate(@Param("id", ParseIntPipe) id: number) {
    return this.workers.deactivate(id);
  }
}
