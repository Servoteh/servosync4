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
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { BalanceSheetService } from "./balance-sheet.service";
import { AprXmlService } from "./apr-xml.service";
import { ControlRulesService } from "./control-rules.service";
import {
  StatementPdfService,
  type StatementPrintUnit,
} from "./statement-pdf.service";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * Završni račun / bilansi (Faza 7). Izvedeni obračuni nad glavnom knjigom.
 *
 *   GET  /api/v1/zavrsni/bruto-bilans?year=YYYY   — sirovi bruto bilans (uvek radi)
 *   POST /api/v1/zavrsni/bilans-stanja  {year}    — generiši bilans stanja (BS)
 *   POST /api/v1/zavrsni/bilans-uspeha  {year}    — generiši bilans uspeha (BU)
 *   GET  /api/v1/zavrsni/statements?type=&year=   — lista sačuvanih obračuna
 *   GET  /api/v1/zavrsni/statements/:id/controls  — kontrolna pravila (zeleno/crveno)
 *   POST /api/v1/zavrsni/statements/:id/finalize  — DRAFT → FINALIZED (uz kontrole)
 *   GET  /api/v1/zavrsni/statements/:id/apr-xml   — APR eFI FiForma XML (download)
 *   GET  /api/v1/zavrsni/statements/:id/pdf       — propisani obrazac kao PDF (inline)
 *
 * Permisije: read/štampa = ZR_READ, generisanje/finalize = ZR_COMPUTE, APR export = ZR_EXPORT.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ZR_READ)
@Controller({ path: "zavrsni", version: "1" })
export class ZavrsniController {
  constructor(
    private readonly balanceSheet: BalanceSheetService,
    private readonly aprXml: AprXmlService,
    private readonly controlRules: ControlRulesService,
    private readonly statementPdf: StatementPdfService,
  ) {}

  @Get("bruto-bilans")
  grossTrialBalance(@Query("year") year?: string) {
    return this.balanceSheet.getGrossTrialBalance(resolveYear(year));
  }

  @Get("statements")
  listStatements(@Query("type") type?: string, @Query("year") year?: string) {
    return this.balanceSheet.listStatements({
      statementType: type,
      year: year ? Number(year) : undefined,
    });
  }

  @Post("bilans-stanja")
  @RequirePermission(PERMISSIONS.ZR_COMPUTE)
  computeBalanceSheet(
    @Body() body: { year?: number },
    @Req() req: { user: AuthUser },
  ) {
    return this.balanceSheet.computeBalanceSheet(
      resolveYear(body?.year),
      req.user?.userId,
    );
  }

  @Post("bilans-uspeha")
  @RequirePermission(PERMISSIONS.ZR_COMPUTE)
  computeIncomeStatement(
    @Body() body: { year?: number },
    @Req() req: { user: AuthUser },
  ) {
    return this.balanceSheet.computeIncomeStatement(
      resolveYear(body?.year),
      req.user?.userId,
    );
  }

  /**
   * Kontrolna pravila za obračun — [{name, left, right, passed}] (zeleno/crveno na FE).
   * Nasleđuje ZR_READ (klasni default). Prazan niz ako obrazac nema pravila (npr. SI).
   */
  @Get("statements/:id/controls")
  statementControls(@Param("id", ParseIntPipe) id: number) {
    return this.controlRules.evaluateControls(id);
  }

  /**
   * Finalizacija obračuna: DRAFT → FINALIZED + finalizedAt. Kontrolna pravila blokiraju
   * (StatementControlsFailedException) osim uz `{ force: true }` u telu (dokumentovani
   * escape hatch). CAS guard sprečava dvostruki finalize. Permisija ZR_COMPUTE.
   */
  @Post("statements/:id/finalize")
  @RequirePermission(PERMISSIONS.ZR_COMPUTE)
  finalizeStatement(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { force?: boolean; reason?: string } | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.balanceSheet.finalizeStatement(id, {
      force: body?.force === true,
      userId: req.user?.userId,
      // Obrazloženje forsiranja: kolona `reason` u tragu je postojala od početka, ali
      // je kontroler nije čitao — trag je znao KO i KADA, a nikad ZAŠTO.
      reason:
        typeof body?.reason === "string" && body.reason.trim() !== ""
          ? body.reason.trim().slice(0, 500)
          : undefined,
    });
  }

  /**
   * APR eFI FiForma XML za sačuvani obračun (BS/BU/SI) — attachment download.
   * Format verbatim po BigBit ZR_EksportXML_BS/BU/SI (doc 37 §F).
   */
  @Get("statements/:id/apr-xml")
  @RequirePermission(PERMISSIONS.ZR_EXPORT)
  async exportAprXml(
    @Param("id", ParseIntPipe) id: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { xml, fileName, contentType } = await this.aprXml.exportFiForma(id);
    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${fileName}"`,
    });
    return new StreamableFile(Buffer.from(xml, "utf-8"), { type: contentType });
  }

  /**
   * PROPISANI OBRAZAC KAO PDF (bilans stanja / bilans uspeha / statistički izveštaj)
   * za sačuvani obračun — `application/pdf` inline. Isti izvor podataka kao APR XML
   * (FinancialStatementLine), pa se štampa i predaja ne mogu raziću.
   *
   * `jedinica`: `hiljade` (podrazumevano — obrazac se predaje u hiljadama dinara) ili
   * `dinari` (sirovi iznosi iz glavne knjige). Ime korisnika ide u nogu kao trag štampe.
   * Permisija ZR_READ (klasni default — štampa je pregled, ne izvoz).
   */
  @Get("statements/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async printStatement(
    @Param("id", ParseIntPipe) id: number,
    @Query("jedinica") jedinica: string | undefined,
    @Res() res: Response,
    @Req() req: { user: AuthUser },
  ): Promise<void> {
    const unit: StatementPrintUnit =
      jedinica === "dinari" ? "dinari" : "hiljade";
    const { buffer, fileName } = await this.statementPdf.buildStatementPdf(id, {
      unit,
      printedBy: req.user?.email,
    });
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }
}

/** Godina iz query/body ili tekuća; validacija opsega (1990..2100). */
function resolveYear(raw?: string | number): number {
  const y =
    raw !== undefined && raw !== null ? Number(raw) : new Date().getFullYear();
  if (!Number.isInteger(y) || y < 1990 || y > 2100) {
    return new Date().getFullYear();
  }
  return y;
}
