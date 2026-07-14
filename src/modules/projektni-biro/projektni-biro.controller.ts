import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ProjektniBiroService } from "./projektni-biro.service";
import {
  ListTasksQueryDto,
  LoadStatsQueryDto,
  TipsQueryDto,
  WorkReportSummaryQueryDto,
  WorkReportsQueryDto,
} from "./dto/pb-query.dto";
import {
  BulkTasksDto,
  CreateCommentDto,
  CreateDepDto,
  CreateTaskDto,
  CreateWorkReportDto,
  NotifConfigPatchDto,
  ProgressDto,
  SaveTipDto,
  SoftDeleteTasksDto,
  TaskFileMetaDto,
  TipCategoryDto,
  TipFileMetaDto,
  UpdateCommentDto,
  UpdateTaskDto,
} from "./dto/pb-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Projektni biro — 3.0 TALAS D, R1 read endpoints (MODULE_SPEC_pb_profil_podesavanja_30.md §3.1).
 * Paritet ŽIVIH 1.0 politika (§2.1): klasa = `pb.read` (SELECT `true`/`deleted_at IS NULL` za sve
 * prijavljene); work-reports = `pb.reports_own` (row-scope self∨reports_all u DB). Mutacije
 * (task CRUD, /progress RPC, komentari/deps/fajlovi write, tips write, notif-config PATCH,
 * presigned storage, idempotency) su R2 — ovde ih namerno NEMA. Row-odluke (draft vidljivost,
 * org-članstvo inženjera, 1h/24h prozori) sprovodi sy15 RLS/DEFINER kroz GUC (withUserRls).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PB_READ)
@Controller({ path: "pb", version: "1" })
export class ProjektniBiroController {
  constructor(private readonly pb: ProjektniBiroService) {}

  @Get("projects")
  listProjects(@Req() req: AuthedRequest) {
    return this.pb.listProjects(req.user.email);
  }

  @Get("engineers")
  listEngineers(@Req() req: AuthedRequest) {
    return this.pb.listEngineers(req.user.email);
  }

  @Get("tasks")
  listTasks(@Req() req: AuthedRequest, @Query() query: ListTasksQueryDto) {
    return this.pb.listTasks(req.user.email, query);
  }

  @Get("load-stats")
  loadStats(@Req() req: AuthedRequest, @Query() query: LoadStatsQueryDto) {
    return this.pb.loadStats(req.user.email, query);
  }

  @Get("team-load-stats")
  teamLoadStats(@Req() req: AuthedRequest, @Query() query: LoadStatsQueryDto) {
    return this.pb.teamLoadStats(req.user.email, query);
  }

  @Get("work-reports")
  @RequirePermission(PERMISSIONS.PB_REPORTS_OWN)
  listWorkReports(
    @Req() req: AuthedRequest,
    @Query() query: WorkReportsQueryDto,
  ) {
    return this.pb.listWorkReports(req.user.email, query);
  }

  @Get("work-reports/summary")
  @RequirePermission(PERMISSIONS.PB_REPORTS_OWN)
  workReportSummary(
    @Req() req: AuthedRequest,
    @Query() query: WorkReportSummaryQueryDto,
  ) {
    return this.pb.workReportSummary(req.user.email, query);
  }

  @Get("tips")
  listTips(@Req() req: AuthedRequest, @Query() query: TipsQueryDto) {
    return this.pb.listTips(req.user.email, query);
  }

  @Get("tips/categories")
  listTipCategories(@Req() req: AuthedRequest) {
    return this.pb.listTipCategories(req.user.email);
  }

  @Get("tips/:id")
  findTip(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.pb.findTip(req.user.email, id);
  }

  @Get("notification-config")
  notificationConfig(@Req() req: AuthedRequest) {
    return this.pb.notificationConfig(req.user.email);
  }

  // ----- :id rute POSLEDNJE (literali „tasks/…" pre parametarskih; doktrina route ordering) -----

  @Get("tasks/:id")
  findTask(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.pb.findTask(req.user.email, id);
  }

  @Get("tasks/:id/comments")
  listComments(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.listComments(req.user.email, id);
  }

  @Get("tasks/:id/deps")
  listDeps(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.pb.listDeps(req.user.email, id);
  }

  @Get("tasks/:id/files")
  listFiles(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.pb.listFiles(req.user.email, id);
  }

  // ==========================================================================
  // R2 — MUTACIJE (route ordering: literali pre :id; per-metod permisija override)
  // Klasa = pb.read; write eskalira na edit/comment/progress/tips_write/admin.
  // Row-odluka (edit-krug, 1h/24h prozori, draft/org-članstvo, self-scope) = sy15 RLS/DEFINER.
  // ==========================================================================

  // ---------- Taskovi ----------

  @Post("tasks")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  createTask(@Req() req: AuthedRequest, @Body() dto: CreateTaskDto) {
    return this.pb.createTask(req.user.email, dto);
  }

  @Patch("tasks/bulk")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  bulkUpdateTasks(@Req() req: AuthedRequest, @Body() dto: BulkTasksDto) {
    return this.pb.bulkUpdateTasks(req.user.email, dto);
  }

  @Post("tasks/soft-delete")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  bulkSoftDeleteTasks(
    @Req() req: AuthedRequest,
    @Body() dto: SoftDeleteTasksDto,
  ) {
    return this.pb.bulkSoftDeleteTasks(req.user.email, dto);
  }

  @Post("tasks/:id/progress")
  @RequirePermission(PERMISSIONS.PB_PROGRESS)
  updateProgress(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: ProgressDto,
  ) {
    return this.pb.updateProgress(req.user.email, id, dto);
  }

  @Post("tasks/:id/soft-delete")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  softDeleteTask(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.softDeleteTask(req.user.email, id);
  }

  @Post("tasks/:id/comments")
  @RequirePermission(PERMISSIONS.PB_COMMENT)
  createComment(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.pb.createComment(req.user.email, id, dto);
  }

  @Post("tasks/:id/deps")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  addDep(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateDepDto,
  ) {
    return this.pb.addDep(req.user.email, id, dto);
  }

  @Post("tasks/:id/files")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  uploadTaskFile(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TaskFileMetaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.pb.uploadTaskFile(req.user.email, id, dto, file);
  }

  @Patch("tasks/:id")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  updateTask(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.pb.updateTask(req.user.email, id, dto);
  }

  // ---------- Komentari / zavisnosti / prilozi (globalno-unikatni id) ----------

  @Patch("comments/:cid")
  @RequirePermission(PERMISSIONS.PB_COMMENT)
  updateComment(
    @Req() req: AuthedRequest,
    @Param("cid", ParseUUIDPipe) cid: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.pb.updateComment(req.user.email, cid, dto);
  }

  @Delete("comments/:cid")
  @RequirePermission(PERMISSIONS.PB_COMMENT)
  deleteComment(
    @Req() req: AuthedRequest,
    @Param("cid", ParseUUIDPipe) cid: string,
  ) {
    return this.pb.deleteComment(req.user.email, cid);
  }

  @Delete("deps/:depId")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  deleteDep(
    @Req() req: AuthedRequest,
    @Param("depId", ParseUUIDPipe) depId: string,
  ) {
    return this.pb.deleteDep(req.user.email, depId);
  }

  @Get("files/:fileId/sign")
  @RequirePermission(PERMISSIONS.PB_COMMENT)
  signTaskFile(
    @Req() req: AuthedRequest,
    @Param("fileId", ParseUUIDPipe) fileId: string,
  ) {
    return this.pb.signTaskFile(req.user.email, fileId);
  }

  @Delete("files/:fileId")
  @RequirePermission(PERMISSIONS.PB_EDIT)
  deleteTaskFile(
    @Req() req: AuthedRequest,
    @Param("fileId", ParseUUIDPipe) fileId: string,
  ) {
    return this.pb.deleteTaskFile(req.user.email, fileId);
  }

  // ---------- Work reports (self ∨ reports_all u DB) ----------

  @Post("work-reports")
  @RequirePermission(PERMISSIONS.PB_REPORTS_OWN)
  createWorkReport(
    @Req() req: AuthedRequest,
    @Body() dto: CreateWorkReportDto,
  ) {
    return this.pb.createWorkReport(req.user.email, dto);
  }

  @Delete("work-reports/:id")
  @RequirePermission(PERMISSIONS.PB_REPORTS_OWN)
  deleteWorkReport(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.deleteWorkReport(req.user.email, id);
  }

  // ---------- Notif config (pb.admin) ----------

  @Patch("notification-config")
  @RequirePermission(PERMISSIONS.PB_ADMIN)
  updateNotificationConfig(
    @Req() req: AuthedRequest,
    @Body() dto: NotifConfigPatchDto,
  ) {
    return this.pb.updateNotificationConfig(req.user.email, dto);
  }

  // ---------- Saveti ----------

  @Post("tips")
  @RequirePermission(PERMISSIONS.PB_TIPS_WRITE)
  saveTip(@Req() req: AuthedRequest, @Body() dto: SaveTipDto) {
    return this.pb.saveTip(req.user.email, dto);
  }

  @Post("tips/categories")
  @RequirePermission(PERMISSIONS.PB_ADMIN)
  upsertTipCategory(@Req() req: AuthedRequest, @Body() dto: TipCategoryDto) {
    return this.pb.upsertTipCategory(req.user.email, dto);
  }

  @Delete("tips/categories/:id")
  @RequirePermission(PERMISSIONS.PB_ADMIN)
  deleteTipCategory(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.deleteTipCategory(req.user.email, id);
  }

  @Post("tips/:id/like")
  toggleTipLike(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.toggleTipLike(req.user.email, id);
  }

  @Post("tips/:id/soft-delete")
  softDeleteTip(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.pb.softDeleteTip(req.user.email, id);
  }

  @Post("tips/:id/files")
  @RequirePermission(PERMISSIONS.PB_TIPS_WRITE)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 6 * 1024 * 1024 } }),
  )
  uploadTipFile(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TipFileMetaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.pb.uploadTipFile(req.user.email, id, dto.clientEventId, file);
  }

  @Get("tip-files/:fileId/sign")
  signTipFile(
    @Req() req: AuthedRequest,
    @Param("fileId", ParseUUIDPipe) fileId: string,
  ) {
    return this.pb.signTipFile(req.user.email, fileId);
  }

  @Delete("tip-files/:fileId")
  @RequirePermission(PERMISSIONS.PB_TIPS_WRITE)
  deleteTipFile(
    @Req() req: AuthedRequest,
    @Param("fileId", ParseUUIDPipe) fileId: string,
  ) {
    return this.pb.deleteTipFile(req.user.email, fileId);
  }
}
