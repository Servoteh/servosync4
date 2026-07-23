import {
  Body,
  Controller,
  Get,
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
import {
  KamataService,
  type CreateRateDto,
  type ComputeInterestDto,
} from "./kamata.service";

/**
 * KAMATA (obračun zatezne kamate) — XL modul.
 *   GET  /api/v1/kamata/rates                 — registar kamatnih stopa
 *   POST /api/v1/kamata/rates                 — nova stopa (zatezna/ugovorna, effective-dated)
 *   POST /api/v1/kamata/compute               — obračun nad otvorenim dospelim stavkama komitenta
 *   GET  /api/v1/kamata/calculations          — lista kamatnih listova
 *   GET  /api/v1/kamata/calculations/:id      — kamatni list (detalj)
 *
 * Permisije: read=KAMATA_READ, unos stope/obračun=KAMATA_WRITE.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KAMATA_READ)
@Controller({ path: "kamata", version: "1" })
export class KamataController {
  constructor(private readonly kamata: KamataService) {}

  @Get("rates")
  listRates(@Query("kind") kind?: string) {
    return this.kamata.listRates(kind);
  }

  @Post("rates")
  @RequirePermission(PERMISSIONS.KAMATA_WRITE)
  createRate(@Body() dto: CreateRateDto) {
    return this.kamata.createRate(dto);
  }

  @Post("compute")
  @RequirePermission(PERMISSIONS.KAMATA_WRITE)
  compute(@Body() dto: ComputeInterestDto, @Req() req: { user: AuthUser }) {
    return this.kamata.compute(dto, req.user);
  }

  @Get("calculations")
  listCalculations(@Query("partnerId") partnerId?: string) {
    return this.kamata.listCalculations(
      partnerId ? Number(partnerId) : undefined,
    );
  }

  @Get("calculations/:id")
  getCalculation(@Param("id", ParseIntPipe) id: number) {
    return this.kamata.getCalculation(id);
  }
}
