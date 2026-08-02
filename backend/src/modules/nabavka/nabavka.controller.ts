import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { NabavkaService } from "./nabavka.service";
import { RfqPdfService } from "./rfq-pdf.service";
import {
  PurchaseOrderPdfService,
  type PurchaseOrderPrintVariant,
} from "./print/purchase-order-pdf.service";
import { MatchReportPdfService } from "./print/match-report-pdf.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreatePurchaseRequestDto } from "./dto/create-purchase-request.dto";
import type { CreatePurchaseOrderDto } from "./dto/create-purchase-order.dto";
import type { AcceptQuoteDto } from "./dto/accept-quote.dto";

/**
 * NACRT — Nabavka (Traka B §B). Operativni tok (Nenad):
 *   preuzimaju i klikću administratori nabavke/prodaje + njihovi šefovi + admin;
 *   nabavka posle ODOBRAVA. Otud posebne permisije za approve.
 *
 *   GET  /api/v1/nabavka/requests                  — radna lista zahteva (status, projectId, paginacija)
 *   POST /api/v1/nabavka/requests                  — kreiraj zahtev (broj NNNN/god server)
 *   POST /api/v1/nabavka/requests/:id/submit       — DRAFT → SUBMITTED (inženjer)
 *   POST /api/v1/nabavka/requests/:id/approve       — SUBMITTED → APPROVED (nabavka)
 *   POST /api/v1/nabavka/requests/:id/send-rfq      — napravi + auto-mail upit dobavljaču (quick-win)
 *   POST /api/v1/nabavka/orders/:id/receive         — prijem robe (3-way match)
 *
 * Permisije: read=NABAVKA_READ, mutacije=NABAVKA_WRITE, odobravanje=NABAVKA_APPROVE.
 * (Nove permisije se PRVO dodaju u backend authz katalog, pa u frontend permissions.ts mirror.)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.NABAVKA_READ)
@Controller({ path: "nabavka", version: "1" })
export class NabavkaController {
  constructor(
    private readonly nabavka: NabavkaService,
    private readonly rfqPdf: RfqPdfService,
    private readonly orderPdf: PurchaseOrderPdfService,
    private readonly matchPdf: MatchReportPdfService,
  ) {}

  /**
   * Jedinstvena isporuka PDF-a: `application/pdf` inline (pregled u browseru +
   * download), naziv fajla iz servisa. Isti obrazac kao `sales.controller`.
   */
  private sendPdf(
    res: Response,
    doc: { buffer: Buffer; fileName: string },
  ): void {
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(doc.fileName)}"`,
    );
    res.send(doc.buffer);
  }

  /** Trag štampe u nozi dokumenta (BigBit štampa samo Now(), bez korisnika). */
  private printedBy(user: AuthUser | undefined): string | null {
    return user?.email ?? null;
  }

  @Get("requests")
  listRequests(
    @Query("status") status?: string,
    @Query("projectId") projectId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nabavka.listRequests({
      status,
      projectId: projectId ? Number(projectId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  /**
   * Jedan zahtev sa stavkama — ekran `/nabavka/detalj?id=N`. Bez ove rute je
   * detalj morao da se izvodi iz prvih 500 redova liste, pa se stariji zahtev
   * video u listi a nije mogao da se otvori.
   */
  @Get("requests/:id")
  getRequest(@Param("id", ParseIntPipe) id: number) {
    return this.nabavka.getRequestDetail(id);
  }

  @Post("requests")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  createRequest(
    @Body() dto: CreatePurchaseRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.createRequest(dto, req.user);
  }

  @Post("requests/:id/submit")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  submit(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.submitRequest(id, req.user);
  }

  @Post("requests/:id/approve")
  @RequirePermission(PERMISSIONS.NABAVKA_APPROVE)
  approve(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.approveRequest(id, req.user);
  }

  @Post("requests/:id/send-rfq")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  sendRfq(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { supplierId: number; supplierEmail: string },
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.createAndSendRfq(
      id,
      body.supplierId,
      body.supplierEmail,
      req.user,
    );
  }

  // ── Upiti dobavljačima (RFQ) ──────────────────────────────────────────────
  @Get("rfqs")
  listRfqs(
    @Query("status") status?: string,
    @Query("supplierId") supplierId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nabavka.listRfqs({
      status,
      supplierId: supplierId ? Number(supplierId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("rfqs/:id")
  getRfq(@Param("id", ParseIntPipe) id: number) {
    return this.nabavka.getRfq(id);
  }

  /**
   * Štampa upita za ponudu (PDF). `RfqPdfService` je postojao od početka, ali samo
   * kao prilog auto-mailu — bez ove rute upit se NIJE mogao odštampati iz aplikacije.
   * Opcioni `deadline` (ISO datum) ispisuje rok za dostavu ponude. Permisija NABAVKA_READ.
   */
  @Get("rfqs/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async rfqPdfDownload(
    @Param("id", ParseIntPipe) id: number,
    @Query("deadline") deadline: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = deadline ? new Date(deadline) : undefined;
    const doc = await this.rfqPdf.buildRfqPdf(
      id,
      parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined,
    );
    this.sendPdf(res, doc);
  }

  @Post("rfqs/:id/accept")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  acceptQuote(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: AcceptQuoteDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.acceptQuote(id, body, req.user);
  }

  // ── Narudžbenice (PO) ─────────────────────────────────────────────────────
  @Get("orders")
  listOrders(
    @Query("status") status?: string,
    @Query("supplierId") supplierId?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nabavka.listOrders({
      status,
      supplierId: supplierId ? Number(supplierId) : undefined,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("orders/:id")
  getOrder(@Param("id", ParseIntPipe) id: number) {
    return this.nabavka.getOrder(id);
  }

  /**
   * Štampa narudžbenice dobavljaču (PDF). `variant=bezCena` daje primerak za
   * magacin (BigBit ima dva odvojena izveštaja — kod nas jedan šablon).
   * Permisija NABAVKA_READ (štampa je pregled).
   */
  @Get("orders/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async orderPdfDownload(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const v: PurchaseOrderPrintVariant =
      variant === "bezCena" ? "withoutPrices" : "withPrices";
    const doc = await this.orderPdf.buildPurchaseOrderPdf(id, {
      variant: v,
      printedBy: this.printedBy(req.user),
    });
    this.sendPdf(res, doc);
  }

  @Post("orders")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  createOrder(
    @Body() dto: CreatePurchaseOrderDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.createOrder(dto, req.user);
  }

  @Post("orders/:id/sign")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  signOrder(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.markOrderSigned(id, req.user);
  }

  @Post("orders/:id/lock")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  lockOrder(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.markOrderLocked(id, req.user);
  }

  @Post("orders/:id/receive")
  @RequirePermission(PERMISSIONS.NABAVKA_WRITE)
  receive(
    @Param("id", ParseIntPipe) id: number,
    @Body()
    body: { lines: Array<{ itemId: number; receivedQuantity?: number }> },
    @Req() req: { user: AuthUser },
  ) {
    return this.nabavka.receiveOrder(id, body.lines ?? [], req.user);
  }

  // ── 3-way match (Batch C) ───────────────────────────────────────────────────
  // Poređenje naručeno / primljeno / fakturisano. Nalazi su UPOZORENJA — po
  // odluci korisnika ništa se ne blokira, ni ovde ni u pripremi plaćanja.

  /** Poređenje po stavkama jedne narudžbenice. */
  @Get("orders/:id/match")
  getOrderMatch(@Param("id", ParseIntPipe) id: number) {
    return this.nabavka.getOrderMatch(id);
  }

  /**
   * Štampa poređenja jedne narudžbenice (A4 položeno, po stavci + spisak nalaza).
   * Nalazi ostaju OBAVEŠTENJE — štampa ništa ne blokira. Permisija NABAVKA_READ.
   */
  @Get("orders/:id/match/pdf")
  @Header("Content-Type", "application/pdf")
  async orderMatchPdf(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const doc = await this.matchPdf.buildOrderMatchPdf(id, {
      printedBy: this.printedBy(req.user),
    });
    this.sendPdf(res, doc);
  }

  /** Pregled odstupanja po više narudžbenica. */
  @Get("match-summary")
  getMatchSummary(
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("supplierId") supplierId?: string,
    @Query("onlyWithFindings") onlyWithFindings?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.nabavka.getMatchSummary({
      from,
      to,
      supplierId:
        supplierId != null && supplierId !== ""
          ? Number(supplierId)
          : undefined,
      onlyWithFindings: onlyWithFindings === "true",
      skip: skip != null && skip !== "" ? Number(skip) : undefined,
      take: take != null && take !== "" ? Number(take) : undefined,
    });
  }

  /**
   * Štampa pregleda odstupanja (A4 položeno) sa trakom primenjenih filtera.
   * Isti filteri kao ekran; `skip` se namerno ne prima — izveštaj pokriva ceo
   * period, ne stranu ekrana. Permisija NABAVKA_READ.
   */
  @Get("match-summary/pdf")
  @Header("Content-Type", "application/pdf")
  async matchSummaryPdf(
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("supplierId") supplierId?: string,
    @Query("onlyWithFindings") onlyWithFindings?: string,
    @Query("take") take?: string,
  ): Promise<void> {
    const doc = await this.matchPdf.buildMatchSummaryPdf(
      {
        from,
        to,
        supplierId:
          supplierId != null && supplierId !== ""
            ? Number(supplierId)
            : undefined,
        onlyWithFindings: onlyWithFindings === "true",
        take: take != null && take !== "" ? Number(take) : undefined,
      },
      { printedBy: this.printedBy(req.user) },
    );
    this.sendPdf(res, doc);
  }
}
