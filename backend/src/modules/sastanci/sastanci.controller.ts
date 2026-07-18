import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { SastanciService } from "./sastanci.service";
import {
  AkcijeQueryDto,
  ListSastanciQueryDto,
  NotificationsQueryDto,
  TemeQueryDto,
  WeeklyDiffQueryDto,
} from "./dto/sastanci-query.dto";
import {
  AddUcesnikDto,
  ArhivaPdfDto,
  BulkStatusDto,
  BulkUcesniciDto,
  CreateAkcijaDto,
  CreateAktivnostDto,
  CreateDraftTemaDto,
  CreateOdlukaDto,
  CreateSastanakDto,
  CreateTemaDto,
  CreateTemplateDto,
  DraftReviewDto,
  DraftUvediDto,
  InstantiateTemplateDto,
  LockSastanakDto,
  PatchAkcijaDto,
  PrenosDto,
  ReorderDto,
  ReorderRangDto,
  RsvpDto,
  AiSummaryDto,
  SetAiModelDto,
  TemaAdminRangDto,
  TemaDodeliDto,
  TemaHitnoDto,
  TemaRazmatranjeDto,
  UpdateAktivnostDto,
  UpdateOdlukaDto,
  UpdatePrefsDto,
  UpdateSastanakDto,
  UpdateSlikaDto,
  UpdateTemaDto,
  UpdateTemplateDto,
  UpdateUcesnikDto,
  UploadSlikaDto,
  WeeklyOdloziDto,
  WeeklyPomeriDto,
  WeeklyVratiDto,
} from "./dto/sastanci-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Sastanci — 3.0 TALAS B, R1 read endpoints (MODULE_SPEC_sastanci_ai_30.md §3).
 * Klasa: `sastanci.read` (paritet 1.0 front gate `canAccessSastanci` — VIDLJIVOST menija;
 * row-nivo/organizator-trio/učesnik-scope presuđuje sy15 RLS kroz `withUserRls`
 * — GUC claims + SET LOCAL ROLE authenticated, review 12.07).
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
  list(@Req() req: AuthedRequest, @Query() query: ListSastanciQueryDto) {
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
    @Query() query: NotificationsQueryDto,
  ) {
    return this.sastanci.notifications(req.user.email, query);
  }

  @Get("ai-model")
  aiModel(@Req() req: AuthedRequest) {
    return this.sastanci.aiModel(req.user.email);
  }

  // Akcioni plan — literal „akcije/*" pre :id-a
  @Get("akcije")
  akcije(@Req() req: AuthedRequest, @Query() query: AkcijeQueryDto) {
    return this.sastanci.listAkcije(req.user.email, query);
  }

  @Get("akcije/weekly-diff")
  akcijeWeeklyDiff(
    @Req() req: AuthedRequest,
    @Query() query: WeeklyDiffQueryDto,
  ) {
    return this.sastanci.akcijeWeeklyDiff(req.user.email, query);
  }

  /** ⭐ uređena lista bigtehn_item_id (redosled RN grupa; paritet 1.0
   *  pullPredmetPlanPrioritetIds). Klasni guard = sastanci.read. */
  @Get("predmet-prioritet")
  predmetPrioritet(@Req() req: AuthedRequest) {
    return this.sastanci.predmetPrioritet(req.user.email);
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
  teme(@Req() req: AuthedRequest, @Query() query: TemeQueryDto) {
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

  /** Red „Od prošlog sastanka" — diff sidren na PRETHODNI ZAKLJUČANI sastanak
   *  (paritet 1.0 loadPrethodniZakljucanPre → loadWeeklyDiffStats); nema
   *  prethodnog → data:null (red se izostavlja). */
  @Get(":id/weekly-diff")
  sastanakWeeklyDiff(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.sastanakWeeklyDiff(req.user.email, id);
  }

  @Get(":id")
  one(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.findOne(req.user.email, id);
  }

  // ==========================================================================
  // R2 — MUTACIJE (route ordering: literali pre :id; bare :id na kraju)
  // Guard klase = `sastanci.read`; write akcije eskaliraju na edit/manage/
  // weekly_move/ai_model per-metod. Row-odluka (trio/učesnik) presuđuje sy15 RLS.
  // ==========================================================================

  // ---------- literal-prefiks write ----------

  @Post()
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  create(@Req() req: AuthedRequest, @Body() dto: CreateSastanakDto) {
    return this.sastanci.createSastanak(req.user.email, dto);
  }

  // Akcioni plan
  @Post("akcije")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createAkcija(@Req() req: AuthedRequest, @Body() dto: CreateAkcijaDto) {
    return this.sastanci.createAkcija(req.user.email, dto);
  }

  @Post("akcije/bulk-status")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  bulkStatus(@Req() req: AuthedRequest, @Body() dto: BulkStatusDto) {
    return this.sastanci.bulkStatus(req.user.email, dto);
  }

  @Patch("akcije/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  patchAkcija(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PatchAkcijaDto,
  ) {
    return this.sastanci.patchAkcija(req.user.email, id, dto);
  }

  @Delete("akcije/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteAkcija(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.deleteAkcija(req.user.email, id);
  }

  // PM teme
  @Post("teme")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createTema(@Req() req: AuthedRequest, @Body() dto: CreateTemaDto) {
    return this.sastanci.createTema(req.user.email, dto);
  }

  @Post("teme/reorder-rang")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  reorderRang(@Req() req: AuthedRequest, @Body() dto: ReorderRangDto) {
    return this.sastanci.reorderRang(req.user.email, dto);
  }

  @Post("teme/draft")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createDraftTema(@Req() req: AuthedRequest, @Body() dto: CreateDraftTemaDto) {
    return this.sastanci.createDraftTema(req.user.email, dto);
  }

  @Get("teme/draft")
  draftTeme(
    @Req() req: AuthedRequest,
    @Query("projektId", ParseUUIDPipe) projektId: string,
  ) {
    return this.sastanci.draftTeme(req.user.email, projektId);
  }

  @Patch("teme/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateTema(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemaDto,
  ) {
    return this.sastanci.updateTema(req.user.email, id, dto);
  }

  @Delete("teme/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteTema(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.deleteTema(req.user.email, id);
  }

  @Post("teme/:id/hitno")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  temaHitno(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TemaHitnoDto,
  ) {
    return this.sastanci.setTemaHitno(req.user.email, id, dto);
  }

  @Post("teme/:id/za-razmatranje")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  temaRazmatranje(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TemaRazmatranjeDto,
  ) {
    return this.sastanci.setTemaRazmatranje(req.user.email, id, dto);
  }

  @Post("teme/:id/admin-rang")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  temaAdminRang(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TemaAdminRangDto,
  ) {
    return this.sastanci.setTemaAdminRang(req.user.email, id, dto);
  }

  @Post("teme/:id/dodeli")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  temaDodeli(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TemaDodeliDto,
  ) {
    return this.sastanci.dodeliTemu(req.user.email, id, dto);
  }

  @Post("teme/:id/draft-review")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  draftReview(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DraftReviewDto,
  ) {
    return this.sastanci.draftReview(req.user.email, id, dto);
  }

  @Post("teme/:id/uvedi")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  draftUvedi(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: DraftUvediDto,
  ) {
    return this.sastanci.draftUvedi(req.user.email, id, dto);
  }

  // Šabloni
  @Post("templates")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createTemplate(@Req() req: AuthedRequest, @Body() dto: CreateTemplateDto) {
    return this.sastanci.createTemplate(req.user.email, dto);
  }

  @Patch("templates/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateTemplate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.sastanci.updateTemplate(req.user.email, id, dto);
  }

  @Delete("templates/:id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteTemplate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.deleteTemplate(req.user.email, id);
  }

  @Post("templates/:id/instantiate")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  instantiate(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: InstantiateTemplateDto,
  ) {
    return this.sastanci.instantiate(req.user.email, id, dto);
  }

  // Tačke zapisnika (globalno-unikatni akt id)
  @Patch("aktivnosti/:aktId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateAktivnost(
    @Req() req: AuthedRequest,
    @Param("aktId", ParseUUIDPipe) aktId: string,
    @Body() dto: UpdateAktivnostDto,
  ) {
    return this.sastanci.updateAktivnost(req.user.email, aktId, dto);
  }

  @Delete("aktivnosti/:aktId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteAktivnost(
    @Req() req: AuthedRequest,
    @Param("aktId", ParseUUIDPipe) aktId: string,
  ) {
    return this.sastanci.deleteAktivnost(req.user.email, aktId);
  }

  // Slike preseka (globalno-unikatni id; storage sastanak-slike)
  @Patch("slike/:slikaId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateSlika(
    @Req() req: AuthedRequest,
    @Param("slikaId", ParseUUIDPipe) slikaId: string,
    @Body() dto: UpdateSlikaDto,
  ) {
    return this.sastanci.updateSlika(req.user.email, slikaId, dto);
  }

  @Delete("slike/:slikaId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteSlika(
    @Req() req: AuthedRequest,
    @Param("slikaId", ParseUUIDPipe) slikaId: string,
  ) {
    return this.sastanci.deleteSlika(req.user.email, slikaId);
  }

  @Get("slike/:slikaId/sign")
  signSlika(
    @Req() req: AuthedRequest,
    @Param("slikaId", ParseUUIDPipe) slikaId: string,
  ) {
    return this.sastanci.getSlikaUrl(req.user.email, slikaId);
  }

  // Sedmični (weekly_move gate = sast_weekly_movers u DB kroz GUC)
  @Post("weekly/pomeri")
  @RequirePermission(PERMISSIONS.SASTANCI_WEEKLY_MOVE)
  weeklyPomeri(@Req() req: AuthedRequest, @Body() dto: WeeklyPomeriDto) {
    return this.sastanci.weeklyPomeri(req.user.email, dto);
  }

  @Post("weekly/odlozi")
  @RequirePermission(PERMISSIONS.SASTANCI_WEEKLY_MOVE)
  weeklyOdlozi(@Req() req: AuthedRequest, @Body() dto: WeeklyOdloziDto) {
    return this.sastanci.weeklyOdlozi(req.user.email, dto);
  }

  @Post("weekly/vrati")
  @RequirePermission(PERMISSIONS.SASTANCI_WEEKLY_MOVE)
  weeklyVrati(@Req() req: AuthedRequest, @Body() dto: WeeklyVratiDto) {
    return this.sastanci.weeklyVrati(req.user.email, dto);
  }

  // Prefs (svoje — guard read; RLS po email claim-u)
  @Patch("prefs")
  updatePrefs(@Req() req: AuthedRequest, @Body() dto: UpdatePrefsDto) {
    return this.sastanci.updatePrefs(req.user.email, dto);
  }

  // AI model (admin)
  @Put("ai-model")
  @RequirePermission(PERMISSIONS.SASTANCI_AI_MODEL)
  setAiModel(@Req() req: AuthedRequest, @Body() dto: SetAiModelDto) {
    return this.sastanci.setAiModel(req.user.email, dto);
  }

  // ---------- :id-prefiks write ----------

  @Post(":id/lock")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  lock(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LockSastanakDto,
  ) {
    return this.sastanci.lock(req.user.email, id, dto);
  }

  @Post(":id/reopen")
  @RequirePermission(PERMISSIONS.SASTANCI_MANAGE)
  reopen(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.reopen(req.user.email, id);
  }

  /** „Sedmični + prenos": kopiraj učesnike izvora + premesti otvorene akcije
   *  (paritet 1.0 prenesiUNoviSastanak). :id = NOVI (ciljni) sastanak;
   *  fromSastanakId opcion — bez njega BE bira izvor (poslednji istog tipa
   *  strogo pre datuma novog); nema izvora → {ucesnici:0, akcije:0, source:null}. */
  @Post(":id/prenos")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  prenos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PrenosDto,
  ) {
    return this.sastanci.prenos(req.user.email, id, dto);
  }

  @Post(":id/invites")
  @RequirePermission(PERMISSIONS.SASTANCI_MANAGE)
  invites(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.sendInvites(req.user.email, id);
  }

  @Post(":id/remind-unprepared")
  @RequirePermission(PERMISSIONS.SASTANCI_MANAGE)
  remind(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.remindUnprepared(req.user.email, id);
  }

  @Post(":id/resend-locked")
  @RequirePermission(PERMISSIONS.SASTANCI_MANAGE)
  resend(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.resendLocked(req.user.email, id);
  }

  @Post(":id/rsvp")
  rsvp(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RsvpDto,
  ) {
    return this.sastanci.setMyRsvp(req.user.email, id, dto);
  }

  @Post(":id/mark-prisutni")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  markPrisutni(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.markPrisutni(req.user.email, id);
  }

  @Put(":id/ucesnici")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  bulkUcesnici(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: BulkUcesniciDto,
  ) {
    return this.sastanci.bulkUcesnici(req.user.email, id, dto);
  }

  @Post(":id/ucesnici")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  addUcesnik(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AddUcesnikDto,
  ) {
    return this.sastanci.addUcesnik(req.user.email, id, dto);
  }

  @Patch(":id/ucesnici/:email")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateUcesnik(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("email") email: string,
    @Body() dto: UpdateUcesnikDto,
  ) {
    return this.sastanci.updateUcesnik(req.user.email, id, email, dto);
  }

  @Delete(":id/ucesnici/:email")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  removeUcesnik(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("email") email: string,
  ) {
    return this.sastanci.removeUcesnik(req.user.email, id, email);
  }

  @Post(":id/aktivnosti/reorder")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  reorderAktivnosti(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ReorderDto,
  ) {
    return this.sastanci.reorderAktivnosti(req.user.email, id, dto);
  }

  @Post(":id/aktivnosti/seed-from-teme")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  seedFromTeme(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.seedFromTeme(req.user.email, id);
  }

  @Post(":id/aktivnosti")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createAktivnost(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateAktivnostDto,
  ) {
    return this.sastanci.createAktivnost(req.user.email, id, dto);
  }

  @Post(":id/odluke")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  createOdluka(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateOdlukaDto,
  ) {
    return this.sastanci.createOdluka(req.user.email, id, dto);
  }

  @Patch(":id/odluke/:odlId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  updateOdluka(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("odlId", ParseUUIDPipe) odlId: string,
    @Body() dto: UpdateOdlukaDto,
  ) {
    return this.sastanci.updateOdluka(req.user.email, odlId, dto);
  }

  @Delete(":id/odluke/:odlId")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  deleteOdluka(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("odlId", ParseUUIDPipe) odlId: string,
  ) {
    return this.sastanci.deleteOdluka(req.user.email, odlId);
  }

  // Storage: PDF zapisnika (sastanci-arhiva)
  @Post(":id/arhiva/pdf")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  // Hard DoS cap ~20MB za PDF zapisnika (multer aborta pre baferovanja).
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  uploadArhivaPdf(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ArhivaPdfDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.sastanci.uploadArhivaPdf(
      req.user.email,
      id,
      file,
      dto.requireArhiva,
    );
  }

  @Get(":id/arhiva/pdf")
  arhivaPdfUrl(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.sastanci.getArhivaPdfUrl(req.user.email, id);
  }

  // Storage: slika uz tačku (sastanak-slike)
  @Post(":id/slike")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  // Hard DoS cap ~20MB za sliku preseka (multer aborta pre baferovanja).
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 20 * 1024 * 1024 } }),
  )
  uploadSlika(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UploadSlikaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.sastanci.uploadSlika(req.user.email, id, dto, file);
  }

  // AI rezime „Sažmi zapisnik" (read; Anthropic — B2)
  @Post(":id/ai-summary")
  aiSummary(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AiSummaryDto,
  ) {
    void id;
    return this.sastanci.aiSummary(req.user.email, dto.sastanak);
  }

  // bare :id (POSLEDNJE — da ne uhvati literale/pod-rute)
  @Patch(":id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  update(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSastanakDto,
  ) {
    return this.sastanci.updateSastanak(req.user.email, id, dto);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.SASTANCI_EDIT)
  remove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.sastanci.deleteSastanak(req.user.email, id);
  }
}
