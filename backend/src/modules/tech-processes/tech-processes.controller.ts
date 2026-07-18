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
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthUser } from "../auth/jwt.strategy";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { TechProcessesService } from "./tech-processes.service";
import { SessionAutoCloseService } from "./session-auto-close.service";
import { PdmService } from "../pdm/pdm.service";
import { PrismaService } from "../../prisma/prisma.service";
import type {
  CardQuery,
  CriticalQuery,
  ListTechProcessesQuery,
  RnProgressQuery,
  SessionQuery,
  StopWorkByIdBody,
  WorkerPerformanceQuery,
} from "./tech-processes.service";
import type { DecodeBarcodeDto } from "./dto/decode-barcode.dto";
import { validateDecodeBarcode } from "./dto/decode-barcode.dto";
import type { ScanTechProcessDto } from "./dto/scan-tech-process.dto";
import type { FinishTechProcessDto } from "./dto/finish-tech-process.dto";
import type { ControlTechProcessDto } from "./dto/control-tech-process.dto";
import type { StornoTechProcessDto } from "./dto/storno-tech-process.dto";
import type { StartWorkDto } from "./dto/start-work.dto";
import type { StopWorkDto } from "./dto/stop-work.dto";
import type { PrintLabelDto } from "./dto/print-label.dto";

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
  constructor(
    private readonly techProcesses: TechProcessesService,
    // Q11: auto-close visećih sesija preko kapije (odvojen servis, ne bloatati God-service).
    private readonly sessionAutoClose: SessionAutoCloseService,
    private readonly pdm: PdmService,
    // SEC-02: audit pristupa PDF-u crteža (traceability, best-effort).
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Query() query: ListTechProcessesQuery, @Req() req: { user: AuthUser }) {
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

  /** DNEVNIK PROIZVODNJE — evidentirana aktivnost po danu (A-4). Mora pre `:id`. */
  @Get("sessions/daily")
  sessionsDaily(@Query() query: SessionQuery) {
    return this.techProcesses.sessionsDaily(query);
  }

  /** ZBIR PO OPERACIJAMA — utrošeno vreme vs normirano (A-4). */
  @Get("sessions/summary")
  sessionsSummary(@Query() query: SessionQuery) {
    return this.techProcesses.sessionsSummary(query);
  }

  /** PO SATU — iskorišćenost po satu (A-4). */
  @Get("sessions/hourly")
  sessionsHourly(@Query() query: SessionQuery) {
    return this.techProcesses.sessionsHourly(query);
  }

  /** LOŠE EVIDENTIRANI — sesije bez ispravnog START/STOP para (A-4). */
  @Get("sessions/poorly-recorded")
  sessionsPoorlyRecorded(@Query() query: SessionQuery) {
    return this.techProcesses.sessionsPoorlyRecorded(query);
  }

  @Get("worker")
  worker(@Query("card") card: string) {
    return this.techProcesses.identifyWorker(card);
  }

  /** Radnik vezan za prijavljeni nalog (`users.worker_id`) — kiosk preskače karticu; null za deljene naloge. */
  @Get("worker/me")
  workerMe(@Req() req: { user: AuthUser }) {
    return this.techProcesses.identifyWorkerFromUser(req.user);
  }

  /**
   * „Moji otvoreni" (kiosk, proba 13.07): otvoreni postupci radnika + plan +
   * `hasOpenSession` — zatvaranje iz liste ide postojećim `POST /:id/finish`,
   * bez ponovnog skeniranja. Radnik = kartica (`?card=`) ili prijavljeni nalog.
   */
  @Get("worker/open")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  workerOpen(
    @Query("card") card: string | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.techProcesses.openForWorker(card, req.user);
  }

  @Get("label")
  label(@Query() query: { workOrderId?: string; quantity?: string }) {
    return this.techProcesses.label(query);
  }

  /** RAW TSPL2 → mrežni termalni štampač (server-side; browser ne dira localhost). */
  @Post("labels/print")
  @HttpCode(200) // slanje bajtova štampaču — ništa se ne kreira u bazi
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  printLabel(@Body() dto: PrintLabelDto) {
    return this.techProcesses.printRawLabel(dto);
  }

  /** Stanje sesije za (radnik, operacija) iz barkodova — vodi kiosk START/STOP. */
  @Get("work/open")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  openSession(
    @Query()
    query: {
      orderBarcode?: string;
      operationBarcode?: string;
      workerCard?: string;
    },
  ) {
    return this.techProcesses.openSession(query);
  }

  // Kiosk (pogon): prijava rada = `tehnologija.report_work` (radnik/tehnolog/CNC/šef),
  // finalna kontrola = `tehnologija.approve` (kontrolor/šef/menadžment). Poravnato sa nav
  // gejtovanjem (Kucanje=report_work, Kontrola=approve) da enforce ne blokira pogon.
  @Post("barcode/decode")
  @HttpCode(200) // čist parse/read — ništa se ne kreira, ne 201
  // READ (ne report_work): dekodiranje je čist parse bez upisa — treba i kontroloru
  // (kiosk KONTROLA skenira nalog/operaciju pre `control`) i menadžmentu (approve bez kucanja).
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
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

  /**
   * „Kraj rada" iz „Moji otvoreni" (kiosk): završava RAD po `tech_processes` id-ju
   * (bez barkodova — radnik iz ID kartice ili prijavljenog naloga). Zatvara njegovu
   * otvorenu sesiju + akumulira komade, ista logika kao `POST /work/stop`.
   */
  @Post(":id/stop-work")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  stopWorkById(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: StopWorkByIdBody,
    @Req() req: { user: AuthUser },
  ) {
    return this.techProcesses.stopWorkById(id, body, req.user);
  }

  /**
   * „Odustani" iz „Moji otvoreni" (kiosk): zatvara SVOJ pogrešno otvoren red BEZ
   * dodavanja komada (za redove otvorene greškom kroz probu). Isti nivo dozvole kao
   * „Kraj rada" (report_work) — kiosk operater čisti svoje redove.
   */
  @Post(":id/dismiss")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  dismissEntry(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: StopWorkByIdBody,
    @Req() req: { user: AuthUser },
  ) {
    return this.techProcesses.dismissEntry(id, body, req.user);
  }

  @Post("control")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_APPROVE)
  control(@Body() dto: ControlTechProcessDto) {
    return this.techProcesses.control(dto);
  }

  /** START skena („dva skena") — otvara vremensku sesiju. */
  @Post("work/start")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  startWork(@Body() dto: StartWorkDto) {
    return this.techProcesses.startWork(dto);
  }

  /** STOP skena („dva skena") — zatvara sesiju + akumulira komade. */
  @Post("work/stop")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_REPORT_WORK)
  stopWork(@Body() dto: StopWorkDto) {
    return this.techProcesses.stopWork(dto);
  }

  /**
   * Auto-close otvorenih sesija (poziva eksterni cron). Gate: `tehnologija.write`.
   * Q11: zatvaranje ide preko evidencije kapije (izlaz → vreme izlaska; bez izlaza →
   * neispravno kucanje + e-mail šefu; nemapiran/bez kapije → 0 trajanje).
   */
  @Post("work/auto-close")
  @HttpCode(200)
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  autoClose(@Body() body?: { olderThanHours?: number }) {
    return this.sessionAutoClose.run(body?.olderThanHours);
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

  /** Ponovo otvori zatvorenu operaciju (dorada) — tehnolog/šef. */
  @Post(":id/reopen")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_WRITE)
  reopen(@Param("id", ParseIntPipe) id: number) {
    return this.techProcesses.reopen(id);
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

  /**
   * Uskladišten PDF crteža (stream) — KIOSK ruta. Kiosk rola (`proizvodni_radnik`)
   * ima TEHNOLOGIJA_READ ali NE PDM_READ, pa `GET /pdm/drawings/:id/pdf/content`
   * (PDM_READ) vraća 403 na kiosku. Ova ruta strimuje isti sadržaj pod
   * TEHNOLOGIJA_READ (delegira na `PdmService.getPdfContent`). Putanja
   * `drawings/:id/pdf/content` je jedinstvena (ne kolidira sa `:id`).
   * `?download=true` → attachment; inače inline (prikaz u browseru).
   */
  @Get("drawings/:id/pdf/content")
  @RequirePermission(PERMISSIONS.TEHNOLOGIJA_READ)
  async pdfContent(
    @Param("id", ParseIntPipe) id: number,
    @Query("download") download: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Req() req: { user: AuthUser },
  ): Promise<StreamableFile> {
    // SEC-02: traceability pristupa PDF-u crteža (ko, kada, koji crtež). Deljeni
    // kiosk terminal + samo TEHNOLOGIJA_READ omogućava enumeraciju id-eva; audit
    // ostavlja trag da se to VIDI. BEST-EFFORT: pad audita NE sme da obori strim.
    void this.prisma.auditLog
      .create({
        data: {
          action: "DRAWING-PDF-ACCESS",
          entityType: "drawing",
          entityId: String(id),
          actorUserId: req.user?.userId ?? null,
          actorUsername: req.user?.email ?? null,
          metadata: { route: "kiosk", download: download === "true" },
        },
      })
      .catch(() => {});

    const { buffer, fileName } = await this.pdm.getPdfContent(id);
    const disposition = download === "true" ? "attachment" : "inline";
    // `fileName` može nositi dijakritike — Node setHeader odbija znakove van latin1
    // (ERR_INVALID_CHAR → 500). ASCII fallback u `filename=` + RFC 5987 `filename*`
    // sa punim UTF-8 imenom (browseri biraju filename*). Isti obrazac kao pdm.controller.
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "crtez.pdf";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    });
    return new StreamableFile(buffer);
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.techProcesses.findOne(id);
  }
}
