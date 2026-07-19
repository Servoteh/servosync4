import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ProjectsWriteService } from "./projects-write.service";
import { CustomerRfqService } from "./customer-rfq.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreateProjectDto } from "./dto/create-project.dto";
import type { UpdateProjectDto } from "./dto/update-project.dto";
import type {
  CreateCustomerRfqDto,
  UpdateCustomerRfqDto,
} from "./dto/customer-rfq.dto";

/**
 * NACRT — write-path predmeti + CustomerRfq (Traka B §A). ODVOJEN od read-only
 * `directory` (listProjects/findProject GET putanja netaknuta).
 *
 *   POST  /api/v1/projects                      — kreiraj predmet (broj server, workTypeId≠0)
 *   PATCH /api/v1/projects/:id                  — izmeni predmet
 *   GET   /api/v1/rfqs                          — lista zahteva za ponudu (status/customer/unlinked)
 *   POST  /api/v1/rfqs                          — kreiraj zahtev za ponudu
 *   GET   /api/v1/rfqs/:id                      — jedan zahtev
 *   PATCH /api/v1/rfqs/:id                      — izmeni zahtev
 *   POST  /api/v1/rfqs/:id/create-project       — „Napravi predmet iz zahteva" (write-back, idempotentno)
 *
 * Permisije: predmeti write = PROJECTS_WRITE; rfq read/write = RFQ_READ / RFQ_WRITE.
 * (Nove permisije se PRVO dodaju u backend authz katalog `permissions.ts` + role mapiranje,
 *  pa mirror u frontend/src/lib/permissions.ts — vidi README.nacrt.md aktivaciju.)
 *
 * NAPOMENA: dva resursa (projects, rfqs) žive u jednom modulu jer dele numeraciju i
 * „napravi predmet" tok; @Controller path je zato prazan, a rute nose pun prefiks.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ version: "1" })
export class ProjectsWriteController {
  constructor(
    private readonly projects: ProjectsWriteService,
    private readonly rfqs: CustomerRfqService,
  ) {}

  // ── PREDMETI (write-path) ───────────────────────────────────────────────────

  @Post("projects")
  @RequirePermission(PERMISSIONS.PROJECTS_WRITE)
  createProject(
    @Body() dto: CreateProjectDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.projects.createProject(dto, req.user);
  }

  @Patch("projects/:id")
  @RequirePermission(PERMISSIONS.PROJECTS_WRITE)
  updateProject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateProjectDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.projects.updateProject(id, req.user, dto);
  }

  // ── ZAHTEVI ZA PONUDU (CustomerRfq) ─────────────────────────────────────────

  @Get("rfqs")
  @RequirePermission(PERMISSIONS.RFQ_READ)
  listRfqs(
    @Query("status") status?: string,
    @Query("customerId") customerId?: string,
    @Query("unlinkedOnly") unlinkedOnly?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.rfqs.list({
      status,
      customerId: customerId ? Number(customerId) : undefined,
      unlinkedOnly: unlinkedOnly === "true" || unlinkedOnly === "1",
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("rfqs/:id")
  @RequirePermission(PERMISSIONS.RFQ_READ)
  getRfq(@Param("id", ParseIntPipe) id: number) {
    return this.rfqs.get(id);
  }

  @Post("rfqs")
  @RequirePermission(PERMISSIONS.RFQ_WRITE)
  createRfq(
    @Body() dto: CreateCustomerRfqDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.rfqs.create(dto, req.user);
  }

  @Patch("rfqs/:id")
  @RequirePermission(PERMISSIONS.RFQ_WRITE)
  updateRfq(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerRfqDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.rfqs.update(id, dto, req.user);
  }

  @Post("rfqs/:id/create-project")
  @RequirePermission(PERMISSIONS.RFQ_WRITE)
  createProjectFromRfq(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.rfqs.createProjectFromRfq(id, req.user);
  }
}
