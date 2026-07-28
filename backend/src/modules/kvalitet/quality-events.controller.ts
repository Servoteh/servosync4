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
import type { AuthUser } from "../auth/jwt.strategy";
import { QualityEventsService } from "./quality-events.service";
import type {
  ConfirmQualityEventDto,
  CreateQualityEventDto,
  PrijavaQualityEventDto,
  RejectQualityEventDto,
} from "./dto/quality-event.dto";
import type {
  ListQualityEventsQuery,
  QualityParetoQuery,
} from "./dto/quality-event.query";

/**
 * Škart i dorada — evidencija događaja kvaliteta (MODULE_SPEC_kvalitet_skart_dorada §3/§4).
 *   GET   /api/v1/kvalitet/reason-codes           — aktivni razlozi (za formu) [KVALITET_READ]
 *   GET   /api/v1/kvalitet/events                 — lista + filteri + red čekanja (pendingCount) [READ]
 *   GET   /api/v1/kvalitet/events/pareto          — zbir po razlogu/mašini (SAMO POTVRDJEN) [READ]
 *   GET   /api/v1/kvalitet/events/:id             — detalj [READ]
 *   POST  /api/v1/kvalitet/events                 — kontrolorski unos → POTVRDJEN [KVALITET_WRITE]
 *   POST  /api/v1/kvalitet/events/prijava         — kiosk prijava-signal → PRIJAVLJEN [TEHNOLOGIJA_REPORT_WORK]
 *   PATCH /api/v1/kvalitet/events/:id/potvrdi     — potvrda prijave → POTVRDJEN [KVALITET_WRITE]
 *   PATCH /api/v1/kvalitet/events/:id/odbaci      — odbacivanje prijave → ODBACEN [KVALITET_WRITE]
 *
 * Read = KVALITET_READ (class-level; kontrolor/šef/menadzment/tehnolog + admin). Kontrolorske
 * mutacije override na KVALITET_WRITE (kontrolor/šef/menadzment/admin; TEHNOLOG ima SAMO read).
 * Kiosk prijava override na TEHNOLOGIJA_REPORT_WORK (isti ključ kao prijava rada na kiosku) —
 * radnik prijavljuje, ali NE može da potvrdi. Zaseban kontroler od `QualityController`
 * (nonconformity_reports) uz istu bazu putanje „kvalitet"; segmenti su jedinstveni (bez kolizije).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KVALITET_READ)
@Controller({ path: "kvalitet", version: "1" })
export class QualityEventsController {
  constructor(private readonly events: QualityEventsService) {}

  @Get("reason-codes")
  reasonCodes() {
    return this.events.listReasonCodes();
  }

  @Get("events")
  list(@Query() query: ListQualityEventsQuery) {
    return this.events.list(query);
  }

  // NAPOMENA: `events/pareto` MORA pre `events/:id` (inače bi „pareto" pao na ParseIntPipe → 400).
  @Get("events/pareto")
  pareto(@Query() query: QualityParetoQuery) {
    return this.events.pareto(query);
  }

  @Get("events/:id")
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.events.getEvent(id);
  }

  @Post("events")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  create(@Body() dto: CreateQualityEventDto, @Req() req: { user: AuthUser }) {
    return this.events.createByController(dto, req.user);
  }

  @Post("events/prijava")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  prijava(@Body() dto: PrijavaQualityEventDto, @Req() req: { user: AuthUser }) {
    return this.events.prijava(dto, req.user);
  }

  @Patch("events/:id/potvrdi")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  confirm(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ConfirmQualityEventDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.events.confirm(id, dto, req.user);
  }

  @Patch("events/:id/odbaci")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  reject(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: RejectQualityEventDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.events.reject(id, dto, req.user);
  }
}
