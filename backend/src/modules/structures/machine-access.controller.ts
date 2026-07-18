import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { MachineAccessService } from "./machine-access.service";
import type { ListMachineAccessQuery } from "./machine-access.service";
import type {
  BatchMachineAccessDto,
  CreateMachineAccessDto,
} from "./dto/machine-access.dto";

/**
 * Matrica radnik × mašina (MODULE_SPEC_structures §6.5).
 *   GET    /api/v1/structures/machine-access        — lista (workerId, workCenterCode)
 *   POST   /api/v1/structures/machine-access        — dodaj par (409 na duplikat)
 *   POST   /api/v1/structures/machine-access/batch  — atomarno {workerId, add[], remove[]}
 *   DELETE /api/v1/structures/machine-access/:id    — ukloni par
 *
 * Traži JWT; read=STRUKTURE_READ, mutacije=STRUKTURE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STRUKTURE_READ)
@Controller({ path: "structures/machine-access", version: "1" })
export class MachineAccessController {
  constructor(private readonly machineAccess: MachineAccessService) {}

  @Get()
  list(@Query() query: ListMachineAccessQuery) {
    return this.machineAccess.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  create(@Body() dto: CreateMachineAccessDto) {
    return this.machineAccess.create(dto);
  }

  @Post("batch")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  batch(@Body() dto: BatchMachineAccessDto) {
    return this.machineAccess.batch(dto);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.machineAccess.remove(id);
  }
}
