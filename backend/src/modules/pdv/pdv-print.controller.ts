import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PdvPrintService } from "./pdv-print.service";

/**
 * PDV štampa (Talas 1D §D2). Regulatorni PDF izlazi — sve rute pod PDV_READ.
 *
 *   GET /api/v1/pdv/print/pp-pdv?period=YYYY-MM|YYYY-Qn  — obrazac PP-PDV
 *   GET /api/v1/pdv/print/kif?year=&month=               — KIF specifikacija
 *   GET /api/v1/pdv/print/kuf?year=&month=               — KUF specifikacija
 *
 * PDF se vraća inline (`application/pdf`) — pregled u browseru + download; isti
 * obrazac kao `SalesController.invoicePdfDownload`.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDV_READ)
@Controller({ path: "pdv/print", version: "1" })
export class PdvPrintController {
  constructor(private readonly print: PdvPrintService) {}

  @Get("pp-pdv")
  async ppPdv(
    @Query("period") period: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.print.buildPpPdvPdf(period);
    this.sendPdf(res, buffer, fileName);
  }

  @Get("kif")
  async kif(
    @Query("year") year: string,
    @Query("month") month: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.print.buildLedgerSpecPdf(
      "output",
      Number(year),
      Number(month),
    );
    this.sendPdf(res, buffer, fileName);
  }

  @Get("kuf")
  async kuf(
    @Query("year") year: string,
    @Query("month") month: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.print.buildLedgerSpecPdf(
      "input",
      Number(year),
      Number(month),
    );
    this.sendPdf(res, buffer, fileName);
  }

  private sendPdf(res: Response, buffer: Buffer, fileName: string): void {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }
}
