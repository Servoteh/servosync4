import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { nativeRowsSurviveSync } from "../sync/table-ownership";

/**
 * BRANE ZA UPIS U `items` — preduslovi bez kojih unos artikla NIJE bezbedan.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ZAŠTO OVAJ FAJL UOPŠTE POSTOJI
 * ─────────────────────────────────────────────────────────────────────────────
 * `items` se sinhronizuje kao FULL REFRESH: `sync-map.generated.ts` daje
 * `watermark: null`, pa `GenericSyncer` briše pa ponovo unosi skup, pod
 * `SET LOCAL session_replication_role='replica'`. Do 28.07.2026 je to brisanje
 * bilo `deleteMany({})` — dakle SVE — pa je red nastao u 4.0 nestajao pri prvom
 * `POST /api/v1/sync/run`, bez greške i bez traga, ostavljajući
 * `price_list_entries.item_id` i `work_order_item_components.item_id` kao siročad
 * (u `replica` režimu FK trigeri ćute).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ŠTA SE PROMENILO 28.07.2026 — I ZAŠTO UNOS I DALJE STOJI
 * ─────────────────────────────────────────────────────────────────────────────
 * Sync od tada čuva 4.0-native redove REZERVISANIM OPSEGOM KLJUČEVA
 * (`sync/table-ownership.ts`: `NATIVE_ID_RANGE_TABLES`). Full refresh za `items`
 * briše samo `id < NATIVE_ID_BASE`, a izvorni red koji bi upao u native opseg se
 * preskače. Migracija `20260728170000` istu granicu ukiva u bazu kao CHECK i
 * pomera sekvencu iznad BigBit prostora. Praktično: artikal unet u 4.0 VIŠE NE
 * NESTAJE pri sync-u — `itemsSurviveSync()` je zato od 28.07 `true`.
 *
 * ⚠️ ALI TO NIJE ISTO ŠTO I DOZVOLA ZA UNOS. Dve stvari su NAMERNO ODVOJENE:
 *
 *   • `itemsSurviveSync()` = ČINJENICA o sync-u (preživljava li native red).
 *     Odgovor čita `sync/table-ownership.ts`, jedno mesto odluke za obe matične
 *     tabele — ne prepisuje se ovde.
 *   • `ITEMS_WRITE_OPEN`   = ODLUKA VLASNIKA (sme li se unositi iz 4.0).
 *     Isti oblik prekidača koji komitenti već imaju (`CUSTOMERS_WRITE_OPEN`).
 *
 * Ranije je jedna funkcija bila i činjenica i prekidač, pa bi je onaj ko ispravi
 * činjenicu USPUT otvorio unos — tačno „novo otkriće" koje ceo ovaj talas
 * sprečava. `assertItemWritesAllowed()` zato traži OBOJE, a otvaranje unosa je
 * jedan red (`ITEMS_WRITE_OPEN = true`) i ništa drugo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ŠTA JOŠ STOJI IZMEĐU DANAŠNJEG STANJA I OTVARANJA
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. ODLUKA VLASNIKA — artikli se do daljeg vode u BigBit-u (isti režim koji
 *      za komitente drži odluka od 26.07.2026).
 *   2. DUPLIKATI KATALOŠKIH BROJEVA u BigBit-u (1.980 grupa / 4.298 artikala,
 *      mereno 25.07) — zaštita od pada uvoza, nezavisan uslov.
 *      ⚠️ NE MEŠATI sa isključenjem iz sync prolaza: od reopena 061/26
 *      (04.08.2026) `items` je u `DEFAULT_SYNC_EXCLUDED`
 *      (`sync/table-ownership.ts`) zato što mu je MSSQL IZVOR ZAMRZNUT od
 *      22.07, a ne zbog duplikata — i to isključenje sada pokriva i ručni i
 *      noćni prolaz. Čišćenje duplikata NE otključava povratak u sync.
 *   3. Prateće tabele forme „Unos artikala" koje šema još nema — v.
 *      `ITEM_FIELDS_REQUIRING_MIGRATION` na dnu fajla.
 */

/** Ime tabele kako ga vidi `GenericSyncer` (`targetDb` u sync mapi). */
export const ITEMS_ENTITY = "items";

/**
 * ČINJENICA: da li bi red nastao u 4.0 preživeo sledeći sync artikala.
 *
 * Odgovor se NE računa ovde — pita se `sync/table-ownership.ts`, koje je jedino
 * mesto odluke o vlasništvu i o rezervisanom opsegu ključeva (`items` je od
 * 28.07 u `NATIVE_ID_RANGE_TABLES`, pa je odgovor `true`). Kad bi se ovde držala
 * kopija pravila, sync bi štitio jedan skup a masters pretpostavljao drugi.
 *
 * ⚠️ NIJE dozvola za unos — v. `ITEMS_WRITE_OPEN`.
 */
export function itemsSurviveSync(): boolean {
  return nativeRowsSurviveSync(ITEMS_ENTITY);
}

/**
 * ODLUKA VLASNIKA: sme li se artikal unositi/menjati iz 4.0.
 *
 * `false` = svaki `POST`/`PATCH` vraća 409, ma koliko sync bio bezbedan. Blizanac
 * je `CUSTOMERS_WRITE_OPEN` u `customers.service.ts` — obe matične tabele imaju
 * ISTI oblik prekidača, pa se unos otvara jednim redom po tabeli.
 *
 * PRE PREVRTANJA na `true` proveriti tačke 1–3 iz zaglavlja ovog fajla.
 */
export const ITEMS_WRITE_OPEN: boolean = false;

/**
 * Poruka za DANAŠNJE stanje: tehnički je bezbedno, ali unos još nije pušten.
 * Namerno ne obećava rok — odluku donosi vlasnik, ne kod.
 */
export const ITEM_WRITE_BLOCKED_MESSAGE =
  "Artikli se za sada unose i menjaju isključivo u BigBit-u — unos iz ovog ekrana " +
  "još nije pušten u rad. Unesite artikal u BigBit-u — ovde stiže automatski noćnim " +
  "uvozom: uneto do 17:30 vidi se sutra ujutru, kasnije prekosutra. Bržeg puta nema " +
  "(izvoz iz BigBita ide jednom dnevno).";

/**
 * Poruka za slučaj da sync zaštita NESTANE (`items` izbačen iz rezervisanog
 * opsega). Tada unos nije samo nepušten nego i OPASAN — red bi se obrisao pri
 * prvom uvozu. Danas nedostižna; postoji da bi otkaz zaštite imao svoj glas.
 */
export const ITEM_WRITE_UNSAFE_MESSAGE =
  "Artikli se trenutno ne mogu unositi iz ovog ekrana: sinhronizacija artikala briše " +
  "i ponovo unosi celu tabelu, pa bi artikal unet ovde nestao pri prvom uvozu — zajedno " +
  "sa vezama na cenovnik i radne naloge. Unesite artikal u BigBit-u — ovde stiže noćnim " +
  "uvozom: uneto do 17:30 vidi se sutra ujutru, kasnije prekosutra.";

export const ITEM_BIGBIT_ORIGIN_MESSAGE =
  "Ovaj artikal je došao iz BigBit-a i ovde se ne menja — svaka izmena bi nestala pri " +
  "sledećem uvozu, jer BigBit ponovo upisuje sva njegova polja. Ispravite artikal u " +
  "BigBit-u — izmena ovde stiže noćnim uvozom: uneto do 17:30 vidi se sutra ujutru, " +
  "kasnije prekosutra.";

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

/**
 * Upis u `items` traži OBOJE: da native red preživi sync (tehnička bezbednost) i
 * da ga vlasnik pusti (poslovna odluka). Otkaz bilo kog uslova = 409.
 *
 * Redosled provere je namеran: ako sync zaštita ikad NESTANE (neko izbaci `items`
 * iz `NATIVE_ID_RANGE_TABLES`), upis se zatvara SAM — čak i ako je prekidač
 * ostao na `true`.
 */
export function assertItemWritesAllowed(): void {
  if (!itemsSurviveSync())
    throw new ItemWriteBlockedException(ITEM_WRITE_UNSAFE_MESSAGE);
  if (!ITEMS_WRITE_OPEN)
    throw new ItemWriteBlockedException(ITEM_WRITE_BLOCKED_MESSAGE);
}

/**
 * KOLONE ARTIKLA KOJE JE 4.0 PREUZEO OD BigBita (uže od cele tabele).
 * ─────────────────────────────────────────────────────────────────────────────
 * `assertItemWritesAllowed()` + `assertItemIsNative()` zatvaraju CELU karticu
 * artikla, i to ostaje: BigBit i dalje piše svih ostalih ~66 kolona, pa bi izmena
 * bilo koje od njih nestala pri prvom noćnom uvozu.
 *
 * Ali vlasništvo nad kolonom nije stvar cele tabele. Odlukom vlasnika 06.08.2026.
 * `min_quantity` je IZBAČENA iz sync mape (`sync-map.generated.ts`), pa je vrednost
 * upisana iz aplikacije jedina koja postoji — uvoz je više ne dira. Tek to čini
 * bezbednim da postoji USKA ruta koja tu jednu kolonu menja i nad BigBit-origin
 * redom (`PATCH /v1/artikli/:id/minimalna-kolicina`, pravo `masters.min_quantity`).
 *
 * ⚠️ OVAJ SPISAK NIJE DEKORACIJA — on je USLOV. Kolona sme ovde SAMO ako je
 * izbačena iz sync mape; inače uska ruta postaje tih gubitak podatka (unos preko
 * dana, brisanje u 03:45). Brane koje to čuvaju:
 *   • `items.write-policy.spec.ts` — svaka kolona odavde mora biti van sync mape;
 *   • `sync/bigbit-mdb-import.items.spec.ts` — uvoz je stvarno ne upisuje.
 *
 * Imena su polja Prisma modela `Item` (ista imena koja koristi `ITEM_FIELDS`).
 */
export const ITEM_FIELDS_OWNED_BY_40 = ["minQuantity"] as const;

export type ItemFieldOwnedBy40 = (typeof ITEM_FIELDS_OWNED_BY_40)[number];

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

/**
 * Vrednost kolone `items.source` za red nastao u 4.0.
 *
 * NIJE ukras: `chk_items_native_id_range` traži `(source='NATIVE') = (id >= 900000000)`,
 * a kolona ima DB default `'BIGBIT'`. Pisac koji je izostavi pravi red sa native
 * id-jem i pogrešnim markerom, pa ga baza odbija kodom 23514 — koji `runGuarded`
 * ne prepoznaje, pa korisnik dobija 500 sa sirovim tekstom baze umesto poruke.
 * Konstanta stoji ovde, uz opseg id-jeva, da marker i granica ostanu jedno pravilo.
 */
export const NATIVE_ITEM_SOURCE = "NATIVE";

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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ISPORUČENO migracijom `20260728170000_maticni_native_opseg_i_poreklo` i zato
 * SKINUTO sa ovog popisa (28.07.2026) — popis koji nabraja urađeno šalje vlasnika
 * da dvaput plati isti posao:
 *
 *   • `items.source` — marker porekla (`BIGBIT`/`NATIVE`), uz CHECK koji ga vezuje
 *     za rezervisan opseg id-a. `external_item_id` je 0 na 1.417 BigBit redova pa
 *     sam za sebe nikad nije razlikovao poreklo.
 *   • `items.updated_at` + `items.updated_by` — `PATCH` sada ostavlja trag u vremenu.
 *   • `items.shelf` VarChar(10) → VarChar(20) — više se ne odseca BigBit `Polica`.
 *     (Već odsečenih 82 vrednosti ovim se NE vraćaju — dopuni ih sledeći pun uvoz.)
 *   • 9 cenovnih kolona `Float` → `Decimal(19,4)` — novac je Decimal po
 *     BACKEND_RULES; izmereno 0 promenjenih vrednosti na 92.511 redova.
 *   • `setval` nad sekvencom `items` — pomerena na 899.999.999, iznad BigBit prostora.
 * ─────────────────────────────────────────────────────────────────────────────
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
];
