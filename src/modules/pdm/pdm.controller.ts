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
import { PdmService } from "./pdm.service";
import type {
  BomQuery,
  ImportLogQuery,
  ListDrawingsQuery,
  WhereUsedQuery,
} from "./pdm.service";

/**
 * API za PDM (Projektna dokumentacija) — READ-ONLY katalog crteža.
 *   GET /api/v1/pdm/drawings                — lista (filteri: q, revision, material, designedBy, statusId, isProcurement)
 *   GET /api/v1/pdm/drawings/:id            — detalj + PDF metapodaci + import info
 *   GET /api/v1/pdm/drawings/:id/bom        — rekurzivna sastavnica (?depth=1..20, ?expandAll=true → samo flat)
 *   GET /api/v1/pdm/drawings/:id/where-used — obrnuta sastavnica (?recursive=true → tranzitivni parent-i)
 *   GET /api/v1/pdm/import-log              — istorija XML uvoza (?success=, ?isCritical=)
 *   GET /api/v1/pdm/lookups                 — statusi + distinct materijali + projektanti (za filtere)
 *
 * Traži JWT + PDM_READ (guard je V1 no-op — ključ se samo deklariše).
 * XML import (write) NIJE ovde — dolazi kasnije uz PDM sync (PDM_IMPORT).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.PDM_READ)
@Controller({ path: "pdm", version: "1" })
export class PdmController {
  constructor(private readonly pdm: PdmService) {}

  @Get("drawings")
  listDrawings(@Query() query: ListDrawingsQuery) {
    return this.pdm.listDrawings(query);
  }

  @Get("drawings/:id")
  findDrawing(@Param("id", ParseIntPipe) id: number) {
    return this.pdm.findDrawing(id);
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
