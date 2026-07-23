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
import { TaxRatesService } from "./tax-rates.service";
import type {
  CreateTaxRateDto,
  UpdateTaxRateDto,
} from "./dto/tax-rates.dto";

/**
 * PORESKE TARIFE (R_Tarife → `tax_rates`) — registar + datumski resolver.
 *   GET   /api/v1/pdv/tax-rates              — lista tarifa (@PDV_READ)
 *   GET   /api/v1/pdv/tax-rates/resolve      — efektivna stopa (?code=X&on=YYYY-MM-DD, @PDV_READ)
 *   POST  /api/v1/pdv/tax-rates              — nova tarifa (@PDV_COMPUTE)
 *   PATCH /api/v1/pdv/tax-rates/:id          — izmena tarife (@PDV_COMPUTE)
 *
 * Permisije: read = PDV_READ; unos/izmena = PDV_COMPUTE. Modul se registruje
 * u pdv.module.ts (controller + provider) — v. moduleRegistrations.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDV_READ)
@Controller({ path: "pdv/tax-rates", version: "1" })
export class TaxRatesController {
  constructor(private readonly taxRates: TaxRatesService) {}

  @Get()
  list() {
    return this.taxRates.list();
  }

  @Get("resolve")
  resolve(@Query("code") code?: string, @Query("on") on?: string) {
    return this.taxRates.resolve(code, on);
  }

  @Post()
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  create(@Body() dto: CreateTaxRateDto) {
    return this.taxRates.create(dto);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  update(@Param("id", ParseIntPipe) id: number, @Body() dto: UpdateTaxRateDto) {
    return this.taxRates.update(id, dto);
  }
}
