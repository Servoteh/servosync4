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
import { WorkerTypesService } from "./worker-types.service";
import type { ListWorkerTypesQuery } from "./worker-types.service";
import type {
  CreateWorkerTypeDto,
  UpdateWorkerTypeDto,
} from "./dto/worker-type.dto";

/**
 * Vrste poslova — šifarnik (MODULE_SPEC_structures §6.4).
 *   GET   /api/v1/structures/worker-types      — lista (q)
 *   POST  /api/v1/structures/worker-types      — kreiranje
 *   PATCH /api/v1/structures/worker-types/:id  — izmena
 *
 * Traži JWT; read=STRUKTURE_READ, mutacije=STRUKTURE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STRUKTURE_READ)
@Controller({ path: "structures/worker-types", version: "1" })
export class WorkerTypesController {
  constructor(private readonly workerTypes: WorkerTypesService) {}

  @Get()
  list(@Query() query: ListWorkerTypesQuery) {
    return this.workerTypes.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  create(@Body() dto: CreateWorkerTypeDto) {
    return this.workerTypes.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateWorkerTypeDto,
  ) {
    return this.workerTypes.update(id, dto);
  }
}
