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
import { BankStatementService } from "./bank-statement.service";
import type { ImportStatementDto } from "./dto/import-statement.dto";
import type { PostStatementDto } from "./dto/post-statement.dto";

/**
 * IZVODI — bankovni izvodi (Faza 4 §B). Tok:
 *   POST /api/v1/izvodi/preview          — parsiraj TXT (dry-run) pre uvoza
 *   POST /api/v1/izvodi                  — uvezi izvod (upload TXT sadržaj) → IMPORTED
 *   GET  /api/v1/izvodi                  — lista izvoda (status, bankAccount, paginacija)
 *   GET  /api/v1/izvodi/:id              — jedan izvod + stavke
 *   POST /api/v1/izvodi/:id/match        — uparivanje komitenta + otvorene stavke
 *   POST /api/v1/izvodi/:id/post         — auto-knjiženje u GK (banka↔analitika)
 *
 * Permisije: read=IZVODI_READ, uvoz/uparivanje=IZVODI_IMPORT, knjiženje=IZVODI_POST.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.IZVODI_READ)
@Controller({ path: "izvodi", version: "1" })
export class IzvodiController {
  constructor(private readonly statements: BankStatementService) {}

  @Post("preview")
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  preview(@Body() body: { txtContent: string }) {
    return this.statements.previewParse(body?.txtContent ?? "");
  }

  @Post()
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  import(@Body() dto: ImportStatementDto, @Req() req: { user: AuthUser }) {
    return this.statements.importStatement(dto, req.user);
  }

  @Get()
  list(
    @Query("status") status?: string,
    @Query("bankAccount") bankAccount?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.statements.listStatements({
      status,
      bankAccount,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get(":id")
  get(@Param("id", ParseIntPipe) id: number) {
    return this.statements.getStatement(id);
  }

  @Post(":id/match")
  @RequirePermission(PERMISSIONS.IZVODI_IMPORT)
  match(@Param("id", ParseIntPipe) id: number) {
    return this.statements.matchLines(id);
  }

  @Post(":id/post")
  @RequirePermission(PERMISSIONS.IZVODI_POST)
  post(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: PostStatementDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.statements.postStatement(id, dto ?? {}, req.user);
  }
}
