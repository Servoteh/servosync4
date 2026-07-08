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
import { DirectoryService } from "./directory.service";
import type {
  ListCustomersQuery,
  ListProjectsQuery,
} from "./directory.service";

/**
 * Read-only pregled BigBit cache šifarnika (Komitenti + Predmeti).
 *   GET /api/v1/directory/customers      — lista (filteri: q po naziv/PIB/mesto)
 *   GET /api/v1/directory/customers/:id  — detalj
 *   GET /api/v1/directory/projects       — lista (filteri: q, customerId, status, from, to)
 *   GET /api/v1/directory/projects/:id   — detalj + broj RN-ova predmeta
 *
 * BigBit je vlasnik ovih tabela do 4.0 (BACKEND_RULES §3) — modul NEMA mutacija.
 * Traži JWT; permisija `directory.read` (V1 no-op guard, V2 aktivacija).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.DIRECTORY_READ)
@Controller({ path: "directory", version: "1" })
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get("customers")
  listCustomers(@Query() query: ListCustomersQuery) {
    return this.directory.listCustomers(query);
  }

  @Get("customers/:id")
  findCustomer(@Param("id", ParseIntPipe) id: number) {
    return this.directory.findCustomer(id);
  }

  @Get("projects")
  listProjects(@Query() query: ListProjectsQuery) {
    return this.directory.listProjects(query);
  }

  @Get("projects/:id")
  findProject(@Param("id", ParseIntPipe) id: number) {
    return this.directory.findProject(id);
  }
}
