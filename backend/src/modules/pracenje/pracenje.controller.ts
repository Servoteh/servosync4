import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PracenjeService } from "./pracenje.service";
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
  UpsertAktivnostDto,
  ZatvoriAktivnostDto,
} from "./dto/pracenje-mutation.dto";
import { BigtehnDrawingSignQueryDto } from "../plan-proizvodnje/dto/plan-proizvodnje-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Praćenje proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Klasa: `pracenje.read` (paritet 1.0 router gate `canAccessPlanProizvodnje`). Write
 * eskalira per-metod: operativni plan (Tab2) = `pracenje.edit`; napomene/override-i =
 * `pracenje.manage`; ↑↓ prioritet = `pracenje.prioritet` (admin). Row-scope
 * (can_edit_pracenje/can_manage_predmet_aktivacija) presuđuje sy15 kroz `withUserRls`.
 *
 * ⚠️ Route ordering: literali (`rn/resolve`, `rn/ensure-from-bigtehn`, `aktivnosti/promote`,
 * `lookups/*`, `search-delovi`, `plan-prioritet`, `crtez/sign`, `export-log`) pre `:param`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRACENJE_READ)
@Controller({ path: "pracenje", version: "1" })
export class PracenjeController {
  constructor(private readonly pracenje: PracenjeService) {}

  // ---------- Portfolio / predmeti (read) ----------

  @Get("portfolio")
  portfolio(@Req() req: AuthedRequest, @Query() q: PortfolioQueryDto) {
    return this.pracenje.portfolio(req.user.email, q);
  }

  @Get("predmeti")
  predmeti(@Req() req: AuthedRequest) {
    return this.pracenje.predmeti(req.user.email);
  }

  @Get("predmeti/:itemId/podsklopovi")
  podsklopovi(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
  ) {
    return this.pracenje.podsklopovi(req.user.email, itemId);
  }

  @Get("predmeti/:itemId/izvestaj")
  izvestaj(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Query() q: IzvestajQueryDto,
  ) {
    return this.pracenje.izvestaj(req.user.email, itemId, q);
  }

  // Tabela praćenja mutacije (manage / prioritet)
  @Put("predmeti/:itemId/napomena")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  napomena(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PracenjeNapomenaDto,
  ) {
    return this.pracenje.upsertNapomena(req.user.email, itemId, dto);
  }

  @Put("predmeti/:itemId/override")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  override(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PracenjeManualOverrideDto,
  ) {
    return this.pracenje.upsertManualOverride(req.user.email, itemId, dto);
  }

  @Put("predmeti/:itemId/parent-override")
  @RequirePermission(PERMISSIONS.PRACENJE_MANAGE)
  parentOverride(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PracenjeParentOverrideDto,
  ) {
    return this.pracenje.upsertParentOverride(req.user.email, itemId, dto);
  }

  @Put("predmeti/:itemId/prioritet")
  @RequirePermission(PERMISSIONS.PRACENJE_PRIORITET)
  prioritet(
    @Req() req: AuthedRequest,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() dto: PrioritetShiftDto,
  ) {
    return this.pracenje.shiftPrioritet(req.user.email, itemId, dto.direction);
  }

  // ---------- RN (read + ensure) ----------

  @Get("rn/resolve")
  rnResolve(@Req() req: AuthedRequest, @Query() q: RnResolveQueryDto) {
    return this.pracenje.rnResolve(req.user.email, q.ref);
  }

  @Post("rn/ensure-from-bigtehn")
  ensureRn(@Req() req: AuthedRequest, @Body() dto: EnsureRnDto) {
    return this.pracenje.ensureRnFromBigtehn(req.user.email, dto);
  }

  @Get("rn/:rnId")
  rn(@Req() req: AuthedRequest, @Param("rnId", ParseUUIDPipe) rnId: string) {
    return this.pracenje.rn(req.user.email, rnId);
  }

  @Get("rn/:rnId/operativni-plan")
  operativniPlan(
    @Req() req: AuthedRequest,
    @Param("rnId", ParseUUIDPipe) rnId: string,
    @Query() q: OperativniPlanQueryDto,
  ) {
    return this.pracenje.operativniPlan(req.user.email, rnId, q);
  }

  @Get("rn/:rnId/can-edit")
  canEdit(
    @Req() req: AuthedRequest,
    @Param("rnId", ParseUUIDPipe) rnId: string,
    @Query() q: CanEditQueryDto,
  ) {
    return this.pracenje.canEdit(req.user.email, rnId, q.projekat);
  }

  // ---------- Operativni plan — aktivnosti (edit) ----------

  @Post("aktivnosti/promote")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  promote(@Req() req: AuthedRequest, @Body() dto: PromoteAkcionaTackaDto) {
    return this.pracenje.promoteAkcionaTacka(req.user.email, dto);
  }

  @Post("aktivnosti")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  createAktivnost(@Req() req: AuthedRequest, @Body() dto: UpsertAktivnostDto) {
    return this.pracenje.upsertAktivnost(req.user.email, dto);
  }

  @Post("aktivnosti/:id/zatvori")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  zatvori(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ZatvoriAktivnostDto,
  ) {
    return this.pracenje.zatvoriAktivnost(req.user.email, id, dto);
  }

  @Post("aktivnosti/:id/blokiraj")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  blokiraj(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: BlokirajAktivnostDto,
  ) {
    return this.pracenje.blokirajAktivnost(req.user.email, id, dto);
  }

  @Post("aktivnosti/:id/odblokiraj")
  @RequirePermission(PERMISSIONS.PRACENJE_EDIT)
  odblokiraj(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: OdblokirajAktivnostDto,
  ) {
    return this.pracenje.odblokirajAktivnost(req.user.email, id, dto);
  }

  @Get("aktivnosti/:id/istorija")
  aktivnostIstorija(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pracenje.aktivnostIstorija(req.user.email, id);
  }

  // ---------- Prijave / lookups / pretraga (read) ----------

  @Get("prijave")
  prijave(@Req() req: AuthedRequest, @Query() q: PrijaveQueryDto) {
    return this.pracenje.prijave(req.user.email, q);
  }

  @Get("lookups/odeljenja")
  odeljenja(@Req() req: AuthedRequest) {
    return this.pracenje.odeljenja(req.user.email);
  }

  @Get("lookups/radnici")
  radnici(@Req() req: AuthedRequest) {
    return this.pracenje.radnici(req.user.email);
  }

  @Get("lookups/akcione-tacke")
  akcioneTacke(@Req() req: AuthedRequest, @Query() q: AkcioneTackeQueryDto) {
    return this.pracenje.akcioneTacke(req.user.email, q);
  }

  @Get("search-delovi")
  searchDelovi(@Req() req: AuthedRequest, @Query() q: SearchDeloviQueryDto) {
    return this.pracenje.searchDelovi(req.user.email, q.q);
  }

  @Get("plan-prioritet")
  planPrioritet(@Req() req: AuthedRequest) {
    return this.pracenje.planPrioritet(req.user.email);
  }

  // Presigned bigtehn crtež (RN side-panel) — gate can_read_production_drawings (C3).
  @Get("crtez/sign")
  crtezSign(@Req() req: AuthedRequest, @Query() q: BigtehnDrawingSignQueryDto) {
    return this.pracenje.crtezSignUrl(req.user.email, q.code);
  }

  // Izvoz-log (server-side; presuda P4).
  @Post("export-log")
  exportLog(@Req() req: AuthedRequest, @Body() dto: ExportLogDto) {
    return this.pracenje.logExport(req.user.email, dto);
  }
}
