import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { ZahteviService } from "./zahtevi.service";
import { ZahteviAiService } from "./zahtevi-ai.service";
import { ZahteviRewardsService } from "./zahtevi-rewards.service";
import { ZahteviDecisionsService } from "./zahtevi-decisions.service";
import type { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import type { UpdateChangeRequestDto } from "./dto/update-change-request.dto";
import type { DecisionDto } from "./dto/decision.dto";
import type { StatusDto } from "./dto/status.dto";
import type { ScoreDto, ExcludeDto } from "./dto/score.dto";
import type { TariffPutDto } from "./dto/tariff.dto";
import type {
  CreateDecisionLogDto,
  UpdateDecisionLogDto,
  SupersedeDecisionLogDto,
} from "./dto/decision-log.dto";

/**
 * Zahtevi — AI PM modul (MODULE_SPEC_zahtevi §7). Guard = JwtAuthGuard + PermissionsGuard;
 * klasni default `zahtevi.read`, per-endpoint override (write/admin). Row-scope (ne-admin
 * vidi SAMO svoje) sprovodi SERVIS kroz prosleđen AuthUser.
 *
 * F1 obim: CRUD, status mašina, prilozi (STT), komentari, events, decision/status, slicni.
 * F3 (AI): retriage / approve-analysis / PATCH analyses / restore. F4: nagrade (score/tarife/
 * obracun) + Decision Log (odluke). Ti endpointi NISU ovde.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ZAHTEVI_READ)
@Controller({ path: "zahtevi", version: "1" })
export class ZahteviController {
  constructor(
    private readonly zahtevi: ZahteviService,
    private readonly zahteviAi: ZahteviAiService,
    private readonly rewards: ZahteviRewardsService,
    private readonly decisions: ZahteviDecisionsService,
  ) {}

  // ── LISTE ──────────────────────────────────────────────────────────────────

  @Get()
  list(
    @Req() req: { user: AuthUser },
    @Query("status") status?: string,
    @Query("module") module?: string,
    @Query("kind") kind?: string,
    @Query("q") q?: string,
    @Query("createdBy") createdBy?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.zahtevi.list(req.user, {
      status,
      module,
      kind,
      q,
      createdBy,
      page,
      pageSize,
    });
  }

  @Get("inbox-meta")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  inboxMeta() {
    return this.zahtevi.inboxMeta();
  }

  @Get("slicni")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  slicni(@Query("q") q?: string) {
    return this.zahtevi.slicni(q);
  }

  // ── NAGRADE (§12) — literalne rute PRE :id (izbegava wildcard shadowing) ──────

  /** GET /zahtevi/nagrade/tarife (admin) — aktuelna tarifa + istorija. */
  @Get("nagrade/tarife")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  getTariffs(@Req() req: { user: AuthUser }) {
    return this.rewards.getTariffs(req.user);
  }

  /** PUT /zahtevi/nagrade/tarife (admin) — 5 iznosa; upis = novi redovi (validFrom danas). */
  @Put("nagrade/tarife")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  putTariffs(@Body() dto: TariffPutDto, @Req() req: { user: AuthUser }) {
    return this.rewards.putTariffs(dto, req.user);
  }

  /** GET /zahtevi/nagrade/obracun?month=YYYY-MM (admin) — mesečni obračun po korisniku. */
  @Get("nagrade/obracun")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  payoutReport(
    @Query("month") month: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.rewards.payoutReport(month, req.user);
  }

  /** POST /zahtevi/nagrade/obracun/:month/zakljuci (admin) — CONFIRMED→PAID (immutable). */
  @Post("nagrade/obracun/:month/zakljuci")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  closeMonth(
    @Param("month") month: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.rewards.closeMonth(month, req.user);
  }

  /** GET /zahtevi/nagrade/moje?month=YYYY-MM (write) — SVOJE nagrade za mesec (row-scope). */
  @Get("nagrade/moje")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  myRewards(
    @Query("month") month: string | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.rewards.myRewards(month, req.user);
  }

  // ── DECISION LOG (§6) — literalne rute PRE :id ───────────────────────────────

  /** GET /zahtevi/odluke (decisions.read = admin+menadzment) — lista sa filterima. */
  @Get("odluke")
  @RequirePermission(PERMISSIONS.ZAHTEVI_DECISIONS_READ)
  listDecisions(
    @Query("q") q?: string,
    @Query("tag") tag?: string,
    @Query("status") status?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.decisions.list({ q, tag, status, page, pageSize });
  }

  /** POST /zahtevi/odluke (decisions.write = admin) — nova odluka. */
  @Post("odluke")
  @RequirePermission(PERMISSIONS.ZAHTEVI_DECISIONS_WRITE)
  createDecision(
    @Body() dto: CreateDecisionLogDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.decisions.create(dto, req.user);
  }

  /** GET /zahtevi/odluke/:id (decisions.read) — detalj. */
  @Get("odluke/:id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_DECISIONS_READ)
  getDecision(@Param("id", ParseIntPipe) id: number) {
    return this.decisions.getOne(id);
  }

  /** PATCH /zahtevi/odluke/:id (decisions.write) — sitne ispravke. */
  @Patch("odluke/:id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_DECISIONS_WRITE)
  updateDecision(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateDecisionLogDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.decisions.update(id, dto, req.user);
  }

  /** POST /zahtevi/odluke/:id/supersede (decisions.write) — nova odluka zamenjuje staru. */
  @Post("odluke/:id/supersede")
  @RequirePermission(PERMISSIONS.ZAHTEVI_DECISIONS_WRITE)
  supersedeDecision(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: SupersedeDecisionLogDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.decisions.supersede(id, dto, req.user);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  create(@Body() dto: CreateChangeRequestDto, @Req() req: { user: AuthUser }) {
    return this.zahtevi.create(dto, req.user);
  }

  @Get(":id")
  getDetail(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.getDetail(id, req.user);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateChangeRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.update(id, dto, req.user);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  remove(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.remove(id, req.user);
  }

  // ── SUBMIT / WITHDRAW ────────────────────────────────────────────────────────

  @Post(":id/submit")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  submit(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.submit(id, req.user);
  }

  @Post(":id/withdraw")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  withdraw(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.withdraw(id, req.user);
  }

  // ── PRILOZI (§5) ────────────────────────────────────────────────────────────

  @Post(":id/attachments")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  // Hard DoS cap 25MB/fajl, do 10 fajlova (servis dodatno primenjuje mime/audio pravila).
  @UseInterceptors(
    FilesInterceptor("files", 10, { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  addAttachments(
    @Param("id", ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.addAttachments(id, files ?? [], req.user);
  }

  @Get(":id/attachments/:attId/url")
  getAttachmentUrl(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.getAttachmentUrl(id, attId, req.user);
  }

  @Delete(":id/attachments/:attId")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  removeAttachment(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.removeAttachment(id, attId, req.user);
  }

  @Post(":id/attachments/:attId/transcribe")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  transcribeAttachment(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.transcribeAttachment(id, attId, req.user);
  }

  // ── KOMENTARI ────────────────────────────────────────────────────────────

  @Post(":id/comments")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  addComment(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { body?: string; isQuestion?: boolean },
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.addComment(id, body, req.user);
  }

  // ── ADMIN PRESUDE / REALIZACIJA ──────────────────────────────────────────────

  @Post(":id/decision")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  decision(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: DecisionDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.decision(id, dto, req.user);
  }

  @Post(":id/status")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  setStatus(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: StatusDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.setStatus(id, dto, req.user);
  }

  // ── AI CEVOVOD (F3, §4) ───────────────────────────────────────────────────

  /** Ponovi trijažu (admin) — nov red analize; radi i kad je trijaža pala. */
  @Post(":id/retriage")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  retriage(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahteviAi.retriage(id, req.user);
  }

  /** Odobrenje #1 (admin): SUBMITTED→ANALYSIS_APPROVED + fire-and-forget detaljna analiza. */
  @Post(":id/approve-analysis")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  approveAnalysis(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahteviAi.approveAnalysis(id, req.user);
  }

  /** Dorada Claude paketa (admin) na redu detaljne analize. */
  @Patch(":id/analyses/:analysisId")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  patchAnalysis(
    @Param("id", ParseIntPipe) id: number,
    @Param("analysisId", ParseIntPipe) analysisId: number,
    @Body() body: { claudePackage?: string },
    @Req() req: { user: AuthUser },
  ) {
    return this.zahteviAi.patchAnalysis(id, analysisId, body, req.user);
  }

  /** Vrati AI-odbačen (ocena 0) zahtev u obradu (admin) — sigurnosni ventil auto-reject-a. */
  @Post(":id/restore")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  restore(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahteviAi.restore(id, req.user);
  }

  // ── NAGRADE po zahtevu (§12.2/§12.3) ─────────────────────────────────────────

  /** Potvrdi/koriguj ocenu 0–5 (admin): 0→REJECTED; ≥1→snapshot iznosa + CONFIRMED. */
  @Post(":id/score")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  score(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ScoreDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.rewards.score(id, dto, req.user);
  }

  /** Isključi predlog iz nagrađivanja (admin) — rewardStatus=EXCLUDED (+ razlog). */
  @Post(":id/exclude")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  exclude(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ExcludeDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.rewards.exclude(id, dto, req.user);
  }
}
