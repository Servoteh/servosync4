import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { DirectoryService } from "./directory.service";
import { rejectCustomerWrite, rejectProjectWrite } from "./bigbit-owned";
import type {
  ListCustomersQuery,
  ListProjectsQuery,
} from "./directory.service";

/**
 * Read-only pregled BigBit šifarnika (Komitenti + Predmeti).
 *   GET /api/v1/directory/customers      — lista (filteri: q po naziv/PIB/mesto)
 *   GET /api/v1/directory/customers/:id  — detalj
 *   GET /api/v1/directory/projects       — lista (filteri: q, customerId, status, from, to)
 *   GET /api/v1/directory/projects/:id   — detalj + broj RN-ova predmeta
 *
 * BigBit je vlasnik ovih tabela (BACKEND_RULES §3; odluka vlasnika 26.07.2026 —
 * vidi `bigbit-owned.ts`). Modul nema pravih mutacija; POST/PATCH rute ispod postoje
 * SAMO da bi klijent koji pokuša upis dobio srpsku poruku šta da radi umesto nemog 404.
 * Traži JWT; permisija `directory.read`.
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

  // ── UPIS JE ZATVOREN (odluka 26.07.2026) ────────────────────────────────────
  // Rute namerno postoje i vraćaju 409 sa uputstvom; brisanje bi dalo 404 iz kog se
  // ne vidi ZAŠTO. Permisija je nasleđena klasna `directory.read` — svako ko sme da
  // gleda šifarnik dobija objašnjenje, a ne „nemate pravo".

  @Post("customers")
  createCustomer(): never {
    rejectCustomerWrite();
  }

  @Patch("customers/:id")
  updateCustomer(): never {
    rejectCustomerWrite();
  }

  @Post("projects")
  createProject(): never {
    rejectProjectWrite();
  }

  @Patch("projects/:id")
  updateProject(): never {
    rejectProjectWrite();
  }
}
