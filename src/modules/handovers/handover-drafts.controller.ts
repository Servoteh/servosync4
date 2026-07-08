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
import { HandoverDraftsService } from "./handover-drafts.service";
import type { ListHandoverDraftsQuery } from "./handover-drafts.service";
import type { CreateHandoverDraftDto } from "./dto/create-handover-draft.dto";
import type { UpdateHandoverDraftDto } from "./dto/update-handover-draft.dto";

/**
 * Nacrti primopredaje (`handover_drafts`) — MODULE_SPEC_nacrti_primopredaje §6.1/§6.2.
 *   GET    /api/v1/handover-drafts            — lista (q, statusId, designerId, projectId, isLocked, from, to)
 *   GET    /api/v1/handover-drafts/:id        — detalj (zaglavlje + stavke)
 *   GET    /api/v1/handover-drafts/:id/items  — samo stavke
 *   POST   /api/v1/handover-drafts            — kreiranje (zaglavlje + stavke), broj generiše server
 *   PATCH  /api/v1/handover-drafts/:id        — izmena zaglavlja (samo dok nije zaključan)
 *   DELETE /api/v1/handover-drafts/:id        — brisanje (samo dok nije zaključan; hard delete — vidi servis)
 *
 * Ovaj talas: samo osnovni unos — BEZ BOM auto-populate wizarda, BEZ item-level
 * POST/PATCH/DELETE endpointa i BEZ `/submit` (predaja u primopredaju) — van skopa zadatka.
 * Traži JWT; read=PRIMOPREDAJE_READ, mutacije=PRIMOPREDAJE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRIMOPREDAJE_READ)
@Controller({ path: "handover-drafts", version: "1" })
export class HandoverDraftsController {
  constructor(private readonly drafts: HandoverDraftsService) {}

  @Get()
  list(@Query() query: ListHandoverDraftsQuery) {
    return this.drafts.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.drafts.findOne(id);
  }

  @Get(":id/items")
  listItems(@Param("id", ParseIntPipe) id: number) {
    return this.drafts.listItems(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_WRITE)
  create(@Body() dto: CreateHandoverDraftDto) {
    return this.drafts.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateHandoverDraftDto,
  ) {
    return this.drafts.update(id, dto);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.drafts.remove(id);
  }
}
