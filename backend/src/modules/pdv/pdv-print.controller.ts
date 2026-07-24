import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { MailService } from "../../common/mail/mail.service";
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
  constructor(
    private readonly print: PdvPrintService,
    private readonly mail: MailService,
  ) {}

  @Get("pp-pdv")
  async ppPdv(
    @Query("period") period: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.print.buildPpPdvPdf(period);
    this.sendPdf(res, buffer, fileName);
  }

  /**
   * Pošalji PP-PDV obrazac mejlom sa PDF prilogom (Talas 3 A6 — npr. knjigovođi).
   * Telo `{ period, to }`: `period` je `YYYY-MM` ili `YYYY-Qn` (validira ga
   * `buildPpPdvPdf`, 404 kad nema POPDV obračuna). Slanje NE baca (DRY-RUN kad
   * ključ fali) — vraća `{ data: { sent, to, fileName } }`. Nasleđuje klasnu
   * PDV_READ (dostava izveštaja koji je već štampiv; bez elevacije).
   */
  @Post("pp-pdv/send-mail")
  async sendPpPdvMail(@Body() dto: { period?: string; to?: string }) {
    const period = typeof dto.period === "string" ? dto.period.trim() : "";
    const to = requireEmail(dto.to);
    const { buffer, fileName } = await this.print.buildPpPdvPdf(period);
    const subject = `PP-PDV obrazac - period ${period}`;
    const html =
      `<p>Poštovani,</p>` +
      `<p>U prilogu Vam dostavljamo obrazac PP-PDV za period ${escapeHtml(period)}.</p>` +
      `<p>Srdačan pozdrav,<br/>Servoteh</p>`;
    const sent = await this.mail.send({
      to,
      subject,
      html,
      attachments: [{ filename: fileName, content: buffer }],
    });
    return { data: { sent, to, fileName } };
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

/** Osnovna provera email formata (jedan primalac); baca 400 na prazno/nevalidno. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function requireEmail(to: unknown): string {
  const email = typeof to === "string" ? to.trim() : "";
  if (!email) {
    throw new BadRequestException("Email adresa primaoca je obavezna.");
  }
  if (!EMAIL_RE.test(email)) {
    throw new BadRequestException(`Neispravna email adresa primaoca: ${email}.`);
  }
  return email;
}

/** Minimalni HTML escape za ubacivanje perioda u telo mejla. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
