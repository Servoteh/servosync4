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
import { PositionsService } from "./positions.service";
import type { ListPositionsQuery } from "./positions.service";
import type { CreatePositionDto, UpdatePositionDto } from "./dto/position.dto";

/**
 * Pozicije/police (MODULE_SPEC_lokacije §1/§5, Was: tPozicije) — CRUD šifarnik.
 *   GET   /api/v1/positions      — lista (q — šifra/opis; paginacija)
 *   POST  /api/v1/positions      — kreiranje
 *   PATCH /api/v1/positions/:id  — izmena
 *
 * Traži JWT; read=LOKACIJE_READ, mutacije=LOKACIJE_WRITE (V1 no-op guard, V2 aktivacija).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.LOKACIJE_READ)
@Controller({ path: "positions", version: "1" })
export class PositionsController {
  constructor(private readonly positions: PositionsService) {}

  @Get()
  list(@Query() query: ListPositionsQuery) {
    return this.positions.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.LOKACIJE_WRITE)
  create(@Body() dto: CreatePositionDto) {
    return this.positions.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.LOKACIJE_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.positions.update(id, dto);
  }
}
