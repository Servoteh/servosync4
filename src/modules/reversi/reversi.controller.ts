import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ReversiService } from "./reversi.service";
import type {
  ConsumptionReportQuery,
  InventoryUnitsQuery,
  LedgerQuery,
  ListDocumentsQuery,
  ListToolsQuery,
  RecipientCardinalityQuery,
} from "./reversi.service";
import {
  JsonPayloadTxDto,
  SeedStockDto,
  StockDeltaDto,
  TxBaseDto,
  WriteOffDto,
} from "./dto/reversi-tx.dto";
import { BulkImportToolsDto } from "./dto/reversi-bulk.dto";
import {
  CuttingToolCreateDto,
  CuttingToolUpdateDto,
} from "./dto/reversi-cutting.dto";
import {
  AddSubgroupDto,
  AddSubsubgroupDto,
  CreateToolDto,
  RenameClassificationDto,
  ReversiPrintLabelDto,
  UpdateToolDto,
} from "./dto/reversi-inventory.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Reversi — 3.0 PILOT, R1 read endpoints (MODULE_SPEC_reversi.md §4).
 * Paritet žive 1.0 politike (42 politike, snapshot 10.07 — 0 drift vs sy15):
 *   - klasa: `reversi.read` (SELECT za sve prijavljene),
 *   - `/ledger`: `reversi.manage` (jedini ne-javni read — rev_tool_stock_ledger_select),
 *   - `/reports/team-issued`: `reversi.team_read` + row-scope u DB fn.
 * Mutacije (issue/return/otpis/inventar, idempotency) su R2 — ovde ih namerno NEMA.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.REVERSI_READ)
@Controller({ path: "reversi", version: "1" })
export class ReversiController {
  constructor(private readonly reversi: ReversiService) {}

  @Get("documents")
  listDocuments(@Query() query: ListDocumentsQuery) {
    return this.reversi.listDocuments(query);
  }

  /**
   * KPI kartica „Primaoci (aktivno)" (RB-16) — broj različitih primalaca na
   * aktivnim reversima uz kontekst-filtere (mesec/tip/pretraga). Statička ruta
   * je DEKLARISANA PRE `documents/:id` (inače ParseUUIDPipe odbije putanju).
   */
  @Get("documents/recipient-cardinality")
  recipientCardinality(@Query() query: RecipientCardinalityQuery) {
    return this.reversi.recipientCardinality(query);
  }

  /**
   * Otvorena ISSUED linija ručnog alata po barkodu — Quick Return skener (RB-43/44
   * HAND). NIJE user-scoped (nalazi tuđi otvoren revers); `reversi.read` (otkrivanje
   * linije nije role-gated — kao cutting open-lines). Statička pre `documents/:id`.
   */
  @Get("documents/open-hand-line")
  openHandLine(@Query("barcode") barcode?: string) {
    return this.reversi.openHandLineByBarcode(barcode);
  }

  @Get("documents/:id")
  findDocument(@Param("id", ParseUUIDPipe) id: string) {
    return this.reversi.findOneDocument(id);
  }

  @Get("tools")
  listTools(@Query() query: ListToolsQuery) {
    return this.reversi.listTools(query);
  }

  @Get("tools/:id")
  findTool(@Param("id", ParseUUIDPipe) id: string) {
    return this.reversi.findOneTool(id);
  }

  @Get("inventory-tree")
  inventoryTree() {
    return this.reversi.inventoryTree();
  }

  /**
   * Lista pojedinačnih jedinica inventara (RA-14/16/17; izvor stat kartica RA-10;
   * pageSize do 5000 za CSV izvoz RA-23). Server-side status/klasifikacija/sort/
   * paginacija; svaki red nosi zaduženje/lokaciju.
   */
  @Get("inventory-units")
  inventoryUnits(@Query() query: InventoryUnitsQuery) {
    return this.reversi.listInventoryUnits(query);
  }

  /** Broj artikala po podgrupi/podpodgrupi (RA-25 brojači, RA-28 upozorenja). */
  @Get("inventory-classification-usage")
  classificationUsage() {
    return this.reversi.inventoryClassificationUsage();
  }

  @Get("ledger")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  listLedger(@Query() query: LedgerQuery) {
    return this.reversi.listLedger(query);
  }

  @Get("reports/my-issued")
  myIssued(@Req() req: AuthedRequest) {
    return this.reversi.reportMyIssued(req.user.email);
  }

  @Get("reports/my-consumed")
  myConsumed(@Req() req: AuthedRequest) {
    return this.reversi.reportMyConsumed(req.user.email);
  }

  @Get("reports/my-machines-cutting")
  myMachinesCutting(@Req() req: AuthedRequest) {
    return this.reversi.reportMyMachinesCutting(req.user.email);
  }

  @Get("reports/team-issued")
  @RequirePermission(PERMISSIONS.REVERSI_TEAM_READ)
  teamIssued(@Req() req: AuthedRequest) {
    return this.reversi.reportTeamIssued(req.user.email);
  }

  @Get("reports/warehouse")
  warehouse(@Query("allLocations") allLocations?: string) {
    return this.reversi.reportWarehouse(allLocations === "true");
  }

  /**
   * Izveštaj potrošnje (RA-39/40/41) — period (from/to) + tip pokreta (reason) iz
   * ledgera. Manage-gated kao `/ledger` (jedini ne-javni read); FE agregira + CSV
   * (fetch-all, do `limit` redova). Statička ruta pod `reports/` — bez :id sudara.
   */
  @Get("reports/consumption")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  consumption(@Query() query: ConsumptionReportQuery) {
    return this.reversi.reportConsumption(query);
  }

  @Get("reports/scrapped")
  scrapped() {
    return this.reversi.reportScrapped();
  }

  @Get("reports/machines")
  machines() {
    return this.reversi.reportMachines();
  }

  @Get("reports/cutting-by-machine")
  cuttingByMachine(@Query("machineCode") machineCode?: string) {
    return this.reversi.cuttingByMachine(machineCode);
  }

  @Get("machines/:code/heads")
  machineHeads(@Param("code") code: string) {
    return this.reversi.machineHeads(code);
  }

  // ---------- Rezni alat (katalog) ----------

  @Get("cutting-tools")
  listCuttingTools(@Query("q") q?: string) {
    return this.reversi.listCuttingTools(q);
  }

  /**
   * Otvorene ISSUED linije reznog alata prijavljenog korisnika za skenirani barkod
   * (FIFO po issued_at) — podrška povraćaju (RC-17/32). reversi.read (klasni default);
   * povraćaj na otkrivanju linija NIJE role-gated (paritet 1.0).
   */
  @Get("cutting-tools/open-lines")
  cuttingOpenLines(
    @Req() req: AuthedRequest,
    @Query("barcode") barcode?: string,
  ) {
    return this.reversi.cuttingOpenLines(req.user.email, barcode);
  }

  @Post("cutting-tools")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  createCuttingTool(
    @Req() req: AuthedRequest,
    @Body() dto: CuttingToolCreateDto,
  ) {
    return this.reversi.createCuttingTool(req.user.email, dto);
  }

  @Patch("cutting-tools/:id")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  updateCuttingTool(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CuttingToolUpdateDto,
  ) {
    return this.reversi.updateCuttingTool(req.user.email, id, dto);
  }

  @Get("lookups/employees")
  lookupEmployees(@Query("q") q?: string) {
    return this.reversi.lookupEmployees(q);
  }

  /** Aktivne lokacije za dropdown povraćaja (RB-45) — paritet 1.0 fetchActiveLocations. */
  @Get("lookups/locations")
  lookupLocations() {
    return this.reversi.lookupLocations();
  }

  /** Razrešavanje skeniranog barkoda (ALAT-/RZN-/card) — paritet 1.0 resolveReversiBarcode. */
  @Get("lookups/barcode")
  lookupBarcode(@Query("code") code?: string) {
    return this.reversi.lookupBarcode(code);
  }

  /** Bulk-import inventara ručnog alata (XLSX/CSV parsira klijent, šalje redove). */
  @Post("bulk-import/tools")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  bulkImportTools(@Body() dto: BulkImportToolsDto) {
    return this.reversi.bulkImportTools(dto.rows);
  }

  // ---------- R1: inventar (nova jedinica / izmena artikla) + klasifikacija + štampa ----------

  /** Nova jedinica ručnog alata (RB-46) — INSERT rev_tools + opc. INITIAL_PLACEMENT. */
  @Post("tools")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  createTool(@Req() req: AuthedRequest, @Body() dto: CreateToolDto) {
    return this.reversi.createTool(req.user.email, dto);
  }

  /** Izmena artikla ručnog alata (RB-11) — PATCH rev_tools; P2025→404. */
  @Patch("tools/:id")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  updateTool(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateToolDto,
  ) {
    return this.reversi.updateTool(id, dto);
  }

  /** Dodaj user-defined podgrupu (RA-26) — rev_add_inventory_subgroup. */
  @Post("inventory-subgroups")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  addSubgroup(@Req() req: AuthedRequest, @Body() dto: AddSubgroupDto) {
    return this.reversi.addInventorySubgroup(req.user.email, dto);
  }

  /** Dodaj podpodgrupu (RA-26) — rev_add_inventory_subsubgroup. */
  @Post("inventory-subsubgroups")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  addSubsubgroup(@Req() req: AuthedRequest, @Body() dto: AddSubsubgroupDto) {
    return this.reversi.addInventorySubsubgroup(req.user.email, dto);
  }

  /** Preimenovanje nivoa klasifikacije (RA-27) — group|subgroup|subsubgroup. */
  @Patch("inventory-classification/:kind/:id")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  renameClassification(
    @Param("kind") kind: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: RenameClassificationDto,
  ) {
    return this.reversi.renameClassification(kind, id, dto.label);
  }

  /** Brisanje korisničke podgrupe (RA-28) — artikli postaju nesvrstani. */
  @Delete("inventory-subgroups/:id")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  deleteSubgroup(@Param("id", ParseUUIDPipe) id: string) {
    return this.reversi.deleteInventorySubgroup(id);
  }

  /** Brisanje korisničke podpodgrupe (RA-28). */
  @Delete("inventory-subsubgroups/:id")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  deleteSubsubgroup(@Param("id", ParseUUIDPipe) id: string) {
    return this.reversi.deleteInventorySubsubgroup(id);
  }

  /** Štampa barkod-nalepnica (RA-22 bulk / RB-47 pri dodavanju) — RAW TSPL2. */
  @Post("labels/print")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  printLabel(@Body() dto: ReversiPrintLabelDto) {
    return this.reversi.printLabel(dto);
  }

  // ---------- R2: transakcione akcije (sve manage; idempotency = clientEventId) ----------

  @Post("issue")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  issue(@Req() req: AuthedRequest, @Body() dto: JsonPayloadTxDto) {
    return this.reversi.issue(req.user.email, dto);
  }

  @Post("return")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  confirmReturn(@Req() req: AuthedRequest, @Body() dto: JsonPayloadTxDto) {
    return this.reversi.confirmReturn(req.user.email, dto);
  }

  @Post("cutting-issue")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  cuttingIssue(@Req() req: AuthedRequest, @Body() dto: JsonPayloadTxDto) {
    return this.reversi.cuttingIssue(req.user.email, dto);
  }

  @Post("cutting-return")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  cuttingReturn(@Req() req: AuthedRequest, @Body() dto: JsonPayloadTxDto) {
    return this.reversi.cuttingReturn(req.user.email, dto);
  }

  @Post("tools/:id/stock-delta")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  stockDelta(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: StockDeltaDto,
  ) {
    return this.reversi.stockDelta(req.user.email, id, dto);
  }

  @Post("cutting-tools/:id/seed-stock")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  seedStock(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SeedStockDto,
  ) {
    return this.reversi.seedStock(req.user.email, id, dto);
  }

  @Post("tools/:id/write-off")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  writeOff(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: WriteOffDto,
  ) {
    return this.reversi.writeOff(req.user.email, id, dto);
  }

  @Post("tools/:id/restore")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  restore(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: TxBaseDto,
  ) {
    return this.reversi.restore(req.user.email, id, dto);
  }

  // ---------- R2: potpisnica PDF (spec §7) ----------

  @Post("documents/:id/signature-pdf")
  @RequirePermission(PERMISSIONS.REVERSI_MANAGE)
  @UseInterceptors(FileInterceptor("file"))
  uploadSignaturePdf(
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.reversi.uploadSignaturePdf(id, file);
  }

  @Get("documents/:id/signature-pdf")
  signaturePdfUrl(@Param("id", ParseUUIDPipe) id: string) {
    return this.reversi.getSignaturePdfUrl(id);
  }
}
