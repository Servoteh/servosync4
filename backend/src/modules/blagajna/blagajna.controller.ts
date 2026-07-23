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
import { BlagajnaService } from "./blagajna.service";
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
 *
 * Permisije: read=BLAGAJNA_READ, unos=BLAGAJNA_WRITE.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.BLAGAJNA_READ)
@Controller({ path: "blagajna", version: "1" })
export class BlagajnaController {
  constructor(private readonly blagajna: BlagajnaService) {}

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
