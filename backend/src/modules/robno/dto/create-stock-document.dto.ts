import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  ValidateNested,
} from "class-validator";
import { IsDecimalLike } from "./update-stock-document.dto";

/**
 * Kreiranje robnog dokumenta (`stock_documents` + `stock_document_items`).
 *
 * KLASE, NE INTERFEJSI (04.08.2026). Globalni `ValidationPipe`
 * (`transform: true, whitelist: true`, `src/main.ts`) validira SAMO klase sa
 * `class-validator` dekoratorima — handler sa `interface` tipom pipe TIHO PRESKAČE.
 * Dok su ovo bili interfejsi, telo `POST /v1/robno/documents` je ulazilo nevalidirano:
 *
 *   • `{"invoicePrice": "abc"}` → `toDec` (decimal.util:33) hvata izuzetak i vraća 0,
 *     pa je stavka dobijala CENU 0 bez ijedne greške — kalkulacija, KEPU i GK nalog
 *     posle toga rade sa tom nulom kao da je uneta namerno;
 *   • `{"quantity": "abc"}` → isto 0, pa je korisnik dobijao poruku „količina mora biti
 *     različita od 0" umesto „to nije broj";
 *   • nepoznata polja su prolazila do servisa umesto da ih `whitelist` odbaci.
 *
 * `whitelist: true` BRIŠE svako polje bez dekoratora — zato SVAKO polje ovde mora imati
 * bar jedan dekorator, inače bi se tiho gubilo (isti nalaz kao kod
 * `UpdateStockDocumentShippingDto`, 27.07.2026).
 *
 * DVA SLOJA, NAMERNO: ove klase brane HTTP granicu. Provere u
 * `RobnoService.createStockDocument` OSTAJU, jer interni pozivaoci (`CarryOverService`,
 * `TransferService`, `InventoryService.finalize`) grade DTO u kodu i zovu servis
 * direktno — kroz njih `ValidationPipe` uopšte ne prolazi.
 *
 * Iznosi (cene/količine) putuju kao STRING (BACKEND_RULES §6: Decimal u JSON-u je string),
 * ali se prima i `number`; servis ih provlači kroz `toDec` → `Prisma.Decimal`.
 * Prazno = 0 (`IsDecimalLike` to izričito dozvoljava, isto kao pri izmeni dokumenta).
 */

/** Diskriminator robnog dokumenta (`stock_documents.kind`). */
export const STOCK_DOCUMENT_KINDS = [
  "UL",
  "IZ",
  "NIV",
  "PRENOS",
  "VISAK",
  "MANJAK",
] as const;

export type StockDocumentKind = (typeof STOCK_DOCUMENT_KINDS)[number];

/**
 * Gornja granica broja stavki na jednom dokumentu. Nije poslovno ograničenje nego brana:
 * svaka stavka ulazi u transakciju koja drži advisory lock po (artikal, magacin), pa
 * neograničeno telo znači neograničeno dugu transakciju pod lock-om.
 */
export const MAX_DOCUMENT_ITEMS = 2000;

export class CreateStockDocumentItemDto {
  @IsInt({ message: "Polje 'itemId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'itemId' mora biti pozitivan broj." })
  itemId!: number;

  /** Redundantno sa headerom (kao legacy); ako izostane → header.warehouseId. */
  @IsOptional()
  @IsInt()
  @IsPositive()
  warehouseId?: number;

  @IsOptional()
  @IsInt()
  lineNo?: number;

  /** Uvek POZITIVNA količina — znak izlaza se izvodi iz DocumentType (as-of upit). */
  @IsDecimalLike()
  quantity!: string | number;

  @IsOptional()
  @IsDecimalLike()
  kgQuantity?: string | number;

  // — Domaća kaskada (doc 39 §A) —
  /** Fakturna cena/JM. */
  @IsOptional() @IsDecimalLike() invoicePrice?: string | number;
  /** Rabat %. */
  @IsOptional() @IsDecimalLike() discountPercent?: string | number;
  /** Kasa %. */
  @IsOptional() @IsDecimalLike() cashDiscountPercent?: string | number;
  /** ZTsop (ako se unosi po stavci). */
  @IsOptional() @IsDecimalLike() dependentCostOwn?: string | number;
  /** ZTdob (ako se unosi po stavci). */
  @IsOptional() @IsDecimalLike() dependentCostSupplier?: string | number;
  /** Stvarna VP (transakciona / prodajna). */
  @IsOptional() @IsDecimalLike() actualWholesalePrice?: string | number;
  /** Stvarna MP. */
  @IsOptional() @IsDecimalLike() actualRetailPrice?: string | number;
  /** RuC (unesena marža; 0 kad je Mag.VP=Nab). */
  @IsOptional() @IsDecimalLike() markupAmount?: string | number;
  /** Akciza. */
  @IsOptional() @IsDecimalLike() excise?: string | number;
  /** Taksa. */
  @IsOptional() @IsDecimalLike() fee?: string | number;
  /** FiksniPorez. */
  @IsOptional() @IsDecimalLike() fixedTax?: string | number;

  /**
   * Zbir stopa poreza za KalkMP (`ΣStopa/100`, doc 39 §A) — % (npr. 20 za PDV 20%).
   * Ako izostane → 0 (KalkMP = Taksa + FiksniPorez + KalkVP).
   */
  @IsOptional() @IsDecimalLike() taxRatePercent?: string | number;

  @IsOptional()
  @IsString()
  @MaxLength(5)
  goodsTaxRateCode?: string;

  // — Uvoz (doc 39 §A: Module__UVOZ ZT raspodela po JM) —
  /** DevNabCena (ključ raspodele). */
  @IsOptional() @IsDecimalLike() fxPurchasePrice?: string | number;
  /** CarStopa %. */
  @IsOptional() @IsDecimalLike() customsRate?: string | number;
}

export class CreateStockDocumentDto {
  /** → `DocumentType.code` (šema + affectsStock + KODJ). Obavezno. */
  @IsString({ message: "Polje 'documentTypeCode' je obavezno." })
  @MaxLength(5)
  documentTypeCode!: string;

  /** Izvorni/glavni magacin. */
  @IsInt({ message: "Polje 'warehouseId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'warehouseId' mora biti pozitivan broj." })
  warehouseId!: number;

  /** Odredišni magacin — samo PRENOS (dodatna pravila su u servisu, jer zavise od `kind`). */
  @IsOptional() @IsInt() @IsPositive() targetWarehouseId?: number;
  /** Dobavljač (UL/UVOZ). */
  @IsOptional() @IsInt() @IsPositive() supplierId?: number;
  /** Kupac (IZ). */
  @IsOptional() @IsInt() @IsPositive() customerId?: number;

  /** ISO datum (as-of ključ za costing). Izostane → sada. */
  @IsOptional() @IsString() documentDate?: string;
  @IsOptional() @IsString() postingDate?: string;

  // — Uvoz zaglavlje (doc 39 §A) —
  @IsOptional() @IsBoolean() isImport?: boolean;
  /** CarKurs. */
  @IsOptional() @IsDecimalLike() customsExchangeRate?: string | number;
  /** ObrKurs. */
  @IsOptional() @IsDecimalLike() accountingExchangeRate?: string | number;
  /** DevVredFak (imenilac raspodele). */
  @IsOptional() @IsDecimalLike() fxInvoiceValue?: string | number;
  /** Doc-level carina. */
  @IsOptional() @IsDecimalLike() customs?: string | number;
  /** Doc-level špedicija. */
  @IsOptional() @IsDecimalLike() forwarding?: string | number;
  @IsOptional() @IsDecimalLike() otherDependentCosts?: string | number;
  /** PovCarOsn. */
  @IsOptional() @IsDecimalLike() customsRefundBase?: string | number;

  // — Uslovi otpreme (BigBit traka na otpremnici) —
  // SVE opciono i SVE se čuva kako je uneto. Izostavljeno polje ostaje NULL i štampa se
  // kao prazna linija za ručni upis — nikad se ne izvodi iz drugog podatka (posebno
  // `shippingDate` NE sme da padne na `documentDate`).
  @IsOptional() @IsString() @MaxLength(100) fco?: string;
  @IsOptional() @IsString() @MaxLength(50) shippingMethod?: string;
  /** ISO datum otpreme (odvojen od `documentDate` — otprema ume da bude kasnije). */
  @IsOptional() @IsString() shippingDate?: string;
  @IsOptional() @IsString() @MaxLength(150) deliveryPlace?: string;
  @IsOptional() @IsString() @MaxLength(100) route?: string;
  /** BigBit „Po porudžbini od" — kupčev broj/datum porudžbine (tekst, ne FK). */
  @IsOptional() @IsString() @MaxLength(100) customerOrderRef?: string;
  /** Napomena na dokumentu (slobodan tekst). */
  @IsOptional() @IsString() note?: string;

  // — Traceback (meki ref-ovi) —
  @IsOptional() @IsInt() @IsPositive() purchaseOrderId?: number;
  @IsOptional() @IsInt() @IsPositive() projectId?: number;
  @IsOptional() @IsInt() @IsPositive() workOrderId?: number;
  @IsOptional() @IsInt() @IsPositive() linkedInboundDocId?: number;
  @IsOptional() @IsInt() @IsPositive() inventoryCountId?: number;

  @IsOptional() @IsInt() @IsPositive() createdByUserId?: number;

  @IsArray()
  @ArrayMinSize(1, { message: "Dokument mora imati bar jednu stavku." })
  @ArrayMaxSize(MAX_DOCUMENT_ITEMS, {
    message: `Dokument sme imati najviše ${MAX_DOCUMENT_ITEMS} stavki.`,
  })
  @ValidateNested({ each: true })
  @Type(() => CreateStockDocumentItemDto)
  items!: CreateStockDocumentItemDto[];
}

/**
 * Telo rute `POST /v1/robno/documents` — DTO dokumenta + `kind`.
 *
 * Postoji kao KLASA baš zbog `kind`: ranije je handler imao tip
 * `{ kind: StockDocumentKind } & CreateStockDocumentDto`, a presek tipova nije klasa, pa
 * je `ValidationPipe` preskakao CELO telo — uključujući i stavke.
 */
export class CreateStockDocumentBodyDto extends CreateStockDocumentDto {
  @IsIn(STOCK_DOCUMENT_KINDS, {
    message: `Polje 'kind' mora biti jedno od: ${STOCK_DOCUMENT_KINDS.join(", ")}.`,
  })
  kind!: StockDocumentKind;
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
