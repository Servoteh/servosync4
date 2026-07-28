import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import {
  hasNativeColumns,
  isAdditiveRefreshTable,
  isOwnedProductionTable,
} from "../sync/table-ownership";

/**
 * BRANE ZA UPIS U `items` — preduslovi bez kojih unos artikla NIJE bezbedan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZAŠTO OVAJ FAJL UOPŠTE POSTOJI
 * ─────────────────────────────────────────────────────────────────────────────
 * `items` se danas sinhronizuje kao FULL REFRESH: `sync-map.generated.ts` daje
 * `watermark: null`, pa `GenericSyncer` radi `deleteMany({})` + `createMany(...)`
 * pod `SET LOCAL session_replication_role='replica'`. Tabela NIJE ni u
 * `ADDITIVE_REFRESH_TABLES`, ni u `NATIVE_COLUMN_TABLES`, ni u
 * `OWNED_PRODUCTION_TABLES`. Posledice, redom:
 *
 *   1. Red nastao u 4.0 se pri prvom `POST /api/v1/sync/run` OBRIŠE — bez greške
 *      i bez traga. Pošto brisanje ide u `replica` režimu (FK trigeri isključeni),
 *      `price_list_entries.item_id` i `work_order_item_components.item_id` ostaju
 *      kao siročad koja se ne restore-uje čisto.
 *   2. Izmena BigBit-origin reda nestaje na istom mestu — red se ne ažurira nego
 *      briše i ponovo unosi iz izvora.
 *   3. Ni `NATIVE_COLUMN_TABLES` to ne bi spasao: sve 68 kolona modela `Item` su u
 *      sync mapi (provereno diff-om), pa je skup „nemapiranih kolona koje zaštita
 *      čuva" PRAZAN. Za `items` ta zaštita ne štiti nijedno polje.
 *
 * Zato rute za upis postoje i validiraju pun skup polja, ali servis PRE upisa pita
 * `assertItemWritesAllowed()`. Dok `items` ne uđe u neki od zaštićenih skupova u
 * `sync/table-ownership.ts`, svaki upis se odbija sa 409 i porukom koja korisniku
 * kaže šta da radi. `sync/` je tuđa granica — zaštita se NE dodaje odavde.
 *
 * Provera je NAMERNO dinamička (čita iste skupove koje čita i syncer), a ne ručni
 * prekidač: onog dana kad sync tim upiše `items` u zaštićeni skup, unos proradi sam
 * i bez izmene ovog fajla — a test to pinuje u oba smera.
 *
 * ISKLJUČENOST IZ NOĆNOG POSLA NIJE ZAŠTITA: `NIGHTLY_SYNC_EXCLUDED = {"items"}`
 * je privremena (do čišćenja duplikata kataloških brojeva u BigBit-u) i važi samo
 * za noćni posao — ručni `POST /api/v1/sync/run` i dalje radi pun `deleteMany`.
 */

/** Ime tabele kako ga vidi `GenericSyncer` (`targetDb` u sync mapi). */
export const ITEMS_ENTITY = "items";

/** Da li bi red nastao u 4.0 preživeo sledeći sync artikala. */
export function itemsSurviveSync(): boolean {
  return (
    isAdditiveRefreshTable(ITEMS_ENTITY) ||
    hasNativeColumns(ITEMS_ENTITY) ||
    isOwnedProductionTable(ITEMS_ENTITY)
  );
}

export const ITEM_WRITE_BLOCKED_MESSAGE =
  "Artikli se za sada unose i menjaju isključivo u BigBit-u. Sinhronizacija artikala " +
  "briše i ponovo unosi celu tabelu, pa bi artikal unet ovde nestao pri prvom uvozu — " +
  "zajedno sa vezama na cenovnik i radne naloge. Unesite artikal u BigBit-u, pa javite " +
  "administratoru da pokrene uvoz (Sinhronizacije → Pokreni sync).";

export const ITEM_BIGBIT_ORIGIN_MESSAGE =
  "Ovaj artikal je došao iz BigBit-a i ovde se ne menja — svaka izmena bi nestala pri " +
  "sledećem uvozu, jer BigBit ponovo upisuje sva njegova polja. Ispravite artikal u " +
  "BigBit-u, pa javite administratoru da pokrene uvoz (Sinhronizacije → Pokreni sync).";

/**
 * Poslovna greška upisa u tabelu čiji je vlasnik BigBit. 409 (ne 403) — nije stvar
 * prava korisnika nego stanja sistema; `code` je stabilan za frontend i isti je koji
 * već koriste komitenti/predmeti (`directory/bigbit-owned.ts`).
 */
export class ItemWriteBlockedException extends ConflictException {
  constructor(message: string) {
    super({
      statusCode: 409,
      error: "Conflict",
      code: "BIGBIT_OWNED_READ_ONLY",
      message,
    });
  }
}

/** Upis u `items` je dozvoljen tek kad sync prestane da briše native redove. */
export function assertItemWritesAllowed(): void {
  if (!itemsSurviveSync())
    throw new ItemWriteBlockedException(ITEM_WRITE_BLOCKED_MESSAGE);
}

/**
 * ODVOJEN OPSEG ID-JEVA ZA 4.0-NATIVE ARTIKLE.
 *
 * `Item.id` je `@default(autoincrement())`, ali sync upisuje EKSPLICITNE id-jeve iz
 * QBigTehn IDENTITY prostora i nigde ne podiže PG sekvencu (`bumpIdSequence` radi
 * samo za aditivne tabele, `setval` nad `items` ne postoji ni u jednoj migraciji).
 * Prvi native unos koji bi uzeo `nextval` zato pada na PK (23505) ili tiho sedne na
 * tuđi BigBit id pa ga sledeći sync prepiše tuđim artiklom („squatter", isti scenario
 * koji je već dokumentovan za `document_types`).
 *
 * Umesto klampovanja sekvence (traži migraciju — tuđa granica), native redovi idu u
 * ODVOJEN OPSEG: id se dodeljuje kao `MAX(id) + 1` UNUTAR opsega, pod
 * `pg_advisory_xact_lock`. BigBit prostor (danas ~92k redova) i native prostor se ne
 * dodiruju, a granica opsega je ujedno i jedini upotrebljiv MARKER POREKLA — za
 * artikle postoji i `external_item_id` (0 = bez BigBit porekla), ali NEPOZNATO je
 * koliko redova na produkciji već ima 0, pa se on ne koristi kao jedini kriterijum
 * (upisuje se, ali odluku donosi opseg id-a).
 *
 * ⚠️ Vrednost granice traži potvrdu vlasnika pre puštanja unosa (v. izveštaj).
 */
export const NATIVE_ITEM_ID_BASE = 900_000_000;

/** `Int` kolona je PG `integer` — gornja granica opsega. */
export const NATIVE_ITEM_ID_MAX = 2_147_483_647;

export function isNativeItemId(id: number): boolean {
  return id >= NATIVE_ITEM_ID_BASE;
}

/** Izmena je dozvoljena samo nad redom koji je nastao u 4.0. */
export function assertItemIsNative(item: { id: number }): void {
  if (!isNativeItemId(item.id))
    throw new ItemWriteBlockedException(ITEM_BIGBIT_ORIGIN_MESSAGE);
}

/**
 * BRANA ZA JEDINSTVEN KATALOŠKI BROJ (DB audit DB-081).
 *
 * Migracija `20260725230000_katbroj_brana` postavlja ratchet trigger
 * `guard_catalog_unique`: `RAISE EXCEPTION 'CATALOG_NUMBER_DUPLICATE: …'` sa
 * `ERRCODE = 'unique_violation'` (23505). Na aplikativnom putu trigger VAŽI (inertan
 * je samo u `replica` režimu full refresh-a, gde ga menja `SOURCE_UNIQUE_FIELDS`).
 *
 * Prisma tu grešku vraća kao `P2002` (23505) ili kao neklasifikovanu grešku sa
 * originalnom porukom — u oba slučaja korisnik bi video sirov engleski tekst iz baze.
 * Ovde se pretvara u srpsku poruku; sve ostale greške se propuštaju nepromenjene.
 */
export function isCatalogDuplicateError(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2002" || (e.meta as { code?: string })?.code === "23505")
  )
    return true;
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("CATALOG_NUMBER_DUPLICATE");
}

export function catalogDuplicateException(
  catalogNumber: string,
): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: "Conflict",
    code: "CATALOG_NUMBER_DUPLICATE",
    message:
      `Kataloški broj „${catalogNumber}” već koristi drugi artikal. ` +
      "Kataloški broj mora biti jedinstven — otvorite postojeći artikal ili dodelite drugi broj.",
  });
}

/**
 * POLJA I TABELE BigBit forme „Unos artikala" KOJE 4.0 ŠEMA NE NOSI.
 *
 * Ništa od ovoga se ne izmišlja u kodu — popis je ulaz za migraciju i za odluku
 * vlasnika. Redosled prati prioritet iz `BIGBIT_ARTIKLI.md` §7.
 */
export const ITEM_FIELDS_REQUIRING_MIGRATION: readonly {
  what: string;
  why: string;
}[] = [
  {
    what: "`RasterDef*` (dimenzije table za `IDRaster`)",
    why: "Kod Servoteha raster = dimenzije lima; bez tih tabela `Item.rasterId` visi u prazno i obračun kg/kom (§4.10) nema odakle da povuče širinu/dužinu — forma ih danas šalje kao prelazna polja koja se ne pamte.",
  },
  {
    what: "`R_Artikli_BarKod` (više barkodova + `MultiFaktor`)",
    why: "`Item.barCode` je samo primarni barkod; skener koji pročita barkod kutije ne nalazi artikal (§3.1).",
  },
  {
    what: "`R_KvalitetArtikla`",
    why: "`Item.qualityTypeId` postoji, šifarnik ne — vrednost se ne može ponuditi ni proveriti (§2.1).",
  },
  {
    what: "`MestaIzdavanja`",
    why: "`Item.issuePlaceId` postoji, šifarnik ne (§2.2).",
  },
  {
    what: "`R_Artikli_Ino` (naziv/JM po jeziku)",
    why: "Danas samo jedan strani naziv (`foreignName`) — 1:N rečnik nije modelovan (§3.2).",
  },
  {
    what: "`ArtikliSlike` / `GrupeSlike` / `PodgrupeSlike`",
    why: "Galerija slika po artiklu/grupi; danas postoji samo jedan `symbolImageLink` (§3.3).",
  },
  {
    what: "`DobavljaciZaArtikal` (više dobavljača + `VremeIsporuke`)",
    why: "`Item.supplierId` nosi samo primarnog dobavljača, bez lead time-a (§2.2).",
  },
  {
    what: "`R_Artikli_Obelezja` (custom atributi)",
    why: "Struktura NEPOZNATA — nema DDL u dostupnom exportu (§3.5).",
  },
  {
    what: "`Rabati` / `RabatiPoArt` / `Akcije` / `AkcijeArtikli`",
    why: "Komercijalna politika cena; `promotionDiscount` je jedini ostatak na artiklu (§2.3).",
  },
  {
    what: "`items.updated_at` (+ ko je izmenio)",
    why: "Artikal ima samo `created_at` (`DatumIVremeArt`) i `signature` (ko) — vreme izmene se nema gde upisati, pa `PATCH` ne ostavlja trag u vremenu.",
  },
  {
    what: "Marker porekla (`source` / nullable `bb_sifra`)",
    why: "Danas se native red prepoznaje samo po opsegu id-a; eksplicitna kolona (obrazac noćnog .mdb uvoza, `bb_stavka_id IS NULL`) bila bi provera upitom, a ne konvencijom.",
  },
  {
    what: "Cenovne kolone `Float` → `Decimal(19,4)`",
    why: "`wholesalePrice`, `retailPrice`, `fxPurchasePrice`, `fxSalePrice`, `priceToWritePricelist`, `itemFee`, `itemExcise`, `nonTaxablePart`, `finalProcessingCost` su legacy `Float` (BigBit `Double`) — BACKEND_RULES traži `Decimal`. API ih već prima i validira kao decimalne, ali kolona ih zaokružuje u binarni float.",
  },
  {
    what: "`items.shelf` VarChar(10) → VarChar(20)",
    why: "BigBit `Polica` je Text(20); naša kolona je uža (F1 nalaz o truncation-u) pa forma mora da odbije duži unos koji BigBit prima.",
  },
  {
    what: "`setval` nad sekvencom `items` (ili `items` u zaštićeni skup)",
    why: "Sekvenca nikad nije klampovana iznad BigBit prostora; obilazi se odvojenim opsegom id-a, ali `nextval` i dalje vraća vrednosti iz BigBit prostora ako ih iko upotrebi.",
  },
];
