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
import { ProjektniBiroService } from "./projektni-biro.service";
import {
  ListTasksQueryDto,
  LoadStatsQueryDto,
  TipsQueryDto,
  WorkReportSummaryQueryDto,
  WorkReportsQueryDto,
} from "./dto/pb-query.dto";

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
}
