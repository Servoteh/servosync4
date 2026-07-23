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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { PaymentPreparationService } from "./payment-preparation.service";
import { PaymentExportService } from "./payment-export.service";
import type { CreatePaymentOrdersDto } from "./dto/create-payment-orders.dto";
import { validateCreatePaymentOrders } from "./dto/create-payment-orders.dto";
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
