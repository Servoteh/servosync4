import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
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
import { PracenjeService } from "./pracenje.service";
import { PracenjeReadService } from "./pracenje-read.service";
import { PracenjeAkcijeSy15Service } from "./pracenje-akcije-sy15.service";
import { PracenjePdfService } from "./pracenje-pdf.service";
import {
  AkcioneTackeQueryDto,
  CanEditQueryDto,
  IzvestajQueryDto,
  OperativniPlanQueryDto,
  PortfolioQueryDto,
  PrijaveQueryDto,
  RnResolveQueryDto,
  SearchDeloviQueryDto,
} from "./dto/pracenje-query.dto";
import {
  BlokirajAktivnostDto,
  EnsureRnDto,
  ExportLogDto,
  OdblokirajAktivnostDto,
  PracenjeManualOverrideDto,
  PracenjeNapomenaDto,
  PracenjeParentOverrideDto,
  PrioritetShiftDto,
  PromoteAkcionaTackaDto,
  SetPlanPrioritetDto,
  UpsertAktivnostDto,
  ZatvoriAktivnostDto,
} from "./dto/pracenje-mutation.dto";
import { BigtehnDrawingSignQueryDto } from "../plan-proizvodnje/dto/plan-proizvodnje-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Praćenje proizvodnje — F1 (docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md). Reads
 * (`PracenjeReadService`) and mutations (`PracenjeService`) both sit on the ORIGINAL
 * 2.0 tables. The ONLY sy15 touch left is `akcione-tacke` (quarantined in
 * `PracenjeAkcijeSy15Service`). Class permission: `pracenje.read`; writes escalate
 * per-method (edit / manage / prioritet).
 *
 * ⚠️ RN id AND activity id are Int (`work_orders.id` / `operativne_aktivnosti.id`) —
 * every `:id`/`:rnId`/`:itemId` route uses `ParseIntPipe` (no more uuid pipes).
 *
 * ⚠️ Route ordering: literals (`rn/resolve`, `rn/ensure-from-bigtehn`, `aktivnosti/promote`,
 * `lookups/*`, `search-delovi`, `plan-prioritet`, `crtez/sign`, `export-log`) before `:param`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRACENJE_READ)
@Controller({ path: "pracenje", version: "1" })
export class PracenjeController {
  constructor(
    private readonly read: PracenjeReadService,
    private readonly pracenje: PracenjeService,
    private readonly akcije: PracenjeAkcijeSy15Service,
    private readonly pdf: PracenjePdfService,
  ) {}

  // ---------- Portfolio / predmeti (read — 2.0) ----------

  @Get("portfolio")
  portfolio(@Req() req: AuthedRequest, @Query() q: PortfolioQueryDto) {
    return this.read.portfolio(req.user.email, q);
  }

  @Get("predmeti")
  predmeti(@Req() req: AuthedRequest) {
    return this.read.predmeti(req.user.email);
  }

  @Get("predmeti/:itemId/podsklopovi")
  podsklopovi(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
  ) {
    return this.read.podsklopovi(req.user.email, itemId);
  }

  @Get("predmeti/:itemId/izvestaj")
  izvestaj(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Query() q: IzvestajQueryDto,
  ) {
    return this.read.izvestaj(req.user.email, itemId, q);
  }

  // Tabela praćenja mutacije (2.0 pracenje_notes / pracenje_overrides).
  @Put("predmeti/:itemId/napomena")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  napomena(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PracenjeNapomenaDto,
  ) {
    return this.pracenje.upsertNapomena(req.user, itemId, dto);
  }

  @Put("predmeti/:itemId/override")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  override(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) _itemId: number,
    @Body() dto: PracenjeManualOverrideDto,
  ) {
    return this.pracenje.upsertManualOverride(req.user, dto);
  }

  @Put("predmeti/:itemId/parent-override")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  parentOverride(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) _itemId: number,
    @Body() dto: PracenjeParentOverrideDto,
  ) {
    return this.pracenje.upsertParentOverride(req.user, dto);
  }

  @Put("predmeti/:itemId/prioritet")
  @RequirePermission(PERMISSIONS.PRACENJE_PRIORITET)
  prioritet(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PrioritetShiftDto,
  ) {
    return this.pracenje.shiftPrioritet(req.user, itemId, dto.direction);
  }

  // ---------- RN (read + ensure — 2.0) ----------

  @Get("rn/resolve")
  rnResolve(@Req() req: AuthedRequest, @Query() q: RnResolveQueryDto) {
    return this.read.rnResolve(req.user.email, q.ref);
  }

  @Post("rn/ensure-from-bigtehn")
  ensureRn(@Req() _req: AuthedRequest, @Body() dto: EnsureRnDto) {
    return this.read.ensureRnFromBigtehn(dto.workOrderId);
  }

  @Get("rn/:rnId")
  rn(@Req() req: AuthedRequest, @Param("rnId", ParseIntPipe) rnId: number) {
    return this.read.rn(req.user.email, rnId);
  }

  @Get("rn/:rnId/operativni-plan")
  operativniPlan(
    @Req() req: AuthedRequest,
    @Param("rnId", ParseIntPipe) rnId: number,
    @Query() q: OperativniPlanQueryDto,
  ) {
    return this.read.operativniPlan(req.user.email, rnId, q);
  }

  @Get("rn/:rnId/can-edit")
  canEdit(
    @Req() req: AuthedRequest,
    @Param("rnId", ParseIntPipe) rnId: number,
    @Query() _q: CanEditQueryDto,
  ) {
    return this.read.canEdit(req.user, rnId);
  }

  // ---------- Operativni plan — aktivnosti (edit — 2.0) ----------

  // Promote: 501 dok se Sastanci/akcioni-plan ne preseli na 2.0 (PracenjeService).
  @Post("aktivnosti/promote")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  promote(@Req() req: AuthedRequest, @Body() dto: PromoteAkcionaTackaDto) {
    return this.pracenje.promoteAkcionaTacka(req.user, dto);
  }

  @Post("aktivnosti")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  createAktivnost(@Req() req: AuthedRequest, @Body() dto: UpsertAktivnostDto) {
    return this.pracenje.upsertAktivnost(req.user, dto);
  }

  @Post("aktivnosti/:id/zatvori")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  zatvori(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ZatvoriAktivnostDto,
  ) {
    return this.pracenje.zatvoriAktivnost(req.user, id, dto);
  }

  @Post("aktivnosti/:id/blokiraj")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  blokiraj(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: BlokirajAktivnostDto,
  ) {
    return this.pracenje.blokirajAktivnost(req.user, id, dto);
  }

  @Post("aktivnosti/:id/odblokiraj")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  odblokiraj(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: OdblokirajAktivnostDto,
  ) {
    return this.pracenje.odblokirajAktivnost(req.user, id, dto);
  }

  // Istorija aktivnosti (read — 2.0). Blokade svima; audit deo je admin-only.
  @Get("aktivnosti/:id/istorija")
  aktivnostIstorija(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.read.aktivnostIstorija(req.user, id);
  }

  // ---------- Prijave / lookups / pretraga (read) ----------

  @Get("prijave")
  prijave(@Req() req: AuthedRequest, @Query() q: PrijaveQueryDto) {
    return this.read.prijave(req.user.email, q);
  }

  @Get("lookups/odeljenja")
  odeljenja(@Req() req: AuthedRequest) {
    return this.read.odeljenja(req.user.email);
  }

  @Get("lookups/radnici")
  radnici(@Req() req: AuthedRequest) {
    return this.read.radnici(req.user.email);
  }

  // Akcione tačke — JEDINI preostali sy15 lookup (v_akcioni_plan), izolovan u
  // PracenjeAkcijeSy15Service. Gasi se kad akcioni-plan/sastanci pređe na 2.0.
  @Get("lookups/akcione-tacke")
  akcioneTacke(@Req() req: AuthedRequest, @Query() q: AkcioneTackeQueryDto) {
    return this.akcije.akcioneTacke(req.user.email, q);
  }

  @Get("search-delovi")
  searchDelovi(@Req() req: AuthedRequest, @Query() q: SearchDeloviQueryDto) {
    return this.read.searchDelovi(req.user.email, q.q);
  }

  @Get("plan-prioritet")
  planPrioritet(@Req() req: AuthedRequest) {
    return this.read.planPrioritet(req.user.email);
  }

  // ⭐ plan-prioritet setter (spec §7-P10): replace the whole list. `pracenje.manage`.
  @Put("plan-prioritet")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  setPlanPrioritet(
    @Req() req: AuthedRequest,
    @Body() dto: SetPlanPrioritetDto,
  ) {
    return this.pracenje.setPlanPrioritet(req.user, dto);
  }

  // Crtež PDF (RN side-panel) — 2.0 drawings/drawing_pdfs; BEZ gate-a (odluka O7).
  @Get("crtez/sign")
  crtezSign(@Req() req: AuthedRequest, @Query() q: BigtehnDrawingSignQueryDto) {
    return this.read.crtezSignUrl(req.user.email, q.code);
  }

  /**
   * Strim uskladištenog PDF-a crteža za praćenje. Gate = SAMO `pracenje.read`
   * (klasa) — BEZ `PDM_READ` / `can_read_production_drawings` (odluka O7: svi
   * prijavljeni u praćenju vide PDF). `crtezSignUrl` vraća baš ovaj path, pa se
   * link otvara `window.open`-om bez posebnog PDM prava. Čita 2.0
   * drawings/drawing_pdfs preko `PracenjePdfService` (404 ako nema PDF-a).
   */
  @Get("crtez/:drawingId/pdf/content")
  crtezPdf(
    @Param("drawingId", ParseIntPipe) drawingId: number,
    @Res({ passthrough: true }) res: Response,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    return this.pdf.streamDrawingPdf(drawingId, res, req.user);
  }

  // Izvoz-log (server-side → 2.0 audit_log).
  @Post("export-log")
  exportLog(@Req() req: AuthedRequest, @Body() dto: ExportLogDto) {
    return this.pracenje.logExport(req.user, dto);
  }
}
