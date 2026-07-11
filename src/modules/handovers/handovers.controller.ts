import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { HandoversService } from "./handovers.service";
import type { ListHandoversQuery } from "./handovers.service";
import { PrintBundleService } from "./print-bundle.service";
import type { PrintBundleQuery } from "./print-bundle.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { ApproveHandoverDto } from "./dto/approve-handover.dto";
import type { RejectHandoverDto } from "./dto/reject-handover.dto";
import type { ReturnHandoverDto } from "./dto/return-handover.dto";
import type { LaunchHandoverDto } from "./dto/launch-handover.dto";

/**
 * Primopredaje crteža (`drawing_handovers`) — MODULE_SPEC_nacrti_primopredaje §6.4/§6.5.
 *   GET  /api/v1/handovers                  — lista (statusId, drawingNumber, projectId, technologistId, from, to)
 *   GET  /api/v1/handovers/lookups          — draft statusi + handover statusi
 *   GET  /api/v1/handovers/technologists    — aktivni radnici vrste "Tehnolog" (id/fullName/username; P4 §6.3)
 *   GET  /api/v1/handovers/pending-approval — tehnolog inbox (status U OBRADI / na čekanju)
 *   GET  /api/v1/handovers/:id              — detalj
 *   GET  /api/v1/handovers/:id/print-bundle     — P3: crtež te primopredaje za štampu (isti oblik kao na nacrtu)
 *   GET  /api/v1/handovers/:id/print-bundle/pdf — P3: PDF crteža te primopredaje (per-RN štampa)
 *   POST /api/v1/handovers/:id/approve            { technologistId, comment?, dueDate? } — odobri (U OBRADI → SAGLASAN) + dodeli tehnologa + rok izrade (§6.5.1)
 *   POST /api/v1/handovers/:id/reject             { reason }           — odbij (U OBRADI → ODBIJENO); reason OBAVEZAN
 *   POST /api/v1/handovers/:id/return-to-pending  { reason? }          — vrati na čekanje (SAGLASAN → U OBRADI, undo; 409 ako RN postoji)
 *   POST /api/v1/handovers/:id/take-over                               — "Preuzmi izradu" (§6.4): tehnolog preuzima zaduženje na SAGLASNOJ primopredaji
 *   POST /api/v1/handovers/:id/prepare-work-order                      — "Otkucaj TP": kreira RN bez lansiranja (idempotentno)
 *   POST /api/v1/handovers/:id/launch             { comment?, dueDate? } — lansiraj (SAGLASAN → LANSIRAN); reuse prepare RN-a ako postoji
 *
 * Kreiranje `drawing_handovers` redova (predaja nacrta u primopredaju) je na
 * `POST /handover-drafts/:id/submit` — vidi handover-drafts.controller.ts. Traži JWT;
 * read=PRIMOPREDAJE_READ; approve/reject/launch/return-to-pending=PRIMOPREDAJE_APPROVE
 * (undo odobravanja = ista težina kao approve — WRITE role, npr. kontrolor/menadžment,
 * ne smeju poništiti šefovo odobrenje); take-over=PRIMOPREDAJE_WRITE + servisni
 * worker-type gate „aktivan radnik vrste Tehnolog" (namerno NE nova permisija —
 * KONTROLOR/MENADZMENT imaju WRITE pa je drugi gate obavezan, §6.4);
 * prepare-work-order=RN_WRITE (kreira `work_orders` red — isti gate kao
 * POST /work-orders; kontrolor bez RN_WRITE ne sme ovuda da kreira RN).
 * Bez novih ključeva.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRIMOPREDAJE_READ)
@Controller({ path: "handovers", version: "1" })
export class HandoversController {
  constructor(
    private readonly handovers: HandoversService,
    private readonly printing: PrintBundleService,
  ) {}

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

  /** P3: bundle od JEDNOG crteža ove primopredaje — isti oblik odgovora kao na nacrtu (korisno za per-RN štampu). */
  @Get(":id/print-bundle")
  printBundle(@Param("id", ParseIntPipe) id: number) {
    return this.printing.handoverBundle(id);
  }

  /** P3: PDF crteža ove primopredaje (?format= / ?drawingIds= kao na nacrtu) — browser print dijalog bira štampač. */
  @Get(":id/print-bundle/pdf")
  async printBundlePdf(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: PrintBundleQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.printing.handoverBundlePdf(
      id,
      query,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
    });
    return new StreamableFile(buffer);
  }

  @Post(":id/approve")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ApproveHandoverDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.approve(id, dto, req.user);
  }

  @Post(":id/reject")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  reject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RejectHandoverDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.reject(id, dto?.reason, req.user);
  }

  /** "Vrati na čekanje" — undo odobravanja (ista težina kao approve); 409 ako RN već postoji. */
  @Post(":id/return-to-pending")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  returnToPending(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ReturnHandoverDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.returnToPending(id, dto, req.user);
  }

  /**
   * "Preuzmi izradu" (§6.4): aktivan radnik vrste "Tehnolog" preuzima zaduženje
   * na SAGLASNOJ, nezaključanoj, ne-legacy primopredaji (worker-type gate je u
   * servisu). Idempotentno: već moj → { alreadyOwner: true } bez upisa.
   */
  @Post(":id/take-over")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_WRITE)
  takeOver(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.takeOver(id, req.user);
  }

  /** "Otkucaj TP" — kreiraj RN bez lansiranja (idempotentno; primopredaja ostaje SAGLASAN). Kreira `work_orders` red → RN_WRITE. */
  @Post(":id/prepare-work-order")
  @RequirePermission(PERMISSIONS.RN_WRITE)
  prepareWorkOrder(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.prepareWorkOrder(id, req.user);
  }

  @Post(":id/launch")
  @RequirePermission(PERMISSIONS.PRIMOPREDAJE_APPROVE)
  launch(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: LaunchHandoverDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.handovers.launch(id, dto, req.user);
  }
}
