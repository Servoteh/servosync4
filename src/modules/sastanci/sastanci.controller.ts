import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { SastanciService } from "./sastanci.service";
import type {
  AkcijeQuery,
  ListSastanciQuery,
  TemeQuery,
} from "./sastanci.service";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Sastanci — 3.0 TALAS B, R1 read endpoints (MODULE_SPEC_sastanci_ai_30.md §3).
 * Klasa: `sastanci.read` (paritet 1.0 front gate `canAccessSastanci` — VIDLJIVOST menija;
 * row-nivo/organizator-trio/učesnik-scope OSTAJE u sy15 bazi kroz GUC most).
 * Mutacije + 13 front RPC + storage presigned + `/ai-summary` su R2 — ovde ih NEMA.
 *
 * ⚠️ Route ordering: sve LITERAL rute pre `:id` (inače bi `:id` uhvatio `/akcije` itd.).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.SASTANCI_READ)
@Controller({ path: "sastanci", version: "1" })
export class SastanciController {
  constructor(private readonly sastanci: SastanciService) {}

  // ---------- literal rute (pre :id) ----------

  @Get()
  list(@Req() req: AuthedRequest, @Query() query: ListSastanciQuery) {
    return this.sastanci.list(req.user.email, query);
  }

  @Get("my")
  my(@Req() req: AuthedRequest) {
    return this.sastanci.myMeetings(req.user.email);
  }

  @Get("next-weekly")
  nextWeekly(@Req() req: AuthedRequest) {
    return this.sastanci.nextWeekly(req.user.email);
  }

  @Get("search")
  search(@Req() req: AuthedRequest, @Query("q") q?: string) {
    return this.sastanci.search(req.user.email, q);
  }

  @Get("dashboard-stats")
  dashboardStats(@Req() req: AuthedRequest) {
    return this.sastanci.dashboardStats(req.user.email);
  }

  @Get("user-directory")
  userDirectory(@Req() req: AuthedRequest) {
    return this.sastanci.userDirectory(req.user.email);
  }

  @Get("weekly")
  weekly(@Req() req: AuthedRequest) {
    return this.sastanci.weeklyStatus(req.user.email);
  }

  @Get("prefs")
  prefs(@Req() req: AuthedRequest) {
    return this.sastanci.myPrefs(req.user.email);
  }

  @Get("notifications")
  notifications(
    @Req() req: AuthedRequest,
    @Query("sastanakId") sastanakId?: string,
  ) {
    return this.sastanci.notifications(req.user.email, sastanakId);
  }

  @Get("ai-model")
  aiModel(@Req() req: AuthedRequest) {
    return this.sastanci.aiModel(req.user.email);
  }

  // Akcioni plan — literal „akcije/*" pre :id-a
  @Get("akcije")
  akcije(@Req() req: AuthedRequest, @Query() query: AkcijeQuery) {
    return this.sastanci.listAkcije(req.user.email, query);
  }

  @Get("akcije/weekly-diff")
  akcijeWeeklyDiff(@Req() req: AuthedRequest) {
    return this.sastanci.akcijeWeeklyDiff(req.user.email);
  }

  @Get("akcije/:id/istorija")
  akcijaIstorija(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.akcijaIstorija(req.user.email, id);
  }

  // PM teme
  @Get("teme")
  teme(@Req() req: AuthedRequest, @Query() query: TemeQuery) {
    return this.sastanci.listTeme(req.user.email, query);
  }

  // Šabloni
  @Get("templates")
  templates(@Req() req: AuthedRequest) {
    return this.sastanci.listTemplates(req.user.email);
  }

  @Get("templates/:id")
  template(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.findTemplate(req.user.email, id);
  }

  // Arhiva (lista svih)
  @Get("arhive")
  arhive(@Req() req: AuthedRequest) {
    return this.sastanci.listArhive(req.user.email);
  }

  // ---------- :id rute (POSLEDNJE) ----------

  @Get(":id/full")
  full(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.findFull(req.user.email, id);
  }

  @Get(":id/ucesnici")
  ucesnici(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.ucesnici(req.user.email, id);
  }

  @Get(":id/aktivnosti")
  aktivnosti(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.aktivnosti(req.user.email, id);
  }

  @Get(":id/slike")
  slike(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.slike(req.user.email, id);
  }

  @Get(":id/odluke")
  odluke(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.odluke(req.user.email, id);
  }

  @Get(":id/arhiva")
  arhiva(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.findArhiva(req.user.email, id);
  }

  @Get(":id")
  one(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.findOne(req.user.email, id);
  }
}
