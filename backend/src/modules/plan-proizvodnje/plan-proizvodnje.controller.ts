import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import type { Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import { PlanProizvodnjeReadService } from "./plan-proizvodnje-read.service";
import {
  CooperationQueryDto,
  DrawingsQueryDto,
  OperationsQueryDto,
  SearchOpsQueryDto,
} from "./dto/plan-proizvodnje-query.dto";
import {
  BulkReassignDto,
  CooperationGroupPatchDto,
  CooperationGroupUpsertDto,
  DrawingUploadDto,
  BigtehnDrawingSignQueryDto,
  OverlayReorderDto,
  OverlayUpsertDto,
  ReassignDto,
  SetUrgentDto,
} from "./dto/plan-proizvodnje-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

const MB = 1024 * 1024;

/**
 * Plan proizvodnje — 3.0 TALAS C, F5b (native na glavnoj bazi — bez sy15 mosta).
 * Read (`PlanProizvodnjeReadService`) reimplementira sy15 view lanac nad
 * work_order_operations/work_orders/tech_processes/operations; write
 * (`PlanProizvodnjeService`) piše `plan_proizvodnje_*` app tabele.
 *
 * Klasa: `plan_proizvodnje.read`. Write eskalira na `plan_proizvodnje.edit`; reassign
 * `force=true` traži `plan_proizvodnje.force` (BE je KONAČNI gate — `assertForce` +
 * servis force gate); auto-koop grupe = `plan_proizvodnje.koop_admin`; reassign audit =
 * `plan_proizvodnje.force`.
 *
 * ⚠️ Route ordering: literali (`operations/all|search`, `cooperation/groups`,
 * `reassign/bulk|audit`, `overlays/reorder`, `drawings/bigtehn/…`) pre bare/`:param`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_READ)
@Controller({ path: "plan-proizvodnje", version: "1" })
export class PlanProizvodnjeController {
  constructor(
    private readonly pp: PlanProizvodnjeService,
    private readonly read: PlanProizvodnjeReadService,
  ) {}

  // ---------- Read ----------

  @Get("machines")
  machines(@Req() req: AuthedRequest) {
    return this.read.machines(req.user.email);
  }

  @Get("operations/all")
  operationsAll(@Req() req: AuthedRequest) {
    return this.read.operationsAll(req.user.email);
  }

  @Get("operations/search")
  operationsSearch(@Req() req: AuthedRequest, @Query() q: SearchOpsQueryDto) {
    return this.read.operationsSearch(req.user.email, q.q);
  }

  @Get("operations")
  operations(@Req() req: AuthedRequest, @Query() q: OperationsQueryDto) {
    return this.read.operations(req.user.email, q);
  }

  @Get("cooperation/groups")
  cooperationGroups(@Req() req: AuthedRequest) {
    return this.read.cooperationGroups(req.user.email);
  }

  @Get("cooperation")
  cooperation(@Req() req: AuthedRequest, @Query() q: CooperationQueryDto) {
    return this.read.cooperation(req.user.email, q);
  }

  @Get("reassign/audit")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_FORCE)
  reassignAudit(@Req() req: AuthedRequest) {
    return this.read.reassignAudit(req.user.email);
  }

  @Get("drawings")
  drawings(@Req() req: AuthedRequest, @Query() q: DrawingsQueryDto) {
    return this.read.drawings(req.user.email, q);
  }

  @Get("tech-procedure/:workOrderId")
  techProcedure(
    @Req() req: AuthedRequest,
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
  ) {
    return this.read.techProcedure(req.user.email, workOrderId);
  }

  // ---------- Overlays (edit) ----------

  @Post("overlays")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  upsertOverlay(@Req() req: AuthedRequest, @Body() dto: OverlayUpsertDto) {
    return this.pp.upsertOverlay(req.user.email, dto);
  }

  @Post("overlays/reorder")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  reorderOverlays(@Req() req: AuthedRequest, @Body() dto: OverlayReorderDto) {
    return this.pp.reorderOverlays(req.user.email, dto);
  }

  // ---------- Urgency (edit) ----------

  @Put("urgency/:workOrderId")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  setUrgent(
    @Req() req: AuthedRequest,
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
    @Body() dto: SetUrgentDto,
  ) {
    return this.pp.setUrgent(req.user.email, String(workOrderId), dto);
  }

  @Delete("urgency/:workOrderId")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  clearUrgent(
    @Req() req: AuthedRequest,
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
  ) {
    return this.pp.clearUrgent(req.user.email, String(workOrderId));
  }

  // ---------- Reassign (edit; force → force permisija) ----------

  @Post("reassign/bulk")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  bulkReassign(@Req() req: AuthedRequest, @Body() dto: BulkReassignDto) {
    this.assertForce(req.user.role, dto.force);
    return this.pp.bulkReassign(
      req.user.email,
      dto,
      this.canForce(req.user.role),
    );
  }

  @Post("reassign")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  reassign(@Req() req: AuthedRequest, @Body() dto: ReassignDto) {
    this.assertForce(req.user.role, dto.force);
    return this.pp.reassign(req.user.email, dto, this.canForce(req.user.role));
  }

  // ---------- Kooperacija — auto grupe (koop_admin) ----------

  @Post("cooperation/groups")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN)
  createCoopGroup(
    @Req() req: AuthedRequest,
    @Body() dto: CooperationGroupUpsertDto,
  ) {
    return this.pp.upsertCooperationGroup(req.user.email, dto);
  }

  @Patch("cooperation/groups/:code")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN)
  patchCoopGroup(
    @Req() req: AuthedRequest,
    @Param("code") code: string,
    @Body() dto: CooperationGroupPatchDto,
  ) {
    return this.pp.patchCooperationGroup(req.user.email, code, dto);
  }

  // ---------- Skice (edit) + crteži (read + content strim) ----------

  @Post("drawings")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  // 20MB = 1.0 drawingManager MAX_BYTES (GAP-PM-19 BE deo).
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 20 * MB } }))
  uploadDrawing(
    @Req() req: AuthedRequest,
    @Body() dto: DrawingUploadDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.pp.uploadDrawing(req.user.email, dto.workOrder, dto.line, file);
  }

  // literali `drawings/bigtehn/*` pre `drawings/:id/*` (inače „bigtehn" → :id).
  @Get("drawings/bigtehn/sign")
  bigtehnDrawingSign(
    @Req() req: AuthedRequest,
    @Query() q: BigtehnDrawingSignQueryDto,
  ) {
    return this.read.bigtehnDrawingSignUrl(req.user.email, q.code);
  }

  @Get("drawings/bigtehn/:drawingId/pdf/content")
  bigtehnDrawingPdf(
    @Param("drawingId", ParseIntPipe) drawingId: number,
    @Res({ passthrough: true }) res: Response,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    return this.read.streamBigtehnDrawing(drawingId, res, req.user);
  }

  @Get("drawings/:id/sign")
  drawingSign(@Req() req: AuthedRequest, @Param("id", ParseIntPipe) id: number) {
    return this.read.drawingSignUrl(req.user.email, String(id));
  }

  @Get("drawings/:id/pdf/content")
  drawingPdf(
    @Param("id", ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
    @Req() req: AuthedRequest,
  ): Promise<StreamableFile> {
    return this.read.streamDrawing(id, res, req.user);
  }

  @Delete("drawings/:id")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  deleteDrawing(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.pp.deleteDrawing(req.user.email, String(id));
  }

  /**
   * `force=true` reassign traži `plan_proizvodnje.force` (mirror guard enforce/shadow).
   * BE servis je KONAČNI gate (nema više DB DEFINER-a): u shadow modu (AUTHZ_ENFORCE≠true)
   * kontroler propušta, ali servis i dalje presuđuje group-mismatch/force_reason. Zato se
   * `canForce` prosleđuje servisu (force bez prava → 403 čak i u shadow-u kad je grupa
   * različita — B/E paritet sy15 `can_force_plan_reassign`).
   */
  private assertForce(role: string, force?: boolean): void {
    if (!force) return;
    if (process.env.AUTHZ_ENFORCE !== "true") return;
    if (!roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_FORCE)) {
      throw new ForbiddenException(
        "Za prinudni reassign (force) potrebna je dozvola plan_proizvodnje.force.",
      );
    }
  }

  private canForce(role: string): boolean {
    return roleHasPermission(role, PERMISSIONS.PLAN_PROIZVODNJE_FORCE);
  }
}
