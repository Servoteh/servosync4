import {
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
import { toDec } from "./decimal.util";
import {
  CreateStockDocumentDto,
  CreateStockDocumentItemDto,
} from "./dto/create-stock-document.dto";
import { ListStockDocumentsQuery } from "./dto/list-stock-documents.dto";

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

    let data = levels.map((l) => {
      const it = itemById.get(l.itemId);
      return {
        itemId: l.itemId,
        warehouseId: l.warehouseId,
        itemName: it?.name ?? null,
        itemCode: it?.catalogNumber ?? null,
        unit: it?.unit ?? null,
        onHand: l.onHand.toFixed(3),
        reserved: l.reserved.toFixed(3),
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
        items: { orderBy: { id: "asc" } },
        stockLevelingItems: { orderBy: { id: "asc" } },
      },
    });
    if (!doc) throw new NotFoundException(`Robni dokument ${id} ne postoji.`);
    return { data: doc };
  }

  // -------------------------------------------------------------- CREATE

  /**
   * Kreiraj robni dokument (`kind` = UL/IZ/NIV/PRENOS/VISAK/MANJAK) u statusu DRAFT.
   * Numeracija `NNNN/god` (advisory lock po companyId+tip+godina) je u istoj transakciji.
   * NE pokreće kalkulaciju — pozivalac (ruta) posle poziva `CalculationService.calculate(docId)`
   * za UL/UVOZ. Iznosi se čuvaju sirovi (invoicePrice/rabat/kasa…); landed polja popunjava kalkulacija.
   */
  async createStockDocument(kind: StockDocumentKind, dto: CreateStockDocumentDto) {
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
