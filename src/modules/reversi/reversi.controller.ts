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
import { ReversiService } from "./reversi.service";
import type {
  LedgerQuery,
  ListDocumentsQuery,
  ListToolsQuery,
} from "./reversi.service";

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
}
