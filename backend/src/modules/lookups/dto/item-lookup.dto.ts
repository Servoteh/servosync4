/**
 * Pretraga artikala za `CodeCombo` na ekranu unosa dokumenata
 * (PLAN_UNOS_DOKUMENATA.md §2.4, §3.3, §5.7).
 *
 * BigBit paritet: dvoklik na labelu menja `RowSource` i natpis polja
 * (`Doc__Form_Izlazna faktura - Podforma.txt:279-303`) — kod nas je to prekidač
 * ključa (`Ctrl+Space`) koji stiže kao `?key=`.
 */

/**
 * Ključevi pretrage.
 *
 * `CATALOG | BARCODE | EXT | NAME` su traženi ugovorom rute; `PLU` je peti ključ
 * iz plana (§2.4 „Kat.broj → Barkod → Ext.šifra → PLU" i §5.7 tabela ruta) — bez
 * njega bi frontend koji cikliše kroz sva četiri BigBit ključa dobio 422 na
 * poslednjem. Naziv je peti čip (§2.4: „Kolona Naziv je isto `CodeCombo`").
 */
export const ITEM_LOOKUP_KEYS = [
  "CATALOG",
  "BARCODE",
  "EXT",
  "NAME",
  "PLU",
] as const;

export type ItemLookupKey = (typeof ITEM_LOOKUP_KEYS)[number];

/** Podrazumevani ključ = kataloški broj (prvi čip u BigBit ciklusu). */
export const ITEM_LOOKUP_DEFAULT_KEY: ItemLookupKey = "CATALOG";

/**
 * Ispod ovoga se NE pretražuje: jedan znak nad ~92k artikala vraća pola šifarnika
 * i obara i bazu i tastaturni tok (§2.5 — lista sme da se otvori tek kad sužava).
 */
export const ITEM_LOOKUP_MIN_QUERY = 2;

/** Koliko redova lista nudi bez skrola (§2.4: „do 25 rezultata" za komitenta). */
export const ITEM_LOOKUP_DEFAULT_LIMIT = 20;

/** Tvrda gornja granica — typeahead se kuca na svaki pritisak tastera. */
export const ITEM_LOOKUP_MAX_LIMIT = 50;

/** Ulaz rute — sve stiže kao string iz `@Query`. */
export interface ItemLookupQuery {
  q?: string;
  key?: string;
  warehouseId?: string;
  limit?: string;
  /** `"true"` = prikaži i neaktivne artikle (obrisani se NIKAD ne prikazuju). */
  includeInactive?: string;
}

/**
 * Zalihe za jedan (artikal, magacin).
 *
 * Količine su stringovi sa 3 decimale — isti format kao `AvailabilityRow` u
 * `robno/dto/reservation.dto.ts`, jer dolaze iz ISTOG računa (`computeAvailability`).
 * Nikad `number`: količina je `Decimal(19,6)` u bazi i float bi je iskrivio.
 */
export interface ItemLookupStock {
  warehouseId: number;
  /** Stanje = Σ(±količina) iz kretanja (`stock_document_items`). */
  onHand: string;
  /** Σ otvorenih rezervacija (`stock_reservations.status = 'OPEN'`). */
  reserved: string;
  /** Ono što se sme obećati kupcu = `onHand − reserved` (može biti < 0). */
  available: string;
}

/** Jedan red liste artikala. */
export interface ItemLookupRow {
  /** Interni id (`items.id`) — ide u `invoice_items.item_id`. */
  id: number;
  /** Kataloški broj = „šifra" koju korisnik kuca (§2.5 primer „4711-02"). */
  catalogNumber: string;
  barCode: string | null;
  externalCode: string | null;
  plu: number | null;
  name: string;
  /** Jedinica mere (`items.unit`) — snapshot na stavku (§3.3). */
  unit: string | null;
  active: boolean;
  /** `false` → artikal se ne vodi na zalihama, `stock` je zato `null`, ne 0. */
  stockTracked: boolean;
  /** Šifra tarife za robu (`R_Tarife`), default „3" = 20%. */
  goodsTaxRateCode: string;
  /** Šifra tarife za usluge (`R_Tarife`), default „1". */
  serviceTaxRateCode: string;
  /** ΣStopa (%) za robu na današnji dan, npr. „20.00". */
  goodsVatRatePercent: string;
  /** ΣStopa (%) za usluge na današnji dan. */
  serviceVatRatePercent: string;
  /**
   * Zalihe u traženom magacinu.
   * `null` znači „nije traženo / ne vodi se", NIKAD „nema na stanju" — razlog je
   * u `meta.stockNote` odnosno u `stockTracked`.
   */
  stock: ItemLookupStock | null;
}

/** Omotač odgovora `{ data, meta }`. */
export interface ItemLookupResult {
  data: ItemLookupRow[];
  meta: {
    key: ItemLookupKey;
    q: string;
    limit: number;
    count: number;
    /** Ima još pogodaka od prikazanih — sužavaj upit. */
    hasMore: boolean;
    warehouseId: number | null;
    /** Odakle je zaliha izračunata; `null` kad zaliha nije tražena. */
    stockSource: string | null;
    /** Ljudska napomena na srpskom (zašto je lista prazna / zašto nema zalihe). */
    stockNote: string | null;
    note: string | null;
  };
}
