import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import { parseDateParam } from "../../common/date-params";
import { StockDocumentNumberingService } from "./stock-document-numbering.service";
import { CostingService } from "./costing.service";
import { toDec } from "./decimal.util";
import {
  CreateStockDocumentDto,
  CreateStockDocumentItemDto,
} from "./dto/create-stock-document.dto";
import { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";
import { computeKepuEntries, writeKepuEntries } from "./kepu-book.util";
import { stockKeyOf, sumOpenReservations } from "./reservation.service";
import type { ReservationSourceRef, StockKey } from "./dto/reservation.dto";
import {
  NOT_DELETED,
  UNDO_WINDOW_MS,
  restore,
  softDelete,
} from "../../common/soft-delete.util";

/** Diskriminator robnog dokumenta (`stock_documents.kind`). */
export type StockDocumentKind =
  | "UL"
  | "IZ"
  | "NIV"
  | "PRENOS"
  | "VISAK"
  | "MANJAK";

const VALID_KINDS: readonly StockDocumentKind[] = [
  "UL",
  "IZ",
  "NIV",
  "PRENOS",
  "VISAK",
  "MANJAK",
];

/**
 * Glavni robni servis (`stock_documents` + `stock_document_items`, 2.0-native, sve Decimal).
 *
 * Obrazac iz `handovers`/`nabavka`: read (list/get) + kreiranje kroz `$transaction` sa advisory-lock
 * numeracijom (`NNNN/god`, `StockDocumentNumberingService`). Kalkulaciju (landed cost) vodi
 * `CalculationService` (poziva se posle kreiranja UL/UVOZ dokumenta — ovaj servis samo kreira DRAFT).
 *
 * Meki ref-ovi (itemId/warehouseId/supplierId/…): postojanje se validira u servisu (BACKEND_RULES §4/§6).
 * Poslovne greške = ugrađeni NestJS exception-i (§7). Iznosi ulaze kao string/number → `Prisma.Decimal`.
 *
 * NAPOMENA (doc 39 / PLAN_FAZA_3): costing čita SAMO `stock_documents` — `goods_documents` je prazna i
 * izbačena iz sync-a (NEMA UNION-a sa njom).
 */
@Injectable()
export class RobnoService {
  private readonly logger = new Logger(RobnoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly numbering: StockDocumentNumberingService,
    private readonly costing: CostingService,
  ) {}

  // ---------------------------------------------------------------- READ

  async listStockDocuments(query: ListStockDocumentsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );

    const where: Prisma.StockDocumentWhereInput = {};
    if (query.kind && VALID_KINDS.includes(query.kind as StockDocumentKind))
      where.kind = query.kind;
    if (query.documentTypeCode) where.documentTypeCode = query.documentTypeCode;
    if (query.status) where.status = query.status;

    const intEq = (v: string | undefined) => {
      const n = Number.parseInt(v ?? "", 10);
      return Number.isNaN(n) ? undefined : n;
    };
    const warehouseId = intEq(query.warehouseId);
    if (warehouseId !== undefined) where.warehouseId = warehouseId;
    const supplierId = intEq(query.supplierId);
    if (supplierId !== undefined) where.supplierId = supplierId;
    const year = intEq(query.year);
    if (year !== undefined) where.year = year;

    const from = parseDateParam(query.from, "from");
    const to = parseDateParam(query.to, "to");
    if (from || to) {
      const range: Prisma.DateTimeFilter = {};
      if (from) range.gte = from;
      if (to) range.lte = to;
      where.documentDate = range;
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockDocument.findMany({
        where,
        orderBy: [{ documentDate: "desc" }, { id: "desc" }],
        skip,
        take,
      }),
      this.prisma.stockDocument.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * Lager lista (BigBit paritet — stanje zaliha po magacinu + prosečne cene).
   * Čita StockLevel snapshot (onHand + avgPurchaseNet/avgWholesalePrice) i
   * pridružuje naziv artikla. Filter: magacin, samo-sa-stanjem, pretraga po nazivu.
   *
   * REZERVISANO (C3): `reserved` je AGREGAT otvorenih redova `stock_reservations`
   * (`status='OPEN'`), NE denormalizovana kolona `StockLevel.reserved` — ta kolona je mrtav
   * legacy snapshot koji niko ne upisuje (uvek 0) i namerno se ne dira. Novo polje
   * `available = onHand − reserved` je ono što se sme obećati kupcu. Jedan agregatni upit
   * po strani (`groupBy`), bez N+1.
   */
  async listLager(query: {
    warehouseId?: number;
    onlyInStock?: boolean;
    q?: string;
    skip?: number;
    take?: number;
  }) {
    const where: Prisma.StockLevelWhereInput = {};
    if (query.warehouseId != null) where.warehouseId = query.warehouseId;
    if (query.onlyInStock) where.onHand = { gt: 0 };

    const take = Math.min(query.take ?? 100, 500);
    const skip = query.skip ?? 0;

    const [levels, total] = await this.prisma.$transaction([
      this.prisma.stockLevel.findMany({
        where,
        orderBy: [{ warehouseId: "asc" }, { itemId: "asc" }],
        skip,
        take,
      }),
      this.prisma.stockLevel.count({ where }),
    ]);

    // Pridruži naziv/šifru artikla (meki ref items.id) — jedan upit po skupu id-jeva.
    const itemIds = [...new Set(levels.map((l) => l.itemId))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          select: { id: true, name: true, catalogNumber: true, unit: true },
        })
      : [];
    const itemById = new Map(items.map((i) => [i.id, i]));

    // Rezervisano = Σ OPEN rezervacija po (artikal, magacin) — jedan groupBy za celu stranu.
    const reservedByKey = await sumOpenReservations(
      this.prisma,
      levels.map((l) => ({ itemId: l.itemId, warehouseId: l.warehouseId })),
    );

    let data = levels.map((l) => {
      const it = itemById.get(l.itemId);
      const reserved =
        reservedByKey.get(stockKeyOf(l.itemId, l.warehouseId)) ??
        new Prisma.Decimal(0);
      return {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        unit: it?.unit ?? null,
        onHand: l.onHand.toFixed(3),
        reserved: reserved.toFixed(3),
        /** Raspoloživo za obećanje kupcu = stanje − otvorene rezervacije (može biti < 0). */
        available: l.onHand.sub(reserved).toFixed(3),
        avgPurchaseNet: l.avgPurchaseNet.toFixed(2),
        avgWholesalePrice: l.avgWholesalePrice.toFixed(2),
        // Vrednost iz ISTE zaokružene cene koja se prikazuje (review NIZAK) — da ručna
        // kontrola „stanje × cena = vrednost" štima; puna preciznost pravila lažne razlike.
        stockValue: l.onHand
          .mul(l.avgPurchaseNet.toDecimalPlaces(2))
          .toFixed(2),
      };
    });

    // Pretraga po nazivu/šifri (posle join-a — mali skup po strani).
    if (query.q && query.q.trim() !== "") {
      const term = query.q.trim().toLowerCase();
      data = data.filter(
        (r) =>
          (r.itemName ?? "").toLowerCase().includes(term) ||
          (r.itemCode ?? "").toLowerCase().includes(term),
      );
    }

    return { data, meta: { total, skip, take } };
  }

  async getStockDocument(id: number) {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id },
      include: {
        // Soft-delete (Batch B): meko-obrisane stavke se NE prikazuju na detalju.
        items: { where: NOT_DELETED, orderBy: { id: "asc" } },
        stockLevelingItems: { orderBy: { id: "asc" } },
      },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
    return { data: doc };
  }

  /**
   * Kartica artikla (BigBit paritet — hronološka kartica kretanja po magacinu). Vraća redove
   * `stock_document_items` za (artikal, magacin) do gornje granice `to` (ili „danas"), hronološki,
   * sa kolonama datum/dokument/vrsta/ulaz/izlaz/running-stanje. Početno stanje pre `from` = `openingBalance`.
   *
   * DOSLEDNOST SA COSTING-om (garantovano): filter je IDENTIČAN `CostingService.stateAsOf` — KODJ izuzet,
   * `affects_stock`, znak iz `DocumentType.is_inbound`, BEZ filtera po statusu (costing broji sva kretanja).
   * Zato `closingBalance` (running na kraju) == `stateAsOf` (nezavisno izračunat kroz costing) — v. smoke §2
   * („krajnje stanje == stateAsOf danas"). `from`/`to` samo seku prozor prikaza, ne menjaju obračun stanja.
   */
  async getItemCard(params: {
    itemId: number;
    warehouseId: number;
    from?: string;
    to?: string;
  }) {
    const { itemId, warehouseId } = params;
    if (!Number.isInteger(itemId) || itemId <= 0)
      throw new UnprocessableEntityException(
        "itemId je obavezan — pozitivan ceo broj.",
      );
    if (!Number.isInteger(warehouseId) || warehouseId <= 0)
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );

    const from = parseDateParam(params.from, "from");
    const to = parseDateParam(params.to, "to");
    // Gornja granica prikaza/obračuna = `to` ili „sada" (stanje na dan danas kad `to` nije zadat).
    const effectiveTo = to ?? new Date();

    // Sva kretanja (artikal, magacin) do `effectiveTo`, hronološki. Filter VERBATIM iz costing.stateAsOf.
    const rows = await this.prisma.$queryRaw<
      Array<{
        item_line_id: number;
        document_id: number;
        document_number: string;
        kind: string;
        document_type_code: string;
        document_date: Date;
        quantity: Prisma.Decimal;
        is_inbound: boolean;
      }>
    >(
      Prisma.sql`
        SELECT sdi.id AS item_line_id, sd.id AS document_id, sd.document_number,
               sd.kind, sd.document_type_code, sd.document_date,
               sdi.quantity, dt.is_inbound
        FROM stock_document_items sdi
        JOIN stock_documents sd ON sd.id = sdi.document_id
        JOIN document_types dt ON dt.code = sd.document_type_code
        WHERE sdi.item_id = ${itemId}
          AND sdi.warehouse_id = ${warehouseId}
          AND sd.document_date <= ${effectiveTo}
          AND sd.document_type_code <> 'KODJ'
          AND COALESCE(dt.affects_stock, TRUE) = TRUE
          AND sdi.deleted_at IS NULL
        ORDER BY sd.document_date ASC, sd.id ASC, sdi.id ASC
      `,
    );

    let running = new Prisma.Decimal(0);
    let opening = new Prisma.Decimal(0);
    let totalIn = new Prisma.Decimal(0);
    let totalOut = new Prisma.Decimal(0);
    const lines: Array<{
      itemLineId: number;
      documentId: number;
      documentNumber: string;
      kind: string;
      documentTypeCode: string;
      documentDate: string;
      direction: "IN" | "OUT";
      in: string;
      out: string;
      balance: string;
    }> = [];

    for (const r of rows) {
      const signed = r.is_inbound ? r.quantity : r.quantity.negated();
      running = running.add(signed);
      // Redovi pre `from` ne ulaze u prikaz — zbir do njih je početno stanje.
      if (from && r.document_date < from) {
        opening = running;
        continue;
      }
      if (r.is_inbound) totalIn = totalIn.add(r.quantity);
      else totalOut = totalOut.add(r.quantity);
      lines.push({
        itemLineId: r.item_line_id,
        documentId: r.document_id,
        documentNumber: r.document_number,
        kind: r.kind,
        documentTypeCode: r.document_type_code,
        documentDate: r.document_date.toISOString(),
        direction: r.is_inbound ? "IN" : "OUT",
        in: r.is_inbound ? r.quantity.toFixed(6) : "0.000000",
        out: r.is_inbound ? "0.000000" : r.quantity.toFixed(6),
        balance: running.toFixed(6),
      });
    }
    const closing = running;

    // Nezavisna provera stanja kroz costing (mora == closing; smoke §2). Meki ref naziva artikla.
    const [stateAsOf, item] = await Promise.all([
      this.costing.stateAsOf(itemId, warehouseId, effectiveTo),
      this.prisma.item.findUnique({
        where: { id: itemId },
        select: { id: true, name: true, catalogNumber: true, unit: true },
      }),
    ]);

    return {
      data: {
        itemId,
        warehouseId,
        from: from ? from.toISOString() : null,
        to: effectiveTo.toISOString(),
        item: item
          ? {
              id: item.id,
              name: item.name,
              code: item.catalogNumber,
              unit: item.unit,
            }
          : null,
        openingBalance: opening.toFixed(6),
        closingBalance: closing.toFixed(6),
        stateAsOf: stateAsOf.toFixed(6),
        totalIn: totalIn.toFixed(6),
        totalOut: totalOut.toFixed(6),
        lines,
      },
    };
  }

  // -------------------------------------------------------------- CREATE

  /**
   * Kreiraj robni dokument (`kind` = UL/IZ/NIV/PRENOS/VISAK/MANJAK) u statusu DRAFT.
   * Numeracija `NNNN/god` (advisory lock po companyId+tip+godina) je u istoj transakciji.
   * NE pokreće kalkulaciju — pozivalac (ruta) posle poziva `CalculationService.calculate(docId)`
   * za UL/UVOZ. Iznosi se čuvaju sirovi (invoicePrice/rabat/kasa…); landed polja popunjava kalkulacija.
   *
   * `opts.reservationSource` (C3): izvor rezervacije koju OVAJ dokument troši — izdatnica
   * napravljena iz predračuna koji drži tu robu ne sme sama sebe da blokira, pa se te
   * rezervacije izuzimaju iz obračuna raspoloživog u guardu. Izostavljeno = dokument nije
   * potrošač nijedne rezervacije (sve otvorene rezervacije mu smanjuju raspoloživo).
   */
  async createStockDocument(
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    opts?: { reservationSource?: ReservationSourceRef },
  ) {
    if (!VALID_KINDS.includes(kind))
      throw new UnprocessableEntityException(
        `Nepoznat tip robnog dokumenta '${kind}'.`,
      );
    if (!dto?.documentTypeCode?.trim())
      throw new UnprocessableEntityException("documentTypeCode je obavezan.");
    if (
      !Number.isInteger(dto?.warehouseId) ||
      (dto.warehouseId as number) <= 0
    )
      throw new UnprocessableEntityException(
        "warehouseId je obavezan — pozitivan ceo broj.",
      );
    if (!Array.isArray(dto?.items) || dto.items.length === 0)
      throw new UnprocessableEntityException(
        "Dokument mora imati bar jednu stavku.",
      );
    if (kind === "PRENOS") {
      if (
        !Number.isInteger(dto?.targetWarehouseId) ||
        (dto.targetWarehouseId as number) <= 0
      )
        throw new UnprocessableEntityException(
          "PRENOS zahteva targetWarehouseId (odredišni magacin).",
        );
      if (dto.targetWarehouseId === dto.warehouseId)
        throw new UnprocessableEntityException(
          "Izvorni i odredišni magacin ne smeju biti isti.",
        );
    }

    // Meki ref-ovi (validacija postojanja pre upisa — BACKEND_RULES §4/§6).
    const documentType = await this.prisma.documentType.findFirst({
      where: { code: dto.documentTypeCode },
      select: { id: true, code: true },
    });
    if (!documentType)
      throw new UnprocessableEntityException(
        `Tip dokumenta '${dto.documentTypeCode}' ne postoji (document_types.code).`,
      );

    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: dto.warehouseId },
      select: { id: true },
    });
    if (!warehouse)
      throw new UnprocessableEntityException(
        `Magacin ${dto.warehouseId} ne postoji.`,
      );
    if (dto.targetWarehouseId) {
      const target = await this.prisma.warehouse.findUnique({
        where: { id: dto.targetWarehouseId },
        select: { id: true },
      });
      if (!target)
        throw new UnprocessableEntityException(
          `Odredišni magacin ${dto.targetWarehouseId} ne postoji.`,
        );
    }

    // Validacija artikala (svi u jednom upitu; nepostojeći → 422 sa spiskom).
    const itemIds = [...new Set(dto.items.map((i) => i.itemId))];
    if (itemIds.some((id) => !Number.isInteger(id) || id <= 0))
      throw new UnprocessableEntityException(
        "Svaka stavka mora imati validan itemId (pozitivan ceo broj).",
      );
    const existingItems = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true },
    });
    const existingItemIds = new Set(existingItems.map((i) => i.id));
    const missingItems = itemIds.filter((id) => !existingItemIds.has(id));
    if (missingItems.length)
      throw new UnprocessableEntityException(
        `Artikli ne postoje: ${missingItems.join(", ")}.`,
      );

    for (const it of dto.items) {
      if (toDec(it.quantity).isZero())
        throw new UnprocessableEntityException(
          `Stavka (itemId ${it.itemId}) mora imati količinu različitu od 0.`,
        );
    }

    const documentDate = parseDateParam(dto.documentDate, "documentDate") ?? new Date();
    const postingDate = parseDateParam(dto.postingDate, "postingDate") ?? documentDate;
    const companyId = 0; // jednofirmno (kao ostatak 2.0); segment numeracije
    const year = documentDate.getFullYear();

    const created = await this.prisma.$transaction(async (tx) => {
      // Guard raspoloživog stanja za IZLAZ (IZ/MANJAK) — nedovoljno stanje → 422 (doc 39 §C).
      // Costing (stateAsOf) namerno dozvoljava negativno interno; provera je ovde, na granici upisa.
      // C3: od stanja se oduzimaju i OTVORENE rezervacije (osim onih koje ovaj dokument troši).
      const reservedByKey = await this.loadOpenReserved(
        tx,
        kind,
        dto,
        opts?.reservationSource,
      );
      await this.assertSufficientStock(
        tx,
        kind,
        dto,
        documentDate,
        reservedByKey,
      );

      const { documentNumber } = await this.numbering.next(
        tx,
        companyId,
        dto.documentTypeCode,
        year,
      );

      return tx.stockDocument.create({
        data: {
          companyId,
          kind,
          documentTypeCode: dto.documentTypeCode,
          documentNumber,
          year,
          warehouseId: dto.warehouseId,
          targetWarehouseId: dto.targetWarehouseId ?? null,
          supplierId: dto.supplierId ?? null,
          customerId: dto.customerId ?? null,
          documentDate,
          postingDate,
          isImport: dto.isImport === true,
          customsExchangeRate: toDec(dto.customsExchangeRate ?? 1),
          accountingExchangeRate: toDec(dto.accountingExchangeRate ?? 1),
          fxInvoiceValue: toDec(dto.fxInvoiceValue),
          customs: toDec(dto.customs),
          forwarding: toDec(dto.forwarding),
          otherDependentCosts: toDec(dto.otherDependentCosts),
          customsRefundBase: toDec(dto.customsRefundBase),
          purchaseOrderId: dto.purchaseOrderId ?? null,
          projectId: dto.projectId ?? null,
          workOrderId: dto.workOrderId ?? null,
          linkedInboundDocId: dto.linkedInboundDocId ?? null,
          inventoryCountId: dto.inventoryCountId ?? null,
          status: "DRAFT",
          isCalculated: false,
          createdByUserId: dto.createdByUserId ?? null,
          items: {
            create: dto.items.map((it, idx) =>
              this.buildItemData(it, dto.warehouseId, idx),
            ),
          },
        },
        include: { items: { orderBy: { id: "asc" } } },
      });
    });

    this.logger.log(
      `Kreiran robni dokument ${created.documentNumber} (kind=${kind}, id=${created.id}, ${created.items.length} stavki).`,
    );
    return { data: created };
  }

  /**
   * Otvorene rezervacije za (artikal, magacin) parove iz izlaznog dokumenta (C3) — jedan
   * agregatni upit; prazna mapa za sve vrste osim IZ/MANJAK (rezervacije ne blokiraju ulaz).
   *
   * `reservationSource` = izvor koji OVAJ dokument troši (npr. predračun čija se izdatnica
   * pravi) — te rezervacije se izuzimaju, jer bi inače dokument blokirao sam sebe.
   */
  private async loadOpenReserved(
    tx: Prisma.TransactionClient,
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    reservationSource?: ReservationSourceRef,
  ): Promise<Map<string, Prisma.Decimal>> {
    if (kind !== "IZ" && kind !== "MANJAK") return new Map();
    const keys: StockKey[] = dto.items.map((it) => ({
      itemId: it.itemId,
      warehouseId: it.warehouseId ?? dto.warehouseId,
    }));
    return sumOpenReservations(
      tx,
      keys,
      reservationSource
        ? {
            sourceType: reservationSource.sourceType,
            sourceId: reservationSource.sourceId,
          }
        : undefined,
    );
  }

  /**
   * Guard negativnog stanja pri IZLAZU (kind IZ/MANJAK) — C11 (doc 39 §C / #21).
   *
   * Za svaku (artikal, magacin) kombinaciju agregira traženu količinu iz stavki i poredi je sa
   * RASPOLOŽIVIM = `CostingService.stateAsOf(itemId, warehouseId, documentDate)` (as-of do datuma
   * dokumenta, KODJ izuzet) **umanjeno za otvorene rezervacije** (`reservedByKey`, C3). Ako je
   * traženo > raspoloživo → `UnprocessableEntityException` sa listom (artikal, traženo,
   * raspoloživo). Čita kroz istu `tx` (dosledno sa upisom).
   *
   * `reservedByKey` puni `loadOpenReserved` i ono već IZUZIMA rezervacije koje ovaj dokument
   * troši — izdatnica koja razdužuje sopstveni predračun ne sme sama sebe da blokira. Prazna
   * mapa (podrazumevano) = ponašanje pre C3, golo `stateAsOf`.
   *
   * NE dira `CostingService` (namerno dozvoljava negativno interno) — guard je isključivo na
   * granici kreiranja izlaznog dokumenta. UL/UVOZ/NIV/PRENOS/VISAK ne prolaze kroz guard.
   */
  private async assertSufficientStock(
    tx: Prisma.TransactionClient,
    kind: StockDocumentKind,
    dto: CreateStockDocumentDto,
    documentDate: Date,
    reservedByKey: ReadonlyMap<string, Prisma.Decimal> = new Map(),
  ): Promise<void> {
    if (kind !== "IZ" && kind !== "MANJAK") return;

    // Agregiraj traženu (pozitivnu) količinu po (artikal, magacin) — više stavki istog artikla se sabira.
    const requested = new Map<
      string,
      { itemId: number; warehouseId: number; qty: Prisma.Decimal }
    >();
    for (const it of dto.items) {
      const warehouseId = it.warehouseId ?? dto.warehouseId;
      const key = `${it.itemId}:${warehouseId}`;
      const qty = toDec(it.quantity).abs();
      const cur = requested.get(key);
      if (cur) cur.qty = cur.qty.add(qty);
      else requested.set(key, { itemId: it.itemId, warehouseId, qty });
    }

    const shortages: Array<{
      itemId: number;
      warehouseId: number;
      requested: Prisma.Decimal;
      available: Prisma.Decimal;
      reserved: Prisma.Decimal;
    }> = [];
    for (const r of requested.values()) {
      const onHand = await this.costing.stateAsOf(
        r.itemId,
        r.warehouseId,
        documentDate,
        { tx },
      );
      // Raspoloživo = stanje − tuđe otvorene rezervacije (C3); rezervacije ovog dokumenta
      // su već izuzete u `loadOpenReserved`, pa potrošač ne blokira sam sebe.
      const reserved =
        reservedByKey.get(stockKeyOf(r.itemId, r.warehouseId)) ??
        new Prisma.Decimal(0);
      const available = onHand.sub(reserved);
      if (available.lessThan(r.qty)) {
        shortages.push({
          itemId: r.itemId,
          warehouseId: r.warehouseId,
          requested: r.qty,
          available,
          reserved,
        });
      }
    }
    if (shortages.length === 0) return;

    // Nazivi artikala za čitljivu poruku (meki ref items.id).
    const items = await tx.item.findMany({
      where: { id: { in: shortages.map((s) => s.itemId) } },
      select: { id: true, name: true, catalogNumber: true },
    });
    const itemById = new Map(items.map((i) => [i.id, i]));

    const detail = shortages.map((s) => {
      const it = itemById.get(s.itemId);
      const label = it
        ? `${it.name}${it.catalogNumber ? ` (${it.catalogNumber})` : ""}`
        : `artikal ${s.itemId}`;
      return {
        itemId: s.itemId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        warehouseId: s.warehouseId,
        requested: s.requested.toFixed(3),
        available: s.available.toFixed(3),
        /** Od toga zauzeto tuđim otvorenim rezervacijama (C3) — 0 kad rezervacija nema. */
        reserved: s.reserved.toFixed(3),
        label,
      };
    });
    const human = detail
      .map(
        (d) =>
          `${d.label} — traženo ${d.requested}, raspoloživo ${d.available}` +
          (Number(d.reserved) > 0 ? ` (rezervisano ${d.reserved})` : ""),
      )
      .join("; ");

    throw new UnprocessableEntityException({
      code: "STOCK_INSUFFICIENT",
      message: `Nedovoljno stanje za izlaz (${kind}): ${human}.`,
      shortages: detail,
    });
  }

  // ------------------------------------------------------- ZAKLJUČAVANJE (lock)

  /**
   * Zaključaj proknjižen robni dokument → status LOCKED (Faza-0 lock; StockDocument nema `isLocked`
   * kolonu, lock je terminalna vrednost `status` — schema:3088 `DRAFT | CALCULATED | POSTED | LOCKED`).
   *
   * Preduslov = dokument je PROKNJIŽEN u GK (`journalEntryId != null`). NAPOMENA: regularni robni
   * `post` (posting.service) postavlja SAMO `journalEntryId` (status ostaje CALCULATED), a NIV put
   * postavlja i `status=POSTED` — zato je „proknjižen" izveden iz `journalEntryId`, ne iz statusa.
   *
   * CAS (updateMany + count guard, obrazac kao GK lock / izvodi): pomeri na LOCKED SAMO ako je
   * dokument proknjižen i još nije LOCKED. `count === 0` → razlikuj 404 / 409 (već zaključan /
   * nije proknjižen) dodatnim čitanjem.
   */
  async lockDocument(id: number) {
    const res = await this.prisma.stockDocument.updateMany({
      where: { id, journalEntryId: { not: null }, status: { not: "LOCKED" } },
      data: { status: "LOCKED" },
    });
    if (res.count === 0) {
      const doc = await this.prisma.stockDocument.findUnique({
        where: { id },
        select: { status: true, journalEntryId: true },
      });
      if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
      if (doc.status === "LOCKED")
        throw new ConflictException(`Dokument ${id} je već zaključan.`);
      throw new ConflictException(
        `Zaključavanje je moguće samo za proknjižen dokument (dokument ${id} nije proknjižen).`,
      );
    }
    this.logger.log(`Zaključan robni dokument ${id} (status → LOCKED).`);
    return { data: { id, status: "LOCKED" as const, isLocked: true } };
  }

  /**
   * Guard: mutacija zaključanog dokumenta se odbija (409). Poziva se iz svih mutacija dokumenta
   * (calculate/post rute) pre poziva odgovarajućeg servisa — zaključan dokument je immutable.
   * Čita samo status (PK lookup). NotFound se prepušta pozivaocu (postojeći servis vraća jasnu 404).
   */
  async assertNotLocked(id: number): Promise<void> {
    const doc = await this.prisma.stockDocument.findUnique({
      where: { id },
      select: { status: true },
    });
    if (doc?.status === "LOCKED")
      throw new ConflictException("Dokument je zaključan.");
  }

  // ------------------------------------------------------- STAVKE (soft-delete)

  /**
   * Guard za mutaciju stavke: brisanje/poništavanje je dozvoljeno SAMO dok dokument
   * nije proknjižen u GK ni zaključan. „Proknjižen" se izvodi iz `journalEntryId`
   * (robni `post` postavlja SAMO njega, status ostaje CALCULATED — v. `lockDocument`),
   * pa se guard oslanja na `journalEntryId != null` ILI status POSTED/LOCKED. Time
   * obrisana stavka NIKAD ne može da izmeni već proknjižen GK/KEPU (najvažniji uslov).
   */
  private async assertItemMutable(
    tx: Prisma.TransactionClient,
    docId: number,
  ): Promise<void> {
    const doc = await tx.stockDocument.findUnique({
      where: { id: docId },
      select: { status: true, journalEntryId: true },
    });
    if (!doc)
      throw new NotFoundException(`Robni dokument ${docId} ne postoji.`);
    if (
      doc.journalEntryId != null ||
      doc.status === "POSTED" ||
      doc.status === "LOCKED"
    )
      throw new ConflictException(
        `Izmena stavki nije moguća — dokument ${docId} je proknjižen ili zaključan.`,
      );
    // CALCULATED je takođe zatvoren za izmenu stavki (review Batch B): kalkulacija je
    // već napisala IZVEDENE, perzistentne podatke koje brisanje stavke NE poništava —
    // KEPU redove i (za UL) uprosečenu nabavnu cenu u ItemValuation + NIV dokument.
    // Brisanje posle kalkulacije bi trajno razišlo knjigu i valuaciju sa stvarnim
    // stavkama. Ispravan tok: poništi kalkulaciju (ili storniraj dokument) pa menjaj.
    if (doc.status === "CALCULATED")
      throw new ConflictException(
        `Izmena stavki nije moguća — dokument ${docId} je kalkulisan ` +
          `(KEPU i valuacija su već izvedeni). Poništi kalkulaciju pa ponovi izmenu.`,
      );
  }

  /**
   * Meko obriši (soft-delete) jednu stavku robnog dokumenta — poništivo („Undo") u
   * `UNDO_WINDOW_MS`. Guard: dokument nije proknjižen/zaključan (409). Obrisana stavka
   * nestaje iz liste i NE utiče na zalihe/kalkulaciju/GK (svi čitaoci filtriraju
   * `deletedAt: null`). Ostavlja trag (`deletedByUserId`, `deletedAt`).
   */
  async deleteItem(docId: number, itemLineId: number, userId: number | null) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertItemMutable(tx, docId);
      const item = await tx.stockDocumentItem.findFirst({
        where: { id: itemLineId, documentId: docId },
        select: { id: true, deletedAt: true },
      });
      if (!item)
        throw new NotFoundException(
          `Stavka ${itemLineId} ne postoji u dokumentu ${docId}.`,
        );
      if (item.deletedAt != null)
        throw new ConflictException(`Stavka ${itemLineId} je već obrisana.`);

      await softDelete(tx, tx.stockDocumentItem, itemLineId, userId);
      this.logger.log(
        `Soft-delete stavke ${itemLineId} (dokument ${docId}, korisnik ${userId ?? "?"}).`,
      );
      return {
        data: { docId, itemLineId, deleted: true, undoWindowMs: UNDO_WINDOW_MS },
      };
    });
  }

  /**
   * Poništi (undo) brisanje stavke — SAMO unutar `UNDO_WINDOW_MS` (posle: 409 rok
   * istekao). Guard: dokument i dalje nije proknjižen/zaključan. Vraća stavku u listu.
   */
  async restoreItem(docId: number, itemLineId: number) {
    return this.prisma.$transaction(async (tx) => {
      await this.assertItemMutable(tx, docId);
      const item = await tx.stockDocumentItem.findFirst({
        where: { id: itemLineId, documentId: docId },
        select: { id: true },
      });
      if (!item)
        throw new NotFoundException(
          `Stavka ${itemLineId} ne postoji u dokumentu ${docId}.`,
        );

      await restore(tx, tx.stockDocumentItem, itemLineId);
      this.logger.log(
        `Undo brisanja stavke ${itemLineId} (dokument ${docId}).`,
      );
      return { data: { docId, itemLineId, restored: true } };
    });
  }

  // ----------------------------------------------------------------- KEPU

  /**
   * Sinhronizuj KEPU red(ove) za jedan robni dokument (doc 39 §E, task D5be) — idempotentno
   * po documentId. Poziva se iz `robno post` toka (posle knjiženja IZ/NIV/…) i iz retro-punjenja.
   * Učitava zaglavlje + stavke + nivelacione parove + `DocumentType.kepuDefault*` (default smer),
   * računa red(ove) u `kepu-book.util` i briše+upisuje po documentId. Vraća broj upisanih redova.
   */
  async writeKepuForDocument(docId: number): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.stockDocument.findUnique({
        where: { id: docId },
        include: {
          // Soft-delete (Batch B): obrisana stavka NE ulazi u KEPU vrednost.
          items: { where: NOT_DELETED, orderBy: { id: "asc" } },
          stockLevelingItems: { orderBy: { id: "asc" } },
        },
      });
      if (!doc)
        throw new NotFoundException(`Robni dokument ${docId} ne postoji.`);

      const docType = await tx.documentType.findFirst({
        where: { code: doc.documentTypeCode },
        select: { kepuDefaultCharge: true, kepuDefaultDischarge: true },
      });
      const entries = computeKepuEntries(
        doc,
        doc.items,
        doc.stockLevelingItems,
        docType,
      );
      return writeKepuEntries(tx, doc.id, entries);
    });
  }

  /**
   * Retro-punjenje KEPU knjige za postojeće dokumente (task D5be). Idempotentno prolazi kroz sve
   * dokumente van DRAFT-a (imaju finalne vrednosti) i (pre)računava KEPU redove. Opcioni filter po godini.
   * Svaki dokument ide u sopstvenoj transakciji (delete+insert po documentId) — bezbedno za ponovni poziv.
   */
  async rebuildKepu(query: { year?: number } = {}): Promise<{
    documents: number;
    entries: number;
  }> {
    const where: Prisma.StockDocumentWhereInput = { status: { not: "DRAFT" } };
    if (query.year != null) where.year = query.year;

    const docs = await this.prisma.stockDocument.findMany({
      where,
      select: { id: true },
      orderBy: [{ documentDate: "asc" }, { id: "asc" }],
    });

    let entries = 0;
    for (const d of docs) {
      entries += await this.writeKepuForDocument(d.id);
    }
    this.logger.log(
      `KEPU rebuild: obrađeno ${docs.length} dokumenata, upisano ${entries} redova` +
        (query.year != null ? ` (godina ${query.year})` : "") +
        ".",
    );
    return { documents: docs.length, entries };
  }

  /** Mapiraj DTO stavku → Prisma create input (sirovi iznosi; landed popunjava kalkulacija). */
  private buildItemData(
    it: CreateStockDocumentItemDto,
    headerWarehouseId: number,
    idx: number,
  ): Prisma.StockDocumentItemCreateWithoutDocumentInput {
    return {
      itemId: it.itemId,
      warehouseId: it.warehouseId ?? headerWarehouseId,
      lineNo: it.lineNo ?? idx + 1,
      quantity: toDec(it.quantity),
      kgQuantity: toDec(it.kgQuantity),
      invoicePrice: toDec(it.invoicePrice),
      discountPercent: toDec(it.discountPercent),
      cashDiscountPercent: toDec(it.cashDiscountPercent),
      dependentCostOwn: toDec(it.dependentCostOwn),
      dependentCostSupplier: toDec(it.dependentCostSupplier),
      actualWholesalePrice: toDec(it.actualWholesalePrice),
      actualRetailPrice: toDec(it.actualRetailPrice),
      markupAmount: toDec(it.markupAmount),
      excise: toDec(it.excise),
      fee: toDec(it.fee),
      fixedTax: toDec(it.fixedTax),
      fxPurchasePrice: toDec(it.fxPurchasePrice),
      customsRate: toDec(it.customsRate),
      goodsTaxRateCode: it.goodsTaxRateCode ?? "3",
    };
  }
}
