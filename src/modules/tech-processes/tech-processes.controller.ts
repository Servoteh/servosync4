import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { TechProcessesService } from "./tech-processes.service";
import type {
  CardQuery,
  CriticalQuery,
  ListTechProcessesQuery,
  RnProgressQuery,
  WorkerPerformanceQuery,
} from "./tech-processes.service";

/**
 * Read-only API za tehnološke postupke (Tehnološki postupci / TP).
 *   GET /api/v1/tech-processes                    — lista (+ identNumber/projectId filter)
 *   GET /api/v1/tech-processes/card               — „Kartica TP": redovi trojke + sume (komadi/vreme)
 *   GET /api/v1/tech-processes/critical           — kritični postupci (severity 1/2/3 po roku)
 *   GET /api/v1/tech-processes/worker-performance — učinak po radniku u periodu (from/to)
 *   GET /api/v1/tech-processes/rn-progress        — „Pregled RN — statusi delova" (planirano vs napravljeno)
 *   GET /api/v1/tech-processes/:id                — jedan TP + radnik + dokumentacija
 *
 * Traži JWT; permisija `tehnologija.read` (V1 no-op guard, V2 aktivacija).
 * Mutacije (barkod/finish/rework) dolaze kasnije, gejtovane RBAC + §11 odlukama.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
@Controller({ path: "tech-processes", version: "1" })
export class TechProcessesController {
  constructor(private readonly techProcesses: TechProcessesService) {}

  @Get()
  list(@Query() query: ListTechProcessesQuery) {
    return this.techProcesses.list(query);
  }

  @Get("card")
  card(@Query() query: CardQuery) {
    return this.techProcesses.card(query);
  }

  @Get("critical")
  critical(@Query() query: CriticalQuery) {
    return this.techProcesses.critical(query);
  }

  @Get("worker-performance")
  workerPerformance(@Query() query: WorkerPerformanceQuery) {
    return this.techProcesses.workerPerformance(query);
  }

  @Get("rn-progress")
  rnProgress(@Query() query: RnProgressQuery) {
    return this.techProcesses.rnProgress(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.techProcesses.findOne(id);
  }
}
