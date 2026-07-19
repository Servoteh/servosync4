import {
  Body,
  Controller,
  Get,
  Header,
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
