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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { roleHasPermission } from "../../common/authz/role-permissions";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
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
 * Plan proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Klasa: `plan_proizvodnje.read` (paritet 1.0 router gate `canAccessPlanProizvodnje`).
 * Write eskalira per-metod na `plan_proizvodnje.edit`; reassign sa `force=true` traži i
 * `plan_proizvodnje.force` (dinamička provera — mirror guard enforce/shadow); auto-koop
 * grupe = `plan_proizvodnje.koop_admin`; reassign audit = `plan_proizvodnje.force`.
 * Row/force odluka dodatno presuđuje sy15 (can_edit/can_force) kroz `withUserRls`.
 *
 * ⚠️ Route ordering: literali (`operations/all|search`, `cooperation/groups`,
 * `reassign/bulk|audit`, `overlays/reorder`, `drawings/bigtehn/sign`) pre bare/`:param`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_READ)
@Controller({ path: "plan-proizvodnje", version: "1" })
export class PlanProizvodnjeController {
  constructor(private readonly pp: PlanProizvodnjeService) {}

  // ---------- Read ----------

  @Get("machines")
  machines(@Req() req: AuthedRequest) {
    return this.pp.machines(req.user.email);
  }

  @Get("operations/all")
  operationsAll(@Req() req: AuthedRequest) {
    return this.pp.operationsAll(req.user.email);
  }

  @Get("operations/search")
  operationsSearch(@Req() req: AuthedRequest, @Query() q: SearchOpsQueryDto) {
    return this.pp.operationsSearch(req.user.email, q.q);
  }

  @Get("operations")
  operations(@Req() req: AuthedRequest, @Query() q: OperationsQueryDto) {
    return this.pp.operations(req.user.email, q);
  }

  @Get("cooperation/groups")
  cooperationGroups(@Req() req: AuthedRequest) {
    return this.pp.cooperationGroups(req.user.email);
  }

  @Get("cooperation")
  cooperation(@Req() req: AuthedRequest, @Query() q: CooperationQueryDto) {
    return this.pp.cooperation(req.user.email, q);
  }

  @Get("reassign/audit")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_FORCE)
  reassignAudit(@Req() req: AuthedRequest) {
    return this.pp.reassignAudit(req.user.email);
  }

  @Get("drawings")
  drawings(@Req() req: AuthedRequest, @Query() q: DrawingsQueryDto) {
    return this.pp.drawings(req.user.email, q);
  }

  @Get("tech-procedure/:workOrderId")
  techProcedure(
    @Req() req: AuthedRequest,
    @Param("workOrderId", ParseIntPipe) workOrderId: number,
  ) {
    return this.pp.techProcedure(req.user.email, workOrderId);
  }

  @Get("bridge-status")
  bridgeStatus(@Req() req: AuthedRequest) {
    return this.pp.bridgeStatus(req.user.email);
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
    return this.pp.bulkReassign(req.user.email, dto);
  }

  @Post("reassign")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  reassign(@Req() req: AuthedRequest, @Body() dto: ReassignDto) {
    this.assertForce(req.user.role, dto.force);
    return this.pp.reassign(req.user.email, dto);
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

  // ---------- Skice (edit) + bigtehn crteži (read + gate) ----------

  @Post("drawings")
  @RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_EDIT)
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * MB } }))
  uploadDrawing(
    @Req() req: AuthedRequest,
    @Body() dto: DrawingUploadDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.pp.uploadDrawing(req.user.email, dto.workOrder, dto.line, file);
  }

  // literal `drawings/bigtehn/sign` pre `drawings/:id/sign` (inače „bigtehn" → :id).
  @Get("drawings/bigtehn/sign")
  bigtehnDrawingSign(
    @Req() req: AuthedRequest,
    @Query() q: BigtehnDrawingSignQueryDto,
  ) {
    return this.pp.bigtehnDrawingSignUrl(req.user.email, q.code);
  }

  @Get("drawings/:id/sign")
  drawingSign(
    @Req() req: AuthedRequest,
    @Param("id", ParseIntPipe) id: number,
  ) {
    return this.pp.drawingSignUrl(req.user.email, String(id));
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
   * `force=true` reassign traži `plan_proizvodnje.force` (mirror guard enforce/shadow;
   * DB `can_force_plan_reassign()` je konačni gate). U shadow modu (AUTHZ_ENFORCE≠true)
   * DB i dalje presuđuje — paritet.
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
}
