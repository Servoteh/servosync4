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
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { QualityService } from "./kvalitet.service";
import type { UploadedMultipartFile } from "./kvalitet.service";
import type { AuthUser } from "../auth/jwt.strategy";
import type { CreateNonconformityReportDto } from "./dto/create-nonconformity-report.dto";
import type { UpdateNonconformityReportDto } from "./dto/update-nonconformity-report.dto";
import type {
  ListNonconformityReportsQuery,
  NonconformitySummaryQuery,
  SummaryMiniQuery,
} from "./dto/nonconformity-report.query";
import type { ListQualityDocsQuery } from "./dto/quality-document.query";

/**
 * Kontrola kvaliteta — evidencija neusaglašenosti (škart + dorada),
 * MODULE_SPEC_kontrola_kvaliteta §4–§7.
 *   GET    /api/v1/kvalitet/reports             — lista (type/status/from/to/q + paginacija)
 *   GET    /api/v1/kvalitet/summary             — izveštajni agregat (K3.1: groupBy dan…kupac)
 *   GET    /api/v1/kvalitet/summary-mini        — mini agregat (bedževi „na čekanju")
 *   GET    /api/v1/kvalitet/mine                — Moj profil: moje neusaglašenosti (K3.2)
 *   GET    /api/v1/kvalitet/reports/:id         — detalj + izvršioci + dokumenti
 *   POST   /api/v1/kvalitet/reports             — ručni draft (status=0, bez broja)
 *   PATCH  /api/v1/kvalitet/reports/:id         — izmena polja + izvršilaca
 *   POST   /api/v1/kvalitet/reports/:id/confirm — dodela broja NNN/YY (status=1)
 *   DELETE /api/v1/kvalitet/reports/:id         — SAMO draft (potvrđen → 422)
 *   POST   /api/v1/kvalitet/docs                — upload QC dokumenta (multipart) [KVALITET_WRITE]
 *   GET    /api/v1/kvalitet/docs                — lista dokumenata (bez sadržaja)
 *   GET    /api/v1/kvalitet/docs/:id/content    — sadržaj dokumenta (inline / ?download=true)
 *   DELETE /api/v1/kvalitet/docs/:id            — brisanje dokumenta [KVALITET_WRITE]
 *
 * Read = KVALITET_READ (class-level); write rute override na KVALITET_WRITE.
 * `mine` override-uje na PROFILE_SELF (getAllAndOverride → handler pobeđuje) da
 * proizvodni radnik (profile.self, bez kvalitet.read) vidi SVOJE neusaglašenosti.
 * Potvrda: bilo koji kontrolor ILI šef/menadžment (kvalitet.write).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KVALITET_READ)
@Controller({ path: "kvalitet", version: "1" })
export class QualityController {
  constructor(private readonly quality: QualityService) {}

  @Get("reports")
  list(@Query() query: ListNonconformityReportsQuery) {
    return this.quality.listReports(query);
  }

  @Get("summary")
  summary(@Query() query: NonconformitySummaryQuery) {
    return this.quality.summary(query);
  }

  @Get("summary-mini")
  summaryMini(@Query() query: SummaryMiniQuery) {
    return this.quality.summaryMini(query);
  }

  /**
   * Moj profil — moje neusaglašenosti. Handler-nivo PROFILE_SELF override-uje klasni
   * KVALITET_READ (getAllAndOverride) → proizvodni radnik vidi SVOJE bez kvalitet.read.
   */
  @Get("mine")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  mine(@Req() req: { user: AuthUser }) {
    return this.quality.mine(req.user);
  }

  @Get("reports/:id")
  detail(@Param("id", ParseIntPipe) id: number) {
    return this.quality.getReport(id);
  }

  @Post("reports")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  create(
    @Body() dto: CreateNonconformityReportDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.quality.createReport(dto, req.user);
  }

  @Patch("reports/:id")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateNonconformityReportDto,
  ) {
    return this.quality.updateReport(id, dto);
  }

  @Post("reports/:id/confirm")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  confirm(@Param("id", ParseIntPipe) id: number) {
    return this.quality.confirmReport(id);
  }

  @Delete("reports/:id")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  remove(@Param("id", ParseIntPipe) id: number) {
    return this.quality.deleteReport(id);
  }

  // ------------------------------------------------------------------ DOKUMENTI (K4-UPLOAD)

  /**
   * Upload QC dokumenta (multipart: `file` + opciona vezivna polja). Interceptor
   * limit 25 MB → 413 (servis dupliranom proverom pokriva direktan poziv). Magic
   * bytes / content_type validacija je u servisu (PDF/PNG/JPG; ostalo 422).
   */
  @Post("docs")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024 } }),
  )
  uploadDoc(
    @UploadedFile() file: UploadedMultipartFile | undefined,
    @Body()
    body:
      | {
          reportId?: string;
          techProcessId?: string;
          workOrderId?: string;
          identNumber?: string;
        }
      | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.quality.uploadDocument(file, body ?? {}, req.user);
  }

  @Get("docs")
  listDocs(@Query() query: ListQualityDocsQuery) {
    return this.quality.listDocuments(query);
  }

  /** Sadržaj dokumenta (stream). `?download=true` → attachment; inače inline. */
  @Get("docs/:id/content")
  async docContent(
    @Param("id", ParseIntPipe) id: number,
    @Query("download") download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName, contentType } =
      await this.quality.getDocumentContent(id);
    const disposition = download === "true" ? "attachment" : "inline";
    // `fileName` može nositi dijakritike — Node setHeader odbija znakove van
    // latin1 (ERR_INVALID_CHAR → 500). ASCII fallback u `filename=` + RFC 5987
    // `filename*` sa punim UTF-8 imenom (obrazac iz pdm.controller pdfContent).
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "dokument";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.set({
      "Content-Type": contentType,
      "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    });
    return new StreamableFile(buffer);
  }

  @Delete("docs/:id")
  @RequirePermission(PERMISSIONS.KVALITET_WRITE)
  removeDoc(@Param("id", ParseIntPipe) id: number) {
    return this.quality.deleteDocument(id);
  }
}
