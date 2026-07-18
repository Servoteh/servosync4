import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
import type { PrintLabelDto } from "../../common/printing/print-label.dto";
import { LocationsService } from "./locations.service";
import { LocTpFeedService } from "./loc-tp-feed.service";
import type {
  ListLocationsQuery,
  ListMovementsQuery,
  ListPlacementsQuery,
  PredmetTpsQuery,
  PredmetWorkOrdersQuery,
  ReportByLocationQuery,
} from "./locations.service";
import {
  CageMoveDto,
  CreateLocationDto,
  CreateMovementDto,
  SyncArmDto,
  SyncRunNowDto,
  UpdateLocationDto,
} from "./dto/locations-tx.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Lokacije delova — 3.0 Talas A, R1 READ + R2 MUTACIJE (MODULE_SPEC_lokacije_30.md §3).
 * Klasni gate = `lokacije.read` (živa politika: SELECT za sve prijavljene). Method
 * override-i po živoj politici (spec §2): `lokacije.move` (movements = loc_can_create_movement),
 * `lokacije.manage` (CRUD + cage-move + definitions-audit = loc_can_manage_locations),
 * `lokacije.admin` (sync = loc_is_admin), `lokacije.labels` (štampa = 1.0 canPrintLocLabels).
 *
 * NAPOMENA (cage-move): DB fn `loc_move_cage` traži `loc_can_manage_locations()` (manage,
 * NE move) — zato je guard `lokacije.manage` (paritet spec §3 + živa fn; usklađeno sa
 * e2e matricom), premda R2 instrukcija pominje „move".
 *
 * VAŽNO: statičke rute (placements/movements/sync/...) su deklarisane PRE parametarskih
 * (`GET :id`, `PATCH :id`) — inače bi Express „:id" pojeo statičku putanju (400).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.LOKACIJE_READ)
@Controller({ path: "locations", version: "1" })
export class LocationsController {
  constructor(
    private readonly locations: LocationsService,
    private readonly feed: LocTpFeedService,
  ) {}

  // ---------- Lokacije (šifarnik + hijerarhija) ----------

  @Get()
  listLocations(@Query() query: ListLocationsQuery) {
    return this.locations.listLocations(query);
  }

  // ---------- Placements / Movements ----------

  @Get("placements")
  listPlacements(
    @Req() req: AuthedRequest,
    @Query() query: ListPlacementsQuery,
  ) {
    // withUserRls: RLS `loc_placements_select` krije rev_tools od ne-manage (email → GUC).
    return this.locations.listPlacements(query, req.user.email);
  }

  @Get("movements")
  listMovements(@Query() query: ListMovementsQuery) {
    return this.locations.listMovements(query);
  }

  /**
   * Puna lista movera za „Korisnik" filter (DISTINCT moved_by + ime) — paritet 1.0
   * loadHistoryUsers; FE više ne puni dropdown iz učitane strane (gubio movere).
   * MORA pre `GET :id` i pre `GET movements` ne kvari (obe statičke).
   */
  @Get("movements/movers")
  movementMovers() {
    return this.locations.movementMovers();
  }

  /** Početna KPI — premeštanja u poslednja 24h / 7 dana (paritet 1.0 dashboard count-ovi). */
  @Get("summary")
  summary() {
    return this.locations.summary();
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

  /**
   * SVI RN za predmet (batch nalepnice) — v_bigtehn_work_orders_with_mes_active po
   * item_id BEZ is_mes_active filtera (loc_tps_for_predmet gubi ~77% RN). onlyOpen=1
   * → samo otvoreni (status_rn=false). Guard = klasni lokacije.read (WO cache je
   * čitljiv svim prijavljenima; nije row-scoped).
   */
  @Get("predmet/:itemId/work-orders")
  predmetWorkOrders(
    @Param("itemId") itemId: string,
    @Query() query: PredmetWorkOrdersQuery,
  ) {
    return this.locations.predmetWorkOrders(itemId, query);
  }

  // ---------- Lookups ----------

  @Get("lookups/validate-order")
  validateOrder(@Req() req: AuthedRequest, @Query("orderNo") orderNo?: string) {
    return this.locations.validateOrder(orderNo, req.user.email);
  }

  /** Skener resolver (RNZ/short/compact stavke + shelf) — paritet 1.0 (spec §3). */
  @Get("lookups/barcode")
  lookupBarcode(@Req() req: AuthedRequest, @Query("code") code?: string) {
    // ITEM razrešenje čita loc_item_placements (row-scoped) → withUserRls (email → GUC).
    return this.locations.lookupBarcode(req.user.email, code);
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

  /** B1 loc-most: stanje feed watermarka (loc_tp_feed_state) — runbook verifikacija. */
  @Get("sync/feed-status")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncFeedStatus() {
    return this.feed.status();
  }

  /**
   * LOK-P3: READ-ONLY zdravlje sync-a za SVE uloge modula (klasni `lokacije.read`,
   * BEZ admin override-a) — samo boolovi (cacheStale + workerHealthy), bez admin
   * detalja. Omogućava ne-adminu (magacioner/cnc) da vidi upozorenja iz 1.0 bannera
   * (audit L-06/L-07) koja su do sada bila gejtovana pod `sync/status` (ADMIN).
   */
  @Get("sync/health")
  syncHealth(@Req() req: AuthedRequest) {
    return this.locations.syncHealth(req.user.email);
  }

  // ==================== R2: MUTACIJE ====================

  /** Pokret (SVE tipove) — loc_create_movement(jsonb); idempotencija = client_event_uuid. */
  @Post("movements")
  @RequirePermission(PERMISSIONS.LOKACIJE_MOVE)
  createMovement(@Req() req: AuthedRequest, @Body() dto: CreateMovementDto) {
    return this.locations.createMovement(req.user.email, dto);
  }

  /** Premeštaj kaveza u drugu halu — loc_move_cage (manage; vidi napomenu iznad). */
  @Post("cage-move")
  @RequirePermission(PERMISSIONS.LOKACIJE_MANAGE)
  moveCage(@Req() req: AuthedRequest, @Body() dto: CageMoveDto) {
    return this.locations.moveCage(req.user.email, dto);
  }

  /** Nova master lokacija (Prisma INSERT nad loc_locations; RLS/triger paritet). */
  @Post()
  @RequirePermission(PERMISSIONS.LOKACIJE_MANAGE)
  createLocation(@Req() req: AuthedRequest, @Body() dto: CreateLocationDto) {
    return this.locations.createLocation(req.user.email, dto);
  }

  /** Štampa nalepnica (police + TP) — reuse deljenog 2.0 TSPL2 transporta. */
  @Post("labels/print")
  @RequirePermission(PERMISSIONS.LOKACIJE_LABELS)
  printLabel(@Body() dto: PrintLabelDto) {
    return this.locations.printLabel(dto);
  }

  /** Sync: arm/disarm bigtehn ingest worker — loc_bigtehn_ingest_arm (admin). */
  @Post("sync/arm")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncArm(@Req() req: AuthedRequest, @Body() dto: SyncArmDto) {
    return this.locations.syncArm(req.user.email, dto.armed);
  }

  /**
   * Sync: ručno okidanje ingest-a — loc_bigtehn_ingest_run_now (admin).
   * PLK-02: traži `{ confirm: true }` u telu (400 bez nje) da slučajan/dupli POST
   * ne okine realan ingest posao.
   */
  @Post("sync/run-now")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncRunNow(@Req() req: AuthedRequest, @Body() _dto: SyncRunNowDto) {
    return this.locations.syncRunNow(req.user.email);
  }

  /**
   * B1 loc-most: feed 2.0 → sy15 bigtehn cache (zamena bridge PRODUCTION job-a;
   * RUNBOOK_LOC_MOST_REPOINT.md). `{ confirm: true }` obavezan (PLK-02 obrazac,
   * kao run-now) — feed pomera watermark, slučajan POST ne sme da ga okine.
   */
  @Post("sync/feed-run")
  @RequirePermission(PERMISSIONS.LOKACIJE_ADMIN)
  syncFeedRun(@Body() _dto: SyncRunNowDto) {
    return this.feed.run();
  }

  // ---------- Parametarske rute (:id) — MORA posle statičkih ----------

  /** Izmena master lokacije (Prisma UPDATE; SAMO 1.0-editabilna polja). */
  @Patch(":id")
  @RequirePermission(PERMISSIONS.LOKACIJE_MANAGE)
  updateLocation(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.locations.updateLocation(req.user.email, id, dto);
  }

  @Get(":id")
  findLocation(@Param("id", ParseUUIDPipe) id: string) {
    return this.locations.findLocation(id);
  }
}
