import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { GlReadService } from "./gl-read.service";

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
  constructor(private readonly glRead: GlReadService) {}

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
