import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { ZahteviService } from "./zahtevi.service";
import type { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import type { UpdateChangeRequestDto } from "./dto/update-change-request.dto";
import type { DecisionDto } from "./dto/decision.dto";
import type { StatusDto } from "./dto/status.dto";

/**
 * Zahtevi — AI PM modul (MODULE_SPEC_zahtevi §7). Guard = JwtAuthGuard + PermissionsGuard;
 * klasni default `zahtevi.read`, per-endpoint override (write/admin). Row-scope (ne-admin
 * vidi SAMO svoje) sprovodi SERVIS kroz prosleđen AuthUser.
 *
 * F1 obim: CRUD, status mašina, prilozi (STT), komentari, events, decision/status, slicni.
 * F3 (AI): retriage / approve-analysis / PATCH analyses. F4: nagrade (score/restore/tarife/
 * obracun) + Decision Log (odluke). Ti endpointi NISU ovde.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ZAHTEVI_READ)
@Controller({ path: "zahtevi", version: "1" })
export class ZahteviController {
  constructor(private readonly zahtevi: ZahteviService) {}

  // ── LISTE ──────────────────────────────────────────────────────────────────

  @Get()
  list(
    @Req() req: { user: AuthUser },
    @Query("status") status?: string,
    @Query("module") module?: string,
    @Query("kind") kind?: string,
    @Query("q") q?: string,
    @Query("createdBy") createdBy?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
  ) {
    return this.zahtevi.list(req.user, {
      status,
      module,
      kind,
      q,
      createdBy,
      page,
      pageSize,
    });
  }

  @Get("inbox-meta")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  inboxMeta() {
    return this.zahtevi.inboxMeta();
  }

  @Get("slicni")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  slicni(@Query("q") q?: string) {
    return this.zahtevi.slicni(q);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  @Post()
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  create(@Body() dto: CreateChangeRequestDto, @Req() req: { user: AuthUser }) {
    return this.zahtevi.create(dto, req.user);
  }

  @Get(":id")
  getDetail(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.getDetail(id, req.user);
  }

  @Patch(":id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateChangeRequestDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.update(id, dto, req.user);
  }

  @Delete(":id")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  remove(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.remove(id, req.user);
  }

  // ── SUBMIT / WITHDRAW ────────────────────────────────────────────────────────

  @Post(":id/submit")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  submit(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.submit(id, req.user);
  }

  @Post(":id/withdraw")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  withdraw(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.withdraw(id, req.user);
  }

  // ── PRILOZI (§5) ────────────────────────────────────────────────────────────

  @Post(":id/attachments")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  // Hard DoS cap 25MB/fajl, do 10 fajlova (servis dodatno primenjuje mime/audio pravila).
  @UseInterceptors(
    FilesInterceptor("files", 10, { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  addAttachments(
    @Param("id", ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.addAttachments(id, files ?? [], req.user);
  }

  @Get(":id/attachments/:attId/url")
  getAttachmentUrl(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.getAttachmentUrl(id, attId, req.user);
  }

  @Delete(":id/attachments/:attId")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  removeAttachment(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.removeAttachment(id, attId, req.user);
  }

  @Post(":id/attachments/:attId/transcribe")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  transcribeAttachment(
    @Param("id", ParseIntPipe) id: number,
    @Param("attId", ParseIntPipe) attId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.transcribeAttachment(id, attId, req.user);
  }

  // ── KOMENTARI ────────────────────────────────────────────────────────────

  @Post(":id/comments")
  @RequirePermission(PERMISSIONS.ZAHTEVI_WRITE)
  addComment(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { body?: string; isQuestion?: boolean },
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.addComment(id, body, req.user);
  }

  // ── ADMIN PRESUDE / REALIZACIJA ──────────────────────────────────────────────

  @Post(":id/decision")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  decision(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: DecisionDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.decision(id, dto, req.user);
  }

  @Post(":id/status")
  @RequirePermission(PERMISSIONS.ZAHTEVI_ADMIN)
  setStatus(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: StatusDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.zahtevi.setStatus(id, dto, req.user);
  }
}
