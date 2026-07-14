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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor, FilesInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PlanMontazeService } from "./plan-montaze.service";
import {
  DrawingsLookupQueryDto,
  PredmetiLookupQueryDto,
  ProjectsQueryDto,
  ReportsQueryDto,
} from "./dto/plan-montaze-query.dto";
import {
  AiGenerateDto,
  CreateReportDto,
  LinkPredmetDto,
  SetMontazaAiModelDto,
  UpdatePhaseDto,
  UpdateProjectDto,
  UpdateWorkPackageDto,
  UploadPhotosMetaDto,
  UpsertPhaseDto,
  UpsertProjectDto,
  UpsertWorkPackageDto,
} from "./dto/plan-montaze-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

const MB = 1024 * 1024;

/**
 * Plan montaže + izveštaji montera — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Klasa: `montaza.read` (modul „Montaža" je UNGATED u 1.0 → svaka aktivna rola).
 * Write eskalira per-metod: PM CRUD = `montaza.edit` (uklj. tim_lider, PRESUDA C1);
 * izveštaji + AI = `montaza.izvestaji`; ai-model PUT = `montaza.ai_admin`. Row-odluka
 * (has_edit_role project-scope, autor-scope izveštaja) presuđuje sy15 kroz `withUserRls`.
 *
 * ⚠️ Route ordering: literali (`projects`, `work-packages`, `ai-model`, `lookups/*`,
 * `reports/ai-generate`, `reports/photo/:photoId/sign`) i `reports/:id/*` pre bare `reports/:id`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.MONTAZA_READ)
@Controller({ path: "montaza", version: "1" })
export class PlanMontazeController {
  constructor(private readonly montaza: PlanMontazeService) {}

  // ---------- Projekti (read + CRUD) ----------

  @Get("projects")
  projects(@Req() req: AuthedRequest, @Query() _q: ProjectsQueryDto) {
    void _q; // include=tree je default (§3); ostavljeno za deep-link paritet
    return this.montaza.projectsTree(req.user.email);
  }

  @Post("projects")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  createProject(@Req() req: AuthedRequest, @Body() dto: UpsertProjectDto) {
    return this.montaza.upsertProject(req.user.email, dto);
  }

  @Patch("projects/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  updateProject(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.montaza.updateProject(req.user.email, id, dto);
  }

  @Delete("projects/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  deleteProject(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.montaza.deleteProject(req.user.email, id);
  }

  // ---------- Work packages (nalog montaže) ----------

  @Post("work-packages")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  createWp(@Req() req: AuthedRequest, @Body() dto: UpsertWorkPackageDto) {
    return this.montaza.upsertWorkPackage(req.user.email, dto);
  }

  @Patch("work-packages/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  updateWp(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkPackageDto,
  ) {
    return this.montaza.updateWorkPackage(req.user.email, id, dto);
  }

  @Delete("work-packages/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  deleteWp(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.montaza.deleteWorkPackage(req.user.email, id);
  }

  // ---------- Faze ----------

  @Post("phases")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  createPhase(@Req() req: AuthedRequest, @Body() dto: UpsertPhaseDto) {
    return this.montaza.upsertPhase(req.user.email, dto);
  }

  @Patch("phases/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  updatePhase(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePhaseDto,
  ) {
    return this.montaza.updatePhase(req.user.email, id, dto);
  }

  @Delete("phases/:id")
  @RequirePermission(PERMISSIONS.MONTAZA_EDIT)
  deletePhase(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.montaza.deletePhase(req.user.email, id);
  }

  // ---------- Izveštaji montera ----------

  @Get("reports")
  reports(@Req() req: AuthedRequest, @Query() q: ReportsQueryDto) {
    return this.montaza.listReports(req.user.email, q);
  }

  @Post("reports")
  @RequirePermission(PERMISSIONS.MONTAZA_IZVESTAJI)
  createReport(@Req() req: AuthedRequest, @Body() dto: CreateReportDto) {
    return this.montaza.createReport(req.user.email, dto);
  }

  // AI strukturiranje (port edge montaza-izvestaj-ai) — literal pre `reports/:id`.
  @Post("reports/ai-generate")
  @RequirePermission(PERMISSIONS.MONTAZA_IZVESTAJI)
  aiGenerate(@Req() req: AuthedRequest, @Body() dto: AiGenerateDto) {
    return this.montaza.aiGenerate(req.user.email, dto);
  }

  // Presigned fotke (po foto id-ju) — literal pre `reports/:id`.
  @Get("reports/photo/:photoId/sign")
  photoSign(
    @Req() req: AuthedRequest,
    @Param("photoId", ParseUUIDPipe) photoId: string,
  ) {
    return this.montaza.photoUrl(req.user.email, photoId);
  }

  @Get("reports/:id/photos")
  reportPhotos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.montaza.reportPhotos(req.user.email, id);
  }

  @Post("reports/:id/photos")
  @RequirePermission(PERMISSIONS.MONTAZA_IZVESTAJI)
  // Do 16 fotki × 8MB hard cap (multer aborta pre baferovanja).
  @UseInterceptors(
    FilesInterceptor("files", 16, { limits: { fileSize: 8 * MB } }),
  )
  uploadPhotos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UploadPhotosMetaDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.montaza.uploadPhotos(
      req.user.email,
      id,
      files ?? [],
      dto.redni,
      dto.opisi,
    );
  }

  @Post("reports/:id/pdf")
  @RequirePermission(PERMISSIONS.MONTAZA_IZVESTAJI)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * MB } }))
  uploadPdf(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.montaza.uploadPdf(req.user.email, id, file);
  }

  @Get("reports/:id/pdf")
  reportPdf(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.montaza.reportPdfUrl(req.user.email, id);
  }

  @Patch("reports/:id/predmet")
  @RequirePermission(PERMISSIONS.MONTAZA_IZVESTAJI)
  linkPredmet(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: LinkPredmetDto,
  ) {
    return this.montaza.linkPredmet(req.user.email, id, dto);
  }

  @Get("reports/:id")
  reportDetail(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.montaza.reportDetail(req.user.email, id);
  }

  // ---------- AI model ----------

  @Get("ai-model")
  aiModel(@Req() req: AuthedRequest) {
    return this.montaza.aiModel(req.user.email);
  }

  @Put("ai-model")
  @RequirePermission(PERMISSIONS.MONTAZA_AI_ADMIN)
  setAiModel(@Req() req: AuthedRequest, @Body() dto: SetMontazaAiModelDto) {
    return this.montaza.setAiModel(req.user.email, dto.model);
  }

  // ---------- Lookups ----------

  @Get("lookups/predmeti")
  lookupPredmeti(@Req() req: AuthedRequest, @Query() q: PredmetiLookupQueryDto) {
    return this.montaza.lookupPredmeti(req.user.email, q.q);
  }

  @Get("lookups/drawings")
  lookupDrawings(@Req() req: AuthedRequest, @Query() q: DrawingsLookupQueryDto) {
    return this.montaza.lookupDrawings(req.user.email, q.codes);
  }
}
