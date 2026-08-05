import { BadRequestException } from "@nestjs/common";
import { parseBoolParam, parseIntParam } from "./list-items.dto";

/**
 * Filteri „drugog pregleda artikala" — LAGER LISTA i KARTICE ARTIKLA.
 *
 * Query stiže kao stringovi; parsiranje/validacija je ovde, servis dobija čiste
 * vrednosti (isti obrazac kao `list-items.dto.ts`: interface + ručne `parse*()`,
 * bez class-validator-a — BACKEND_RULES §6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ŠTA JE OVO, DA SE NE BI ČITALO KAO 4.0 MODUL
 * ─────────────────────────────────────────────────────────────────────────────
 * Robno se do cutover-a (april 2027) vodi ISKLJUČIVO u BigBit-u. 4.0 native
 * tabele (`stock_documents`, `stock_levels`, `stock_reservations`,
 * `purchase_orders`) su na produkciji PRAZNE. Sve ispod čita `*_mirror` tabele
 * koje puni noćni `.mdb` uvoz — dakle READ-ONLY OGLEDALO, bez ijedne mutacije.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 DVE GRANICE KOJE SE NE VIDE IZ PODATAKA, A MENJAJU ODGOVOR
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. POSLOVNA GODINA. BigBit svaku godinu otvara sopstvenim „Donosom po popisu"
 *    (vrsta POPIS, `Ulaz = True`), a uvoz ništa ne briše — pa ogledalo posle
 *    01.01. drži DVE godine odjednom. Prost zbir bi tada UDVOSTRUČIO stanje.
 *    Zato svaki upit ispod SEČE PO GODINI; podrazumevana je poslednja zatečena
 *    (`meta.year` + `meta.yearSource` je uvek u odgovoru, da ekran može da je
 *    ispiše i da korisnik nikad ne gleda „neku" godinu ne znajući koju).
 *
 * 2. REZERVACIJE SE U BigBit-u NE GASE. Mereno 05.08.2026 nad
 *    `_legacy/BB_T_26_11-07-26.mdb`: 1.576 rezervacionih dokumenata ide od 2013.
 *    do 2026., a samo 49 ih je iz 2026. Zbir po godinama ≈ 2023: 121.058 ·
 *    2024: 515.063 · 2025: 375.188 · 2026: 71.361 (2017–2022 se ponište u nulu);
 *    ukupno ≈ 1,08 M jedinica prema ≈ 71 k tekuće godine. Da se rezervacije ne
 *    seku po godini, kolona SLOBODNO bi pokazivala masovnu prezauzetost —
 *    i to bi izgledalo kao tačan podatak. Podrazumevano je zato `year`;
 *    `reservationScope=all` daje pun BigBit zbir za onoga ko baš to traži.
 *    ⚠️ Ovo je PODRAZUMEVANA VREDNOST, a ne presuđena odluka vlasnika —
 *    odsecanje starih rezervacija u samom BigBit-u je i dalje otvoreno pitanje.
 */
export interface ListLagerQuery {
  page?: string;
  pageSize?: string;
  /** Kolona sorta iz `LAGER_SORT_COLUMNS`; izostavljeno = kataloški broj rastuće. */
  sort?: string;
  /** `asc` (podrazumevano) ili `desc`. */
  dir?: string;
  /** Objedinjena pretraga: kataloški broj / naziv (case-insensitive `contains`). */
  q?: string;
  /** Magacin (`goods_document_items_mirror.warehouse_id`) — tačno poklapanje. */
  warehouseId?: string;
  /** Šifra grupe artikla (`items.group_code`) — tačno poklapanje. */
  groupCode?: string;
  /** `true` (PODRAZUMEVANO) = samo redovi sa stanjem različitim od nule. */
  onlyWithStock?: string;
  /** `true` = samo redovi sa NEGATIVNIM stanjem (radna lista za ispravke). */
  onlyNegative?: string;
  /** Poslovna godina; izostavljeno = poslednja zatečena u ogledalu. */
  year?: string;
  /** `year` (podrazumevano) ili `all` — v. tačku 2 u zaglavlju. */
  reservationScope?: string;
}

/** Zajedničko za sve tri kartice artikla. */
export interface ItemCardQuery {
  /** Poslovna godina; izostavljeno = poslednja zatečena u ogledalu. */
  year?: string;
  /** Period OD (ISO `YYYY-MM-DD`) — po datumu knjiženja, pad na datum isprave. */
  from?: string;
  /** Period DO (ISO `YYYY-MM-DD`), uključivo. */
  to?: string;
}

export interface GoodsCardQuery extends ItemCardQuery {
  /** Magacin (sa STAVKE) — tačno poklapanje. */
  warehouseId?: string;
}

export interface OrdersCardQuery extends ItemCardQuery {
  page?: string;
  pageSize?: string;
  /** `true` = samo neisporučene stavke trebovanja. */
  onlyOpen?: string;
}

export interface ProformaCardQuery extends ItemCardQuery {
  page?: string;
  pageSize?: string;
  /** Magacin (sa STAVKE) — tačno poklapanje. */
  warehouseId?: string;
  /** `true` = samo dokumenti koji rezervišu robu (`Rezervisi`). */
  onlyReservations?: string;
  /** Vrsta dokumenta (BigBit `Vrsta dokumenta`, npr. `PON`, `PROF`, `REZM`). */
  documentType?: string;
}

/**
 * KOLONE PO KOJIMA SE SME SORTIRATI — ZATVOREN SPISAK (isti razlog kao
 * `ITEM_SORT_COLUMNS`): ime kolone iz zahteva završi u `ORDER BY`, a upit je
 * ovde raw SQL, pa je allowlist jedina brana. Spisak je tačno skup kolona koje
 * lista PRIKAZUJE — sortira se po onome što stoji u zaglavlju kolone.
 *
 * `warehouse` sortira po NAZIVU magacina, ne po njegovom broju: broj se na
 * ekranu nigde ne vidi, pa bi sort po njemu izgledao kao nasumičan redosled.
 */
export const LAGER_SORT_COLUMNS = [
  "catalogNumber",
  "name",
  "unit",
  "shelf",
  "groupCode",
  "warehouse",
  "stock",
  "reserved",
  "free",
  "wholesalePrice",
] as const;

export type LagerSortColumn = (typeof LAGER_SORT_COLUMNS)[number];
export type LagerSortDirection = "asc" | "desc";

export interface LagerSort {
  column: LagerSortColumn;
  direction: LagerSortDirection;
}

/**
 * `?sort=<kolona>&dir=asc|desc` → `{ column, direction }`; bez `sort` →
 * `undefined` (podrazumevani redosled).
 *
 * Nepoznata kolona je 400 SA SPISKOM dozvoljenih, a ne tiho vraćanje na
 * podrazumevani redosled — inače korisnik koji traži „gde mi je najveći minus"
 * dobije prvih 50 redova po kataloškom broju i pročita ih kao odgovor.
 */
export function parseLagerSort(
  sort: string | undefined,
  dir: string | undefined,
): LagerSort | undefined {
  const direction = parseLagerSortDirection(dir);
  const column = sort?.trim();
  if (!column) return undefined;
  if (!(LAGER_SORT_COLUMNS as readonly string[]).includes(column))
    throw new BadRequestException(
      `Sortiranje po koloni '${column}' nije podržano. Dozvoljene kolone: ${LAGER_SORT_COLUMNS.join(", ")}.`,
    );
  return { column: column as LagerSortColumn, direction };
}

function parseLagerSortDirection(dir: string | undefined): LagerSortDirection {
  const value = dir?.trim();
  if (!value) return "asc";
  if (value === "asc" || value === "desc") return value;
  throw new BadRequestException(
    `Parametar 'dir' mora biti 'asc' ili 'desc' (dobijeno: '${value}').`,
  );
}

/** Domet rezervacija: tekuća poslovna godina ili SVE godine iz BigBita. */
export type ReservationScope = "year" | "all";

/**
 * `?reservationScope=year|all`; odsutno → `year`. Pogrešna vrednost je 400, ne
 * tiho `year`: razlika između ta dva odgovora je ≈ 1,08 M prema ≈ 71 k jedinica
 * rezervisano, tj. cela kolona SLOBODNO.
 */
export function parseReservationScope(
  value: string | undefined,
): ReservationScope {
  const trimmed = value?.trim();
  if (!trimmed) return "year";
  if (trimmed === "year" || trimmed === "all") return trimmed;
  throw new BadRequestException(
    `Parametar 'reservationScope' mora biti 'year' ili 'all' (dobijeno: '${trimmed}').`,
  );
}

/**
 * Poslovna godina iz `?year=`; odsutno → `undefined` (servis uzima poslednju
 * zatečenu). Opseg je namerno uzak: `year=0` ili `year=20261` je greška u
 * pozivu, a tiho bi vratilo praznu listu koja izgleda kao „nema zaliha".
 */
export function parseYearParam(value: string | undefined): number | undefined {
  const year = parseIntParam(value, "year");
  if (year === undefined) return undefined;
  if (year < 1990 || year > 2100)
    throw new BadRequestException(
      `Parametar 'year' mora biti godina između 1990 i 2100 (dobijeno: ${year}).`,
    );
  return year;
}

/** `?onlyWithStock=` — odsutno je `true` (BigBit pregled lagera ne nudi prazne redove). */
export function parseOnlyWithStock(value: string | undefined): boolean {
  return parseBoolParam(value, "onlyWithStock") ?? true;
}

/** `?onlyNegative=` / `?onlyOpen=` / `?onlyReservations=` — odsutno je `false`. */
export function parseOptionalFlag(
  value: string | undefined,
  name: string,
): boolean {
  return parseBoolParam(value, name) ?? false;
}
