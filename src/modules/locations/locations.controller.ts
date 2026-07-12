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
import { LocationsService } from "./locations.service";
import type {
  ListLocationsQuery,
  ListMovementsQuery,
  ListPlacementsQuery,
  PredmetTpsQuery,
  ReportByLocationQuery,
} from "./locations.service";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Lokacije delova — 3.0 Talas A, R1 READ endpointi (MODULE_SPEC_lokacije_30.md §3).
 * Klasni gate = `lokacije.read` (živa politika: SELECT za sve prijavljene). Method
 * override-i: `lokacije.manage` (istorija definicija), `lokacije.admin` (sync/outbound).
 * Mutacije (movements/cage-move/CRUD/labels/sync arm) su R2 — ovde ih namerno NEMA.
 *
 * VAŽNO: statičke rute (placements/movements/...) su deklarisane PRE parametarske
 * `:id` — inače bi Express „:id" pojeo `/locations/placements` (ParseUUIDPipe → 400).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.LOKACIJE_READ)
@Controller({ path: "locations", version: "1" })
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  // ---------- Lokacije (šifarnik + hijerarhija) ----------

  @Get()
  listLocations(@Query() query: ListLocationsQuery) {
    return this.locations.listLocations(query);
  }

  // ---------- Placements / Movements ----------

  @Get("placements")
  listPlacements(@Query() query: ListPlacementsQuery) {
    return this.locations.listPlacements(query);
  }

  @Get("movements")
  listMovements(@Query() query: ListMovementsQuery) {
    return this.locations.listMovements(query);
  }

  // ---------- Izveštaji ----------

  @Get("reports/by-location")
  reportByLocation(
    @Req() req: AuthedRequest,
    @Query() query: ReportByLocationQuery,
  ) {
    return this.locations.reportByLocation(query, req.user.email);
  }

  @Get("reports/suggest-naziv-dela")
  reportSuggest(@Req() req: AuthedRequest, @Query("q") q?: string) {
    return this.locations.reportSuggestNazivDela(q, req.user.email);
  }

  // ---------- Pregled predmeta ----------

  @Get("predmet/:itemId/tps")
  predmetTps(
    @Req() req: AuthedRequest,
    @Param("itemId") itemId: string,
    @Query() query: PredmetTpsQuery,
  ) {
    return this.locations.predmetTps(itemId, query, req.user.email);
  }

  // ---------- Lookups ----------

  @Get("lookups/validate-order")
  validateOrder(@Req() req: AuthedRequest, @Query("orderNo") orderNo?: string) {
    return this.locations.validateOrder(orderNo, req.user.email);
  }

  /** Skener resolver (RNZ/short/compact stavke + shelf) — paritet 1.0 (spec §3). */
  @Get("lookups/barcode")
  lookupBarcode(@Query("code") code?: string) {
    return this.locations.lookupBarcode(code);
  }

  // ---------- Istorija definicija (manage) ----------

  @Get("definitions-audit")
  @RequirePermission(PERMISSIONS.LOKACIJE_MANAGE)
  definitionsAudit(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    return this.locations.definitionsAudit(limit, req.user.email);
  }

  // ---------- Sync (admin) ----------

  @Get("sync/status")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncStatus(@Req() req: AuthedRequest) {
    return this.locations.syncStatus(req.user.email);
  }

  @Get("sync/outbound")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncOutbound(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    return this.locations.syncOutbound(limit, req.user.email);
  }

  // ---------- Jedna lokacija po id (PARAMETARSKA — MORA biti poslednja) ----------

  @Get(":id")
  findLocation(@Param("id", ParseUUIDPipe) id: string) {
    return this.locations.findLocation(id);
  }
}
