import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PlanProizvodnjeService } from "./plan-proizvodnje.service";
import {
  CooperationQueryDto,
  DrawingsQueryDto,
  OperationsQueryDto,
  SearchOpsQueryDto,
} from "./dto/plan-proizvodnje-query.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Plan proizvodnje — 3.0 TALAS C, R1 read endpointi (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Klasa: `plan_proizvodnje.read` (paritet 1.0 router gate `canAccessPlanProizvodnje`).
 * Reassign audit eskalira na `plan_proizvodnje.force` (admin/menadzment). Overlays/urgency/
 * reassign/drawings mutacije + koop admin su R2 — ovde ih NEMA.
 *
 * ⚠️ Route ordering: `operations/all` i `operations/search` (literali) pre bare `operations`;
 * `cooperation/groups` pre `cooperation`; `:workOrderId` u tech-procedure je poslednji segment.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PLAN_PROIZVODNJE_READ)
@Controller({ path: "plan-proizvodnje", version: "1" })
export class PlanProizvodnjeController {
  constructor(private readonly pp: PlanProizvodnjeService) {}

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
}
