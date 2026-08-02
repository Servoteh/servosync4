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
import { BlagajnaService } from "./blagajna.service";
import { CashJournalPdfService } from "./print/cash-journal-pdf.service";
import type {
  CreateCashJournalDto,
  CreateCashEntryDto,
} from "./dto/blagajna.dto";

/**
 * BLAGAJNA (gotovinski dnevnik) — XL modul.
 *   GET  /api/v1/blagajna/journals                 — blagajne + tekući saldo
 *   POST /api/v1/blagajna/journals                 — nova blagajna (konto + valuta)
 *   GET  /api/v1/blagajna/journals/:id/entries     — stavke (uplatnice/isplatnice) + saldo
 *   POST /api/v1/blagajna/journals/:id/entries     — uplatnica/isplatnica (auto-GL knjiženje)
 *   GET  /api/v1/blagajna/journals/:id/dnevnik/pdf — BLAGAJNIČKI IZVEŠTAJ (PDF, inline)
 *
 * Permisije: read=BLAGAJNA_READ, unos=BLAGAJNA_WRITE. Štampa je pregled → READ.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.BLAGAJNA_READ)
@Controller({ path: "blagajna", version: "1" })
export class BlagajnaController {
  constructor(
    private readonly blagajna: BlagajnaService,
    private readonly cashPdf: CashJournalPdfService,
  ) {}

  /**
   * BLAGAJNIČKI IZVEŠTAJ (dnevnik) za blagajnu i period — PDF inline.
   * `from`/`to` su `YYYY-MM-DD`; bez njih se štampa današnji dan. `to` je
   * uključivo (poredi se sa krajem dana). Sadrži preneti („Prethodni saldo") i
   * novi saldo, iznos u slovima, PRAZNU apoensku specifikaciju za brojanje i
   * potpisna mesta Blagajnik / Kontrolisao.
   */
  @Get("journals/:id/dnevnik/pdf")
  @Header("Content-Type", "application/pdf")
  async dnevnikPdf(
    @Param("id", ParseIntPipe) id: number,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.cashPdf.buildPdf({
      journalId: id,
      from: from && from.trim() !== "" ? from.trim() : undefined,
      to: to && to.trim() !== "" ? to.trim() : undefined,
      userId: req.user?.userId ?? null,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  @Get("journals")
  listJournals() {
    return this.blagajna.listJournals();
  }

  @Post("journals")
  @RequirePermission(PERMISSIONS.BLAGAJNA_WRITE)
  createJournal(@Body() dto: CreateCashJournalDto) {
    return this.blagajna.createJournal(dto);
  }

  @Get("journals/:id/entries")
  listEntries(
    @Param("id", ParseIntPipe) id: number,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.blagajna.listEntries(id, {
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Post("journals/:id/entries")
  @RequirePermission(PERMISSIONS.BLAGAJNA_WRITE)
  createEntry(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateCashEntryDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.blagajna.createEntry(id, dto, req.user);
  }
}
