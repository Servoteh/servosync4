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
import { PlanMontazeService } from "./plan-montaze.service";
import {
  DrawingsLookupQueryDto,
  PredmetiLookupQueryDto,
  ProjectsQueryDto,
  ReportsQueryDto,
} from "./dto/plan-montaze-query.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Plan montaže + izveštaji montera — 3.0 TALAS C, R1 read endpointi
 * (MODULE_SPEC_planovi_pracenje_30.md §3). Klasa: `montaza.read` (modul „Montaža" je
 * UNGATED u 1.0 → svaka aktivna rola). Row-odluka (has_edit_role project-scope za edit,
 * autor-scope izveštaja) presuđuje sy15 kroz `withUserRls`. Mutacije (faze/WP CRUD,
 * izveštaji POST + AI port + storage, ai-model PUT) su R2 — ovde ih NEMA.
 *
 * ⚠️ Route ordering: literali (`projects`, `ai-model`, `lookups/*`) i `reports/:id/photos`
 * pre bare `reports/:id`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.MONTAZA_READ)
@Controller({ path: "montaza", version: "1" })
export class PlanMontazeController {
  constructor(private readonly montaza: PlanMontazeService) {}

  @Get("projects")
  projects(@Req() req: AuthedRequest, @Query() _q: ProjectsQueryDto) {
    void _q; // include=tree je default (§3); ostavljeno za deep-link paritet
    return this.montaza.projectsTree(req.user.email);
  }

  @Get("reports")
  reports(@Req() req: AuthedRequest, @Query() q: ReportsQueryDto) {
    return this.montaza.listReports(req.user.email, q);
  }

  @Get("reports/:id/photos")
  reportPhotos(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.montaza.reportPhotos(req.user.email, id);
  }

  @Get("reports/:id")
  reportDetail(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.montaza.reportDetail(req.user.email, id);
  }

  @Get("ai-model")
  aiModel(@Req() req: AuthedRequest) {
    return this.montaza.aiModel(req.user.email);
  }

  @Get("lookups/predmeti")
  lookupPredmeti(@Req() req: AuthedRequest, @Query() q: PredmetiLookupQueryDto) {
    return this.montaza.lookupPredmeti(req.user.email, q.q);
  }

  @Get("lookups/drawings")
  lookupDrawings(@Req() req: AuthedRequest, @Query() q: DrawingsLookupQueryDto) {
    return this.montaza.lookupDrawings(req.user.email, q.codes);
  }
}
