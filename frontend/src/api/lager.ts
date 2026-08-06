'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { apiFetch } from './client';
import type { CodeRef } from './masters';
import { useWarehousesLookup } from './lookups';

/**
 * LAGER LISTA I KARTICE ARTIKLA — „drugi pregled artikala" (READ-ONLY OGLEDALO BigBita).
 *
 * Backend: `src/modules/masters/lager.service.ts`, sve rute pod pravom `directory.read`:
 *   GET /v1/artikli/lager                  · stanje / rezervisano / slobodno po (artikal, magacin)
 *   GET /v1/artikli/:id/kartica-robno       · hronološko kretanje + tekuće stanje (Level 0)
 *   GET /v1/artikli/:id/kartica-profakture  · ponude/rezervacije/otpremnice (Level ≥ 250)
 *   GET /v1/artikli/:id/kartica-narudzbine  · trebovanja koja sadrže artikal
 * plus JEDNA mutacija, pod svojim pravom `masters.min_quantity` (v. izuzetak ispod):
 *   PATCH /v1/artikli/:id/minimalna-kolicina · prag ispod kog se poručuje
 *
 * ⚠️ ZALIHE SU READ-ONLY, i to nije stvar opreza nego stanja podataka: robno se do
 * cutover-a (april 2027) vodi ISKLJUČIVO u BigBit-u. Mereno na produkciji 04.08.2026:
 * `stock_documents` = 0, `stock_levels` = 0, `stock_reservations` = 0, `purchase_orders` = 0.
 * Sve ispod čita `*_mirror` tabele koje puni noćni `.mdb` uvoz. Ekran koji bi ovde pisao
 * stanje pisao bi u prazne 4.0 tabele, a magacioner bi i dalje gledao BigBit.
 *
 * JEDAN IZUZETAK (06.08.2026): `useSetMinimalnaKolicina` — `items.min_quantity` NIJE
 * podatak o zalihi nego prag koji određuje Servoteh. Kolona je istog dana izbačena iz
 * sync mape, pa je uvoz više ne prepisuje; unose je magacioneri (troje imenovanih,
 * pravo `masters.min_quantity`). Sve ostalo ostaje bez ijedne mutacije.
 *
 * 🔴 DVE GRANICE KOJE SE NE VIDE IZ BROJEVA, A MENJAJU IH (obe stižu u `meta`, i obe se
 * MORAJU ispisati na ekranu — v. `lager/page.tsx`):
 *
 *  1. POSLOVNA GODINA. BigBit svaku godinu otvara sopstvenim „Donosom po popisu", a uvoz
 *     ništa ne briše — posle 01.01. ogledalo drži DVE godine odjednom i prost zbir bi
 *     UDVOSTRUČIO stanje. Zato svaki upit seče po godini; podrazumevana je poslednja
 *     zatečena (`meta.yearSource = 'latest'`), ne kalendarska.
 *  2. REZERVACIJE SE U BigBit-u NE GASE. Mereno 05.08.2026: 1.576 rezervacionih dokumenata
 *     ide od 2013., ukupno ≈ 1,08 M jedinica prema ≈ 71 k iz 2026. Podrazumevani domet je
 *     zato tekuća godina (`reservationScope = 'year'`); `'all'` daje pun BigBit zbir.
 *
 * Napomena o tipovima: SVE količine i cene stižu kao STRING (`Decimal`, BACKEND_RULES §6) —
 * nikad kao `number`. Prikaz ide kroz `formatDecimal`, poređenje kroz `Number(...)`.
 * Datumi su gotovi `YYYY-MM-DD` stringovi (backend ih pravi `to_char`-om, pa zona ne ulazi
 * u igru); prikaz kroz `formatDate`.
 */

// ────────────────────────────────────────────────────────────── zajednički tipovi

/**
 * Magacin kakav ekran prikazuje. Backend uvek popuni `name` — kad magacin postoji u
 * BigBit-u a nema ga u 4.0 `warehouses` (BigBit vozi 1, 2 i 44), pada na „Magacin 44",
 * da se zaliha ne pripiše praznoj ćeliji.
 */
export interface WarehouseRef {
  id: number;
  name: string;
}

/** Odakle je došla primenjena poslovna godina — ekran je uz broj i ispisuje. */
export type YearSource = 'query' | 'latest' | 'fallback';

/** Domet rezervacija: tekuća poslovna godina ili sve godine iz BigBita. */
export type ReservationScope = 'year' | 'all';

interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Zaglavlje kartice — identitet artikla, isti na sve tri kartice. */
export interface KarticaItem {
  id: number;
  catalogNumber: string;
  name: string;
  unit: string | null;
  shelf: string | null;
}

// ─────────────────────────────────────────────────────────────────── LAGER LISTA

/**
 * Jedan red lagera = JEDAN PAR (artikal, magacin), ne artikal. Isti artikal sa zalihom u
 * dva magacina daje dva reda — zato je ključ reda `itemId` + `warehouseId`, nikad sam
 * `itemId` (React bi na duplom ključu prikazao samo jedan od njih).
 *
 * `catalogNumber` / `name` su NULLABLE jer je spoj na `items` LEFT: ogledalo nosi
 * `item_id` iz BigBita, a artikal je u međuvremenu mogao nestati iz šifarnika. Takav red
 * je i dalje zaliha koja fizički postoji i mora se videti — ekran ga označava (v.
 * `lager/page.tsx`), a kartice za njega vraćaju 404 jer artikla u `items` nema.
 */
export interface LagerRow {
  /** `items.id` — ključ artikla u 3.0/4.0 (NIJE BigBit šifra artikla). */
  itemId: number;
  catalogNumber: string | null;
  name: string | null;
  unit: string | null;
  shelf: string | null;
  groupCode: string | null;
  /** Opis grupe (tooltip); `description` je danas `null` — `item_groups` je prazan. */
  group: CodeRef | null;
  warehouse: WarehouseRef;
  /** SUM(ulaz) − SUM(izlaz) nad dokumentima `Level 0` izabrane godine (Decimal-as-string). */
  stock: string;
  /** SUM količina nad dokumentima koji rezervišu (`Rezervisi`), po `reservationScope`. */
  reserved: string;
  /** `stock − reserved`. Negativno = obećano više nego što postoji. */
  free: string;
  /**
   * MINIMALNA KOLIČINA (`items.min_quantity`) — prag ispod kog se poručuje.
   *
   * 🔴 `null` NIJE `0`. „Prag nije postavljen" i „prag je nula" su različite stvari i
   * ekran ih prikazuje različito (— vs 0). Mereno na produkciji 06.08.2026:
   * 162 artikla ima prag > 0, 92.460 ima nulu, 3 imaju prazno (od 92.625).
   *
   * Do prelaska (01.04.2027) ovu kolonu puni BigBit i ovde se SAMO ČITA —
   * v. `meta.minQuantityOwner` i `useSetMinimalnaKolicina`.
   */
  minQuantity: string | null;
  /** VP cena iz šifarnika artikala (`items.wholesale_price`), ne nabavna vrednost zalihe. */
  wholesalePrice: string | null;
}

/**
 * KO VLADA KOLONOM „Min. kol." — odgovor stiže IZ BACKEND-a, ne iz konstante ovde.
 *
 * `'BigBit'` = prag se unosi u BigBit-u, ekran ga samo prikazuje (noćni uvoz u 03:45
 * bi svaki unos odavde pregazio, pa ga backend odbija sa 409).
 * `'4.0'`    = prag se unosi ovde (uz pravo `masters.min_quantity`).
 *
 * 🔴 NE PRAVITI KOPIJU OVE ODLUKE NA FRONTU. Jedini vlasnik je
 * `VLASNIK_MINIMALNE_KOLICINE` u `backend/src/modules/masters/items.write-policy.ts`;
 * kopija bi značila da se na dan prelaska menjaju dva mesta u dva repoa — i da ekran
 * neko vreme nudi unos koji backend odbija (ili obrnuto, krije polje koje radi).
 */
export type MinQuantityOwner = 'BigBit' | '4.0';

export interface LagerMeta {
  pagination: PaginationMeta;
  /** Poslovna godina koja je STVARNO primenjena — ekran je uvek ispisuje. */
  year: number;
  yearSource: YearSource;
  reservationScope: ReservationScope;
  onlyWithStock: boolean;
  onlyNegative: boolean;
  /** Ko puni „Min. kol." — v. `MinQuantityOwner`. Stariji odgovor bez polja = `'BigBit'`. */
  minQuantityOwner?: MinQuantityOwner;
}

export interface LagerResponse {
  data: LagerRow[];
  meta: LagerMeta;
}

/**
 * KOLONE PO KOJIMA SERVER UME DA SORTIRA — ogledalo backend allowlist-a
 * `LAGER_SORT_COLUMNS` (`backend/src/modules/masters/dto/list-lager.dto.ts`). Kolona van
 * spiska vraća 400 SA SPISKOM, ne tiho podrazumevani redosled, pa je ovaj niz jedina
 * brana da zaglavlje ne pošalje nepostojeću kolonu.
 *
 * `warehouse` sortira po NAZIVU magacina — broj magacina se na ekranu nigde ne vidi.
 */
export const LAGER_SORT_COLUMNS = [
  'catalogNumber',
  'name',
  'unit',
  'shelf',
  'groupCode',
  'warehouse',
  'stock',
  'reserved',
  'free',
  'minQuantity',
  'wholesalePrice',
] as const;

export type LagerSortColumn = (typeof LAGER_SORT_COLUMNS)[number];
export type LagerSortDir = 'asc' | 'desc';

/** Je li ključ kolone dozvoljen za sort (URL ume da nosi smeće). */
export function isLagerSortColumn(key: string | null | undefined): key is LagerSortColumn {
  return !!key && (LAGER_SORT_COLUMNS as readonly string[]).includes(key);
}

export interface LagerListParams {
  page?: number;
  pageSize?: number;
  sort?: LagerSortColumn;
  dir?: LagerSortDir;
  /** Objedinjena pretraga: kataloški broj ili naziv (`contains`, bez razlike u veličini slova). */
  q?: string;
  /** Magacin sa STAVKE (BigBit `IDMagacin`), ne sa dokumenta. */
  warehouseId?: number;
  /** Šifra grupe artikla — tačno poklapanje. */
  groupCode?: string;
  /**
   * `true` (podrazumevano na backendu) = samo redovi sa stanjem ≠ 0. Isključivanje se
   * MORA poslati izričito (`onlyWithStock=false`) — izostavljen parametar znači „true".
   */
  onlyWithStock?: boolean;
  /** Samo negativna stanja — radna lista za ispravke. */
  onlyNegative?: boolean;
  /** Poslovna godina; izostavljeno = poslednja zatečena u ogledalu. */
  year?: number;
  /** Domet rezervacija; izostavljeno = `year`. */
  reservationScope?: ReservationScope;
}

/** `LagerListParams` → query string. Jedan izvor i za skrol i za izvoz. */
function buildLagerQuery(params: LagerListParams): string {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.sort) {
    qs.set('sort', params.sort);
    if (params.dir) qs.set('dir', params.dir);
  }
  if (params.q) qs.set('q', params.q);
  if (params.warehouseId !== undefined) qs.set('warehouseId', String(params.warehouseId));
  if (params.groupCode) qs.set('groupCode', params.groupCode);
  // Podrazumevano je `true`, pa se šalje SAMO isključivanje — inače bi „prikaži i
  // artikle bez stanja" tiho ostalo bez efekta.
  if (params.onlyWithStock === false) qs.set('onlyWithStock', 'false');
  if (params.onlyNegative) qs.set('onlyNegative', 'true');
  if (params.year !== undefined) qs.set('year', String(params.year));
  if (params.reservationScope) qs.set('reservationScope', params.reservationScope);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/** Veličina jedne strane skrola; backend tvrdo seče `pageSize` na 200. */
export const LAGER_STRANA_SKROLA = 200;

/**
 * KAPA UČITANIH REDOVA. Isti razlog kao na listi artikala: skrol nadovezuje strane u
 * JEDNU tabelu i tabela crta svaki red. Mereno u BigBit-u: 7.143 artikla sa stanjem ≠ 0,
 * dakle uz „prikaži i artikle bez stanja" spisak ume da naraste daleko preko toga.
 * Kad se kapa dostigne, ekran nudi izvoz — pa je kapa i granica izvoza.
 */
export const LAGER_SKROL_KAPA = 5000;

/**
 * Lager lista ZA SKROL — strane se nadovezuju umesto da se smenjuju.
 *
 * Dovlačenje je uvek NA ZAHTEV (dugme „Učitaj još"), nikad na dolazak dna: odskok na
 * dodirnom ekranu okine posmatrača više puta i pošalje plotun zahteva.
 *
 * Uz redove vraća i `meta` PRVE strane — primenjena godina i domet rezervacija su isti
 * za ceo skup, a ekran ih mora ispisati (bez njih korisnik gleda brojeve jedne godine ne
 * znajući koje).
 */
export function useLagerSkrol(
  params: LagerListParams,
  pageSize: number = LAGER_STRANA_SKROLA,
  kapa: number = LAGER_SKROL_KAPA,
) {
  const upit = useInfiniteQuery({
    queryKey: ['masters', 'lager', 'skrol', { ...params, pageSize }],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiFetch<LagerResponse>(`/v1/artikli/lager${buildLagerQuery({ ...params, page: pageParam, pageSize })}`),
    getNextPageParam: (poslednja, sve) => {
      const p = poslednja.meta.pagination;
      if (p.page >= p.totalPages) return undefined;
      // Prazna strana bez ovoga vrti „Učitaj još" u prazno zauvek.
      if (poslednja.data.length === 0) return undefined;
      const ucitano = sve.reduce((n, s) => n + s.data.length, 0);
      if (ucitano >= kapa) return undefined;
      return p.page + 1;
    },
  });

  const strane = upit.data?.pages;
  const redovi = useMemo(() => (strane ?? []).flatMap((s) => s.data), [strane]);
  const meta = strane?.[0]?.meta ?? null;
  const ukupno = meta?.pagination.total ?? 0;

  return {
    upit,
    redovi,
    /** `meta` prve strane — godina, poreklo godine, domet rezervacija, primenjeni filteri. */
    meta,
    ukupno,
    ucitano: redovi.length,
    /** `true` = stalo se zbog KAPE, a ne zbog kraja spiska — ekran to mora reći. */
    naKapi: redovi.length >= kapa && ukupno > redovi.length,
  };
}

// ────────────────────────────────────────────── UNOS MINIMALNE KOLIČINE (jedina mutacija)

/** Odgovor uske izmene — dovoljno da ekran osveži ćeliju i napiše ŠTA je promenio. */
export interface MinimalnaKolicinaOdgovor {
  itemId: number;
  catalogNumber: string | null;
  name: string | null;
  minQuantity: number | null;
  /** Vrednost PRE izmene — poruka kaže „2 → 5", ne samo „sačuvano". */
  previousMinQuantity: number | null;
}

/**
 * MINIMALNA KOLIČINA — PRIPREMLJENA mutacija, danas se NE KORISTI.
 *
 * 🔴 DOK `meta.minQuantityOwner === 'BigBit'` (danas), ovaj hook se NE POZIVA i ekran
 * ne sme da ponudi polje: backend vraća 409 sa objašnjenjem da se prag do prelaska
 * (01.04.2027) unosi u BigBit-u, jer bi ga noćni uvoz u 03:45 vratio na staro.
 * Vlasnik, 06.08.2026: „ovde nema UNOSA dok ne krenemo da radimo sa APP… neka ti je
 * pripremljeno sve, ali nećemo ga testirati."
 *
 * Zato ostaje netaknut: na dan prelaska backend prevrne prekidač, `meta` počne da
 * javlja `'4.0'` i ekran otvori unos — bez ijedne izmene ovde.
 *
 * ⚠️ Zaglavlje ovog fajla kaže „ZALIHE SU READ-ONLY". To je tačno i ostaje tačno:
 * stanje, rezervisano i slobodno su BigBit-ovi do cutover-a. `min_quantity` je jedini
 * kandidat za izuzetak, i to tek kad prekidač to kaže.
 *
 * Pravo je `masters.min_quantity` i NEMA GA NIJEDNA ROLA — troje imenovanih ga nosi
 * kroz `user_permission_overrides`. Ekran mora da gejtuje prikaz kroz `can()` I kroz
 * `minQuantityOwner`, a ne da se osloni na grešku posle klika.
 *
 * `invalidateQueries` gađa CEO lager keš namerno: isti artikal ume da stoji u više
 * magacina (više redova), a prag je na ARTIKLU — ručno krpljenje jednog reda
 * ostavilo bi ostale sa starom vrednošću dok se ekran ne osveži.
 */
export function useSetMinimalnaKolicina() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      minQuantity,
    }: {
      itemId: number;
      /** `null` = obriši prag (nije isto što i 0). String dozvoljava srpski zarez. */
      minQuantity: string | number | null;
    }) =>
      apiFetch<MinimalnaKolicinaOdgovor>(`/v1/artikli/${itemId}/minimalna-kolicina`, {
        method: 'PATCH',
        body: JSON.stringify({ minQuantity }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['masters', 'lager'] });
    },
  });
}

/** Gornja granica jednog izvoza — ista kao kapa skrola (izvoz je izlaz iz kape). */
export const IZVOZ_LAGERA_LIMIT = LAGER_SKROL_KAPA;

/** Osigurač protiv petlje kad server vrati neočekivanu paginaciju. */
const IZVOZ_MAX_ZAHTEVA = 60;

/**
 * Jednokratno povlačenje CELE filtrirane lager liste za izvoz (izvozi se filter, ne
 * tekuća strana). Nije hook — poziva se na klik. `sort`/`dir` putuju sa filterom, pa je
 * redosled u Excelu isti kao na ekranu.
 *
 * `truncated` kaže da filter ima više redova nego što je izvezeno; bez toga korisnik
 * misli da u ruci drži ceo lager.
 */
export async function fetchLagerZaIzvoz(
  params: LagerListParams,
  limit = IZVOZ_LAGERA_LIMIT,
): Promise<{ rows: LagerRow[]; total: number; truncated: boolean; meta: LagerMeta | null }> {
  const rows: LagerRow[] = [];
  let total = 0;
  let meta: LagerMeta | null = null;
  let page = 1;

  for (let zahtev = 0; zahtev < IZVOZ_MAX_ZAHTEVA; zahtev += 1) {
    const res = await apiFetch<LagerResponse>(
      `/v1/artikli/lager${buildLagerQuery({ ...params, page, pageSize: limit })}`,
    );
    if (meta === null) meta = res.meta;
    total = res.meta.pagination.total;
    rows.push(...res.data);
    if (res.data.length === 0) break;
    if (rows.length >= limit || rows.length >= total) break;
    if (page >= res.meta.pagination.totalPages) break;
    page += 1;
  }

  const izvezeno = rows.slice(0, limit);
  return { rows: izvezeno, total, truncated: izvezeno.length < total, meta };
}

// ──────────────────────────────────────────────────── KARTICA — ROBNO KRETANJE

/**
 * Jedan red robnog kretanja (`Level 0`). `balance` je TEKUĆE STANJE posle ovog reda i
 * računa ga backend — ne sme se rekonstruisati na ekranu, jer kreće od `openingBalance`
 * koji je zbir SVEGA pre početka perioda.
 */
export interface GoodsCardRow {
  /** `goods_document_items_mirror.id` — ključ reda. */
  id: number;
  documentId: number;
  documentNumber: string | null;
  /** BigBit `Vrsta dokumenta` (UFROB, IFR, UVOZ, POPIS…). */
  documentType: string;
  documentDate: string | null;
  postingDate: string | null;
  isInflow: boolean;
  customerId: number | null;
  customerName: string | null;
  projectId: number | null;
  warehouse: WarehouseRef;
  quantityIn: string;
  quantityOut: string;
  balance: string;
  purchasePriceNet: string | null;
  actualWholesalePrice: string | null;
  description: string | null;
}

export interface GoodsCardMeta {
  item: KarticaItem;
  year: number;
  yearSource: YearSource;
  warehouseId: number | null;
  from: string | null;
  to: string | null;
  /** Zbir SVEGA pre `from` — bez njega kartica za mart laže o stanju. */
  openingBalance: string;
  totalIn: string;
  totalOut: string;
  closingBalance: string;
  count: number;
  /** `true` = kartica je odsečena na `limit` redova; ekran to MORA reći. */
  truncated: boolean;
  limit: number;
}

export interface GoodsCardParams {
  warehouseId?: number;
  from?: string;
  to?: string;
  year?: number;
}

function buildCardQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    qs.set(k, String(v));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/**
 * Kartica robnog kretanja. NIJE PAGINIRANA (tekuće stanje ima smisla samo nad celim
 * nizom — druga strana bi počinjala od nule), nego odsečena na `meta.limit` uz
 * `meta.truncated`.
 */
export function useKarticaRobno(itemId: number | null, params: GoodsCardParams) {
  return useQuery({
    queryKey: ['masters', 'kartica', 'robno', itemId, params],
    queryFn: () =>
      apiFetch<{ data: GoodsCardRow[]; meta: GoodsCardMeta }>(
        `/v1/artikli/${itemId}/kartica-robno${buildCardQuery({ ...params })}`,
      ),
    enabled: itemId != null && itemId > 0,
  });
}

// ────────────────────────────────────────────── KARTICA — PROFAKTURE / REZERVACIJE

/**
 * Red „profakture" — dokument `Level ≥ 250`: ponuda, predračun, rezervacija ili
 * otpremnica. U BigBit-u to nije tabela nego upit nad istim `T_Robna dokumenta`, pa se
 * vrste dokumenata ne nabrajaju — nova vrsta radnog dokumenta se sama pojavi.
 *
 * `isReservation` je jedini podatak koji kaže da li red UMANJUJE SLOBODNO u lageru;
 * `quantity` je zato izračunat istim izrazom kao kolona REZERVISANO.
 */
export interface ProformaCardRow {
  id: number;
  documentId: number;
  documentNumber: string | null;
  documentType: string;
  documentDate: string | null;
  postingDate: string | null;
  level: number;
  isReservation: boolean;
  isInflow: boolean;
  customerId: number | null;
  customerName: string | null;
  projectId: number | null;
  year: number | null;
  warehouse: WarehouseRef;
  quantity: string | null;
  actualWholesalePrice: string | null;
  discountPercent: string | null;
  description: string | null;
}

export interface ProformaCardMeta {
  pagination: PaginationMeta;
  item: KarticaItem;
  /** `null` = godina nije tražena (kartica profaktura se po godini ne seče sama od sebe). */
  year: number | null;
  warehouseId: number | null;
  from: string | null;
  to: string | null;
  onlyReservations: boolean;
  documentType: string | null;
}

export interface ProformaCardParams {
  warehouseId?: number;
  from?: string;
  to?: string;
  year?: number;
  onlyReservations?: boolean;
  documentType?: string;
}

// ─────────────────────────────────────────────────────── KARTICA — NARUDŽBINE

/**
 * Stavka trebovanja (BigBit `T_Trebovanja` + stavke, 22.931 dokument).
 *
 * ⚠️ Trebovanja se NE seku po godini podrazumevano (za razliku od lagera): decembarska
 * narudžbina koja stiže u januaru je i dalje otvorena narudžbina.
 */
export interface OrdersCardRow {
  id: number;
  orderId: number;
  orderNumber: string | null;
  orderDate: string | null;
  supplierId: number | null;
  supplierName: string | null;
  projectId: number | null;
  level: number;
  isOrdered: boolean;
  year: number | null;
  note: string | null;
  orderedQuantity: string | null;
  receivedQuantity: string | null;
  /** Ostatak isporuke; nikad negativan (višak isporuke je 0, ne minus). */
  remainingQuantity: string;
  unitPrice: string | null;
  discountPercent: string | null;
  description: string | null;
  expectedDeliveryDate: string | null;
  deliveryDate: string | null;
  isDelivered: boolean;
}

export interface OrdersCardMeta {
  pagination: PaginationMeta;
  item: KarticaItem;
  year: number | null;
  from: string | null;
  to: string | null;
  onlyOpen: boolean;
}

export interface OrdersCardParams {
  from?: string;
  to?: string;
  year?: number;
  onlyOpen?: boolean;
}

/**
 * Kapa skrola za dve paginirane kartice. Manja je od lagerske jer je skup po jednom
 * artiklu: najprometniji artikal u celoj godini ima red veličine hiljadu stavki, a
 * kartica se čita, ne pretražuje.
 */
export const KARTICA_SKROL_KAPA = 2000;

/** Veličina strane kartice — 100 redova je jedan pun ekran skrola, ne 200 kao lista. */
const KARTICA_STRANA = 100;

/**
 * Zajednička logika skrola za dve paginirane kartice (profakture, narudžbine): staje na
 * kraju spiska, na praznoj strani i na kapi. Kad stane zbog kape, `hasNextPage` je
 * `false`, pa ekran mora sam reći zašto (v. `naKapi`).
 */
function sledecaStrana<T>(
  poslednja: { data: T[]; meta: { pagination: PaginationMeta } },
  sve: { data: T[] }[],
): number | undefined {
  const p = poslednja.meta.pagination;
  if (p.page >= p.totalPages) return undefined;
  if (poslednja.data.length === 0) return undefined;
  const ucitano = sve.reduce((n, s) => n + s.data.length, 0);
  if (ucitano >= KARTICA_SKROL_KAPA) return undefined;
  return p.page + 1;
}

/** Zajednički oblik rezultata obe paginirane kartice — jedan idiom za oba taba. */
function rezultatSkrola<T, M extends { pagination: PaginationMeta }>(
  strane: { data: T[]; meta: M }[] | undefined,
) {
  const redovi = (strane ?? []).flatMap((s) => s.data);
  const meta = strane?.[0]?.meta ?? null;
  const ukupno = meta?.pagination.total ?? 0;
  return {
    redovi,
    meta,
    ukupno,
    ucitano: redovi.length,
    naKapi: redovi.length >= KARTICA_SKROL_KAPA && ukupno > redovi.length,
  };
}

/** Kartica profaktura/rezervacija — skrol, najnovije prvo. */
export function useKarticaProfakture(itemId: number | null, params: ProformaCardParams) {
  const upit = useInfiniteQuery({
    queryKey: ['masters', 'kartica', 'profakture', itemId, params],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: ProformaCardRow[]; meta: ProformaCardMeta }>(
        `/v1/artikli/${itemId}/kartica-profakture${buildCardQuery({
          ...params,
          page: pageParam > 1 ? pageParam : undefined,
          pageSize: KARTICA_STRANA,
        })}`,
      ),
    getNextPageParam: sledecaStrana,
    enabled: itemId != null && itemId > 0,
  });
  const strane = upit.data?.pages;
  const spojeno = useMemo(() => rezultatSkrola(strane), [strane]);
  return { upit, ...spojeno };
}

/** Kartica narudžbina (trebovanja) — skrol, najnovije prvo. */
export function useKarticaNarudzbine(itemId: number | null, params: OrdersCardParams) {
  const upit = useInfiniteQuery({
    queryKey: ['masters', 'kartica', 'narudzbine', itemId, params],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiFetch<{ data: OrdersCardRow[]; meta: OrdersCardMeta }>(
        `/v1/artikli/${itemId}/kartica-narudzbine${buildCardQuery({
          ...params,
          page: pageParam > 1 ? pageParam : undefined,
          pageSize: KARTICA_STRANA,
        })}`,
      ),
    getNextPageParam: sledecaStrana,
    enabled: itemId != null && itemId > 0,
  });
  const strane = upit.data?.pages;
  const spojeno = useMemo(() => rezultatSkrola(strane), [strane]);
  return { upit, ...spojeno };
}

// ───────────────────────────────────────────────────────────────── magacini

/**
 * OPCIJE ZA BIRANJE MAGACINA — 4.0 šifarnik PLUS magacini koje ogledalo stvarno nosi.
 *
 * 🔴 Sam `/v1/lookups/warehouses` ovde NIJE dovoljan: BigBit vozi magacine 1 (roba),
 * 2 (repro) i 44 (gotovi proizvodi), a 4.0 `warehouses` je zaseban šifarnik od tri
 * zapisa koji broj 44 ne mora imati. Magacin koji 4.0 ne zna bi tada ispao iz padajuće
 * liste — a zaliha na njemu postoji i vidi se u tabeli, pa bi filter ćutke odbijao da
 * je izdvoji.
 *
 * `izabran` je tu iz istog razloga zbog kog lista artikala drži nepoznatu J.m. u spisku:
 * kad filter ne vrati nijedan red, magacin viđen u podacima nestane, a kontrola bi
 * ostala prazna dok filter i dalje radi po njemu — ekran bi lagao šta je filtrirano.
 *
 * Bez `useMemo`: spisak ima jednocifren broj stavki, a `<Select>` ga ne poredi po
 * referenci — memoizacija bi ovde bila samo još jedna dep lista koja ume da zastari.
 */
export function useMagacinOpcije(
  izPodataka: WarehouseRef[],
  izabran?: number | null,
): { options: { value: string; label: string }[]; isLoading: boolean; error: unknown } {
  const lookup = useWarehousesLookup();

  const map = new Map<number, string>();
  for (const w of lookup.data?.data ?? []) {
    map.set(w.id, w.city ? `${w.name} (${w.city})` : w.name);
  }
  for (const w of izPodataka) if (!map.has(w.id)) map.set(w.id, w.name);
  if (izabran != null && izabran > 0 && !map.has(izabran)) map.set(izabran, `Magacin ${izabran}`);

  const options = [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, name]) => ({ value: String(id), label: name }));

  return { options, isLoading: lookup.isLoading, error: lookup.error };
}
