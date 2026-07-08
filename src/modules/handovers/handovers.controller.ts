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
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { HandoversService } from "./handovers.service";
import type { ListHandoversQuery } from "./handovers.service";
import type { RejectHandoverDto } from "./dto/reject-handover.dto";
import type { LaunchHandoverDto } from "./dto/launch-handover.dto";

/**
 * Primopredaje crteža (`drawing_handovers`) — MODULE_SPEC_nacrti_primopredaje §6.4/§6.5.
 *   GET  /api/v1/handovers                  — lista (statusId, drawingNumber, projectId, from, to)
 *   GET  /api/v1/handovers/lookups          — draft statusi + handover statusi
 *   GET  /api/v1/handovers/technologists    — radnici sa defines_approval=true (id/fullName/username)
 *   GET  /api/v1/handovers/pending-approval — tehnolog inbox (status U OBRADI / na čekanju)
 *   GET  /api/v1/handovers/:id              — detalj
 *   POST /api/v1/handovers/:id/approve      { comment? }         — odobri (U OBRADI → SAGLASAN)
 *   POST /api/v1/handovers/:id/reject       { reason }           — odbij (U OBRADI → ODBIJENO); reason OBAVEZAN
 *   POST /api/v1/handovers/:id/launch       { comment?, dueDate? } — lansiraj (SAGLASAN → LANSIRAN), kreira work_orders red
 *
 * Kreiranje `drawing_handovers` redova (predaja nacrta u primopredaju) je na
 * `POST /handover-drafts/:id/submit` — vidi handover-drafts.controller.ts. Traži JWT;
 * read=PRIMOPREDAJE_READ, approve/reject/launch=PRIMOPREDAJE_APPROVE (V1 no-op guard).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRIMOPREDAJE_READ)
@Controller({ path: "handovers", version: "1" })
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Get("lookups")
  lookups() {
    return this.handovers.lookups();
  }

  @Get("technologists")
  technologists() {
    return this.handovers.technologists();
  }

  @Get("pending-approval")
  pendingApproval(@Query() query: ListHandoversQuery) {
    return this.handovers.pendingApproval(query);
  }

  @Get()
  list(@Query() query: ListHandoversQuery) {
    return this.handovers.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.handovers.findOne(id);
  }

  @Post(":id/approve")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { comment?: string },
  ) {
    return this.handovers.approve(id, body?.comment);
  }

  @Post(":id/reject")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  reject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RejectHandoverDto,
  ) {
    return this.handovers.reject(id, dto?.reason);
  }

  @Post(":id/launch")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  launch(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: LaunchHandoverDto,
  ) {
    return this.handovers.launch(id, dto);
  }
}
