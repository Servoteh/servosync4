import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
import { GlReadService } from "./gl-read.service";
import { GlWriteService } from "./gl-write.service";
import { JournalPrintService } from "./journal-print.service";
import type { CreateJournalEntryDto } from "./dto/create-journal-entry.dto";

/**
 * Glavna knjiga (Faza 2) — READ: dnevnik (nalozi) + kartica konta.
 *   GET /api/v1/gl/journal            — dnevnik: lista naloga (orderType/year/status, paginacija)
 *   GET /api/v1/gl/journal/:id        — nalog sa stavkama
 *   GET /api/v1/gl/account-card       — kartica konta (accountCode, analyticalCode?, from?, to?)
 *
 * Bruto bilans je u /zavrsni/bruto-bilans (Faza 7). read = GL_READ.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.GL_READ)
@Controller({ path: "gl", version: "1" })
export class GlController {
  constructor(
    private readonly glRead: GlReadService,
    private readonly glWrite: GlWriteService,
    private readonly journalPrint: JournalPrintService,
  ) {}

  /** Kontni plan — pretraga (picker konta u nalozima). */
  @Get("accounts")
  searchAccounts(
    @Query("q") q?: string,
    @Query("allowsAnalytics") allowsAnalytics?: string,
    @Query("take") take?: string,
  ) {
    return this.glRead.searchAccounts({
      q,
      allowsAnalytics:
        allowsAnalytics === "true"
          ? true
          : allowsAnalytics === "false"
            ? false
            : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  // ── Ručni unos + status naloga (temeljnica) ─────────────────────────────
  @Post("journal")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  createEntry(
    @Body() dto: CreateJournalEntryDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.glWrite.createManualEntry(dto, req.user.userId);
  }

  @Post("journal/:id/post")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  postEntry(@Param("id", ParseIntPipe) id: number) {
    return this.glWrite.markPosted(id);
  }

  @Post("journal/:id/lock")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  lockEntry(@Param("id", ParseIntPipe) id: number) {
    return this.glWrite.markLocked(id);
  }

  @Post("journal/:id/reverse")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  reverseEntry(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.glWrite.reverse(id, req.user.userId);
  }

  /**
   * Masovno zaključavanje starih naloga (BigBit „zaključaj period"): svi `posted`
   * nalozi sa postingDate < beforeDate → `locked`. Vraća `{ count }`.
   */
  @Post("journal/lock-older")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  lockOlder(@Body() body: { beforeDate?: string }) {
    const raw = body?.beforeDate;
    if (!raw || typeof raw !== "string" || raw.trim() === "") {
      throw new BadRequestException("Parametar beforeDate je obavezan (datum praga).");
    }
    const before = new Date(raw);
    if (Number.isNaN(before.getTime())) {
      throw new BadRequestException("Parametar beforeDate nije ispravan datum.");
    }
    return this.glWrite.lockOlderThan(before);
  }

  @Get("journal")
  listJournal(
    @Query("orderType") orderType?: string,
    @Query("year") year?: string,
    @Query("status") status?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.glRead.listJournalEntries({
      orderType,
      year: year ? Number(year) : undefined,
      status,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("journal/:id")
  getJournal(@Param("id", ParseIntPipe) id: number) {
    return this.glRead.getJournalEntry(id);
  }

  /**
   * Štampa naloga za knjiženje (temeljnica) — PDF inline (`application/pdf`), isti
   * obrazac kao PdvPrintController. Nasleđuje klasnu GL_READ (read-only izlaz).
   */
  @Get("journal/:id/pdf")
  async journalPdf(
    @Param("id", ParseIntPipe) id: number,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.journalPrint.buildJournalPdf(id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(fileName)}"`,
    );
    res.send(buffer);
  }

  @Get("account-card")
  accountCard(
    @Query("accountCode") accountCode: string,
    @Query("analyticalCode") analyticalCode?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.glRead.accountCard({
      accountCode,
      analyticalCode: analyticalCode ? Number(analyticalCode) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }
}
