import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { VatLedgerService } from "./vat-ledger.service";
import { PopdvService } from "./popdv.service";
import { KepuService } from "./kepu.service";

/**
 * PDV / POPDV kontroler (Faza 6). Izvedena PDV evidencija iz glavne knjige.
 *
 *   GET  /api/v1/pdv/kif?year=&month=            — KIF (izlazne fakture) za period
 *   GET  /api/v1/pdv/kuf?year=&month=            — KUF (ulazne fakture) za period
 *   POST /api/v1/pdv/kif-kuf/build                — napuni KIF/KUF iz GK za period
 *   POST /api/v1/pdv/popdv/compute                — POPDV obračun (VatReturn + linije)
 *   GET  /api/v1/pdv/returns?year=                — sačuvani PDV obračuni
 *   GET  /api/v1/pdv/kepu?year=&month=&warehouseId= — KEPU rekapitulacija
 *
 * Permisije: read = PDV_READ; obračun/punjenje = PDV_COMPUTE.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDV_READ)
@Controller({ path: "pdv", version: "1" })
export class PdvController {
  constructor(
    private readonly vatLedger: VatLedgerService,
    private readonly popdv: PopdvService,
    private readonly kepu: KepuService,
  ) {}

  @Get("kif")
  async listKif(@Query("year") year: string, @Query("month") month: string) {
    const data = await this.vatLedger.listKif(Number(year), Number(month));
    return { data, meta: { count: data.length } };
  }

  @Get("kuf")
  async listKuf(@Query("year") year: string, @Query("month") month: string) {
    const data = await this.vatLedger.listKuf(Number(year), Number(month));
    return { data, meta: { count: data.length } };
  }

  @Post("kif-kuf/build")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async buildKifKuf(@Body() body: { year: number; month: number }) {
    const data = await this.vatLedger.buildKifKuf(
      Number(body.year),
      Number(body.month),
    );
    return { data };
  }

  @Post("popdv/compute")
  @RequirePermission(PERMISSIONS.PDV_COMPUTE)
  async computePopdv(
    @Body() body: { year: number; month?: number; quarter?: number },
  ) {
    const data = await this.popdv.compute({
      year: Number(body.year),
      month: body.month != null ? Number(body.month) : undefined,
      quarter: body.quarter != null ? Number(body.quarter) : undefined,
    });
    return { data };
  }

  @Get("returns")
  async listReturns(@Query("year") year?: string) {
    const data = await this.popdv.listReturns(
      year != null ? Number(year) : undefined,
    );
    return { data, meta: { count: data.length } };
  }

  @Get("kepu")
  async kepuRecap(
    @Query("year") year: string,
    @Query("month") month?: string,
    @Query("warehouseId") warehouseId?: string,
  ) {
    const data = await this.kepu.recap(
      Number(year),
      month != null ? Number(month) : undefined,
      warehouseId != null ? Number(warehouseId) : undefined,
    );
    return { data, meta: { count: data.length } };
  }
}
