import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/**
 * DTO-i za unos/izmenu ARTIKLA (`POST /api/v1/artikli`, `PATCH /api/v1/artikli/:id`).
 *
 * Obrazac repoa: `interface` + ručna `validate*()` (BACKEND_RULES §6 — class-validator
 * se za tela zahteva ovde ne koristi; v. `projects-write/dto/customer-rfq.dto.ts`).
 * Kod je engleski, SVE poruke greške su srpske (latinica).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POKRIVENOST POLJA — PUN SKUP BigBit forme „Unos artikala"
 * ─────────────────────────────────────────────────────────────────────────────
 * `docs/migration/BIGBIT_ARTIKLI.md` §1 popisuje 67 kolona `R_Artikli` (+ `BBSifra
 * artikla` koja postoji samo u QBigTehn kopiji). Prisma model `Item` ima TAČNO 68
 * kolona i SVAKA od njih je u sync mapi (`sync-map.generated.ts`, `source: "R_Artikli"`)
 * — provereno diff-om, presek je prazan u oba smera.
 *
 * Ovaj katalog (`ITEM_FIELDS`) pokriva svih 68 minus 4 koje server drži sam:
 *   • `id`             — dodeljuje servis iz native opsega (`items.write-policy.ts`),
 *   • `externalItemId` — 0 = „nema BigBit porekla" (BIGBIT_ARTIKLI.md §5.1),
 *   • `signature`      — `PotpisArt`, upisuje se iz JWT-a (BigBit `PotpisiArt`, §4.8),
 *   • `createdAt`      — `DatumIVremeArt`, server-vreme.
 * `Record<keyof ItemWriteFields, ItemFieldSpec>` znači da katalog ne može da
 * „zaboravi" polje — nedostajući ključ je greška u kompilaciji.
 *
 * ŠTA NIJE OVDE (i zašto) — puna lista sa razlozima je u `items.write-policy.ts`
 * (`ITEM_FIELDS_REQUIRING_MIGRATION`): multi-barkod, višejezični nazivi, kvalitet,
 * mesto izdavanja, raster definicije, galerije slika, više dobavljača, obeležja,
 * rabati/akcije. Nijedna od tih kolona/tabela ne postoji u `schema.prisma`, a šema
 * je tuđa granica — ne izmišljaju se polja.
 */

/** Novčani/decimalni ulaz — prima i string (bezbedno za decimale) i broj. */
export type NumericInput = string | number;

export type ItemFieldKind =
  | "text"
  | "int"
  | "money"
  | "percent"
  | "quantity"
  | "bool"
  | "enum";

export interface ItemFieldSpec {
  kind: ItemFieldKind;
  /** Srpska oznaka polja — ide doslovno u poruku greške. */
  label: string;
  /** Izvorna BigBit kolona (`R_Artikli`) — trag do `BIGBIT_ARTIKLI.md` §1. */
  src: string;
  /** Maksimalna dužina teksta (BigBit definicija; kolona je ista ili šira). */
  maxLength?: number;
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Obavezno pri kreiranju (kolona je NOT NULL i BigBit forma je traži). */
  requiredOnCreate?: boolean;
  /** `@default` iz `schema.prisma` — informativno (UI predlaže istu vrednost). */
  columnDefault?: string | number | boolean | null;
  /** Kolona je `Decimal` u šemi (jedina: `manual_markup_percent`). */
  decimalColumn?: true;
  /** Napomena o odstupanju šeme od BigBit-a (dužina, tip). */
  note?: string;
}

/** `HPS` — CHECK constraint u QBigTehn kopiji (BIGBIT_ARTIKLI.md §1). */
export const HPS_VALUES = ["H", "P", "S", "O"] as const;

/**
 * Sva polja artikla koja korisnik sme da pošalje. Opciona su SVA — obaveznost pri
 * kreiranju nosi `requiredOnCreate` u katalogu, da bi `PATCH` mogao da šalje podskup.
 */
export interface ItemWriteFields {
  // ── identitet ───────────────────────────────────────────────────────────────
  catalogNumber?: string;
  barCode?: string | null;
  plu?: number;
  externalCode?: string | null;
  // ── nazivi i opisi ──────────────────────────────────────────────────────────
  name?: string;
  foreignName?: string | null;
  itemDescription?: string | null;
  webDescription?: string | null;
  memo?: string | null;
  note2?: string | null;
  // ── jedinice mere i pakovanje ───────────────────────────────────────────────
  unit?: string | null;
  baseUnit?: string | null;
  foreignUnit?: string | null;
  packaging?: string | null;
  box?: NumericInput;
  transportPackaging?: NumericInput;
  quantityInPackage?: NumericInput;
  // ── klasifikacija (šifarnici) ───────────────────────────────────────────────
  groupCode?: string;
  subgroupCode?: string;
  originCode?: string;
  qualityTypeId?: number;
  hps?: string;
  // ── porez, carina, poreklo robe ─────────────────────────────────────────────
  goodsTaxRateCode?: string;
  serviceTaxRateCode?: string;
  alwaysTaxGoods?: boolean;
  alwaysTaxServices?: boolean;
  nonTaxablePart?: NumericInput;
  itemExcise?: NumericInput;
  itemFee?: NumericInput;
  customsRate?: NumericInput;
  customsTariff?: string | null;
  originCountry?: string | null;
  // ── cene i komercijala ──────────────────────────────────────────────────────
  wholesalePrice?: NumericInput;
  retailPrice?: NumericInput;
  fxPurchasePrice?: NumericInput;
  fxSalePrice?: NumericInput;
  priceToWritePricelist?: NumericInput;
  maxDiscountPercent?: NumericInput;
  promotionDiscount?: NumericInput;
  manualMarkupPercent?: NumericInput;
  retailLossPercent?: NumericInput;
  wholesaleLossPercent?: NumericInput;
  minQuantity?: NumericInput;
  paymentTermDays?: number;
  finalProcessingCost?: NumericInput;
  supplierId?: number;
  // ── knjigovodstvo ───────────────────────────────────────────────────────────
  accountingCode?: string | null;
  accountingCode2?: string | null;
  issuePlaceId?: number;
  // ── fizičke veličine (Servoteh: lim/ploča) ──────────────────────────────────
  weight?: NumericInput;
  weightKg?: NumericInput;
  volume?: NumericInput;
  area?: NumericInput;
  thickness?: NumericInput;
  rasterId?: number;
  // ── prilozi (putanje, ne fajlovi) ───────────────────────────────────────────
  pdfLink?: string | null;
  symbolImageLink?: string | null;
  wordLocation?: string | null;
  // ── magacin i statusi ───────────────────────────────────────────────────────
  shelf?: string | null;
  manufacturer?: string | null;
  notStockTracked?: boolean;
  active?: boolean;
  toDelete?: boolean;
  sortOrder?: number;
}

/**
 * PRELAZNI ULAZ ZA RASTER (dimenzije lima/ploče) — NE ČUVA SE.
 *
 * BIGBIT_ARTIKLI.md §4.10: kod Servoteha raster NISU maloprodajne veličine/boje nego
 * DIMENZIJE TABLE. Dugme `DugmePreracunajTezinuUKomadu` radi:
 *   `Kutija = Debljina * VrstaRastera * KolonaRastera * 7850 / 1000000000`
 * gde su `VrstaRastera`/`KolonaRastera` dimenzije u mm izvučene iz `RasterDef*`
 * tabela za `IDRaster` artikla, a 7850 je gustina čelika u kg/m³ → rezultat su
 * KILOGRAMI PO KOMADU i upisuju se u `Kutija` (`Item.box`).
 *
 * `RasterDef*` tabele NE POSTOJE u `schema.prisma` (`Item.rasterId` visi u prazno),
 * pa se dimenzije ne mogu pročitati iz šifarnika. Zato ih forma šalje direktno kao
 * prelazna polja: obračun radi isto, ali dimenzije se NIGDE NE PAMTE — pri sledećoj
 * izmeni se unose ponovo. Kolone koje bi to rešile su popisane kao „traži migraciju".
 */
export interface RasterWeightInput {
  /** Širina table u mm (BigBit `VrstaRastera`). */
  rasterWidthMm?: NumericInput;
  /** Dužina table u mm (BigBit `KolonaRastera`). */
  rasterLengthMm?: NumericInput;
}

export interface CreateItemDto extends ItemWriteFields, RasterWeightInput {
  catalogNumber: string;
  name: string;
  groupCode: string;
}

export type UpdateItemDto = ItemWriteFields & RasterWeightInput;

/** Gustina čelika u kg/m³ (BIGBIT_ARTIKLI.md §4.10). */
export const STEEL_DENSITY_KG_PER_M3 = 7850;

/**
 * Katalog polja. `Record<keyof ItemWriteFields, …>` = kompajler traži SVAKI ključ.
 * Dužine su BigBit definicije iz `BIGBIT_ARTIKLI.md` §1; gde je kolona u
 * `schema.prisma` uža ili šira, to piše u `note`.
 */
export const ITEM_FIELDS: Record<keyof ItemWriteFields, ItemFieldSpec> = {
  catalogNumber: {
    kind: "text",
    label: "Kataloški broj",
    src: "Kataloski broj",
    maxLength: 20,
    requiredOnCreate: true,
    columnDefault: "-",
    note: "Jedinstven — brana `guard_catalog_unique` (migracija 20260725230000). BigBit forma auto-dodeljuje sledeći petocifreni broj; MI TO NE RADIMO (v. items.write-policy.ts).",
  },
  barCode: {
    kind: "text",
    label: "Barkod",
    src: "BarKod",
    maxLength: 20,
    note: "Kolona je VarChar(50), BigBit Text(20) — držimo BigBit granicu. Samo PRIMARNI barkod; `R_Artikli_BarKod` (više barkodova + MultiFaktor) nema model.",
  },
  plu: {
    kind: "int",
    label: "PLU",
    src: "PLU",
    min: 0,
    columnDefault: 0,
    note: "BigBit dodeljuje `SledeciPLU()`; kod nas nema izvora numeracije → ostaje 0 dok ga korisnik ne zada.",
  },
  externalCode: {
    kind: "text",
    label: "Eksterna šifra",
    src: "ExtSifra",
    maxLength: 20,
  },

  name: {
    kind: "text",
    label: "Naziv",
    src: "Naziv",
    maxLength: 50,
    requiredOnCreate: true,
    note: "CHECK `Naziv IS NOT NULL` u QBigTehn kopiji.",
  },
  foreignName: {
    kind: "text",
    label: "Naziv na stranom jeziku",
    src: "INONaziv",
    maxLength: 50,
    note: "Jedan jezik. Prava 1:N tabela `R_Artikli_Ino` nema model.",
  },
  itemDescription: {
    kind: "text",
    label: "Opis artikla",
    src: "OpisArtikla",
    maxLength: 50,
  },
  webDescription: {
    kind: "text",
    label: "Web opis",
    src: "WebOpis",
    maxLength: 255,
  },
  memo: {
    kind: "text",
    label: "Napomena",
    src: "Memo",
    maxLength: 4000,
    note: "Kolona je `text` (bez granice); BigBit Memo/255. Granica 4000 je zaštita od zloupotrebe, ne poslovno pravilo.",
  },
  note2: {
    kind: "text",
    label: "Napomena 2",
    src: "Napomena2",
    maxLength: 255,
  },

  unit: { kind: "text", label: "Jedinica mere", src: "Jedinica mere", maxLength: 5 },
  baseUnit: { kind: "text", label: "Osnovna JM", src: "OsnJM", maxLength: 5 },
  foreignUnit: { kind: "text", label: "Strana JM", src: "InoJm", maxLength: 5 },
  packaging: { kind: "text", label: "Pakovanje", src: "Pakovanje", maxLength: 10 },
  box: {
    kind: "quantity",
    label: "Kutija (kg/kom)",
    src: "Kutija",
    min: 0,
    columnDefault: 0,
    note: "CHECK `Kutija >= 0`. Kod Servoteha nosi kg po komadu iz obračuna rastera (§4.10), ne kom/kutija.",
  },
  transportPackaging: {
    kind: "quantity",
    label: "Transportno pakovanje",
    src: "Transportno pakovanje",
    min: 0,
    columnDefault: 0,
    note: "CHECK `[Transportno pakovanje] >= 0`.",
  },
  quantityInPackage: {
    kind: "quantity",
    label: "Količina u pakovanju",
    src: "KolUPak",
    min: 0,
    columnDefault: 1,
  },

  groupCode: {
    kind: "text",
    label: "Grupa",
    src: "Grupa",
    maxLength: 10,
    requiredOnCreate: true,
    note: "FK → `R_Grupa`/`item_groups`. Kolona je NOT NULL bez `@default` → obavezna.",
  },
  subgroupCode: {
    kind: "text",
    label: "Podgrupa",
    src: "Podgrupa",
    maxLength: 10,
    columnDefault: "0",
    note: "FK → `item_subgroups`; hijerarhija Grupa → Podgrupa → Poreklo (§4.9).",
  },
  originCode: {
    kind: "text",
    label: "Poreklo",
    src: "Poreklo",
    maxLength: 5,
    columnDefault: "0",
    note: "FK → `item_origins`.",
  },
  qualityTypeId: {
    kind: "int",
    label: "Kvalitet artikla",
    src: "IDKvalitetArtikla",
    min: 0,
    columnDefault: 0,
    note: "FK → `R_KvalitetArtikla` — TABELA NEMA MODEL, vrednost se ne može proveriti.",
  },
  hps: {
    kind: "enum",
    label: "HPS",
    src: "HPS",
    values: HPS_VALUES,
    columnDefault: "O",
    note: "CHECK `HPS IN ('H','P','S','O')` u QBigTehn kopiji.",
  },

  goodsTaxRateCode: {
    kind: "text",
    label: "Tarifa robe",
    src: "Tarifa robe",
    maxLength: 5,
    columnDefault: "3",
    note: "FK → `R_Tarife`/`tax_rates`.",
  },
  serviceTaxRateCode: {
    kind: "text",
    label: "Tarifa usluga",
    src: "Tarifa usluga",
    maxLength: 5,
    columnDefault: "1",
    note: "FK → `R_Tarife`/`tax_rates`.",
  },
  alwaysTaxGoods: {
    kind: "bool",
    label: "Uvek porez na robu",
    src: "Uvek porez na robu",
    columnDefault: true,
  },
  alwaysTaxServices: {
    kind: "bool",
    label: "Uvek porez na usluge",
    src: "Uvek porez na usluge",
    columnDefault: false,
  },
  nonTaxablePart: {
    kind: "money",
    label: "Neoporezivi deo",
    src: "Neoporezivi deo",
    min: 0,
    columnDefault: 0,
  },
  itemExcise: {
    kind: "money",
    label: "Akciza",
    src: "ArtAkciza",
    min: 0,
    columnDefault: 0,
  },
  itemFee: {
    kind: "money",
    label: "Taksa",
    src: "ArtTaksa",
    min: 0,
    columnDefault: 0,
    note: "CHECK `ArtTaksa IS NOT NULL`.",
  },
  customsRate: {
    kind: "percent",
    label: "Carinska stopa",
    src: "CarStopa",
    columnDefault: 0,
  },
  customsTariff: {
    kind: "text",
    label: "Carinski tarifni broj",
    src: "CarTarifa",
    maxLength: 20,
  },
  originCountry: {
    kind: "text",
    label: "Zemlja porekla",
    src: "ZemljaPorekla",
    maxLength: 20,
  },

  wholesalePrice: {
    kind: "money",
    label: "VP cena",
    src: "VP cena",
    min: 0,
    columnDefault: 0,
  },
  retailPrice: {
    kind: "money",
    label: "MP cena",
    src: "MP cena",
    min: 0,
    columnDefault: 0,
  },
  fxPurchasePrice: {
    kind: "money",
    label: "Devizna nabavna cena",
    src: "NabDevCena",
    min: 0,
    columnDefault: 0,
  },
  fxSalePrice: {
    kind: "money",
    label: "Devizna prodajna cena",
    src: "ProdDevCena",
    min: 0,
    columnDefault: 0,
  },
  priceToWritePricelist: {
    kind: "money",
    label: "Cena za upis u cenovnik",
    src: "CenaZaUpisUCen",
    min: 0,
    columnDefault: 0,
  },
  maxDiscountPercent: {
    kind: "percent",
    label: "Maksimalan rabat",
    src: "MaxRabatProc",
    columnDefault: 100,
  },
  promotionDiscount: {
    kind: "percent",
    label: "Akcijski rabat",
    src: "AkcijskiRabat",
    columnDefault: 0,
  },
  manualMarkupPercent: {
    kind: "money",
    label: "Ručna marža",
    src: "KLRucProc",
    min: 0,
    columnDefault: 0,
    decimalColumn: true,
    note: "JEDINA `Decimal(19,4)` kolona na artiklu — ostale novčane su legacy `Float`.",
  },
  retailLossPercent: {
    kind: "percent",
    label: "MP kalo",
    src: "MPKaloProc",
    columnDefault: 0,
    note: "CHECK `MPKaloProc >= 0`.",
  },
  wholesaleLossPercent: {
    kind: "percent",
    label: "VP kalo",
    src: "VPKaloProc",
    columnDefault: 0,
  },
  minQuantity: {
    kind: "quantity",
    label: "Minimalna količina",
    src: "Minimalna kolicina",
    min: 0,
    columnDefault: 0,
  },
  paymentTermDays: {
    kind: "int",
    label: "Odloženo plaćanje (dana)",
    src: "Odlozeno",
    min: 0,
    max: 32767,
    columnDefault: 0,
    note: "Kolona je `SmallInt` → gornja granica 32767.",
  },
  finalProcessingCost: {
    kind: "money",
    label: "Zavisni trošak proizvodnje",
    src: "ZavTrosProiz",
    min: 0,
    columnDefault: 0,
  },
  supplierId: {
    kind: "int",
    label: "Dobavljač",
    src: "SifDob",
    min: 1,
    columnDefault: 1,
    note: "Meki FK → `customers`. Samo JEDAN (primarni); `DobavljaciZaArtikal` nema model.",
  },

  accountingCode: {
    kind: "text",
    label: "GK konto",
    src: "KngSifra",
    maxLength: 10,
    columnDefault: "0",
  },
  accountingCode2: {
    kind: "text",
    label: "GK konto 2 / zamenska šifra",
    src: "KngSifra_2",
    maxLength: 10,
    columnDefault: "0",
    note: "BigBit ga koristi i kao lanac zamene artikla (§4.11) — ta pravila NISU implementirana, polje je ovde samo tekst.",
  },
  issuePlaceId: {
    kind: "int",
    label: "Mesto izdavanja",
    src: "IDMestoIzdavanja",
    min: 0,
    columnDefault: 0,
    note: "FK → `MestaIzdavanja` — TABELA NEMA MODEL, vrednost se ne može proveriti.",
  },

  weight: {
    kind: "quantity",
    label: "Težina",
    src: "Tezina",
    min: 0,
    columnDefault: 0,
    note: "CHECK `Tezina >= 0`.",
  },
  weightKg: {
    kind: "quantity",
    label: "Težina (kg)",
    src: "TezinaKg",
    min: 0,
    columnDefault: 0,
  },
  volume: { kind: "quantity", label: "Zapremina", src: "Zapremina", min: 0, columnDefault: 0 },
  area: { kind: "quantity", label: "Površina", src: "Povrsina", min: 0, columnDefault: 0 },
  thickness: {
    kind: "quantity",
    label: "Debljina",
    src: "Debljina",
    min: 0,
    columnDefault: 0,
    note: "Debljina lima u mm — ulaz u obračun kg/kom (§4.10).",
  },
  rasterId: {
    kind: "int",
    label: "Raster",
    src: "IDRaster",
    min: 0,
    columnDefault: 0,
    note: "FK → `RasterDef*` — TABELE NEMAJU MODEL, pa se dimenzije table ne mogu pročitati; obračun kg/kom traži prelazna polja.",
  },

  pdfLink: {
    kind: "text",
    label: "PDF link",
    src: "PDFLink",
    maxLength: 255,
    note: "Putanja do fajla (FileDialog u BigBit-u), ne upload — 4.0 je ne verifikuje.",
  },
  symbolImageLink: {
    kind: "text",
    label: "Link slike simbola",
    src: "SlikaSimbolaLink",
    maxLength: 250,
  },
  wordLocation: {
    kind: "text",
    label: "Word lokacija",
    src: "WordLokacija",
    maxLength: 250,
  },

  shelf: {
    kind: "text",
    label: "Polica",
    src: "Polica",
    maxLength: 10,
    note: "BigBit Text(20), naša kolona VarChar(10) — SUŽENA (F1 nalaz o truncation-u). Granica je naša, uža.",
  },
  manufacturer: {
    kind: "text",
    label: "Proizvođač",
    src: "Proizvodjac",
    maxLength: 50,
  },
  notStockTracked: {
    kind: "bool",
    label: "Ne vodi zalihe",
    src: "NeVodiZalihe",
    columnDefault: false,
  },
  active: { kind: "bool", label: "Aktivan", src: "Aktivan", columnDefault: true },
  toDelete: {
    kind: "bool",
    label: "Za brisanje",
    src: "ZaBrisanje",
    columnDefault: false,
    note: "Meko brisanje — 4.0 NEMA `DELETE` rutu (BigBit forma ima i fizički DELETE, §4.8; ne repliciramo ga).",
  },
  sortOrder: { kind: "int", label: "Redosled", src: "RSort", min: 0, columnDefault: 0 },
};

const FIELD_NAMES = Object.keys(ITEM_FIELDS) as (keyof ItemWriteFields)[];
const TRANSIENT_NAMES = ["rasterWidthMm", "rasterLengthMm"] as const;

// ─────────────────────────────────────────────────────────────── validacija ──

/** Decimalni broj iz `string | number`; `null` kad ulaz nije upotrebljiv. */
function toDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return new Prisma.Decimal(value);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(",", ".");
  if (trimmed === "" || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  try {
    return new Prisma.Decimal(trimmed);
  } catch {
    return null;
  }
}

function validateOne(
  errors: string[],
  name: keyof ItemWriteFields,
  value: unknown,
): void {
  const spec = ITEM_FIELDS[name];

  // `null` = eksplicitno brisanje vrednosti; dozvoljeno samo tamo gde kolona
  // sme da bude NULL, tj. gde polje nije obavezno pri kreiranju.
  if (value === null) {
    if (spec.requiredOnCreate)
      errors.push(`${spec.label} ne sme biti prazan.`);
    return;
  }

  switch (spec.kind) {
    case "text": {
      if (typeof value !== "string") {
        errors.push(`${spec.label} mora biti tekst.`);
        return;
      }
      const t = value.trim();
      if (t === "") {
        if (spec.requiredOnCreate) errors.push(`${spec.label} ne sme biti prazan.`);
        return;
      }
      if (spec.maxLength && t.length > spec.maxLength)
        errors.push(
          `${spec.label} je duži od dozvoljenih ${spec.maxLength} znakova (uneto ${t.length}).`,
        );
      return;
    }
    case "enum": {
      if (typeof value !== "string" || !spec.values?.includes(value))
        errors.push(
          `${spec.label} mora biti jedna od vrednosti: ${(spec.values ?? []).join(", ")}.`,
        );
      return;
    }
    case "bool": {
      if (typeof value !== "boolean")
        errors.push(`${spec.label} mora biti tačno ili netačno.`);
      return;
    }
    case "int": {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        errors.push(`${spec.label} mora biti ceo broj.`);
        return;
      }
      if (spec.min !== undefined && value < spec.min)
        errors.push(`${spec.label} ne sme biti manji od ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max)
        errors.push(`${spec.label} ne sme biti veći od ${spec.max}.`);
      return;
    }
    case "money":
    case "quantity":
    case "percent": {
      const dec = toDecimal(value);
      if (!dec) {
        errors.push(`${spec.label} mora biti broj.`);
        return;
      }
      const min = spec.min ?? (spec.kind === "percent" ? 0 : undefined);
      const max = spec.max ?? (spec.kind === "percent" ? 100 : undefined);
      if (min !== undefined && dec.lessThan(min))
        errors.push(`${spec.label} ne sme biti manji od ${min}.`);
      if (max !== undefined && dec.greaterThan(max))
        errors.push(`${spec.label} ne sme biti veći od ${max}.`);
      if (dec.decimalPlaces() > 4)
        errors.push(`${spec.label} sme imati najviše 4 decimale.`);
      return;
    }
  }
}

/** Prelazna raster polja (§4.10) — oba ili nijedno, uz obaveznu debljinu. */
function validateRasterInput(
  errors: string[],
  dto: RasterWeightInput & ItemWriteFields,
  existingThickness: number | null,
): void {
  const w = dto.rasterWidthMm;
  const l = dto.rasterLengthMm;
  if (w === undefined && l === undefined) return;
  if (w === undefined || l === undefined) {
    errors.push(
      "Za obračun kilograma po komadu treba zadati i širinu i dužinu table (u mm).",
    );
    return;
  }
  const dw = toDecimal(w);
  const dl = toDecimal(l);
  if (!dw || dw.lessThanOrEqualTo(0))
    errors.push("Širina table mora biti pozitivan broj (mm).");
  if (!dl || dl.lessThanOrEqualTo(0))
    errors.push("Dužina table mora biti pozitivan broj (mm).");

  const thickness =
    dto.thickness !== undefined ? toDecimal(dto.thickness) : null;
  const effective =
    thickness ??
    (existingThickness !== null ? new Prisma.Decimal(existingThickness) : null);
  if (!effective || effective.lessThanOrEqualTo(0))
    errors.push(
      "Za obračun kilograma po komadu debljina mora biti veća od nule (mm).",
    );
  if (dto.box !== undefined)
    errors.push(
      "Kutija (kg/kom) se ne šalje zajedno sa dimenzijama table — vrednost se računa iz debljine i dimenzija.",
    );
}

/** Odbaci ključeve koje ne poznajemo (tiho ignorisanje = korisnik misli da je snimljeno). */
function rejectUnknownKeys(errors: string[], dto: object): void {
  const known = new Set<string>([...FIELD_NAMES, ...TRANSIENT_NAMES]);
  const unknown = Object.keys(dto).filter((k) => !known.has(k));
  if (unknown.length)
    errors.push(`Nepoznata polja: ${unknown.join(", ")}.`);
}

export function validateCreateItem(dto: CreateItemDto): void {
  const errors: string[] = [];
  rejectUnknownKeys(errors, dto);

  for (const name of FIELD_NAMES) {
    const value = (dto as unknown as Record<string, unknown>)[name];
    if (value === undefined) {
      if (ITEM_FIELDS[name].requiredOnCreate)
        errors.push(`${ITEM_FIELDS[name].label} je obavezan.`);
      continue;
    }
    validateOne(errors, name, value);
  }
  validateRasterInput(errors, dto, null);

  if (errors.length) throw new BadRequestException(errors);
}

export function validateUpdateItem(
  dto: UpdateItemDto,
  existingThickness: number | null = null,
): void {
  const errors: string[] = [];
  rejectUnknownKeys(errors, dto);

  let touched = 0;
  for (const name of FIELD_NAMES) {
    const value = (dto as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    touched++;
    validateOne(errors, name, value);
  }
  const rasterTouched =
    dto.rasterWidthMm !== undefined || dto.rasterLengthMm !== undefined;
  validateRasterInput(errors, dto, existingThickness);

  if (touched === 0 && !rasterTouched) errors.push("Nema polja za izmenu.");
  if (errors.length) throw new BadRequestException(errors);
}

// ──────────────────────────────────────────────────────── mapiranje u kolone ──

/**
 * DTO → kolone `Item`. Prenose se SAMO poslata polja (`PATCH` semantika).
 *
 * Novčane vrednosti se validiraju kao `Prisma.Decimal` (BACKEND_RULES §6 — nikad
 * `parseFloat` nad korisničkim unosom), pa se za LEGACY `Float` kolone spuštaju u
 * broj tek na samoj granici upisa. Jedina `Decimal` kolona (`manualMarkupPercent`)
 * dobija `Decimal` bez konverzije. Da su sve cenovne kolone `Decimal` — a traže
 * migraciju, v. `items.write-policy.ts` — ovog spuštanja ne bi ni bilo.
 */
export function toItemColumns(
  dto: ItemWriteFields,
): Record<string, string | number | boolean | Prisma.Decimal | null> {
  const out: Record<string, string | number | boolean | Prisma.Decimal | null> =
    {};

  for (const name of FIELD_NAMES) {
    const value = (dto as unknown as Record<string, unknown>)[name];
    if (value === undefined) continue;
    const spec = ITEM_FIELDS[name];

    if (value === null) {
      out[name] = null;
      continue;
    }
    switch (spec.kind) {
      case "text": {
        const t = String(value).trim();
        out[name] = t === "" ? null : t;
        break;
      }
      case "enum":
        out[name] = String(value);
        break;
      case "bool":
        out[name] = Boolean(value);
        break;
      case "int":
        out[name] = Number(value);
        break;
      default: {
        const dec = toDecimal(value);
        if (!dec) break;
        out[name] = spec.decimalColumn ? dec : dec.toNumber();
      }
    }
  }
  return out;
}

/**
 * kg po komadu table: `debljina[mm] × širina[mm] × dužina[mm] × 7850 / 1e9`.
 * Verni port `DugmePreracunajTezinuUKomadu` (BIGBIT_ARTIKLI.md §4.10); rezultat ide
 * u `box` (`Kutija`), zaokružen na 4 decimale (preciznost `Decimal(19,4)` u repou).
 */
export function computeKilogramsPerPiece(
  thicknessMm: NumericInput,
  widthMm: NumericInput,
  lengthMm: NumericInput,
): number | null {
  const t = toDecimal(thicknessMm);
  const w = toDecimal(widthMm);
  const l = toDecimal(lengthMm);
  if (!t || !w || !l) return null;
  if (t.lessThanOrEqualTo(0) || w.lessThanOrEqualTo(0) || l.lessThanOrEqualTo(0))
    return null;
  return t
    .mul(w)
    .mul(l)
    .mul(STEEL_DENSITY_KG_PER_M3)
    .div(1_000_000_000)
    .toDecimalPlaces(4)
    .toNumber();
}
