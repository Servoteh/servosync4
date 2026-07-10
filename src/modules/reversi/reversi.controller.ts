import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  LedgerQuery,
  ListDocumentsQuery,
  ListToolsQuery,
} from "./reversi.service";
import {
  JsonPayloadTxDto,
  SeedStockDto,
  StockDeltaDto,
  TxBaseDto,
  WriteOffDto,
} from "./dto/reversi-tx.dto";

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

  @Get("reports/scrapped")
  scrapped() {
    return this.reversi.reportScrapped();
  }

  @Get("reports/machines")
  machines() {
    return this.reversi.reportMachines();
  }

  @Get("lookups/employees")
  lookupEmployees(@Query("q") q?: string) {
    return this.reversi.lookupEmployees(q);
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
