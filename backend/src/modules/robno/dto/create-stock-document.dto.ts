import { IsOptional, IsString } from "class-validator";

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

  // — Uslovi otpreme (BigBit traka na otpremnici) —
  // SVE opciono i SVE se čuva kako je uneto. Izostavljeno polje ostaje NULL i štampa se
  // kao prazna linija za ručni upis — nikad se ne izvodi iz drugog podatka (posebno
  // `shippingDate` NE sme da padne na `documentDate`).
  fco?: string;
  shippingMethod?: string;
  /** ISO datum otpreme (odvojen od `documentDate` — otprema ume da bude kasnije). */
  shippingDate?: string;
  deliveryPlace?: string;
  route?: string;
  /** BigBit „Po porudžbini od" — kupčev broj/datum porudžbine (tekst, ne FK). */
  customerOrderRef?: string;
  /** Napomena na dokumentu (slobodan tekst). */
  note?: string;

  // — Traceback (meki ref-ovi) —
  purchaseOrderId?: number;
  projectId?: number;
  workOrderId?: number;
  linkedInboundDocId?: number;
  inventoryCountId?: number;

  createdByUserId?: number;

  items: CreateStockDocumentItemDto[];
}

/**
 * Izmena USLOVA OTPREME i napomene na postojećem robnom dokumentu
 * (`PATCH /robno/documents/:id/shipping`).
 *
 * Ovo je jedini put kojim ta polja ulaze u bazu posle kreiranja i namerno je ODVOJEN
 * od ostalih izmena dokumenta: otprema se popunjava kasnije (kad vozač krene), pa mora
 * biti dozvoljena i na dokumentu koji je već proknjižen — ali NE i na zaključanom.
 *
 * SEMANTIKA POLJA (bitna, jer razlikuje „nije dirano" od „obriši"):
 *   - polje IZOSTAVLJENO (`undefined`) → ne dira se;
 *   - polje `null` ili prazan string   → briše se (vraća na prazno, tj. na liniju za
 *     ručni upis na papiru).
 *
 * KLASA, NE INTERFEJS (ispravka 27.07.2026): globalni `ValidationPipe` validira samo
 * klase sa `class-validator` dekoratorima. Dok je ovo bio interfejs, telo je prolazilo
 * nevalidirano — `{"fco": 123}` je padao na `v.trim is not a function` i vraćao 500
 * umesto srpskog 422. (Ostatak modula je i dalje na interfejsima; nove mutacione rute
 * ne nasleđuju taj obrazac.)
 */
export class UpdateStockDocumentShippingDto {
  @IsOptional()
  @IsString()
  fco?: string | null;

  @IsOptional()
  @IsString()
  shippingMethod?: string | null;

  /** ISO datum; `null`/prazno briše. */
  @IsOptional()
  @IsString()
  shippingDate?: string | null;

  @IsOptional()
  @IsString()
  deliveryPlace?: string | null;

  @IsOptional()
  @IsString()
  route?: string | null;

  @IsOptional()
  @IsString()
  customerOrderRef?: string | null;

  @IsOptional()
  @IsString()
  note?: string | null;
}
