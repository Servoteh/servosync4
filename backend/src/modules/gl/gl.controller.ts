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
import { GlReadService } from "./gl-read.service";
import { GlWriteService } from "./gl-write.service";
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
