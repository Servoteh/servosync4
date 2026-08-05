import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  ValidateIf,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from "class-validator";
import {
  KNOWN_VAT_CODES,
  unknownVatCodeMessage,
} from "../../gl/posting/vat-rates";

/**
 * IZMENA POSTOJEĆEG ROBNOG DOKUMENTA (zaglavlje + stavke).
 * ============================================================================
 * Do 28.07.2026. robni dokument se posle kreiranja NIJE mogao ispraviti: postojali su samo
 * `DELETE`/`restore` stavke i `PATCH …/shipping`. Pogrešno ukucana količina ili pogrešan
 * dobavljač su značili „obriši sve stavke i unesi dokument ponovo pod novim brojem".
 * Ove DTO klase pokrivaju rupu iz `PLAN_UNOS_DOKUMENATA.md §5.7`.
 *
 * KLASE, NE INTERFEJSI — globalni `ValidationPipe` (`transform: true, whitelist: true`) validira
 * SAMO klase sa `class-validator` dekoratorima, a `whitelist` iz tela BRIŠE svako polje bez
 * dekoratora. Zato svako polje koje sme da uđe MORA imati bar jedan dekorator; inače bi se
 * tiho gubilo (isti nalaz kao kod `UpdateStockDocumentShippingDto`, 27.07.2026).
 *
 * SEMANTIKA (ista u sva tri DTO-a):
 *   - polje IZOSTAVLJENO (`undefined`) → ne dira se;
 *   - polje `null` na OPCIONOJ vezi (`supplierId`, `customerId`) → briše se;
 *   - polje `null` na OBAVEZNOJ koloni (`documentDate`, `warehouseId`, `quantity`, `itemId`)
 *     → 422, jer bi baza pukla ili bi dokument ostao bez ključnog podatka.
 */

/**
 * „Broj koji sme da dođe kao string ILI kao number" — iznosi i količine putuju kroz JSON kao
 * STRING (BACKEND_RULES §6: Decimal u JSON-u je string), ali stariji klijenti šalju `number`.
 * Servis oba oblika provlači kroz `toDec` → `Prisma.Decimal` (nikad Float aritmetika).
 *
 * Prazan string je DOZVOLJEN i znači 0 — isto kao pri kreiranju (`toDec("") === 0`); tako se
 * ponašanje izmene ne razilazi sa ponašanjem unosa.
 *
 * `null`/`undefined` se ODBIJAJU — odsustvo se propušta isključivo preko `@IsOptional()`
 * (opciono polje) ili `@ValidateIf(v !== undefined)` (polje koje sme da se izostavi, ali ne
 * sme da bude `null`). Da validator sam propušta prazno, obavezna `quantity` bi prolazila
 * neuneta i `toDec(undefined)` bi je tiho pretvorio u 0 — stavka bez količine.
 */
export function IsDecimalLike(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isDecimalLike",
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === null || value === undefined) return false;
          if (typeof value === "number") return Number.isFinite(value);
          if (typeof value !== "string") return false;
          const t = value.trim();
          if (t === "") return true; // prazno = 0 (kao pri kreiranju)
          return !Number.isNaN(Number(t));
        },
        defaultMessage(args: ValidationArguments): string {
          return (
            `Polje '${args.property}' mora biti broj (npr. 12.5 ili "12.5")` +
            ` i ne sme biti prazno.`
          );
        },
      },
    });
  };
}

/**
 * Zaglavlje robnog dokumenta — `PATCH /v1/robno/documents/:id`.
 *
 * Polja su podeljena na DVA razreda po posledici, jer im guard NIJE isti (v. servis):
 *   • TVRDA  (`documentDate`, `postingDate`, `warehouseId`, `supplierId`, `customerId`) —
 *     ulaze u obračun zaliha/costinga → menjaju se SAMO dok je dokument nacrt (DRAFT);
 *   • MEKA   (`shippingMethod`, `note`) — prateći podaci koje magacin saznaje kasnije →
 *     dozvoljena su i posle knjiženja, kao i na `PATCH …/shipping` (isti smisao, ista pravila).
 */
export class UpdateStockDocumentDto {
  /** ISO datum dokumenta (as-of ključ costinga). `null` = 422 (kolona je obavezna). */
  @ValidateIf((_, v) => v !== undefined)
  @IsString({ message: "Polje 'documentDate' mora biti ISO datum (tekst)." })
  documentDate?: string;

  /** ISO datum knjiženja. `null` = 422. */
  @ValidateIf((_, v) => v !== undefined)
  @IsString({ message: "Polje 'postingDate' mora biti ISO datum (tekst)." })
  postingDate?: string;

  /** Dobavljač (ulaz robe) — meki ref `customers.id`. `null` briše. */
  @IsOptional()
  @IsInt({ message: "Polje 'supplierId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'supplierId' mora biti pozitivan broj." })
  supplierId?: number | null;

  /** Kupac (izlaz robe) — meki ref `customers.id`. `null` briše. */
  @IsOptional()
  @IsInt({ message: "Polje 'customerId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'customerId' mora biti pozitivan broj." })
  customerId?: number | null;

  /**
   * Magacin dokumenta. Promena POMERA i stavke koje su pratile zaglavlje (v. servis) —
   * bez toga bi zaglavlje pisalo jedan magacin, a zaliha se knjižila u drugi. `null` = 422.
   */
  @ValidateIf((_, v) => v !== undefined)
  @IsInt({ message: "Polje 'warehouseId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'warehouseId' mora biti pozitivan broj." })
  warehouseId?: number;

  /** Način otpreme (sopstveni prevoz / kurir / dobavljač / preuzimanje). `null`/prazno briše. */
  @IsOptional()
  @IsString({ message: "Polje 'shippingMethod' mora biti tekst." })
  shippingMethod?: string | null;

  /** Napomena na dokumentu. `null`/prazno briše. */
  @IsOptional()
  @IsString({ message: "Polje 'note' mora biti tekst." })
  note?: string | null;

  /**
   * BROJ OTPREMNICE DOBAVLJAČA — kolone NEMA u `stock_documents` (v. servis: 422 sa uputstvom).
   * Polje stoji u DTO-u NAMERNO: bez njega bi ga `whitelist: true` tiho obrisao iz tela i
   * korisnik bi mislio da je broj sačuvan. Ovako dobija jasnu poruku umesto tihog gubitka.
   */
  @IsOptional()
  @IsString({ message: "Polje 'deliveryNoteNumber' mora biti tekst." })
  deliveryNoteNumber?: string | null;

  /** USLOVI PLAĆANJA — kolone NEMA u `stock_documents`; v. `deliveryNoteNumber` iznad. */
  @IsOptional()
  @IsString({ message: "Polje 'paymentTerms' mora biti tekst." })
  paymentTerms?: string | null;
}

/**
 * Zajednička polja stavke (kalkulativne kolone `stock_document_items`) — ista lista kao pri
 * kreiranju (`CreateStockDocumentItemDto`), da se unos i izmena ne raziđu. Kalkulativne
 * IZVEDENE kolone (`purchasePriceNet`, `calculatedWholesalePrice`, `calculatedRetailPrice`)
 * NISU ovde: njih piše ISKLJUČIVO `CalculationService.calculate` — ručni upis izvedene cene
 * bi razišao dokument sa motorom kalkulacije.
 */
class StockDocumentItemFieldsDto {
  /** Redni broj stavke na papiru. Izostane pri dodavanju → sledeći slobodan. */
  @IsOptional()
  @IsInt({ message: "Polje 'lineNo' mora biti ceo broj." })
  lineNo?: number;

  @IsOptional()
  @IsDecimalLike()
  kgQuantity?: string | number;

  // — Domaća kaskada (doc 39 §A) —
  @IsOptional() @IsDecimalLike() invoicePrice?: string | number; // Fakturna cena/JM
  @IsOptional() @IsDecimalLike() discountPercent?: string | number; // Rabat %
  @IsOptional() @IsDecimalLike() cashDiscountPercent?: string | number; // Kasa %
  @IsOptional() @IsDecimalLike() dependentCostOwn?: string | number; // ZTsop
  @IsOptional() @IsDecimalLike() dependentCostSupplier?: string | number; // ZTdob
  @IsOptional() @IsDecimalLike() actualWholesalePrice?: string | number; // Stvarna VP
  @IsOptional() @IsDecimalLike() actualRetailPrice?: string | number; // Stvarna MP
  @IsOptional() @IsDecimalLike() markupAmount?: string | number; // RuC
  @IsOptional() @IsDecimalLike() excise?: string | number; // Akciza
  @IsOptional() @IsDecimalLike() fee?: string | number; // Taksa
  @IsOptional() @IsDecimalLike() fixedTax?: string | number; // FiksniPorez

  // — Uvoz (doc 39 §A: Module__UVOZ) —
  @IsOptional() @IsDecimalLike() fxPurchasePrice?: string | number; // DevNabCena
  @IsOptional() @IsDecimalLike() customsRate?: string | number; // CarStopa %

  /**
   * Šifra poreske tarife — ulazi u KalkMP (maloprodajnu cenu) i u PDV kofe glavne knjige.
   *
   * ⚠️ Do 02.08.2026. je bila goli `@IsString`: prošlo bi „18", „99", bilo šta. Odatle je
   * nepoznata šifra išla u `CalculationService.taxRateOf` i `PostingEngine`, gde je oba
   * puta davala tihu nulu — maloprodajna cena bez PDV-a i nalog bez PDV linije. Spisak
   * dozvoljenih je IZVEDEN iz `VAT_RATE_BY_CODE` (nalaz S3).
   */
  @IsOptional()
  @IsIn([...KNOWN_VAT_CODES], {
    message: `Polje 'goodsTaxRateCode': ${unknownVatCodeMessage("$value")}`,
  })
  goodsTaxRateCode?: string;

  /**
   * Pokreni kalkulaciju (`POST …/calculate`) odmah po izmeni.
   *
   * PODRAZUMEVANO `false` I TO JE SVESNA ODLUKA: `CalculationService.calculate` radi samo iz
   * statusa DRAFT i po uspehu prevodi dokument u CALCULATED, a CALCULATED dokument je zatvoren
   * za izmenu stavki (KEPU redovi i uprosečena valuacija su već izvedeni). Automatska
   * kalkulacija posle SVAKE izmene bi zato zaključala dokument već na prvoj stavci — primka bi
   * ostala sa jednim redom i drugi se više ne bi mogao dodati. Uz to bi za ULAZ okinula
   * nivelaciju (uprosečavanje cena + NIV dokument) nad polupopunjenim dokumentom.
   * Zato je ovo prekidač koji operater pali kad je unos ZAVRŠEN.
   */
  @IsOptional()
  @IsBoolean({ message: "Polje 'recalculate' mora biti true/false." })
  recalculate?: boolean;
}

/** Dodavanje stavke — `POST /v1/robno/documents/:id/items`. */
export class CreateStockDocumentItemBodyDto extends StockDocumentItemFieldsDto {
  /** Artikal (`items.id`) — obavezan. */
  @IsInt({ message: "Polje 'itemId' je obavezno (ceo broj)." })
  @IsPositive({ message: "Polje 'itemId' mora biti pozitivan broj." })
  itemId!: number;

  /** Magacin stavke; izostane → magacin zaglavlja. */
  @IsOptional()
  @IsInt({ message: "Polje 'warehouseId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'warehouseId' mora biti pozitivan broj." })
  warehouseId?: number;

  /** Količina (uvek POZITIVNA — znak se izvodi iz vrste dokumenta). Obavezna, 0 = 422. */
  @IsDecimalLike()
  quantity!: string | number;
}

/** Izmena stavke — `PATCH /v1/robno/documents/:id/items/:lineId`. Sva polja opciona. */
export class UpdateStockDocumentItemDto extends StockDocumentItemFieldsDto {
  /** Zamena artikla na redu. `null` = 422 (stavka bez artikla ne postoji). */
  @ValidateIf((_, v) => v !== undefined)
  @IsInt({ message: "Polje 'itemId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'itemId' mora biti pozitivan broj." })
  itemId?: number;

  /** Premeštanje reda u drugi magacin. `null` = 422. */
  @ValidateIf((_, v) => v !== undefined)
  @IsInt({ message: "Polje 'warehouseId' mora biti ceo broj." })
  @IsPositive({ message: "Polje 'warehouseId' mora biti pozitivan broj." })
  warehouseId?: number;

  /** Nova količina (pozitivna, != 0). `null` = 422. */
  @ValidateIf((_, v) => v !== undefined)
  @IsDecimalLike()
  quantity?: string | number;
}
