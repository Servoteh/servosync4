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
import { rejectProjectWrite } from "../directory/bigbit-owned";
import { CustomerRfqService } from "./customer-rfq.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type {
  CreateCustomerRfqDto,
  UpdateCustomerRfqDto,
} from "./dto/customer-rfq.dto";

/**
 * Zahtevi kupaca za ponudu (CustomerRfq) — 4.0-native modul.
 *
 *   GET   /api/v1/rfqs                          — lista zahteva (status/customer/unlinked)
 *   POST  /api/v1/rfqs                          — kreiraj zahtev
 *   GET   /api/v1/rfqs/:id                      — jedan zahtev
 *   PATCH /api/v1/rfqs/:id                      — izmeni zahtev (uklj. vezivanje predmeta)
 *
 * ODLUKA VLASNIKA 26.07.2026 — PREDMETI SE VIŠE NE OTVARAJU KOD NAS (vidi
 * `../directory/bigbit-owned.ts`). Zato su ugašeni:
 *   • `POST /api/v1/projects` i `PATCH /api/v1/projects/:id` — rute su zadržane samo
 *     da vrate 409 sa uputstvom (`ProjectsWriteService` i `ProjectNumberingService`
 *     su OBRISANI — 3.0 nema više sopstvenu numeraciju predmeta);
 *   • `POST /api/v1/rfqs/:id/create-project` — „Napravi predmet iz zahteva" isto vraća
 *     409; zamena je: otvori predmet u BigBit-u, sačekaj uvoz, pa ga veži na zahtev
 *     preko `PATCH /api/v1/rfqs/:id` sa `{ projectId }`.
 *
 * Permisije: RFQ read/write = RFQ_READ / RFQ_WRITE (ostaju — zahtevi za ponudu su naši).
 * `PROJECTS_WRITE` je uklonjen iz kataloga; ugašene project rute nose RFQ_READ da bi
 * korisnik dobio objašnjenje umesto 403.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller({ version: "1" })
export class ProjectsWriteController {
  constructor(private readonly rfqs: CustomerRfqService) {}

  // ── PREDMETI: UPIS ZATVOREN (odluka 26.07.2026) ─────────────────────────────

  @Post("projects")
  @RequirePermission(PERMISSIONS.RFQ_READ)
  createProject(): never {
    rejectProjectWrite();
  }

  @Patch("projects/:id")
  @RequirePermission(PERMISSIONS.RFQ_READ)
  updateProject(): never {
    rejectProjectWrite();
  }

  @Post("rfqs/:id/create-project")
  @RequirePermission(PERMISSIONS.RFQ_READ)
  createProjectFromRfq(): never {
    rejectProjectWrite();
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
  createRfq(@Body() dto: CreateCustomerRfqDto, @Req() req: { user: AuthUser }) {
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
}
