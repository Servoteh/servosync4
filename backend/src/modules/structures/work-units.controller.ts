import {
  Body,
  Controller,
  Delete,
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
import { WorkUnitsService } from "./work-units.service";
import type { ListWorkUnitsQuery } from "./work-units.service";
import type { CreateWorkUnitDto, UpdateWorkUnitDto } from "./dto/work-unit.dto";

/**
 * Radne jedinice — šifarnik (MODULE_SPEC_structures §6.2).
 *   GET    /api/v1/structures/work-units      — lista (q)
 *   POST   /api/v1/structures/work-units      — kreiranje
 *   PATCH  /api/v1/structures/work-units/:id  — izmena
 *   DELETE /api/v1/structures/work-units/:id  — brisanje (409: code="0" ili referencirana)
 *
 * Traži JWT; read=STRUKTURE_READ, mutacije=STRUKTURE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STRUKTURE_READ)
@Controller({ path: "structures/work-units", version: "1" })
export class WorkUnitsController {
  constructor(private readonly workUnits: WorkUnitsService) {}

  @Get()
  list(@Query() query: ListWorkUnitsQuery) {
    return this.workUnits.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  create(@Body() dto: CreateWorkUnitDto) {
    return this.workUnits.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateWorkUnitDto,
  ) {
    return this.workUnits.update(id, dto);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.workUnits.remove(id);
  }
}
