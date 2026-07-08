import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { OperationsService } from "./operations.service";
import type { ListOperationsQuery } from "./operations.service";
import type {
  CreateOperationDto,
  UpdateOperationDto,
} from "./dto/operation.dto";

/**
 * Operacije — šifarnik (MODULE_SPEC_structures §6.3). Prirodni ključ = workCenterCode.
 *   GET    /api/v1/structures/operations                     — lista (q, workUnitCode)
 *   POST   /api/v1/structures/operations                     — kreiranje (409 na duplu šifru)
 *   PATCH  /api/v1/structures/operations/:workCenterCode     — izmena (4 flag polja + naziv/RJ/napomena)
 *   DELETE /api/v1/structures/operations/:workCenterCode     — brisanje (409 ako je referencirana)
 *
 * Traži JWT; read=STRUKTURE_READ, mutacije=STRUKTURE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.STRUKTURE_READ)
@Controller({ path: "structures/operations", version: "1" })
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get()
  list(@Query() query: ListOperationsQuery) {
    return this.operations.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  create(@Body() dto: CreateOperationDto) {
    return this.operations.create(dto);
  }

  @Patch(":workCenterCode")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  update(
    @Param("workCenterCode") workCenterCode: string,
    @Body() dto: UpdateOperationDto,
  ) {
    return this.operations.update(workCenterCode, dto);
  }

  @Delete(":workCenterCode")
  @RequirePermission(PERMISSIONS.STRUKTURE_WRITE)
  remove(@Param("workCenterCode") workCenterCode: string) {
    return this.operations.remove(workCenterCode);
  }
}
