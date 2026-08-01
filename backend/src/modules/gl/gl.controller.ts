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
import { JournalBookPrintService } from "./print/journal-book-print.service";
import { AccountCardPrintService } from "./print/account-card-print.service";
import { TrialBalancePrintService } from "./print/trial-balance-print.service";
import { YearOpenService, type YearOpenDto } from "./year-open.service";
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
    private readonly journalBookPrint: JournalBookPrintService,
    private readonly accountCardPrint: AccountCardPrintService,
    private readonly trialBalancePrint: TrialBalancePrintService,
    private readonly yearOpen: YearOpenService,
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
  postEntry(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.glWrite.markPosted(id, req.user.userId);
  }

  @Post("journal/:id/lock")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  lockEntry(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.glWrite.markLocked(id, req.user.userId);
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
  /**
   * Masovno zaključavanje perioda. `dryRun: true` samo prebroji naloge (bez izmene) —
   * FE to koristi za potvrdu „zaključavam N naloga" pre stvarnog poziva (review Opus 5).
   */
  @Post("journal/lock-older")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  lockOlder(
    @Body() body: { beforeDate?: string; dryRun?: boolean },
    @Req() req: { user: AuthUser },
  ) {
    const raw = body?.beforeDate;
    if (!raw || typeof raw !== "string" || raw.trim() === "") {
      throw new BadRequestException("Parametar beforeDate je obavezan (datum praga).");
    }
    const before = new Date(raw);
    if (Number.isNaN(before.getTime())) {
      throw new BadRequestException("Parametar beforeDate nije ispravan datum.");
    }
    return this.glWrite.lockOlderThan(
      before,
      { dryRun: body?.dryRun === true },
      req.user.userId,
    );
  }

  /** Otključavanje pojedinačnog naloga (locked → posted) — ispravka greške pri zaključavanju. */
  @Post("journal/:id/unlock")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  unlockJournal(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.glWrite.markUnlocked(id, req.user.userId);
  }

  /**
   * POČETNO STANJE / carry-over godine (B2): zatvaranje klasa 5/6 → rezultat, pa PS nalog
   * klasa 0–4 za `toYear`. Nepovratno bez storna; ako PS za toYear postoji → 409. GL_WRITE.
   */
  @Post("year-open")
  @RequirePermission(PERMISSIONS.GL_WRITE)
  yearOpenEntry(
    @Body() body: YearOpenDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.yearOpen.createYearOpen(body, req.user.userId);
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

  /**
   * ŠTAMPA DNEVNIKA KNJIŽENJA (dnevnik glavne knjige) — PDF inline. Filteri su
   * isti kao na ekranu dnevnika (vrsta/godina) + period po datumu knjiženja.
   * Nasleđuje klasnu GL_READ (read-only izlaz).
   */
  @Get("journal-book/pdf")
  async journalBookPdf(
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("orderType") orderType: string | undefined,
    @Query("year") year: string | undefined,
    @Req() req: { user: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.journalBookPrint.buildJournalBookPdf({
      from: parseOptionalDate(from),
      to: parseOptionalDate(to),
      orderType: orderType?.trim() || undefined,
      year: parseOptionalInt(year),
      printedBy: req.user?.email ?? null,
    });
    sendPdf(res, buffer, fileName);
  }

  /**
   * ŠTAMPA KARTICE KONTA — PDF inline; isti filteri kao `GET /gl/account-card`
   * (konto obavezan, komitent/mesto troška/period opcioni). GL_READ.
   */
  @Get("account-card/pdf")
  async accountCardPdf(
    @Query("accountCode") accountCode: string,
    @Query("analyticalCode") analyticalCode: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Query("costCenter") costCenter: string | undefined,
    @Req() req: { user: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    if (!accountCode || accountCode.trim() === "") {
      throw new BadRequestException("Parametar accountCode je obavezan.");
    }
    const { buffer, fileName } = await this.accountCardPrint.buildAccountCardPdf({
      accountCode,
      analyticalCode: parseOptionalInt(analyticalCode),
      costCenter: costCenter?.trim() || undefined,
      from: parseOptionalDate(from),
      to: parseOptionalDate(to),
      printedBy: req.user?.email ?? null,
    });
    sendPdf(res, buffer, fileName);
  }

  /**
   * ŠTAMPA BRUTO BILANSA (zaključni list) za godinu — PDF inline. Isti ledger
   * obim kao `/zavrsni/bruto-bilans`; `class` sužava na jednu klasu konta. GL_READ.
   */
  @Get("trial-balance/pdf")
  async trialBalancePdf(
    @Query("year") year: string | undefined,
    @Query("class") accountClass: string | undefined,
    @Req() req: { user: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const parsedYear = parseOptionalInt(year) ?? new Date().getFullYear();
    if (parsedYear < 2000 || parsedYear > 2100) {
      throw new BadRequestException("Parametar year nije ispravna poslovna godina.");
    }
    const { buffer, fileName } = await this.trialBalancePrint.buildTrialBalancePdf({
      year: parsedYear,
      accountClass: accountClass?.trim() || undefined,
      printedBy: req.user?.email ?? null,
    });
    sendPdf(res, buffer, fileName);
  }

  @Get("account-card")
  accountCard(
    @Query("accountCode") accountCode: string,
    @Query("analyticalCode") analyticalCode?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("costCenter") costCenter?: string,
  ) {
    return this.glRead.accountCard({
      accountCode,
      analyticalCode: analyticalCode ? Number(analyticalCode) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      costCenter:
        costCenter && costCenter.trim() !== "" ? costCenter.trim() : undefined,
    });
  }
}

/** Inline isporuka PDF-a (isti obrazac na svim štampama). */
function sendPdf(res: Response, buffer: Buffer, fileName: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(fileName)}"`,
  );
  res.send(buffer);
}

function parseOptionalInt(v?: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

function parseOptionalDate(v?: string): Date | undefined {
  if (v == null || v === "") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}
