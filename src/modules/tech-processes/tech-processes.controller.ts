import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { TechProcessesService } from "./tech-processes.service";
import type { ListTechProcessesQuery } from "./tech-processes.service";

/**
 * Read-only API for technological processes (Tehnološki postupci / TP).
 *   GET /api/v1/tech-processes        — paginated list (+ identNumber/projectId filter)
 *   GET /api/v1/tech-processes/:id    — single TP with worker + documents
 *
 * Requires a valid JWT (any authenticated user, per V1 auth). Mutations come
 * later, gated by RBAC + §11 decisions.
 */
@UseGuards(JwtAuthGuard)
@Controller({ path: "tech-processes", version: "1" })
export class TechProcessesController {
  constructor(private readonly techProcesses: TechProcessesService) {}

  @Get()
  list(@Query() query: ListTechProcessesQuery) {
    return this.techProcesses.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.techProcesses.findOne(id);
  }
}
