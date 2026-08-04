import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import {
  KNOWN_VAT_CODES,
  unknownVatCodeMessage,
} from "../gl/posting/vat-rates";
import {
  parseBoolParam,
  parseIntParam,
  type ListItemsQuery,
} from "./dto/list-items.dto";
import {
  computeKilogramsPerPiece,
  toItemColumns,
  validateCreateItem,
  validateUpdateItem,
  type CreateItemDto,
  type ItemWriteFields,
  type RasterWeightInput,
  type UpdateItemDto,
} from "./dto/upsert-item.dto";
import {
  assertItemIsNative,
  assertItemWritesAllowed,
  catalogDuplicateException,
  isCatalogDuplicateError,
  isNativeItemId,
  NATIVE_ITEM_ID_BASE,
  NATIVE_ITEM_ID_MAX,
  NATIVE_ITEM_SOURCE,
} from "./items.write-policy";
import type { AuthUser } from "../auth/jwt.strategy";

/**
 * KOLONE PREGLEDA ARTIKALA — REDOSLED JE BigBit REDOSLED, I TO JE UGOVOR.
 *
 * Zahtev vlasnika (04.08.2026): „SVE TREBA DA BUDE KAO U BIGBITU… KOLONE U PREGLEDU
 * DA BUDU ISTIM REDOSLEDOM, SVI KORISNICI SU NAVIKLI." Redosled ispod je doslovno
 * prepisan iz same Access baze — kontrole sekcije forme „Pregled artikala" sortirane
 * po x koordinati (levo → desno), ne po nekom našem osećaju šta je važnije.
 * Zato se ključevi OVDE NE PREUREĐUJU: redosled ključeva `select`-a je i redosled
 * ključeva u JSON-u, pa tabela na ekranu ostaje ista i kad je frontend samo prepiše.
 *
 * 1 Kataloški broj · 2 Naziv · 3 J.m. · 4 Polica · 5 Težina · 6 Grupa · 7 Podgrupa ·
 * 8 PodPodgrupa · 9 VP cena · 10 MP cena · 11 Tarifa robe · 12 PPD · 13 Debljina ploče ·
 * 14 Kg u kom. · 15 Devizna cena · 16 Kng. šifra 1 · 17 Kng. šifra 2 · 18 PLU · 19 ID ·
 * 20 Bar kod · 21 Ext. šifra · 22 INO naziv
 *
 * Dve kolone nisu iz BigBit liste i namerno stoje na krajevima, da ne pomere nijednu
 * od 22: `id` (tehnički ključ — bez njega red nema na šta da vodi) i `active`
 * (postojeći filter `?active=`; BigBit neaktivan artikal prikazuje prigušeno).
 *
 * `items` ima ~91k redova — lista nikad ne ide bez LIMIT-a (`parsePagination`).
 */
const ITEM_LIST_SELECT = {
  id: true,
  catalogNumber: true, //  1 Kataloški broj
  name: true, //  2 Naziv
  unit: true, //  3 J.m.
  shelf: true, //  4 Polica
  weight: true, //  5 Težina
  groupCode: true, //  6 Grupa        (opis iz šifarnika ide u `group`)
  subgroupCode: true, //  7 Podgrupa     (`subgroup`)
  originCode: true, //  8 PodPodgrupa  (`origin` — BigBit kolona `Poreklo`)
  wholesalePrice: true, //  9 VP cena
  retailPrice: true, // 10 MP cena
  goodsTaxRateCode: true, // 11 Tarifa robe
  alwaysTaxGoods: true, // 12 PPD (BigBit checkbox „Uvek porez na robu")
  thickness: true, // 13 Debljina ploče
  box: true, // 14 Kg u kom. (BigBit `Kutija` — v. obračun §4.10)
  fxSalePrice: true, // 15 Devizna cena (`ProdDevCena`)
  accountingCode: true, // 16 Kng. šifra 1
  accountingCode2: true, // 17 Kng. šifra 2
  plu: true, // 18 PLU
  externalItemId: true, // 19 ID = BigBit „Šifra artikla" (NIKAD `items.id`)
  barCode: true, // 20 Bar kod
  externalCode: true, // 21 Ext. šifra
  foreignName: true, // 22 INO naziv
  active: true,
} as const;

/**
 * Gornja granica spiska duplih kataloških brojeva (podupit za `?duplicateCatalogNumbers=true`).
 *
 * Mereno 25.07.2026 na produkciji: 1.980 grupa duplikata / 4.298 artikala
 * (`items.write-policy.ts`, tačka 2) — 5.000 pokriva današnje stanje sa rezervom.
 * Granica postoji zato što je ovo RADNA LISTA ZA ČIŠĆENJE, a ne izveštaj: ako bi se
 * duplikati ikad namnožili preko ovog broja, korisniku ne treba `IN` sa desetinama
 * hiljada vrednosti (upit bi postao skup, a lista neupotrebljiva) nego izveštaj o
 * kvalitetu podataka. Odsečen spisak zato ostaje ISPRAVAN ODGOVOR na pitanje „daj mi
 * duplikate za čišćenje" — samo nije potpun, i to je namerno.
 */
const DUPLICATE_CATALOG_LIMIT = 5000;

/** Pet komponenti stope iz `R_Tarife` koje BigBit sabira u „zbirnu stopu". */
const TAX_RATE_SELECT = {
  code: true,
  description: true,
  baseRate: true,
  railwayRate: true,
  cityRate: true,
  warRate: true,
  specialRate: true,
} as const;

/**
 * Upiti za combo-boxove BEZ ŠIFARNIKA (jedinica mere, proizvođač, zemlja porekla).
 *
 * Tri gotova, doslovno napisana upita — imena kolona su deo koda, ne podatak. Zbog
 * toga ovde nema `$queryRawUnsafe` ni interpolacije: nijedan ulaz iz zahteva ne može
 * da dođe do teksta upita. `LIMIT 500` je zaštita od combo-a sa hiljadama stavki
 * (proizvođači su slobodan tekst na 92k artikala, pa umeju da se namnože).
 */
const DISTINCT_VALUE_SQL = {
  unit: Prisma.sql`SELECT DISTINCT unit AS value FROM items
     WHERE unit IS NOT NULL AND btrim(unit) <> '' ORDER BY 1 LIMIT 500`,
  manufacturer: Prisma.sql`SELECT DISTINCT manufacturer AS value FROM items
     WHERE manufacturer IS NOT NULL AND btrim(manufacturer) <> '' ORDER BY 1 LIMIT 500`,
  origin_country: Prisma.sql`SELECT DISTINCT origin_country AS value FROM items
     WHERE origin_country IS NOT NULL AND btrim(origin_country) <> '' ORDER BY 1 LIMIT 500`,
} as const;

/** Razrešen šifarnički kod: `{ code, description }`; `description` = null kad šifarnik nije sinkovan. */
export interface CodeRef {
  code: string;
  description: string | null;
}

/**
 * Matični podatak „Artikli" (BigBit cache `items`) — pregled + unos/izmena.
 *
 * PREGLED JE PARITET BigBit EKRANA „Pregled artikala" (odluka vlasnika 04.08.2026):
 * iste kolone i isti njihov redosled (`ITEM_LIST_SELECT`), isti sort (grupa →
 * kataloški broj → naziv) i isti filteri, uključujući kaskadu Grupa → Podgrupa →
 * PodPodgrupa koju frontend računa iz `lookups()`. Nijedno od toga nije stvar ukusa:
 * korisnici rade po navici, pa je razlika u rasporedu greška kao i pogrešan podatak.
 *
 * ⚠️ UNOS I IZMENA SU DANAS ZATVORENI BRANOM, NE IZOSTAVLJENI. `create()`/`update()`
 * postoje sa punim skupom polja BigBit forme „Unos artikala", ali prvo pitaju
 * `assertItemWritesAllowed()` — dok `items` prolazi kroz full refresh
 * (`deleteMany({})` + `createMany`), svaki upis odavde bi nestao pri prvom uvozu i
 * ostavio siročad u `price_list_entries`/`work_order_item_components`. Puno
 * obrazloženje i uslovi otvaranja: `items.write-policy.ts`.
 *
 * ⚠️ Šifarnici `item_groups` / `item_subgroups` / `item_origins` su DANAS PRAZNI
 * (BIGBIT_ARTIKLI.md §2.1 — synceri za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` ne
 * postoje). Zato se nazivi razrešavaju BATCH upitom i `description` pada na
 * `null` — nikad izuzetak, nikad required-relation JOIN (koji bi na praznom
 * šifarniku dao `Inconsistent query result` → 500; isti razlog kao u
 * `common/relations.ts`).
 */
@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListItemsQuery) {
    const { page, pageSize, skip, take } = parsePagination(
      query.page,
      query.pageSize,
    );
    const where = await this.buildListWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where,
        // BigBit sort pregleda: `ORDER BY Grupa, [Kataloski broj], Naziv`. Korisnik
        // je navikao da mu artikli iste grupe stoje zajedno — sortiranje po samom
        // kataloškom broju (kako je stajalo do 04.08.2026) razbacuje grupe.
        // `id` je SAMO tie-break, ne menja vidljiv redosled: kataloški broj NIJE
        // jedinstven (1.980 grupa duplikata), a bez determinističkog kriterijuma
        // paginacija ume da isti red pokaže dvaput ili da ga preskoči.
        orderBy: [
          { groupCode: "asc" },
          { catalogNumber: "asc" },
          { name: "asc" },
          { id: "asc" },
        ],
        skip,
        take,
        select: ITEM_LIST_SELECT,
      }),
      this.prisma.item.count({ where }),
    ]);

    // Sva tri šifarnika batch-om (jedan upit po šifarniku, ne po redu). Do 04.08.2026
    // se razrešavala samo grupa, pa su kolone Podgrupa/PodPodgrupa mogle prikazati
    // isključivo golu šifru — u BigBit-u operater vidi opis u combo-boxu.
    const [groups, subgroups, origins] = await Promise.all([
      this.resolveGroups(rows.map((r) => r.groupCode)),
      this.resolveSubgroups(rows.map((r) => r.subgroupCode)),
      this.resolveOrigins(rows.map((r) => r.originCode)),
    ]);

    const data = rows.map((r) => ({
      ...r,
      // Decimal → string (BACKEND_RULES §6); ostale cenovne kolone artikla su
      // legacy `Float` i ostaju brojevi (zatečena šema, ne dira se odavde).
      wholesalePrice: decimalToString(r.wholesalePrice),
      retailPrice: decimalToString(r.retailPrice),
      fxSalePrice: decimalToString(r.fxSalePrice),
      group: codeRef(r.groupCode, groups),
      subgroup: codeRef(r.subgroupCode, subgroups),
      origin: codeRef(r.originCode, origins),
      // Kolona „ID" prikazuje BigBit šifru artikla (`externalItemId`), koja je za
      // artikal nastao u 4.0 uvek 0. Bez ove oznake UI ne može da razlikuje „nema
      // BigBit porekla" od „BigBit šifra je baš 0" i prikazao bi golu nulu.
      native: isNativeItemId(r.id),
    }));

    return { data, meta: pageMeta(page, pageSize, total) };
  }

  /**
   * `where` iz filtera BigBit pregleda. Async je zbog jednog jedinog filtera
   * (`duplicateCatalogNumbers`), koji traži podupit — sve ostalo je čisto parsiranje.
   * Redosled je nameran: svi 400-ovi (loš `active`, `rasterId` koji nije broj…) padaju
   * PRE nego što se otvori podupit, da neispravan zahtev ne plati skupu agregaciju.
   */
  private async buildListWhere(
    query: ListItemsQuery,
  ): Promise<Prisma.ItemWhereInput> {
    const where: Prisma.ItemWhereInput = {};

    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { catalogNumber: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
        { barCode: { contains: q, mode: "insensitive" } },
        { externalCode: { contains: q, mode: "insensitive" } },
      ];
    }

    const groupCode = query.groupCode?.trim();
    if (groupCode) where.groupCode = groupCode;
    const subgroupCode = query.subgroupCode?.trim();
    if (subgroupCode) where.subgroupCode = subgroupCode;
    const originCode = query.originCode?.trim();
    if (originCode) where.originCode = originCode;

    // BigBit `Like "<uneto>*"` = PREFIKS, ne „sadrži". Kataloški brojevi su
    // petocifreni sa vodećim nulama (`00001`…), pa se traži „sve od 004…".
    const catalogNumber = query.catalogNumber?.trim();
    if (catalogNumber)
      where.catalogNumber = { startsWith: catalogNumber, mode: "insensitive" };

    const name = query.name?.trim();
    if (name) where.name = { contains: name, mode: "insensitive" };

    const rasterId = parseIntParam(query.rasterId, "rasterId");
    if (rasterId !== undefined) where.rasterId = rasterId;
    const qualityTypeId = parseIntParam(query.qualityTypeId, "qualityTypeId");
    if (qualityTypeId !== undefined) where.qualityTypeId = qualityTypeId;

    const active = parseBoolParam(query.active, "active");
    if (active !== undefined) where.active = active;

    const duplicates = parseBoolParam(
      query.duplicateCatalogNumbers,
      "duplicateCatalogNumbers",
    );
    if (duplicates) {
      // Ide u `AND`, a ne u `where.catalogNumber`, jer se sme kombinovati sa
      // prefiks filterom („duple, a počinju sa 004") — dva uslova nad istom
      // kolonom u jednom filter objektu bi se pregazila.
      where.AND = [
        { catalogNumber: { in: await this.duplicateCatalogNumbers() } },
      ];
    }

    return where;
  }

  /**
   * Kataloški brojevi koji se u `items` pojavljuju više puta (BigBit toggle
   * „Prikaži artikle sa duplim kataloškim brojem" / `DugmeMTDupliKatBrojevi`, koji
   * u Access-u pravi privremenu tabelu).
   *
   * Prazan rezultat namerno prolazi dalje kao `in: []` → 0 redova: to JESTE tačan
   * odgovor („nema duplih"), dok bi izostavljanje filtera prikazalo sve artikle i
   * ostavilo utisak da su svi duplirani.
   */
  private async duplicateCatalogNumbers(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ catalog_number: string }[]>(
      Prisma.sql`
        SELECT catalog_number
          FROM items
         GROUP BY catalog_number
        HAVING COUNT(*) > 1
         ORDER BY catalog_number
         LIMIT ${Prisma.raw(String(DUPLICATE_CATALOG_LIMIT))}`,
    );
    return rows.map((r) => r.catalog_number);
  }

  /**
   * Šifarnici za padajuće liste pregleda i forme — jedan poziv umesto pet, jer se
   * na otvaranju ekrana pune svi combo-boxovi odjednom (BigBit ih drži kao
   * RowSource upite na samoj formi).
   *
   * `subgroups` nose `parentGroup`, a `origins` `subgroupCode` — bez njih frontend ne
   * može da napravi KASKADU koju BigBit ima (`FilterZaGrupu_AfterUpdate`: izbor grupe
   * suzi podgrupe, izbor podgrupe suzi PodPodgrupe). Kaskada se računa na klijentu iz
   * ovog jednog odgovora, da promena grupe ne bi vukla nov HTTP poziv po kucanju.
   *
   * ⚠️ `item_groups`/`item_subgroups`/`item_origins` su DANAS PRAZNI (nema syncera za
   * `R_Grupa`/`R_Podgrupa`/`R_Poreklo` — BIGBIT_ARTIKLI.md §2.1). Prazna lista je zato
   * OČEKIVAN odgovor, ne greška: UI tada nudi slobodan unos šifre, kao i do sada.
   */
  async lookups() {
    const [
      groups,
      subgroups,
      origins,
      qualityTypes,
      rasters,
      taxRates,
      units,
      manufacturers,
      countries,
    ] = await Promise.all([
      this.prisma.itemGroup.findMany({
        select: { code: true, description: true },
        orderBy: { code: "asc" },
      }),
      this.prisma.itemSubgroup.findMany({
        select: { code: true, description: true, parentGroup: true },
        orderBy: { code: "asc" },
      }),
      this.prisma.itemOrigin.findMany({
        select: { code: true, description: true, subgroupCode: true },
        orderBy: { code: "asc" },
      }),
      this.prisma.itemQualityType.findMany({
        select: { id: true, code: true, description: true },
        orderBy: { code: "asc" },
      }),
      this.prisma.itemRaster.findMany({
        select: {
          id: true,
          name: true,
          description: true,
          widthMm: true,
          lengthMm: true,
        },
        orderBy: { name: "asc" },
      }),
      this.prisma.taxRate.findMany({
        select: TAX_RATE_SELECT,
        orderBy: { code: "asc" },
      }),
      this.distinctItemValues("unit"),
      this.distinctItemValues("manufacturer"),
      this.distinctItemValues("origin_country"),
    ]);

    return {
      data: {
        groups,
        subgroups,
        origins,
        qualityTypes,
        rasters,
        // BigBit combo tarife prikazuje ZBIRNU stopu, ne pet komponenti
        // (RowSource: `Tarifa, [Osnovna stopa]+[Zeleznica]+…`).
        taxRates: taxRates.map((r) => ({
          code: r.code,
          description: r.description,
          totalRate: sumTaxRate(r),
        })),
        units,
        manufacturers,
        countries,
      },
    };
  }

  /**
   * Različite vrednosti jedne kolone artikla — jedinica mere, proizvođač i zemlja
   * porekla NEMAJU šifarnik ni u BigBit-u; tamošnji combo se puni sa
   * `SELECT … FROM R_Artikli GROUP BY …`, pa se isto radi i ovde.
   *
   * ⚠️ Ime kolone dolazi ISKLJUČIVO iz ovog zatvorenog spiska (tri gotova `Prisma.sql`
   * literala), NIKAD iz zahteva. Ovo je jedino mesto u modulu gde bi sirov SQL mogao
   * da primi ime kolone spolja — a ne prima ga: parametar je unija tri literala, pa
   * ni greškom nema šta da se ušije u upit.
   */
  private async distinctItemValues(
    column: keyof typeof DISTINCT_VALUE_SQL,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ value: string }[]>(
      DISTINCT_VALUE_SQL[column],
    );
    return rows.map((r) => r.value);
  }

  /**
   * Sva polja artikla + sve što forma „Unos artikala" PRIKAZUJE pored šifre:
   * nazivi grupe/podgrupe/porekla, naziv dimenzije (`rasterName`) i kvaliteta
   * (`qualityName`), i zbirne PDV stope za robu i usluge.
   */
  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({ where: { id } });
    if (!item) throw new NotFoundException(`Artikal ${id} ne postoji`);

    const [
      groups,
      subgroups,
      origins,
      raster,
      quality,
      goodsTaxTotalRate,
      serviceTaxTotalRate,
    ] = await Promise.all([
      this.resolveGroups([item.groupCode]),
      this.resolveSubgroups([item.subgroupCode]),
      this.resolveOrigins([item.originCode]),
      // ⚠️ `0` SE NE PRESKAČE. Za brojčane šifre 0 NIJE sentinel „nije zadato":
      // `item_quality_types` ima red `id = 0` sa doslovnim BigBit opisom
      // („NE TREBA KVAKITET" — tipfeler je u izvoru), i BigBit ga prikazuje u
      // combo-u. Pravilo je zato „pitaj šifarnik", a ne „pogodi sentinel": kad reda
      // nema, `findUnique` vrati null i polje ostane prazno — isti ishod, bez
      // pretpostavke. (Za TEKSTUALNE kodove sentinel `"0"` postoji i poštuje se —
      // v. `isRealCode`.)
      item.rasterId !== null && item.rasterId !== undefined
        ? this.prisma.itemRaster.findUnique({
            where: { id: item.rasterId },
            select: { name: true },
          })
        : null,
      item.qualityTypeId !== null && item.qualityTypeId !== undefined
        ? this.prisma.itemQualityType.findUnique({
            where: { id: item.qualityTypeId },
            select: { code: true },
          })
        : null,
      this.totalTaxRate(item.goodsTaxRateCode),
      this.totalTaxRate(item.serviceTaxRateCode),
    ]);

    // Decimal → string u JSON-u (BACKEND_RULES §6). Ostale novčane kolone su u
    // legacy portu `Float` (BigBit `Double`) i ostaju brojevi — to je zatečena
    // šema, ne menja se iz read-only modula.
    const { manualMarkupPercent, ...rest } = item;
    const data = {
      ...rest,
      manualMarkupPercent: manualMarkupPercent?.toString() ?? null,
      group: codeRef(item.groupCode, groups),
      subgroup: codeRef(item.subgroupCode, subgroups),
      origin: codeRef(item.originCode, origins),
      /** BigBit combo „Dimenzija (mm)" — `RasterDefZag.RasterNaziv`. */
      rasterName: raster?.name ?? null,
      /** BigBit combo „Kvalitet artikla" — `R_KvalitetArtikla.KvalitetArtikal`. */
      qualityName: quality?.code ?? null,
      /** BigBit polje `RobaZbirnaStopa` (%) uz tarifu robe. */
      goodsTaxTotalRate,
      /** BigBit polje `UslugeZbirnaStopa` (%) uz tarifu usluga. */
      serviceTaxTotalRate,
      native: isNativeItemId(item.id),
    };
    return { data };
  }

  /**
   * ZBIRNA PDV STOPA ZA ŠIFRU TARIFE — BigBit `RobaZbirnaStopa`/`UslugeZbirnaStopa`.
   *
   * Forma ne prikazuje pet komponenti nego njihov zbir (RowSource combo-a:
   * `[Osnovna stopa]+[Zeleznica]+[Gradska]+[Ratna]+[Posebna]`). Komponente su
   * istorijske (železnička/gradska/ratna taksa) i danas su po pravilu nule, ali se
   * sabiraju sve — ne pretpostavlja se da je zbir jednak osnovnoj stopi.
   *
   * `null` (a ne 0) kad tarife nema u registru: `tax_rates` je na produkciji prazna
   * (v. `assertCodebookRefs`), a nula bi na ekranu značila „stopa je 0%" — što je
   * poslovno pogrešna tvrdnja, ne prazno polje.
   */
  private async totalTaxRate(code: string | null | undefined) {
    if (!isRealCode(code)) return null;
    const rate = await this.prisma.taxRate.findUnique({
      where: { code: code.trim() },
      select: TAX_RATE_SELECT,
    });
    return rate ? sumTaxRate(rate) : null;
  }

  // ─────────────────────────────────────────────────────────── unos / izmena ──

  /**
   * Nov artikal (4.0-native). Redosled je namerno ovakav:
   *   1. brana upisa (stanje sistema — 409, pre svake druge poruke),
   *   2. validacija polja (400 sa spiskom svih grešaka odjednom),
   *   3. provera šifarnika i kataloškog broja (400/409 sa jasnim razlogom),
   *   4. upis pod `pg_advisory_xact_lock` sa id-em iz native opsega.
   *
   * BigBit forma sama dodeljuje sledeći kataloški broj i sledeći PLU
   * (`NajveciKatBroj`, `SledeciPLU` — BIGBIT_ARTIKLI.md §4.8). MI TO NE RADIMO:
   * BigBit ostaje vlasnik numeracije i dodelio bi isti sledeći broj svom artiklu,
   * pa bi dva sistema proizvela isti kataloški broj — istu grešku koju je paritet-
   * guard morao da leči kod predmeta. Zato je kataloški broj OBAVEZAN ULAZ.
   */
  async create(dto: CreateItemDto, user: AuthUser) {
    assertItemWritesAllowed();
    validateCreateItem(dto);
    await this.assertCodebookRefs(dto, null);

    const catalogNumber = dto.catalogNumber.trim();
    await this.assertCatalogNumberFree(catalogNumber, null);

    const columns = toItemColumns(dto);
    applyRasterWeight(columns, dto, null);

    const created = await this.runGuarded(catalogNumber, () =>
      this.prisma.$transaction(async (tx) => {
        // Serijalizuje dodelu id-a: `MAX(id)+1` bez brave daje isti id dvema
        // paralelnim transakcijama (isti obrazac kao `document-print.service`).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('items_native_id'))`;
        const id = await nextNativeItemId(tx);
        return tx.item.create({
          data: {
            ...columns,
            id,
            // MARKER POREKLA — bez njega upis fizički ne prolazi.
            // `chk_items_native_id_range` traži `(source='NATIVE') = (id >= 900000000)`,
            // a kolona ima DB default `'BIGBIT'`. Red se pravi sa id-jem iz native
            // opsega, pa bi bez ovog polja CHECK bio prekršen i baza vratila 23514 —
            // koji `runGuarded` ne prepoznaje (hvata samo duplikat kataloškog broja),
            // pa bi korisnik dobio 500 sa sirovim engleskim tekstom baze. Dakle: unos
            // ne bi radio NIJEDNOM, i to tek na dan preklapanja prekidača.
            // (Adversarni pregled 28.07.2026, KRITIČNO — dokazano izvršavanjem.)
            source: NATIVE_ITEM_SOURCE,
            // 0 = „nema BigBit porekla" (`BBSifra artikla` ne postoji za native red).
            externalItemId: 0,
            signature: signatureFor(user),
            createdAt: new Date(),
          } as unknown as Prisma.ItemUncheckedCreateInput,
          select: { id: true },
        });
      }),
    );

    return this.findOne(created.id);
  }

  /**
   * Izmena artikla — SAMO nad 4.0-native redom. BigBit-origin red se odbija sa 409:
   * sve 68 kolona modela su u sync mapi, pa bi svaka izmena nestala pri sledećem
   * uvozu (i to tiho, danima kasnije — najgori oblik kvara).
   */
  async update(id: number, dto: UpdateItemDto, user: AuthUser) {
    assertItemWritesAllowed();

    const existing = await this.prisma.item.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Artikal ${id} ne postoji`);
    assertItemIsNative(existing);

    validateUpdateItem(dto, existing.thickness ?? null);
    await this.assertCodebookRefs(dto, existing);

    const catalogNumber =
      dto.catalogNumber !== undefined ? dto.catalogNumber.trim() : null;
    if (catalogNumber !== null)
      await this.assertCatalogNumberFree(catalogNumber, id);

    const columns = toItemColumns(dto);
    applyRasterWeight(columns, dto, existing.thickness ?? null);
    // `PotpisArt` — ko je poslednji dirao slog (BigBit `PotpisiArt`, §4.8).
    columns.signature = signatureFor(user);

    await this.runGuarded(catalogNumber ?? existing.catalogNumber, () =>
      this.prisma.item.update({
        where: { id },
        data: {
          ...(columns as unknown as Prisma.ItemUncheckedUpdateInput),
          // TRAG IZMENE. Kolone su stigle migracijom 20260728170000; bez ovog
          // upisa stajale bi prazne, a kod bi tvrdio trag koji ne postoji — što
          // je gore nego da ih nema, jer se na njih računa pri svakom pitanju
          // „ko je ovo promenio". Vreme je vreme UPISA (server), ne sa ekrana.
          updatedAt: new Date(),
          updatedBy: signatureFor(user),
        },
        select: { id: true },
      }),
    );

    return this.findOne(id);
  }

  /**
   * Sirova greška iz brane `guard_catalog_unique` → srpska poruka.
   * (Migracija `20260725230000_katbroj_brana`: `RAISE EXCEPTION
   * 'CATALOG_NUMBER_DUPLICATE: …' USING ERRCODE = 'unique_violation'`.)
   */
  private async runGuarded<T>(
    catalogNumber: string,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (isCatalogDuplicateError(e)) throw catalogDuplicateException(catalogNumber);
      throw e;
    }
  }

  /**
   * Provera kataloškog broja PRE upisa — da korisnik dobije poruku sa imenom
   * postojećeg artikla umesto gole greške baze. Nije zamena za branu (trka između
   * provere i upisa ostaje na trigeru), nego bolji tekst u 99% slučajeva.
   */
  private async assertCatalogNumberFree(
    catalogNumber: string,
    selfId: number | null,
  ) {
    const clash = await this.prisma.item.findFirst({
      where: {
        catalogNumber: { equals: catalogNumber, mode: "insensitive" },
        ...(selfId !== null ? { id: { not: selfId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (clash)
      throw catalogDuplicateException(catalogNumber);
  }

  /**
   * Grupa / podgrupa / poreklo / tarife / dobavljač se BIRAJU IZ ŠIFARNIKA, ne kucaju.
   *
   * Kvaka: `item_groups`/`item_subgroups`/`item_origins` su DANAS PRAZNI (nema
   * syncera za `R_Grupa`/`R_Podgrupa`/`R_Poreklo` — BIGBIT_ARTIKLI.md §7 gap #1).
   * Tvrda provera bi zato odbila SVAKI unos. Pravilo: šifarnik koji ima bar jedan
   * red se poštuje tvrdo; prazan šifarnik se preskače (i to je razlog zašto ta tri
   * syncera imaju prioritet „VISOK, odmah").
   *
   * Kaskada Grupa → Podgrupa → Poreklo (BigBit combo-boxovi, §4.9) se proverava tek
   * kad šifarnik ume da je potvrdi. `"0"` je BigBit sentinel za „nije zadato".
   */
  private async assertCodebookRefs(
    dto: ItemWriteFields,
    existing: {
      groupCode: string;
      subgroupCode: string;
      originCode: string;
    } | null,
  ) {
    const errors: string[] = [];
    const eff = {
      groupCode: effectiveCode(dto.groupCode, existing?.groupCode),
      subgroupCode: effectiveCode(dto.subgroupCode, existing?.subgroupCode),
      originCode: effectiveCode(dto.originCode, existing?.originCode),
    };

    if (
      dto.groupCode !== undefined ||
      dto.subgroupCode !== undefined ||
      dto.originCode !== undefined
    ) {
      const [group, subgroup, origin] = await Promise.all([
        this.lookupCode(this.prisma.itemGroup, eff.groupCode),
        this.lookupCode(this.prisma.itemSubgroup, eff.subgroupCode),
        this.lookupCode(this.prisma.itemOrigin, eff.originCode),
      ]);

      if (group === "MISSING")
        errors.push(`Grupa „${eff.groupCode}” ne postoji u šifarniku grupa.`);
      if (subgroup === "MISSING")
        errors.push(
          `Podgrupa „${eff.subgroupCode}” ne postoji u šifarniku podgrupa.`,
        );
      if (origin === "MISSING")
        errors.push(`Poreklo „${eff.originCode}” ne postoji u šifarniku porekla.`);

      const subgroupRow =
        subgroup !== "MISSING" && subgroup !== "SKIPPED" ? subgroup : null;
      if (
        subgroupRow &&
        "parentGroup" in subgroupRow &&
        isRealCode(subgroupRow.parentGroup) &&
        eff.groupCode !== null &&
        subgroupRow.parentGroup !== eff.groupCode
      )
        errors.push(
          `Podgrupa „${eff.subgroupCode}” pripada grupi „${subgroupRow.parentGroup}”, a izabrana je grupa „${eff.groupCode}”.`,
        );

      const originRow =
        origin !== "MISSING" && origin !== "SKIPPED" ? origin : null;
      if (
        originRow &&
        "subgroupCode" in originRow &&
        isRealCode(originRow.subgroupCode) &&
        eff.subgroupCode !== null &&
        originRow.subgroupCode !== eff.subgroupCode
      )
        errors.push(
          `Poreklo „${eff.originCode}” pripada podgrupi „${originRow.subgroupCode}”, a izabrana je podgrupa „${eff.subgroupCode}”.`,
        );
    }

    // ⚠️ ULAZNA PROVERA TARIFE JE VEZANA ZA MAPU, NE ZA PRAZNU TABELU (nalaz S3).
    // Do 02.08.2026. je ovde stajalo `if (total === 0) continue` — a `tax_rates` je na
    // produkciji PRAZNA (0 redova, v. N1-a), pa je provera bila POTPUNO ISKLJUČENA:
    // artikal je mogao da dobije šifru „18" ili „99" i da uđe u šifarnik. Odatle je
    // šifra išla u svaki dokument koji taj artikal koristi.
    //
    // Zato je merodavan spisak `KNOWN_VAT_CODES` — IZVEDEN iz iste mape iz koje svaki
    // potrošač uzima stopu. Registar `tax_rates`, kad se popuni (N1-a), ostaje DODATNA
    // provera: šifra mora biti i poznata mapi i prisutna u registru.
    for (const [value, label] of [
      [dto.goodsTaxRateCode, "Tarifa robe"],
      [dto.serviceTaxRateCode, "Tarifa usluga"],
    ] as const) {
      const code = effectiveCode(value, undefined);
      if (value === undefined || code === null) continue;
      if (!KNOWN_VAT_CODES.has(code)) {
        errors.push(`${label}: ${unknownVatCodeMessage(code)}`);
        continue;
      }
      const total = await this.prisma.taxRate.count();
      if (total === 0) continue;
      const row = await this.prisma.taxRate.findFirst({
        where: { code },
        select: { code: true },
      });
      if (!row)
        errors.push(`${label} „${code}” ne postoji u šifarniku poreskih tarifa.`);
    }

    if (dto.supplierId !== undefined && dto.supplierId > 0) {
      const total = await this.prisma.customer.count();
      if (total > 0) {
        const supplier = await this.prisma.customer.findUnique({
          where: { id: dto.supplierId },
          select: { id: true },
        });
        if (!supplier)
          errors.push(`Dobavljač ${dto.supplierId} ne postoji u šifarniku komitenata.`);
      }
    }

    if (errors.length) throw new BadRequestException(errors);
  }

  /**
   * `SKIPPED` = kod nije zadat ili je šifarnik prazan (ne proveravamo);
   * `MISSING`  = šifarnik postoji, koda u njemu nema; inače vraćen red.
   */
  private async lookupCode<T extends { code: string }>(
    delegate: {
      count: () => Promise<number>;
      findUnique: (args: { where: { code: string } }) => Promise<T | null>;
    },
    code: string | null,
  ): Promise<T | "SKIPPED" | "MISSING"> {
    if (code === null) return "SKIPPED";
    const total = await delegate.count();
    if (total === 0) return "SKIPPED";
    const row = await delegate.findUnique({ where: { code } });
    return row ?? "MISSING";
  }

  // --- batch resolveri šifarnika (prazan šifarnik → description null, ne 500) ---

  private async resolveGroups(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemGroup.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }

  private async resolveSubgroups(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemSubgroup.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }

  private async resolveOrigins(codes: (string | null | undefined)[]) {
    const uniq = uniqueCodes(codes);
    if (!uniq.length) return new Map<string, string>();
    return byCode(
      await this.prisma.itemOrigin.findMany({
        where: { code: { in: uniq } },
        select: { code: true, description: true },
      }),
    );
  }
}

/**
 * Zbir pet komponenti poreske stope (BigBit „zbirna stopa"). Kolone su legacy
 * `Float`, pa se zbir zaokružuje na 6 decimala — `8.5 + 0.5` u binarnom zapisu ume
 * da ispadne `9.000000000000002`, a to bi korisnik video baš tako na ekranu.
 */
function sumTaxRate(rate: {
  baseRate: number | null;
  railwayRate: number | null;
  cityRate: number | null;
  warRate: number | null;
  specialRate: number | null;
}): number {
  const sum =
    (rate.baseRate ?? 0) +
    (rate.railwayRate ?? 0) +
    (rate.cityRate ?? 0) +
    (rate.warRate ?? 0) +
    (rate.specialRate ?? 0);
  return Math.round(sum * 1e6) / 1e6;
}

/** Decimal → string (BACKEND_RULES §6); prazno ostaje prazno, ne postaje "0". */
function decimalToString(
  value: Prisma.Decimal | null | undefined,
): string | null {
  return value === null || value === undefined ? null : value.toString();
}

/** BigBit sentinel „nije zadato" je `"0"` (a ne NULL) — v. `@default("0")` u šemi. */
function isRealCode(code: string | null | undefined): code is string {
  return typeof code === "string" && code.trim() !== "" && code.trim() !== "0";
}

/** Vrednost koja će stvarno stajati u koloni posle ovog zahteva. */
function effectiveCode(
  sent: string | null | undefined,
  existing: string | null | undefined,
): string | null {
  const value = sent !== undefined ? sent : existing;
  return isRealCode(value) ? value.trim() : null;
}

/**
 * Sledeći id iz NATIVE opsega. Zove se pod `pg_advisory_xact_lock` — bez brave dve
 * paralelne transakcije dobiju isti broj. `::int` kastovi su obavezni: bez njih
 * Prisma vezuje JS broj kao `bigint`, pa izraz pređe u `bigint` i vrati `BigInt`.
 */
async function nextNativeItemId(tx: Prisma.TransactionClient): Promise<number> {
  const rows = await tx.$queryRaw<{ next_id: number | bigint }[]>`
    SELECT COALESCE(MAX(id), ${NATIVE_ITEM_ID_BASE - 1}::int) + 1 AS next_id
    FROM items
    WHERE id >= ${NATIVE_ITEM_ID_BASE}::int`;
  const next = Number(rows[0]?.next_id ?? NATIVE_ITEM_ID_BASE);
  if (!Number.isInteger(next) || next < NATIVE_ITEM_ID_BASE)
    throw new Error(`Neispravan id iz native opsega: ${String(next)}`);
  if (next > NATIVE_ITEM_ID_MAX)
    throw new BadRequestException(
      "Opseg šifara za artikle unete u ServoSync-u je popunjen — javite administratoru.",
    );
  return next;
}

/**
 * Obračun kg/kom iz dimenzija table (BIGBIT_ARTIKLI.md §4.10) — rezultat u `box`,
 * tačno kao BigBit dugme `DugmePreracunajTezinuUKomadu`. Dimenzije se NE ČUVAJU
 * (nema `RasterDef*` tabela), pa se pri sledećoj izmeni unose ponovo.
 */
function applyRasterWeight(
  columns: Record<string, string | number | boolean | Prisma.Decimal | null>,
  dto: ItemWriteFields & RasterWeightInput,
  existingThickness: number | null,
): void {
  if (dto.rasterWidthMm === undefined || dto.rasterLengthMm === undefined) return;
  const thickness = dto.thickness ?? existingThickness;
  if (thickness === null || thickness === undefined) return;
  const kg = computeKilogramsPerPiece(
    thickness,
    dto.rasterWidthMm,
    dto.rasterLengthMm,
  );
  if (kg !== null) columns.box = kg;
}

/** `PotpisArt` Text(50) — ko je poslednji dirao slog. */
function signatureFor(user: AuthUser): string {
  return (user.email || String(user.userId)).slice(0, 50);
}

/** Jedinstveni neprazni kodovi za `WHERE code IN (...)`. */
function uniqueCodes(codes: (string | null | undefined)[]): string[] {
  return [
    ...new Set(
      codes.filter((c): c is string => typeof c === "string" && c !== ""),
    ),
  ];
}

function byCode(rows: { code: string; description: string }[]) {
  return new Map(rows.map((r) => [r.code, r.description]));
}

/** `{ code, description }`; kod bez reda u šifarniku → `description: null`. */
function codeRef(
  code: string | null | undefined,
  descriptions: Map<string, string>,
): CodeRef | null {
  if (!code) return null;
  return { code, description: descriptions.get(code) ?? null };
}
