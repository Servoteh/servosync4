import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
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
import type { AuthUser } from "../auth/jwt.strategy";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { PdmService } from "./pdm.service";
import type {
  BomQuery,
  ImportLogQuery,
  ListDrawingsQuery,
  WhereUsedQuery,
} from "./pdm.service";
import { PdmImportService } from "./pdm-import.service";
import type { UploadedMultipartFile } from "./pdm-import.service";

/**
 * API za PDM (Projektna dokumentacija) — katalog crteža + nativni intake.
 *   GET  /api/v1/pdm/drawings                — lista (filteri: q, revision, material, designedBy, statusId, isProcurement, hasPdf=yes|no, type=proizvodnja|gotova|montazni)
 *   GET  /api/v1/pdm/drawings/:id            — detalj + PDF metapodaci + import info
 *   GET  /api/v1/pdm/drawings/:id/bom        — rekurzivna sastavnica (?depth=1..20, ?expandAll=true → samo flat)
 *   GET  /api/v1/pdm/drawings/:id/where-used — obrnuta sastavnica (?recursive=true → tranzitivni parent-i)
 *   GET  /api/v1/pdm/import-log              — istorija XML uvoza (?success=, ?isCritical=)
 *   GET  /api/v1/pdm/lookups                 — statusi + distinct materijali + projektanti (za filtere)
 *   POST /api/v1/pdm/import                  — XML uvoz (multipart: file + sourcePath?) [PDM_IMPORT]
 *   POST /api/v1/pdm/pdf-import              — PDF uvoz (multipart: file + drawingNumber?/revision?/sourcePath?) [PDM_IMPORT]
 *
 * Read rute traže JWT + PDM_READ (klasni guard); import rute PDM_IMPORT —
 * `PermissionsGuard` koristi getAllAndOverride([handler, class]) pa metoda
 * pobedi klasu. Multi-fajl: endpoint prima JEDAN fajl; UI/bridge šalju
 * sekvencijalno, svaki fajl = svoj log red + svoj response.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDM_READ)
@Controller({ path: "pdm", version: "1" })
export class PdmController {
  constructor(
    private readonly pdm: PdmService,
    private readonly pdmImport: PdmImportService,
  ) {}

  /**
   * XML uvoz iz SolidWorks PDM-a (MODULE_SPEC_pdm §5.5). Poslovna
   * validaciona greška → 200 + success:false (bridge/UI čitaju flag);
   * 400 samo bez fajla; 413 preko 10 MB.
   */
  @Post("import")
  @RequirePermission(PERMISSIONS.PDM_IMPORT)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }),
  )
  importXml(
    @UploadedFile() file: UploadedMultipartFile | undefined,
    @Body() body: { sourcePath?: string } | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.pdmImport.importXml(file, body?.sourcePath, req.user);
  }

  /**
   * PDF uvoz — ime fajla `{Broj}_{Rev}.pdf` / `{Broj}.pdf`; eksplicitna
   * form polja imaju prednost. Crtež ne mora postojati (PDF pre XML-a).
   */
  @Post("pdf-import")
  @RequirePermission(PERMISSIONS.PDM_IMPORT)
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  importPdf(
    @UploadedFile() file: UploadedMultipartFile | undefined,
    @Body()
    body:
      | { drawingNumber?: string; revision?: string; sourcePath?: string }
      | undefined,
    @Req() req: { user: AuthUser },
  ) {
    return this.pdmImport.importPdf(file, body ?? {}, req.user);
  }

  @Get("drawings")
  listDrawings(@Query() query: ListDrawingsQuery) {
    return this.pdm.listDrawings(query);
  }

  @Get("drawings/:id")
  findDrawing(@Param("id", ParseIntPipe) id: number) {
    return this.pdm.findDrawing(id);
  }

  /** Uskladišten PDF crteža (stream). `?download=true` → attachment; inače inline (prikaz u browseru). */
  @Get("drawings/:id/pdf/content")
  async pdfContent(
    @Param("id", ParseIntPipe) id: number,
    @Query("download") download: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, fileName } = await this.pdm.getPdfContent(id);
    const disposition = download === "true" ? "attachment" : "inline";
    // `fileName` može nositi dijakritike (decodeOriginalName pri uvozu ih
    // namerno restaurira latin1→utf8) — Node setHeader odbija znakove van
    // latin1 (ERR_INVALID_CHAR → 500). Zato: ASCII fallback u `filename=` +
    // RFC 5987 `filename*` sa punim UTF-8 imenom (browseri biraju filename*).
    const asciiName =
      fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") ||
      "crtez.pdf";
    const utf8Name = encodeURIComponent(fileName).replace(
      /['()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
    });
    return new StreamableFile(buffer);
  }

  @Get("drawings/:id/bom")
  bom(@Param("id", ParseIntPipe) id: number, @Query() query: BomQuery) {
    return this.pdm.bom(id, query);
  }

  @Get("drawings/:id/where-used")
  whereUsed(
    @Param("id", ParseIntPipe) id: number,
    @Query() query: WhereUsedQuery,
  ) {
    return this.pdm.whereUsed(id, query);
  }

  @Get("import-log")
  importLog(@Query() query: ImportLogQuery) {
    return this.pdm.importLog(query);
  }

  @Get("lookups")
  lookups() {
    return this.pdm.lookups();
  }
}
