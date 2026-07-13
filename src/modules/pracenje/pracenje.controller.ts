import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
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

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Praćenje proizvodnje — 3.0 TALAS C, R1 read endpointi (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Klasa: `pracenje.read` (paritet 1.0 router gate `canAccessPlanProizvodnje` — modul
 * „Proizvodnja" nosi i Praćenje). Row-nivo (can_edit_pracenje project/rn-scope) presuđuje
 * sy15 RLS/DEFINER kroz `withUserRls`. Mutacije (aktivnosti/override/napomena/prioritet/
 * promocija) + ensure-from-bigtehn su R2 — ovde ih NEMA.
 *
 * ⚠️ Route ordering: literal rute (`rn/resolve`, `lookups/*`, `search-delovi`,
 * `plan-prioritet`) pre `rn/:rnId` i `predmeti/:itemId/*`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PRACENJE_READ)
@Controller({ path: "pracenje", version: "1" })
export class PracenjeController {
  constructor(private readonly pracenje: PracenjeService) {}

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

  // RN — literal rute pre :rnId
  @Get("rn/resolve")
  rnResolve(@Req() req: AuthedRequest, @Query() q: RnResolveQueryDto) {
    return this.pracenje.rnResolve(req.user.email, q.ref);
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

  @Get("aktivnosti/:id/istorija")
  aktivnostIstorija(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pracenje.aktivnostIstorija(req.user.email, id);
  }

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
}
