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
import type { AuthUser } from "../auth/jwt.strategy";
import { PaymentPreparationService } from "./payment-preparation.service";
import { PaymentExportService } from "./payment-export.service";
import { PaymentOrderPdfService } from "./payment-order-pdf.service";
import type { CreatePaymentOrdersDto } from "./dto/create-payment-orders.dto";
import { validateCreatePaymentOrders } from "./dto/create-payment-orders.dto";
import type { CreateManualPaymentOrderDto } from "./dto/create-manual-payment-order.dto";
import { validateCreateManualPaymentOrder } from "./dto/create-manual-payment-order.dto";
import type { ExportPaymentsDto } from "./dto/export-payments.dto";
import { validateExportPayments } from "./dto/export-payments.dto";

/**
 * Priprema plaćanja / virmani (Faza 4 §C).
 *   GET  /api/v1/placanja/due     — dospele obaveze iz otvorenih stavaka GK (cutoff=danas)
 *   POST /api/v1/placanja/orders  — kreiraj naloge za plaćanje (DEDUP dvostruko plaćanje)
 *   POST /api/v1/placanja/export  — izvoz u banku (FX TXT) + oznaka exportedAt
 *
 * Permisije: read=PLACANJA_READ, kreiranje/potpis=PLACANJA_PREPARE, izvoz=PLACANJA_EXPORT.
 * (Nove permisije su dodate u backend authz katalog; frontend mirror ide uz aktivaciju.)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PLACANJA_READ)
@Controller({ path: "placanja", version: "1" })
export class PlacanjaController {
  constructor(
    private readonly preparation: PaymentPreparationService,
    private readonly exporter: PaymentExportService,
    private readonly orderPdf: PaymentOrderPdfService,
  ) {}

  /** Dospele obaveze na dan `cutoff` (default danas). */
  @Get("due")
  async listDue(@Query("cutoff") cutoff?: string) {
    const at = cutoff ? new Date(cutoff) : new Date();
    const data = await this.preparation.selectDue(at);
    return { data, meta: { cutoff: at.toISOString(), count: data.length } };
  }

  /** Pregled kreiranih naloga za plaćanje (BigBit paritet — bez ovoga refresh gubi naloge). */
  @Get("orders")
  async listOrders(
    @Query("status") status?: string,
    @Query("supplierId") supplierId?: string,
    @Query("exported") exported?: string,
    @Query("dateFrom") dateFrom?: string,
    @Query("dateTo") dateTo?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.preparation.listOrders({
      status,
      supplierId: supplierId ? Number(supplierId) : undefined,
      exported:
        exported === "true" ? true : exported === "false" ? false : undefined,
      dateFrom,
      dateTo,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  /** CREATED → SIGNED (potpis naloga). */
  @Post("orders/:id/sign")
  @RequirePermission(PERMISSIONS.PLACANJA_PREPARE)
  async sign(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    await this.preparation.markSigned(id, req.user.userId);
    return { data: { id, status: "SIGNED" } };
  }

  /** Masovni potpis (BigBit PotpisiVirmane) — CREATED→SIGNED za listu naloga. */
  @Post("orders/sign-batch")
  @RequirePermission(PERMISSIONS.PLACANJA_PREPARE)
  async signBatch(
    @Body() body: { ids: number[] },
    @Req() req: { user: AuthUser },
  ) {
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    const result = await this.preparation.markSignedBatch(ids, req.user.userId);
    return { data: result };
  }

  /** SIGNED → PAID (nalog plaćen). */
  @Post("orders/:id/pay")
  @RequirePermission(PERMISSIONS.PLACANJA_PREPARE)
  async pay(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    await this.preparation.markPaid(id, req.user.userId);
    return { data: { id, status: "PAID" } };
  }

  /** Kreiraj naloge za plaćanje iz selekcije (DEDUP po poziv-na-broj + dobavljač). */
  @Post("orders")
  @RequirePermission(PERMISSIONS.PLACANJA_PREPARE)
  async createOrders(
    @Body() dto: CreatePaymentOrdersDto,
    @Req() req: { user: AuthUser },
  ) {
    validateCreatePaymentOrders(dto);
    const data = await this.preparation.createPaymentOrders(dto, req.user.userId);
    return { data, meta: { count: data.length } };
  }

  /**
   * RUČNI pojedinačni virman (BigBit UnosVirmana) — bez izvora iz saldakonta.
   * DobarTR validacija žiro računa; nalog ulazi u pregled kao CREATED.
   */
  @Post("orders/manual")
  @RequirePermission(PERMISSIONS.PLACANJA_PREPARE)
  async createManual(
    @Body() dto: CreateManualPaymentOrderDto,
    @Req() req: { user: AuthUser },
  ) {
    validateCreateManualPaymentOrder(dto);
    const data = await this.preparation.createManualOrder(dto, req.user.userId);
    return { data };
  }

  /**
   * Štampa virmana — obrazac „Nalog za prenos" (PDF, inline). Nasleđuje klasnu
   * PLACANJA_READ permisiju (read-only izlaz). 404 ako nalog ne postoji.
   */
  @Get("orders/:id/pdf")
  async printOrder(
    @Param("id", ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.orderPdf.buildOrderPdf(id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  /**
   * Izvoz naloga u banku (FX fiksni TXT). Vraća čist TXT (text/plain) —
   * banka-klijent učitava fajl. Nalozi se posle izvoza označavaju exportedAt.
   */
  @Post("export")
  @RequirePermission(PERMISSIONS.PLACANJA_EXPORT)
  @Header("Content-Type", "text/plain; charset=utf-8")
  async export(@Body() dto: ExportPaymentsDto): Promise<string> {
    validateExportPayments(dto);
    const { txt } = await this.exporter.exportFx(dto.orderIds, {
      debitAccount: dto.debitAccount,
      debitName: dto.debitName,
      debitPlace: dto.debitPlace,
      orderDate: dto.orderDate ? new Date(dto.orderDate) : undefined,
    });
    return txt;
  }
}
