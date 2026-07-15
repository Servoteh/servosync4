import {
  Body,
  Controller,
  Delete,
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
import { QualityService } from "./kvalitet.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreateNonconformityReportDto } from "./dto/create-nonconformity-report.dto";
import type { UpdateNonconformityReportDto } from "./dto/update-nonconformity-report.dto";
import type {
  ListNonconformityReportsQuery,
  SummaryMiniQuery,
} from "./dto/nonconformity-report.query";

/**
 * Kontrola kvaliteta — evidencija neusaglašenosti (škart + dorada),
 * MODULE_SPEC_kontrola_kvaliteta §4–§7.
 *   GET    /api/v1/kvalitet/reports             — lista (type/status/from/to/q + paginacija)
 *   GET    /api/v1/kvalitet/summary-mini        — mini agregat (bedževi „na čekanju")
 *   GET    /api/v1/kvalitet/reports/:id         — detalj + izvršioci
 *   POST   /api/v1/kvalitet/reports             — ručni draft (status=0, bez broja)
 *   PATCH  /api/v1/kvalitet/reports/:id         — izmena polja + izvršilaca
 *   POST   /api/v1/kvalitet/reports/:id/confirm — dodela broja NNN/YY (status=1)
 *   DELETE /api/v1/kvalitet/reports/:id         — SAMO draft (potvrđen → 422)
 *
 * Read = KVALITET_READ (class-level); write rute override na KVALITET_WRITE.
 * Potvrda: bilo koji kontrolor ILI šef/menadžment (kvalitet.write).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KVALITET_READ)
@Controller({ path: "kvalitet", version: "1" })
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get("reports")
  list(@Query() query: ListNonconformityReportsQuery) {
    return this.quality.listReports(query);
  }

  @Get("summary-mini")
  summaryMini(@Query() query: SummaryMiniQuery) {
    return this.quality.summaryMini(query);
  }

  @Get("reports/:id")
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.quality.getReport(id);
  }

  @Post("reports")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  create(
    @Body() dto: CreateNonconformityReportDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.quality.createReport(dto, req.user);
  }

  @Patch("reports/:id")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateNonconformityReportDto,
  ) {
    return this.quality.updateReport(id, dto);
  }

  @Post("reports/:id/confirm")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  confirm(@Param("id", ParseIntPipe) id: number) {
    return this.quality.confirmReport(id);
  }

  @Delete("reports/:id")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.quality.deleteReport(id);
  }
}
