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
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { RobnoService, type StockDocumentKind } from "./robno.service";
import { CalculationService } from "./calculation.service";
import { InventoryService } from "./inventory.service";
import {
  CarryOverService,
  type CarryOverOptions,
} from "./carry-over.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { ReservationService } from "./reservation.service";
import type {
  CreateReservationDto,
  ListReservationsQuery,
  ReleaseReservationDto,
} from "./dto/reservation.dto";
import type { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";
import type { CreateStockDocumentDto } from "./dto/create-stock-document.dto";
import type {
  CreateInventoryCountDto,
  FinalizeInventoryCountDto,
  UpdateInventoryCountItemDto,
} from "./dto/inventory.dto";

/**
 * Robno / magacin (Faza 3) — robni dokumenti + kalkulacija (landed cost) + knjiženje u GK.
 *   GET  /api/v1/robno/documents          — lista (kind/tip/magacin/status/godina/opseg datuma), paginirano
 *   GET  /api/v1/robno/documents/:id      — detalj (zaglavlje + stavke + nivelacioni parovi)
 *   POST /api/v1/robno/documents          — kreiranje (kind u body; broj NNNN/god server), DRAFT
 *   POST /api/v1/robno/documents/:id/calculate — kalkulacija landed cost (DRAFT → CALCULATED); UL okida nivelaciju
 *   POST /api/v1/robno/documents/:id/post — knjiženje u glavnu knjigu (StockDocument → nalog GK)
 *
 * Popis / inventura (doc 39 §D) — predpunjenje → unos KolPop → razlika → knjiženje VISAK/MANJAK:
 *   GET   /api/v1/robno/inventory-counts               — lista (opciono ?year)
 *   POST  /api/v1/robno/inventory-counts               — kreiranje + predpunjenje (DRAFT→COUNTING)
 *   GET   /api/v1/robno/inventory-counts/:id           — detalj (zaglavlje + stavke)
 *   GET   /api/v1/robno/inventory-counts/:id/differences — razlika po stavci + zbirovi višak/manjak
 *   PATCH /api/v1/robno/inventory-counts/:id/items/:itemId — unos popisane količine (KolPop)
 *   POST  /api/v1/robno/inventory-counts/:id/finalize  — zaključi (VISAK/MANJAK dokumenti, COUNTING→POSTED)
 *
 * read = ROBNO_READ; kreiranje/kalkulacija/popis-write = ROBNO_WRITE; knjiženje = ROBNO_POST.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ROBNO_READ)
@Controller({ path: "robno", version: "1" })
export class RobnoController {
  constructor(
    private readonly robno: RobnoService,
    private readonly calculation: CalculationService,
    private readonly posting: PostingEngineService,
    private readonly inventory: InventoryService,
    private readonly carryOver: CarryOverService,
    private readonly reservation: ReservationService,
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

  /**
   * Kartica artikla — hronološka kartica kretanja po magacinu (ulaz/izlaz/running-stanje).
   * `itemId`+`warehouseId` obavezni; `from`/`to` opcioni prozor. Krajnje stanje == stateAsOf (costing).
   */
  @Get("item-card")
  itemCard(
    @Query("itemId") itemId?: string,
    @Query("warehouseId") warehouseId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.robno.getItemCard({
      itemId: Number(itemId),
      warehouseId: Number(warehouseId),
      from,
      to,
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

  /**
   * Prepis narudžbenice (PurchaseOrder) → robni ulaz (Primka, UL). Stavke/količine/cene iz
   * narudžbenice; veže `purchaseOrderId`. Nacrt narudžbenica = 422; ponovni prepis = 409
   * (jedna narudžbenica = max 1 ulaz). Body opcije: `warehouseId` (default 1), `documentTypeCode`
   * (default UFROB). Permisija ROBNO_WRITE.
   */
  @Post("documents/from-purchase-order/:orderId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  fromPurchaseOrder(
    @Param("orderId", ParseIntPipe) orderId: number,
    @Body() body: CarryOverOptions,
    @Req() req: { user: AuthUser },
  ) {
    return this.carryOver.fromPurchaseOrder(orderId, body ?? {}, req.user.userId);
  }

  /**
   * Prepis predračuna/fakture (Invoice) → izdatnica (robni izlaz IZ). Stavke sa artiklom iz
   * fakture; po uspehu upisuje `Invoice.stockDocumentId`. Već prenet dokument = 409; IZ prolazi
   * kroz proveru dovoljnog stanja (nedovoljno = 422). Body opcije: `warehouseId` (default 1),
   * `documentTypeCode` (default IFR). Permisija ROBNO_WRITE.
   */
  @Post("documents/from-invoice/:invoiceId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  fromInvoice(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body() body: CarryOverOptions,
    @Req() req: { user: AuthUser },
  ) {
    return this.carryOver.fromInvoice(invoiceId, body ?? {}, req.user.userId);
  }

  @Post("documents/:id/calculate")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  async calculate(@Param("id", ParseIntPipe) id: number) {
    await this.robno.assertNotLocked(id); // zaključan dokument = immutable
    return this.calculation.calculate(id);
  }

  /**
   * Zaključaj proknjižen dokument (booked → LOCKED). CAS na status; naredne mutacije (calculate/post)
   * su blokirane guardom `assertNotLocked`. Permisija ROBNO_WRITE.
   */
  @Post("documents/:id/lock")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  lock(@Param("id", ParseIntPipe) id: number) {
    return this.robno.lockDocument(id);
  }

  @Post("documents/:id/post")
  @RequirePermission(PERMISSIONS.ROBNO_POST)
  async post(@Param("id", ParseIntPipe) id: number) {
    await this.robno.assertNotLocked(id); // zaključan dokument se ne re-knjiži
    const lines = await this.posting.postFromStockDocument(id);
    // KEPU (maloprodajna knjiga) — razduženje/zaduženje po proknjiženom dokumentu (IZ/NIV/…),
    // idempotentno po documentId. Van posting transakcije: posting baca na grešku pa se KEPU ne izvrši.
    const kepuEntries = await this.robno.writeKepuForDocument(id);
    // Ne vraćamo interni LedgerLineDraft[] tip direktno (nije eksportovan) — sažetak.
    return {
      data: { docId: id, ledgerLines: lines.length, kepuEntries, posted: true },
    };
  }

  // ─── Stavke: soft-delete + Undo (Batch B) ──────────────────────────────────

  /**
   * Meko obriši stavku dokumenta (poništivo — „Undo" u 30 s). Guard: dokument nije
   * proknjižen/zaključan (409). Obrisana stavka ne utiče na zalihe/kalkulaciju/GK.
   * Permisija ROBNO_WRITE.
   */
  @Delete("documents/:docId/items/:itemLineId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  deleteItem(
    @Param("docId", ParseIntPipe) docId: number,
    @Param("itemLineId", ParseIntPipe) itemLineId: number,
    @Req() req: { user: AuthUser },
  ) {
    return this.robno.deleteItem(docId, itemLineId, req.user.userId);
  }

  /**
   * Poništi brisanje stavke (undo) — samo unutar prozora od 30 s, inače 409 (rok
   * istekao). Guard: dokument i dalje nije proknjižen/zaključan. Permisija ROBNO_WRITE.
   */
  @Post("documents/:docId/items/:itemLineId/restore")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  restoreItem(
    @Param("docId", ParseIntPipe) docId: number,
    @Param("itemLineId", ParseIntPipe) itemLineId: number,
  ) {
    return this.robno.restoreItem(docId, itemLineId);
  }

  /**
   * Retro-punjenje KEPU knjige za postojeće dokumente (task D5be). Idempotentno — može se
   * pozvati više puta. Opcioni filter po godini. Piše `kepu_book_entries` iz robnog toka.
   */
  @Post("kepu/rebuild")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  async rebuildKepu(@Query("year") year?: string) {
    const y = year != null && year.trim() !== "" ? Number(year) : undefined;
    const result = await this.robno.rebuildKepu({ year: y });
    return { data: result };
  }

  // ─── Popis / inventura (doc 39 §D) ─────────────────────────────────────────

  /** Lista popisa (najnoviji prvo), opcioni filter po godini. */
  @Get("inventory-counts")
  listCounts(@Query("year") year?: string) {
    const y = year != null && year.trim() !== "" ? Number(year) : undefined;
    return this.inventory.list(y);
  }

  /** Kreiranje popisa + predpunjenje stavki iz costing-a (DRAFT → COUNTING). */
  @Post("inventory-counts")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  createCount(
    @Body() dto: CreateInventoryCountDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.inventory.createCount(dto, req.user.userId);
  }

  @Get("inventory-counts/:id")
  getCount(@Param("id", ParseIntPipe) id: number) {
    return this.inventory.get(id);
  }

  /** Razlika popisa po stavci (KolPop − KolKng) + zbirovi višak/manjak. */
  @Get("inventory-counts/:id/differences")
  countDifferences(@Param("id", ParseIntPipe) id: number) {
    return this.inventory.differences(id);
  }

  /** Unos popisane količine (KolPop) za jednu stavku. */
  @Patch("inventory-counts/:id/items/:itemId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  updateCountItem(
    @Param("id", ParseIntPipe) id: number,
    @Param("itemId", ParseIntPipe) itemId: number,
    @Body() body: UpdateInventoryCountItemDto,
  ) {
    return this.inventory.updateItem(id, itemId, body.countedQuantity);
  }

  /** Zaključi popis — kreira VISAK/MANJAK robne dokumente (COUNTING → POSTED). */
  @Post("inventory-counts/:id/finalize")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  finalizeCount(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: FinalizeInventoryCountDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.inventory.finalize(id, req.user.userId, body);
  }

  // ── Rezervacije zaliha (Batch C) ────────────────────────────────────────────
  // „Rezervisano" je agregat OTVORENIH redova stock_reservations; raspoloživo =
  // stanje − rezervisano. Denormalizovana kolona stock_levels.reserved se ne koristi.

  /** Lista rezervacija (filter artikal/magacin/status/izvor). */
  @Get("reservations")
  @RequirePermission(PERMISSIONS.ROBNO_READ)
  listReservations(@Query() query: ListReservationsQuery) {
    return this.reservation.list(query);
  }

  /** Raspoloživo za (artikal, magacin). */
  @Get("availability")
  @RequirePermission(PERMISSIONS.ROBNO_READ)
  availability(
    @Query("itemId", ParseIntPipe) itemId: number,
    @Query("warehouseId", ParseIntPipe) warehouseId: number,
  ) {
    return this.reservation.availability({ itemId, warehouseId });
  }

  /** Rezerviši robu po stavkama predračuna (idempotentno — ponovni poziv preskače). */
  @Post("reservations/from-invoice/:invoiceId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  reserveForProforma(
    @Param("invoiceId", ParseIntPipe) invoiceId: number,
    @Body() body: { warehouseId?: number; note?: string },
    @Req() req: { user: AuthUser },
  ) {
    return this.reservation.reserveForProforma(
      { invoiceId, warehouseId: body?.warehouseId, note: body?.note },
      req.user.userId,
    );
  }

  /** Ručna rezervacija. */
  @Post("reservations")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  createReservation(
    @Body() body: CreateReservationDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.reservation.create(body, req.user.userId);
  }

  /** Oslobodi jednu rezervaciju (vraća količinu u raspoloživo). */
  @Post("reservations/:id/release")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  releaseReservationById(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: { reason?: string },
    @Req() req: { user: AuthUser },
  ) {
    return this.reservation.releaseById(id, body?.reason, req.user.userId);
  }

  /** Oslobodi rezervacije po izvoru (ceo dokument ili jedna stavka). */
  @Post("reservations/release")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  releaseReservations(
    @Body() body: ReleaseReservationDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.reservation.release(body, req.user.userId);
  }

  /** Oslobodi istekle rezervacije (kandidat i za cron). */
  @Post("reservations/expire")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  expireReservations() {
    return this.reservation.expireDue();
  }
}
