import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import type { AuthUser } from "../auth/jwt.strategy";
import { RobnoService } from "./robno.service";
import { LagerQueryService } from "./lager-query.service";
import { KepuService } from "./kepu.service";
import {
  parseBoolParam,
  parseIntParam,
  requireIntParam,
} from "../../common/number-params";
import { CalculationService } from "./calculation.service";
import { InventoryService } from "./inventory.service";
import {
  CarryOverService,
  type CarryOverOptions,
} from "./carry-over.service";
import { PostingEngineService } from "../gl/posting/posting.service";
import { ReservationService } from "./reservation.service";
import { TransferService } from "./transfer.service";
import type { CreateTransferDto, ReverseTransferDto } from "./dto/transfer.dto";
import {
  StockDocumentPdfService,
  STOCK_PRINT_VARIANTS,
  type StockPrintVariant,
} from "./print/stock-document-pdf.service";
import {
  InventoryCountPdfService,
  INVENTORY_PRINT_VARIANTS,
  type InventoryPrintVariant,
} from "./print/inventory-count-pdf.service";
import { StockReportPdfService } from "./print/stock-report-pdf.service";
import { GoodsReceiptReportPdfService } from "./print/goods-receipt-report-pdf.service";
import {
  DOCUMENT_PRINT_KIND,
  DocumentPrintService,
} from "../documents/document-print.service";
import type {
  CreateReservationDto,
  ListReservationsQuery,
  ReleaseReservationDto,
} from "./dto/reservation.dto";
import type { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";
// VREDNOSNI import, NE `import type` — `emitDecoratorMetadata` upisuje klasu u
// `design:paramtypes` samo ako binding postoji u runtime-u. Sa `import type` TS je izbriše,
// metapodatak postane `Object`, i globalni `ValidationPipe` TIHO preskoči telo. Zbog toga
// `UpdateStockDocumentShippingDto` nije validirao ništa iako je 27.07.2026. baš radi
// validacije pretvoren iz interfejsa u klasu.
import {
  CreateStockDocumentBodyDto,
  UpdateStockDocumentShippingDto,
} from "./dto/create-stock-document.dto";
import { DocumentEditService } from "./document-edit.service";
import {
  CreateStockDocumentItemBodyDto,
  UpdateStockDocumentDto,
  UpdateStockDocumentItemDto,
} from "./dto/update-stock-document.dto";
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
 *   PATCH /api/v1/robno/documents/:id     — IZMENA ZAGLAVLJA (datum, dobavljač/kupac, magacin,
 *                                           način otpreme, napomena) — nacrt; meka polja i posle knjiženja
 *   POST  /api/v1/robno/documents/:id/items          — DODAJ stavku (nacrt)
 *   PATCH /api/v1/robno/documents/:id/items/:lineId  — IZMENI stavku (nacrt)
 *   PATCH /api/v1/robno/documents/:id/shipping — uslovi otpreme + napomena (polja koja štampa otpremnica)
 *   POST /api/v1/robno/documents/:id/calculate — kalkulacija landed cost (DRAFT → CALCULATED); UL okida nivelaciju
 *   POST /api/v1/robno/documents/:id/post — knjiženje u glavnu knjigu (StockDocument → nalog GK)
 *
 * Prenos između magacina (međuskladišnica) — PAR dokumenata u jednoj transakciji:
 *   POST /api/v1/robno/transfers            — razduži izvorni + zaduži odredišni magacin
 *   GET  /api/v1/robno/transfers/:id        — detalj (obe strane para + status storna)
 *   POST /api/v1/robno/transfers/:id/reverse — storno (ogledalni par)
 *
 * Popis / inventura (doc 39 §D) — predpunjenje → unos KolPop → razlika → knjiženje VISAK/MANJAK:
 *   GET   /api/v1/robno/inventory-counts               — lista (opciono ?year)
 *   POST  /api/v1/robno/inventory-counts               — kreiranje + predpunjenje (DRAFT→COUNTING)
 *   GET   /api/v1/robno/inventory-counts/:id           — detalj (zaglavlje + stavke)
 *   GET   /api/v1/robno/inventory-counts/:id/differences — razlika po stavci + zbirovi višak/manjak
 *   PATCH /api/v1/robno/inventory-counts/:id/items/:itemId — unos popisane količine (KolPop)
 *   POST  /api/v1/robno/inventory-counts/:id/finalize  — zaključi (VISAK/MANJAK dokumenti, COUNTING→POSTED)
 *
 * Štampa (PDF, inline; sve pod ROBNO_READ — štampa je pregled):
 *   GET /api/v1/robno/documents/:id/pdf?variant=  — primka | izdatnica | otpremnica |
 *                                                   nivelacija | prenosnica | kalkulacija | zapisnik |
 *                                                   trebovanje
 *   GET /api/v1/robno/documents/:id/prijem-zapisnik/pdf — ZAPISNIK O PRIJEMU (uz UL)
 *   GET /api/v1/robno/inventory-counts/:id/pdf?variant=prazna|popunjena — POPISNA LISTA
 *   GET /api/v1/robno/lager/pdf                   — lager lista (A4 položeno)
 *   GET /api/v1/robno/item-card/pdf               — kartica artikla
 *
 * read = ROBNO_READ; kreiranje/kalkulacija/popis-write = ROBNO_WRITE; knjiženje = ROBNO_POST.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.ROBNO_READ)
@Controller({ path: "robno", version: "1" })
export class RobnoController {
  constructor(
    private readonly robno: RobnoService,
    private readonly lagerQuery: LagerQueryService,
    private readonly kepu: KepuService,
    private readonly calculation: CalculationService,
    private readonly posting: PostingEngineService,
    private readonly inventory: InventoryService,
    private readonly carryOver: CarryOverService,
    private readonly documentEdit: DocumentEditService,
    private readonly reservation: ReservationService,
    private readonly transfer: TransferService,
    private readonly stockPdf: StockDocumentPdfService,
    private readonly inventoryPdf: InventoryCountPdfService,
    private readonly reportPdf: StockReportPdfService,
    private readonly receiptReportPdf: GoodsReceiptReportPdfService,
    private readonly prints: DocumentPrintService,
  ) {}

  // ─── Štampa (PDF) ──────────────────────────────────────────────────────────
  // Sve štampe robnog modula dele isti obrazac izgleda (`print/robno-doc-layout.ts`):
  // zaglavlje firme, telo sa stavkama i ponovljenim zaglavljem kolona preko strana,
  // zbirovi, potpisna mesta i noga „strana N/M" sa tragom štampe. Permisija ROBNO_READ
  // (kao ostale read rute modula) — generisanje PDF-a JESTE pregled.
  //
  // PREGLED vs ŠTAMPA (`?stampa=1`): trag u `document_prints` i žig „KOPIJA" se
  // upisuju SAMO kad klijent pošalje `stampa=1`, tj. kad je čovek pritisnuo dugme
  // „Štampaj". Bez toga bi svako otvaranje dokumenta radi provere trošilo redni broj
  // primerka i prvi fizički otisak bi izašao sa žigom KOPIJA (nalaz revizije
  // 27.07.2026). Ruta zato ostaje pod READ: samo eksplicitna štampa piše trag.

  /**
   * Štampa robnog dokumenta u PDF (inline). `variant` bira obrazac:
   * `primka | izdatnica | otpremnica | nivelacija | prenosnica | kalkulacija | zapisnik`.
   * Kad se ne prosledi, obrazac se izvodi iz `kind` dokumenta (UL→primka, IZ→izdatnica,
   * NIV→nivelacija, PRENOS→prenosnica, VISAK/MANJAK→zapisnik).
   */
  @Get("documents/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async documentPdf(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Query("stampa") stampa: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const v = parseVariant(
      variant,
      STOCK_PRINT_VARIANTS,
      "Nepoznat obrazac štampe",
    ) as StockPrintVariant | undefined;
    const { buffer, fileName } = await this.stockPdf.buildPdf(
      id,
      v,
      req.user?.userId ?? null,
      isPrintAction(stampa),
    );
    sendPdf(res, buffer, fileName);
  }

  /**
   * ZAPISNIK O PRIJEMU ROBE (kvantitativno-kvalitativni) uz ULAZNI dokument.
   * Odvojen obrazac od prijemnice: poredi naručeno (narudžbenica) sa primljenim i
   * ostavlja prazne kolone „Rok trajanja / Serija / Nalaz kontrole" za komisiju —
   * te kolone još nemaju polja u evidenciji, pa se ništa ne pretpostavlja.
   */
  @Get("documents/:id/prijem-zapisnik/pdf")
  @Header("Content-Type", "application/pdf")
  async receiptReportPdfRoute(
    @Param("id", ParseIntPipe) id: number,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.receiptReportPdf.buildPdf(
      id,
      req.user?.userId ?? null,
    );
    sendPdf(res, buffer, fileName);
  }

  /**
   * Štampa POPISNE LISTE (zakonski obrazac) u PDF. `variant`:
   *   `prazna`    — za teren (bez knjigovodstvenog stanja i cena, sa bar kodom i praznim poljima),
   *   `popunjena` — puni obrazac sa višak/manjak razlikama i zbirovima (podrazumevano).
   */
  @Get("inventory-counts/:id/pdf")
  @Header("Content-Type", "application/pdf")
  async inventoryCountPdf(
    @Param("id", ParseIntPipe) id: number,
    @Query("variant") variant: string | undefined,
    @Query("stampa") stampa: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const v =
      (parseVariant(
        variant,
        INVENTORY_PRINT_VARIANTS,
        "Nepoznata varijanta popisne liste",
      ) as InventoryPrintVariant | undefined) ?? "popunjena";
    const { buffer, fileName } = await this.inventoryPdf.buildPdf(
      id,
      v,
      req.user?.userId ?? null,
      isPrintAction(stampa),
    );
    sendPdf(res, buffer, fileName);
  }

  /** Štampa LAGER LISTE (A4 položeno) — isti filteri kao GET /robno/lager. */
  @Get("lager/pdf")
  @Header("Content-Type", "application/pdf")
  async lagerPdf(
    @Query("warehouseId") warehouseId: string | undefined,
    @Query("onlyInStock") onlyInStock: string | undefined,
    @Query("q") q: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.reportPdf.buildLagerPdf(
      {
        warehouseId: parseIntParam(warehouseId, "warehouseId", { min: 1 }),
        onlyInStock: parseBoolParam(onlyInStock),
        q,
      },
      req.user?.userId ?? null,
    );
    sendPdf(res, buffer, fileName);
  }

  /** Štampa KARTICE ARTIKLA — isti parametri kao GET /robno/item-card. */
  @Get("item-card/pdf")
  @Header("Content-Type", "application/pdf")
  async itemCardPdf(
    @Query("itemId") itemId: string | undefined,
    @Query("warehouseId") warehouseId: string | undefined,
    @Query("from") from: string | undefined,
    @Query("to") to: string | undefined,
    @Req() req: { user?: AuthUser },
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, fileName } = await this.reportPdf.buildItemCardPdf(
      {
        itemId: requireIntParam(itemId, "itemId", { min: 1 }),
        warehouseId: requireIntParam(warehouseId, "warehouseId", { min: 1 }),
        from,
        to,
      },
      req.user?.userId ?? null,
    );
    sendPdf(res, buffer, fileName);
  }

  @Get("documents")
  list(@Query() query: ListStockDocumentsQuery) {
    return this.robno.listStockDocuments(query);
  }

  /**
   * Lager lista — stanje zaliha po magacinu + prosečne cene (BigBit paritet).
   *
   * Brojevi idu kroz `parseIntParam` (400 na nevalidan unos): `Number("abc")` je `NaN`,
   * a `NaN` prolazi provere `!= null` i odlazi pravo u SQL parametar → goli 500 iz
   * drajvera na banalnu grešku u URL-u.
   */
  @Get("lager")
  lager(
    @Query("warehouseId") warehouseId?: string,
    @Query("onlyInStock") onlyInStock?: string,
    @Query("q") q?: string,
    @Query("skip") skip?: string,
    @Query("take") take?: string,
  ) {
    return this.lagerQuery.listLager({
      warehouseId: parseIntParam(warehouseId, "warehouseId", { min: 1 }),
      onlyInStock: parseBoolParam(onlyInStock),
      q,
      skip: parseIntParam(skip, "skip", { min: 0 }),
      take: parseIntParam(take, "take", { min: 1 }),
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
    return this.lagerQuery.getItemCard({
      itemId: requireIntParam(itemId, "itemId", { min: 1 }),
      warehouseId: requireIntParam(warehouseId, "warehouseId", { min: 1 }),
      from,
      to,
    });
  }

  @Get("documents/:id")
  findOne(@Param("id", ParseIntPipe) id: number) {
    return this.robno.getStockDocument(id);
  }

  /**
   * Istorija štampe dokumenta: ko je, kada i koji obrazac odštampao, i koji je to
   * bio primerak. Bez ovoga se broj primerka i žig „KOPIJA" na papiru ne mogu
   * proveriti ni objasniti — a to je jedini razlog zbog kog `document_prints`
   * postoji. Permisija ROBNO_READ: isti podatak korisnik već vidi u nozi papira.
   */
  @Get("documents/:id/prints")
  documentPrints(@Param("id", ParseIntPipe) id: number) {
    return this.prints
      .history(DOCUMENT_PRINT_KIND.STOCK, id)
      .then((data) => ({ data }));
  }

  /**
   * Kreiranje robnog dokumenta. Telo je KLASA (`CreateStockDocumentBodyDto`), ne presek
   * tipova — globalni `ValidationPipe` validira samo klase, a presek
   * `{ kind } & CreateStockDocumentDto` je tiho preskakao CELO telo (i stavke).
   */
  @Post("documents")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  create(@Body() body: CreateStockDocumentBodyDto) {
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
   * Uslovi otpreme i napomena (`fco`, način/datum otpreme, mesto isporuke, ruta,
   * „po porudžbini od", napomena). Ova polja štampa OTPREMNICA; dok nisu uneta,
   * papir ostavlja prazne linije za ručni upis (nikad pretpostavljenu vrednost).
   *
   * Dozvoljeno i na PROKNJIŽENOM dokumentu (podaci se saznaju posle knjiženja i ne
   * ulaze u zalihu/GK), ali NE na zaključanom (409). Permisija ROBNO_WRITE.
   */
  @Patch("documents/:id/shipping")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  updateShipping(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateStockDocumentShippingDto,
  ) {
    return this.robno.updateShipping(id, dto);
  }

  /**
   * IZMENA ZAGLAVLJA robnog dokumenta — datum dokumenta/knjiženja, dobavljač, kupac, magacin,
   * način otpreme, napomena. Do 28.07.2026. ovog puta NIJE BILO: pogrešno ukucan datum ili
   * dobavljač značili su „obriši sve stavke i unesi dokument ponovo", a broj je već potrošen
   * (`PLAN_UNOS_DOKUMENATA §5.7`).
   *
   * GUARD PO POSLEDICI: polja koja ulaze u zalihu/costing (datum, magacin, komitent) menjaju se
   * samo dok je dokument NACRT (proknjižen/kalkulisan/zaključan = 409 sa uputstvom); način
   * otpreme i napomena su dozvoljeni i posle knjiženja (kao `PATCH …/shipping`), jer se ti
   * podaci saznaju kasnije. Promena magacina POVLAČI i stavke koje su pratile zaglavlje i za
   * izlazni dokument prolazi kroz proveru zaliha NOVOG magacina.
   *
   * Prenos između magacina, storno i dokument iz popisa se ODBIJAJU (ne popravljaju se ovuda).
   * Permisija ROBNO_WRITE.
   */
  @Patch("documents/:id")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  updateDocument(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: UpdateStockDocumentDto,
    @Req() req: { user?: AuthUser },
  ) {
    return this.documentEdit.updateHeader(id, dto, req.user?.userId ?? null);
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
    const kepuEntries = await this.kepu.writeKepuForDocument(id);
    // Ne vraćamo interni LedgerLineDraft[] tip direktno (nije eksportovan) — sažetak.
    return {
      data: { docId: id, ledgerLines: lines.length, kepuEntries, posted: true },
    };
  }

  // ─── Stavke: dodavanje / izmena ────────────────────────────────────────────
  // Cene NE računa ova ruta — kalkulativne kolone piše isključivo `CalculationService`.
  // `recalculate: true` u telu ga pozove odmah, ali time dokument prelazi u CALCULATED i
  // zatvara se za dalje izmene stavki; zato je podrazumevano `false` (v. DTO).

  /**
   * DODAJ stavku na nacrt robnog dokumenta. Telo = ista polja kao stavka pri kreiranju
   * (`itemId`, `quantity`, `warehouseId`, fakturna cena, rabat, kasa, zavisni troškovi…).
   * `lineNo` izostavljen → sledeći slobodan. Količina 0 ili negativna = 422 (smer se izvodi
   * iz vrste dokumenta). Za IZLAZNI dokument prolazi kroz proveru zaliha magacina te stavke.
   * Permisija ROBNO_WRITE.
   */
  @Post("documents/:id/items")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  addItem(
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: CreateStockDocumentItemBodyDto,
    @Req() req: { user?: AuthUser },
  ) {
    return this.documentEdit.addItem(id, dto, req.user?.userId ?? null);
  }

  /**
   * IZMENI postojeću stavku nacrta (artikal, magacin, količina, redni broj, cene/rabati).
   * Prosleđuju se samo polja koja se menjaju. Meko obrisana stavka = 409 sa uputstvom
   * („poništi brisanje pa menjaj"). Permisija ROBNO_WRITE.
   */
  @Patch("documents/:id/items/:lineId")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  updateItem(
    @Param("id", ParseIntPipe) id: number,
    @Param("lineId", ParseIntPipe) lineId: number,
    @Body() dto: UpdateStockDocumentItemDto,
    @Req() req: { user?: AuthUser },
  ) {
    return this.documentEdit.updateItem(
      id,
      lineId,
      dto,
      req.user?.userId ?? null,
    );
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
    const y = parseIntParam(year, "year", { min: 1990, max: 2100 });
    const result = await this.kepu.rebuildKepu({ year: y });
    return { data: result };
  }

  // ─── Prenos između magacina (međuskladišnica) ──────────────────────────────
  // Prenos NIJE jedan dokument: stanje se računa po magacinu iz stavki, sa znakom iz
  // vrste dokumenta, pa jedan dokument može da promeni SAMO jedan magacin. Zato ove rute
  // prave PAR (PREIZ izlaz + PREUL ulaz) u jednoj transakciji. Kreiranje prenosa kroz
  // opštu rutu `POST /robno/documents` sa `kind=PRENOS` je namerno odbijeno (422).

  /**
   * Napravi prenos između magacina — razduži izvorni i zaduži odredišni magacin
   * (dva povezana dokumenta, jedna transakcija). Nedovoljno stanje u izvornom
   * magacinu = 422. Permisija ROBNO_WRITE.
   */
  @Post("transfers")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  createTransfer(
    @Body() body: CreateTransferDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.transfer.createTransfer(body, req.user?.userId ?? null);
  }

  /** Detalj prenosa (sa bilo koje strane para) — obe strane, oba magacina, status storna. */
  @Get("transfers/:id")
  getTransfer(@Param("id", ParseIntPipe) id: number) {
    return this.transfer.get(id);
  }

  /**
   * Storniraj prenos — ogledalni par koji vraća robu u izvorni magacin. Već storniran
   * prenos = 409; roba potrošena iz odredišnog magacina = 422. Permisija ROBNO_WRITE.
   */
  @Post("transfers/:id/reverse")
  @RequirePermission(PERMISSIONS.ROBNO_WRITE)
  reverseTransfer(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: ReverseTransferDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.transfer.reverse(id, body ?? {}, req.user?.userId ?? null);
  }

  // ─── Popis / inventura (doc 39 §D) ─────────────────────────────────────────

  /** Lista popisa (najnoviji prvo), opcioni filter po godini. */
  @Get("inventory-counts")
  listCounts(@Query("year") year?: string) {
    const y = parseIntParam(year, "year", { min: 1990, max: 2100 });
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

/**
 * Validacija `?variant=` — prazno vraća `undefined` (servis bira podrazumevani obrazac),
 * nepoznata vrednost je 422 sa spiskom dozvoljenih (ne tiho pada na default, da se
 * pogrešan link u UI-ju odmah vidi).
 */
function parseVariant<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  message: string,
): T | undefined {
  const v = (value ?? "").trim();
  if (v === "") return undefined;
  if (!(allowed as readonly string[]).includes(v))
    throw new UnprocessableEntityException(
      `${message}: „${v}". Dozvoljeno: ${allowed.join(", ")}.`,
    );
  return v as T;
}

/**
 * `?stampa=1` — klijent izričito traži ŠTAMPU, ne pregled.
 *
 * Samo tada se upisuje trag u `document_prints` i troši redni broj primerka, pa
 * samo tada papir može da nosi žig „KOPIJA". Sve ostalo (otvaranje dokumenta,
 * ponovno preuzimanje istog PDF-a, tuđi pregled) je pregled i ne pomera brojač.
 * Prihvata se samo `1`/`true`/`da` — nepoznata vrednost je pregled, jer je tiho
 * potrošen primerak gora greška od nezabeležene štampe.
 */
function isPrintAction(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "da";
}

/** Isporuka PDF-a inline (pregled u browseru + preuzimanje) — isti obrazac kao sales/gl. */
function sendPdf(res: Response, buffer: Buffer, fileName: string): void {
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${encodeURIComponent(fileName)}"`,
  );
  res.send(buffer);
}
