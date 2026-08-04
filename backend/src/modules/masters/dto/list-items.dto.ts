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
 */
export interface ListItemsQuery {
  page?: string;
  pageSize?: string;
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
