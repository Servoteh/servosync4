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
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { HandoverDraftsService } from "./handover-drafts.service";
import type { ListHandoverDraftsQuery } from "./handover-drafts.service";
import { PrintBundleService } from "./print-bundle.service";
import type { PrintBundleQuery } from "./print-bundle.service";
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
 *   POST   /api/v1/handover-drafts/:id/submit — predaja u primopredaju (§6.3): zaključa nacrt i kreira drawing_handovers redove
 *   GET    /api/v1/handover-drafts/:id/print-bundle     — P3: crteži za štampu (hasPdf/sizeKb/pageFormat + grupe po formatu)
 *   GET    /api/v1/handover-drafts/:id/print-bundle/pdf — P3: JEDAN spojen PDF (?format=A4 ILI ?drawingIds=1,2,3; bez oba = svi)
 *
 * Ovaj talas: osnovni unos + submit — BEZ BOM auto-populate wizarda i BEZ
 * item-level POST/PATCH/DELETE endpointa (van skopa zadatka).
 * Traži JWT; read=PRIMOPREDAJE_READ, mutacije=PRIMOPREDAJE_WRITE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRIMOPREDAJE_READ)
@Controller({ path: "handover-drafts", version: "1" })
export class HandoverDraftsController {
  constructor(
    private readonly drafts: HandoverDraftsService,
    private readonly printing: PrintBundleService,
  ) {}

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

  /** P3: pregled crteža nacrta za štampu — hasPdf/sizeKb/pageFormat + grupe po formatu (za izbor štampača). */
  @Get(":id/print-bundle")
  printBundle(@Param("id", ParseIntPipe) id: number) {
    return this.printing.draftBundle(id);
  }

  /** P3: jedan spojen PDF crteža nacrta (?format=A4 ILI ?drawingIds=1,2,3) — browser print dijalog bira štampač. */
  @Get(":id/print-bundle/pdf")
  async printBundlePdf(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PrintBundleQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.printing.draftBundlePdf(id, query);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
    });
    return new StreamableFile(buffer);
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

  @Post(":id/submit")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_WRITE)
  submit(@Param("id", ParseIntPipe) id: number) {
    return this.drafts.submit(id);
  }
}
