import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { TechProcessesService } from "./tech-processes.service";
import type {
  CardQuery,
  CriticalQuery,
  ListTechProcessesQuery,
  RnProgressQuery,
  WorkerPerformanceQuery,
} from "./tech-processes.service";
import type { DecodeBarcodeDto } from "./dto/decode-barcode.dto";
import { validateDecodeBarcode } from "./dto/decode-barcode.dto";
import type { ScanTechProcessDto } from "./dto/scan-tech-process.dto";
import type { FinishTechProcessDto } from "./dto/finish-tech-process.dto";
import type { ControlTechProcessDto } from "./dto/control-tech-process.dto";
import type { StornoTechProcessDto } from "./dto/storno-tech-process.dto";

/**
 * Read-only API za tehnološke postupke (Tehnološki postupci / TP).
 *   GET /api/v1/tech-processes                    — lista (+ identNumber/projectId filter)
 *   GET /api/v1/tech-processes/card               — „Kartica TP": redovi trojke + sume (komadi/vreme)
 *   GET /api/v1/tech-processes/critical           — kritični postupci (severity 1/2/3 po roku)
 *   GET /api/v1/tech-processes/worker-performance — učinak po radniku u periodu (from/to)
 *   GET /api/v1/tech-processes/rn-progress        — „Pregled RN — statusi delova" (planirano vs napravljeno)
 *   GET /api/v1/tech-processes/:id                — jedan TP + radnik + dokumentacija
 *
 *   GET  /api/v1/tech-processes/worker            ?card=…                                 — radnik iz ID kartice (kiosk login)
 *   GET  /api/v1/tech-processes/label             ?workOrderId=…&quantity=…               — podaci za nalepnicu (RNZ)
 *
 *   POST /api/v1/tech-processes/barcode/decode    { barcode }                             — parsira/validira JEDAN barkod
 *   POST /api/v1/tech-processes/scan              { orderBarcode, operationBarcode, pieceCount, workerCard? } — barkod prijava rada
 *   POST /api/v1/tech-processes/:id/finish        { pieceCount?, note?, workerCard? }      — zatvaranje postupka
 *   POST /api/v1/tech-processes/control           { orderBarcode, operationBarcode, workerCard, pieceCount, qualityTypeId, locations[], note? } — ZAVRŠNA KONTROLA (create-on-scan)
 *
 * Traži JWT; read=`tehnologija.read`, write=`tehnologija.write` (V1 no-op guard,
 * V2 aktivacija). Mutacije odobrene (ODLUKE 2026-07-08: proizvodne tabele =
 * ServoSync vlasništvo). `rework` (dorada/škart → novi nalog) dolazi u P2.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
@Controller({ path: "tech-processes", version: "1" })
export class TechProcessesController {
  constructor(private readonly techProcesses: TechProcessesService) {}

  @Get()
  list(
    @Query() query: ListTechProcessesQuery,
    @Req() req: { user: AuthUser },
  ) {
    // Row-scope: proizvodni_radnik → samo svoje mašine (ScopeService).
    return this.techProcesses.list(query, req.user);
  }

  @Get("card")
  card(@Query() query: CardQuery) {
    return this.techProcesses.card(query);
  }

  @Get("critical")
  critical(@Query() query: CriticalQuery) {
    return this.techProcesses.critical(query);
  }

  @Get("worker-performance")
  workerPerformance(@Query() query: WorkerPerformanceQuery) {
    return this.techProcesses.workerPerformance(query);
  }

  @Get("rn-progress")
  rnProgress(@Query() query: RnProgressQuery) {
    return this.techProcesses.rnProgress(query);
  }

  @Get("worker")
  worker(@Query("card") card: string) {
    return this.techProcesses.identifyWorker(card);
  }

  @Get("label")
  label(@Query() query: { workOrderId?: string; quantity?: string }) {
    return this.techProcesses.label(query);
  }

  // Kiosk (pogon): prijava rada = `tehnologija.report_work` (radnik/tehnolog/CNC/šef),
  // finalna kontrola = `tehnologija.approve` (kontrolor/šef/menadžment). Poravnato sa nav
  // gejtovanjem (Kucanje=report_work, Kontrola=approve) da enforce ne blokira pogon.
  @Post("barcode/decode")
  @HttpCode(200) // čist parse/read — ništa se ne kreira, ne 201
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  decodeBarcode(@Body() dto: DecodeBarcodeDto) {
    validateDecodeBarcode(dto);
    return this.techProcesses.decodeBarcode(dto.barcode);
  }

  @Post("scan")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  scan(@Body() dto: ScanTechProcessDto) {
    return this.techProcesses.scan(dto);
  }

  @Post(":id/finish")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  finish(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: FinishTechProcessDto,
  ) {
    return this.techProcesses.finish(id, dto);
  }

  @Post("control")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_APPROVE)
  control(@Body() dto: ControlTechProcessDto) {
    return this.techProcesses.control(dto);
  }

  /** STORNO otkucane operacije (kontra-red, ne briše). */
  @Post(":id/storno")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  storno(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: StornoTechProcessDto,
  ) {
    return this.techProcesses.storno(id, dto);
  }

  /** Audited brisanje otkucane operacije (snapshot u audit_log pa brisanje). */
  @Delete(":id")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  deleteEntry(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto?: { note?: string },
  ) {
    return this.techProcesses.deleteEntry(id, dto);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.techProcesses.findOne(id);
  }
}
