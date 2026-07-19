/**
 * Kreiranje robnog dokumenta (`stock_documents` + `stock_document_items`).
 *
 * `kind` (UL/IZ/NIV/PRENOS/VISAK/MANJAK) prosleđuje pozivalac (ruta/servis), NE ovaj DTO —
 * `RobnoService.createStockDocument(kind, dto)`. `documentTypeCode` (→ `DocumentType.code`)
 * vozi znak zalihe + GK šemu + KODJ izuzeće.
 *
 * Iznosi (cene/količine) su STRING u JSON-u (BACKEND_RULES §6: Decimal u JSON-u kao string);
 * servis ih parsira u `Prisma.Decimal`. Prazno/izostavljeno = 0.
 */
export interface CreateStockDocumentItemDto {
  itemId: number;
  /** Redundantno sa headerom (kao legacy); ako izostane → header.warehouseId. */
  warehouseId?: number;
  lineNo?: number;

  /** Uvek POZITIVNA količina — znak izlaza se izvodi iz DocumentType (as-of upit). */
  quantity: string | number;
  kgQuantity?: string | number;

  // — Domaća kaskada (doc 39 §A) —
  invoicePrice?: string | number; // Fakturna cena/JM
  discountPercent?: string | number; // Rabat %
  cashDiscountPercent?: string | number; // Kasa %
  dependentCostOwn?: string | number; // ZTsop (ako se unosi po stavci)
  dependentCostSupplier?: string | number; // ZTdob (ako se unosi po stavci)
  actualWholesalePrice?: string | number; // Stvarna VP (transakciona / prodajna)
  actualRetailPrice?: string | number; // Stvarna MP
  markupAmount?: string | number; // RuC (unesena marža; 0 kad je Mag.VP=Nab)
  excise?: string | number; // Akciza
  fee?: string | number; // Taksa
  fixedTax?: string | number; // FiksniPorez

  /**
   * Zbir stopa poreza za KalkMP (`ΣStopa/100`, doc 39 §A) — % (npr. 20 za PDV 20%).
   * Ako izostane → 0 (KalkMP = Taksa + FiksniPorez + KalkVP).
   */
  taxRatePercent?: string | number;
  goodsTaxRateCode?: string;

  // — Uvoz (doc 39 §A: Module__UVOZ ZT raspodela po JM) —
  fxPurchasePrice?: string | number; // DevNabCena (ključ raspodele)
  customsRate?: string | number; // CarStopa %
}

export interface CreateStockDocumentDto {
  /** → `DocumentType.code` (šema + affectsStock + KODJ). Obavezno. */
  documentTypeCode: string;

  warehouseId: number; // izvorni/glavni magacin
  targetWarehouseId?: number; // samo PRENOS
  supplierId?: number; // UL/UVOZ
  customerId?: number; // IZ

  /** ISO datum (as-of ključ za costing). Izostane → sada. */
  documentDate?: string;
  postingDate?: string;

  // — Uvoz zaglavlje (doc 39 §A) —
  isImport?: boolean;
  customsExchangeRate?: string | number; // CarKurs
  accountingExchangeRate?: string | number; // ObrKurs
  fxInvoiceValue?: string | number; // DevVredFak (imenilac raspodele)
  customs?: string | number; // doc-level carina
  forwarding?: string | number; // doc-level špedicija
  otherDependentCosts?: string | number;
  customsRefundBase?: string | number; // PovCarOsn

  // — Traceback (meki ref-ovi) —
  purchaseOrderId?: number;
  projectId?: number;
  workOrderId?: number;
  linkedInboundDocId?: number;
  inventoryCountId?: number;

  createdByUserId?: number;

  items: CreateStockDocumentItemDto[];
}
