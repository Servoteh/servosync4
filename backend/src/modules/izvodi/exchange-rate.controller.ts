import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { ExchangeRateService } from "./exchange-rate.service";
import type {
  CopyExchangeRatesDto,
  CreateExchangeRateDto,
  UpdateExchangeRateDto,
} from "./dto/exchange-rate.dto";

/**
 * KURSNA LISTA (ExchangeRate → `exchange_rates`) — registar + datumski resolver kursa.
 *   GET   /api/v1/izvodi/exchange-rates           — lista (?currency=&from=&to=, default 60 dana)
 *   GET   /api/v1/izvodi/exchange-rates/resolve   — kurs na dan (?currency=&on=&type=sell|middle|buy)
 *   POST  /api/v1/izvodi/exchange-rates           — nova kursna stavka
 *   POST  /api/v1/izvodi/exchange-rates/copy-from — prepiši sve valute (fromDate → toDate)
 *   PATCH /api/v1/izvodi/exchange-rates/:id        — izmena kursne stavke
 *
 * Permisije (iste kao izvodi.controller): read = IZVODI_READ; unos/izmena/prepis =
 * IZVODI_IMPORT (write). Modul se registruje u izvodi.module.ts (controller + provider,
 * export servisa za konverziju stavke) — v. moduleRegistrations.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.IZVODI_READ)
@Controller({ path: "izvodi/exchange-rates", version: "1" })
export class ExchangeRateController {
  constructor(private readonly exchangeRates: ExchangeRateService) {}

  @Get()
  list(
    @Query("currency") currency?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.exchangeRates.list({ currency, from, to });
  }

  @Get("resolve")
  resolve(
    @Query("currency") currency?: string,
    @Query("on") on?: string,
    @Query("type") type?: string,
  ) {
    return this.exchangeRates.resolveEnvelope(currency, on, type);
  }

  @Post()
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  create(@Body() dto: CreateExchangeRateDto) {
    return this.exchangeRates.create(dto);
  }

  @Post("copy-from")
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  copyFrom(@Body() dto: CopyExchangeRatesDto) {
    return this.exchangeRates.copyFrom(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateExchangeRateDto,
  ) {
    return this.exchangeRates.update(id, dto);
  }
}
