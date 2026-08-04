import { BadRequestException } from "@nestjs/common";

/**
 * Filteri liste artikala (`GET /api/v1/artikli`). Query stiže kao stringovi —
 * parsiranje/validacija je ovde, servis dobija čiste vrednosti.
 *
 * Obrazac: interface + ručna `parse*()` (kao `nabavka/dto/*` — class-validator
 * se u ovom repou još ne koristi za query stringove; BACKEND_RULES §6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARITET SA BigBit FORMOM „Pregled artikala"
 * ─────────────────────────────────────────────────────────────────────────────
 * Svaki filter ispod ima svog blizanca u zaglavlju BigBit forme (izvučeno iz same
 * Access baze, kontrole po x/y koordinatama). Imena kontrola su namerno zapisana —
 * ona su jedini trag do izvorne semantike („PodPodgrupa" na ekranu = kolona
 * `Poreklo` u bazi, i to se NE ISPRAVLJA u nazivu koji korisnik vidi):
 *
 *   FilterZaGrupu     → `groupCode`
 *   ZaPodgrupu        → `subgroupCode`
 *   FilterZaPoreklo   → `originCode`              (labela na ekranu: „PodPodgrupa")
 *   ZaKatBroj         → `catalogNumber`           (BigBit `Like "…*"` = PREFIKS)
 *   TraziNazivArtikla → `name`                    (deo naziva)
 *   ZaDimenziju       → `rasterId`                (labela: „Dimenzija")
 *   ZaKvalitet        → `qualityTypeId`           (labela: „Kvalitet")
 *   ZaDupleKatBrojeve → `duplicateCatalogNumbers` (toggle „Prikaži artikle sa
 *                                                  duplim kataloškim brojem")
 *
 * Svi filteri se kombinuju logičkim I; izostavljen filter = bez ograničenja.
 *
 * Tri parametra NEMAJU blizanca na BigBit formi i stižu iz 4.0 pregleda (klik na
 * zaglavlje kolone + traka filtera): `sort`/`dir`, `shelf`/`shelfPresence` i `unit`.
 * Svi su server-side nad CELIM skupom (92.592 artikla) — sortiranje/filtriranje u
 * pregledaču bi radilo samo nad učitanim stranama, pa bi „najskuplji artikal" bio
 * najskuplji među prvih 50, a to je pogrešan odgovor koji izgleda tačno.
 */
export interface ListItemsQuery {
  page?: string;
  pageSize?: string;
  /**
   * Kolona po kojoj se sortira CEO SKUP (server-side), iz `ITEM_SORT_COLUMNS`.
   * Izostavljeno = BigBit redosled pregleda (grupa → kat. broj → naziv).
   */
  sort?: string;
  /** Smer sorta: `asc` (podrazumevano kad je `sort` zadat) ili `desc`. */
  dir?: string;
  /**
   * Objedinjena pretraga: kataloški broj / naziv / barkod / eksterna šifra
   * (case-insensitive `contains`). BigBit isto traži, ali kroz tri odvojena
   * combo-boxa u zaglavlju (`TraziKataloskiBroj`, `TraziNazivArtikla`,
   * `ComboBarKod`) — ovde je to jedno polje, jer korisnik po pravilu ne zna
   * unapred da li mu je u ruci kat. broj ili barkod.
   */
  q?: string;
  /** Šifra grupe (`R_Grupa.Grupa` → `items.group_code`) — tačno poklapanje. */
  groupCode?: string;
  /** Šifra podgrupe (`R_Podgrupa.Podgrupa` → `items.subgroup_code`) — tačno poklapanje. */
  subgroupCode?: string;
  /**
   * Šifra porekla (`R_Poreklo.Poreklo` → `items.origin_code`) — tačno poklapanje.
   * NA EKRANU SE ZOVE „PodPodgrupa" (tako piše u BigBit formi) — kod zadržava ime
   * kolone, UI zadržava ime na koje su korisnici navikli.
   */
  originCode?: string;
  /** Kataloški broj — PREFIKS (BigBit `Like "<uneto>*"`), case-insensitive. */
  catalogNumber?: string;
  /** Deo naziva (case-insensitive `contains`). */
  name?: string;
  /**
   * Jedinica mere — TAČNO poklapanje, case-insensitive (`kom`, `KOM` i `Kom` su ista
   * jedinica; vrednosti dolaze iz `lookups().units`, tj. iz samih podataka).
   *
   * Namerno NIJE prefiks kao polica/kat. broj: jedinice su zatvoren spisak kratkih
   * oznaka, pa bi „m" prefiksom povuklo i „m2" i „mm" — korisnik koji bira „m" iz
   * padajuće liste dobio bi metre kvadratne i milimetre u istoj listi i nikako ne bi
   * mogao da izabere samo „m".
   */
  unit?: string;
  /**
   * Polica — PREFIKS, case-insensitive (kao kataloški broj). Police su
   * hijerarhijske oznake tipa „A-1-3", pa upisano „A" mora da vrati ceo red A;
   * `contains` bi na „1" povukao i „B-11" i „C-21", što nije ono što se traži.
   */
  shelf?: string;
  /**
   * `with` = samo artikli koji IMAJU policu, `without` = samo oni bez nje;
   * izostavljeno = svi. Ne meša se sa `shelf` prefiksom — sme i oboje
   * („sve police koje počinju na A" je ionako podskup „sa policom").
   */
  shelfPresence?: string;
  /** Dimenzija ploče/lima (`item_rasters.id`) — ceo broj. */
  rasterId?: string;
  /** Kvalitet artikla (`item_quality_types.id`) — ceo broj. */
  qualityTypeId?: string;
  /**
   * `true` = samo artikli čiji se kataloški broj ponavlja (BigBit toggle
   * `ZaDupleKatBrojeve`). Radna lista za čišćenje duplikata, ne svakodnevni filter.
   */
  duplicateCatalogNumbers?: string;
  /** `true` / `false`; izostavljeno = i aktivni i neaktivni. */
  active?: string;
}

/**
 * KOLONE PO KOJIMA SE SME SORTIRATI — ZATVOREN SPISAK, NE „šta god stigne".
 *
 * Sort je server-side i ide nad CELIM skupom (92.592 artikla), pa ime kolone iz
 * zahteva završi u `orderBy`. Zato je spisak allowlist, a ne blacklist: bez njega bi
 * proizvoljno ime ili proizvelo Prisma grešku (500 sa engleskim tekstom baze), ili —
 * gore — otvorilo sort po koloni koju pregled uopšte ne pokazuje.
 *
 * Spisak je namerno ISTI skup kolona koje lista prikazuje (`ITEM_LIST_SELECT`), umanjen
 * za `id` (tehnički ključ; on je uvek tie-break), `alwaysTaxGoods` (PPD — checkbox) i
 * `active` (svi artikli su danas aktivni, sort bi bio no-op). Pravilo je jednostavno:
 * sortira se po onome što korisnik vidi u zaglavlju kolone.
 */
export const ITEM_SORT_COLUMNS = [
  "catalogNumber",
  "name",
  "unit",
  "shelf",
  "weight",
  "groupCode",
  "subgroupCode",
  "originCode",
  "wholesalePrice",
  "retailPrice",
  "goodsTaxRateCode",
  "thickness",
  "box",
  "fxSalePrice",
  "accountingCode",
  "accountingCode2",
  "plu",
  "externalItemId",
  "barCode",
  "externalCode",
  "foreignName",
] as const;

export type ItemSortColumn = (typeof ITEM_SORT_COLUMNS)[number];
export type SortDirection = "asc" | "desc";

/** Traženi sort liste; `undefined` = podrazumevani (BigBit) redosled. */
export interface ItemSort {
  column: ItemSortColumn;
  direction: SortDirection;
}

/**
 * `?sort=<kolona>&dir=asc|desc` → `{ column, direction }`; bez `sort` → `undefined`.
 *
 * Nepoznata kolona je 400 sa SPISKOM dozvoljenih, a ne tiho vraćanje na podrazumevani
 * redosled: korisnik bi dobio listu sortiranu drugačije nego što traži, video prvih
 * 50 redova i zaključio da je to vrh po njegovoj koloni (npr. „najskuplji artikli").
 * Isti razlog i za `dir` — `dir=nagore` ne sme tiho da postane `asc`.
 */
export function parseSortParam(
  sort: string | undefined,
  dir: string | undefined,
): ItemSort | undefined {
  const direction = parseSortDirection(dir);
  const column = sort?.trim();
  if (!column) return undefined;
  if (!(ITEM_SORT_COLUMNS as readonly string[]).includes(column))
    throw new BadRequestException(
      `Sortiranje po koloni '${column}' nije podržano. Dozvoljene kolone: ${ITEM_SORT_COLUMNS.join(", ")}.`,
    );
  return { column: column as ItemSortColumn, direction };
}

/** `?dir=` — prazno/odsutno je `asc`; sve van `asc|desc` je 400. */
function parseSortDirection(dir: string | undefined): SortDirection {
  const value = dir?.trim();
  if (!value) return "asc";
  if (value === "asc" || value === "desc") return value;
  throw new BadRequestException(
    `Parametar 'dir' mora biti 'asc' ili 'desc' (dobijeno: '${value}').`,
  );
}

/** Filter prisustva police; `undefined` = bez ograničenja (svi artikli). */
export type ShelfPresence = "with" | "without";

/**
 * `?shelfPresence=with|without` → filter; odsutno/prazno → `undefined`.
 * Kao i kod `active`, pogrešna vrednost je 400 — inače bi „bez police" tiho
 * prikazalo svih 92.592 artikla i delovalo kao da police ima svaki artikal.
 */
export function parseShelfPresence(
  value: string | undefined,
): ShelfPresence | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "with" || trimmed === "without") return trimmed;
  throw new BadRequestException(
    `Parametar 'shelfPresence' mora biti 'with' ili 'without' (dobijeno: '${trimmed}').`,
  );
}

/**
 * `?active=true|false` → boolean; odsutno/prazno → `undefined` (bez filtera).
 * Bilo šta drugo je 400, ne tiho ignorisanje — inače korisnik dobija listu koju
 * nije tražio i misli da filter radi.
 */
export function parseBoolParam(
  value: string | undefined,
  name: string,
): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new BadRequestException(
    `Parametar '${name}' mora biti 'true' ili 'false'.`,
  );
}

/**
 * `?rasterId=12` → 12; odsutno/prazno → `undefined`. Isti razlog za 400 kao gore:
 * `Number("dvanaest")` je `NaN`, a `NaN` u `where` tiho vraća praznu listu — korisnik
 * bi mislio da nema takvih artikala umesto da je pogrešio parametar.
 */
export function parseIntParam(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed))
    throw new BadRequestException(`Parametar '${name}' mora biti ceo broj.`);
  return parsed;
}
