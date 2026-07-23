import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { RobnoService, type StockDocumentKind } from "./robno.service";
import { CalculationService } from "./calculation.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import type { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";
import type { CreateStockDocumentDto } from "./dto/create-stock-document.dto";

/**
 * Robno / magacin (Faza 3) — robni dokumenti + kalkulacija (landed cost) + knjiženje u GK.
 *   GET  /api/v1/robno/documents          — lista (kind/tip/magacin/status/godina/opseg datuma), paginirano
 *   GET  /api/v1/robno/documents/:id      — detalj (zaglavlje + stavke + nivelacioni parovi)
 *   POST /api/v1/robno/documents          — kreiranje (kind u body; broj NNNN/god server), DRAFT
 *   POST /api/v1/robno/documents/:id/calculate — kalkulacija landed cost (DRAFT → CALCULATED); UL okida nivelaciju
 *   POST /api/v1/robno/documents/:id/post — knjiženje u glavnu knjigu (StockDocument → nalog GK)
 *
 * read = ROBNO_READ; kreiranje/kalkulacija = ROBNO_WRITE; knjiženje = ROBNO_POST.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ROBNO_READ)
@Controller({ path: "robno", version: "1" })
export class RobnoController {
  constructor(
    private readonly robno: RobnoService,
    private readonly calculation: CalculationService,
    private readonly posting: PostingEngineService,
  ) {}

  @Get("documents")
  list(@Query() query: ListStockDocumentsQuery) {
    return this.robno.listStockDocuments(query);
  }

  /** Lager lista — stanje zaliha po magacinu + prosečne cene (BigBit paritet). */
  @Get("lager")
  lager(
    @Query("warehouseId") warehouseId?: string,
    @Query("onlyInStock") onlyInStock?: string,
    @Query("q") q?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.robno.listLager({
      warehouseId: warehouseId ? Number(warehouseId) : undefined,
      onlyInStock: onlyInStock === "true",
      q,
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
    });
  }

  @Get("documents/:id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.robno.getStockDocument(id);
  }

  @Post("documents")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  create(@Body() body: { kind: StockDocumentKind } & CreateStockDocumentDto) {
    const { kind, ...dto } = body;
    return this.robno.createStockDocument(kind, dto);
  }

  @Post("documents/:id/calculate")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  calculate(@Param("id", ParseIntPipe) id: number) {
    return this.calculation.calculate(id);
  }

  @Post("documents/:id/post")
  @RequirePermission(PERMISSIONS.ROBNO_POST)
  async post(@Param("id", ParseIntPipe) id: number) {
    const lines = await this.posting.postFromStockDocument(id);
    // Ne vraćamo interni LedgerLineDraft[] tip direktno (nije eksportovan) — sažetak.
    return { data: { docId: id, ledgerLines: lines.length, posted: true } };
  }
}
