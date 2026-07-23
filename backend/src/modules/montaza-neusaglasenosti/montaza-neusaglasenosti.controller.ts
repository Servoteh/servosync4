import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FilesInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { MontazaNeusaglasenostiService } from "./montaza-neusaglasenosti.service";
import type { UploadedPhotoFile } from "./montaza-neusaglasenosti.service";
import type { CreateNonconformityDto } from "./dto/create-nonconformity.dto";
import type { UpdateInvestigationDto } from "./dto/update-investigation.dto";
import type { ChangeStatusDto } from "./dto/change-status.dto";
import type { ListNonconformityQuery } from "./dto/list-query";

/**
 * Neusaglašenosti na montaži (zahtev 004/26, MODULE_SPEC_montaza_neusaglasenosti §3).
 *   GET    /api/v1/montaza/neusaglasenosti               — lista (status/severity/q/from/to + paginacija)
 *   POST   /api/v1/montaza/neusaglasenosti               — prijava [WRITE]
 *   GET    /api/v1/montaza/neusaglasenosti/:id           — detalj + fotke meta + events
 *   POST   /api/v1/montaza/neusaglasenosti/:id/photos    — upload fotki (multipart) [WRITE, podnosilac/manage]
 *   GET    /api/v1/montaza/neusaglasenosti/:id/photos/:photoId — bytea serve (inline)
 *   PATCH  /api/v1/montaza/neusaglasenosti/:id/istraga   — polja istrage [MANAGE]
 *   POST   /api/v1/montaza/neusaglasenosti/:id/status    — prelaz statusa [MANAGE]
 *
 * Read = MONTAZA_NEUSAGLASENOSTI_READ (class-level; ceo montaža krug). Write rute override
 * na WRITE (prijava + fotke); istraga/status na MANAGE. Ovaj kontroler NE koliduje sa
 * plan-montaze kontrolerom (path "montaza") jer je segment `neusaglasenosti` jedinstven.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_READ)
@Controller({ path: "montaza/neusaglasenosti", version: "1" })
export class MontazaNeusaglasenostiController {
  constructor(private readonly service: MontazaNeusaglasenostiService) {}

  @Get()
  list(@Query() query: ListNonconformityQuery) {
    return this.service.list(query);
  }

  @Post()
  @RequirePermission(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE)
  create(@Body() dto: CreateNonconformityDto, @Req() req: { user: AuthUser }) {
    return this.service.create(dto, req.user);
  }

  @Get(":id")
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.service.getOne(id);
  }

  /**
   * Upload fotki (multipart: `files`, do 6 × 8 MB → 413). Magic bytes / content_type
   * validacija je u servisu (PDF/PNG/JPG; ostalo 422). Dozvoljeno podnosiocu ili manage.
   */
  @Post(":id/photos")
  @RequirePermission(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE)
  @UseInterceptors(
    FilesInterceptor("files", 6, { limits: { fileSize: 8 * 1024 * 1024 } }),
  )
  addPhotos(
    @Param("id", ParseIntPipe) id: number,
    @UploadedFiles() files: UploadedPhotoFile[] | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.service.addPhotos(id, files ?? [], req.user);
  }

  /** Sadržaj fotke (stream, inline). */
  @Get(":id/photos/:photoId")
  async photoContent(
    @Param("id", ParseIntPipe) id: number,
    @Param("photoId", ParseIntPipe) photoId: number,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName, contentType } =
      await this.service.getPhotoContent(id, photoId);
    // `fileName` može nositi dijakritike — Node setHeader odbija znakove van latin1
    // (ERR_INVALID_CHAR → 500). ASCII fallback + RFC 5987 filename* (obrazac kvalitet.controller).
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "fotografija";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    });
    return new StreamableFile(buffer);
  }

  @Patch(":id/istraga")
  @RequirePermission(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE)
  updateInvestigation(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateInvestigationDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.service.updateInvestigation(id, dto, req.user);
  }

  @Post(":id/status")
  @RequirePermission(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_MANAGE)
  changeStatus(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ChangeStatusDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.service.changeStatus(id, dto, req.user);
  }
}
