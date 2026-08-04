'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * Matični podaci 4.0 — Artikli i Komitenti (read-only pregled BigBit cache tabela).
 * Backend: `src/modules/masters` — modul ima ISKLJUČIVO GET rute
 * (`items.controller.ts`, `customers.controller.ts`).
 *   GET /v1/artikli         · lista (22 kolone BigBit pregleda + filteri forme)
 *   GET /v1/artikli/lookups · šifarnici za filtere (grupe/podgrupe/podpodgrupe…)
 *   GET /v1/artikli/:id     · pun slog + nazivi grupe/podgrupe/porekla
 *   GET /v1/komitenti       · lista (q: naziv/PIB/mesto; codeTypeCode)
 *   GET /v1/komitenti/:id   · pun slog + vrsta šifre / prodavac / uplatni račun
 *
 * ⚠️ OVDE NE SME NASTATI NIJEDNA MUTACIJA — i to iz dva različita razloga, koje ne
 * treba mešati:
 *   • `customers`: ODLUKA VLASNIKA 26.07.2026 — read-only za celu aplikaciju, jedini
 *     pisac je sync modul; `POST/PATCH /v1/directory/customers` namerno vraćaju 409
 *     `BIGBIT_OWNED_READ_ONLY` (`backend/src/modules/directory/bigbit-owned.ts`).
 *   • `items`: tehnički — sync radi `full_refresh` (`watermark: null`), tj.
 *     `deleteMany({})` + `createMany`, pa bi 4.0-native artikal nestao bez traga, a
 *     `price_list_entries` / `work_order_item_components` ostali kao siročad.
 * Ekrani unosa/izmene postoje (`/artikli/nov`, `/komitenti/nov`, `?rezim=izmena`), ali
 * stoje ZAKLJUČANI; jedan izvor te odluke za frontend je `app/artikli/_forma/pravila.ts`
 * (`BRANA_ARTIKAL`, `BRANA_KOMITENT`) — tamo se menja kad odluka padne, i nigde više.
 *
 * Napomena o tipovima: `Decimal` kolone stižu kao STRING (BACKEND_RULES §6), a
 * legacy `Double` kolone (cene, procenti, dimenzije) kao broj — otud mešavina
 * `number | null` i `string | null` ispod. Prikaz oba ide kroz `formatDecimal`.
 */

/** Razrešen šifarnički kod. `description` = null dok šifarnik nije sinkovan. */
export interface CodeRef {
  code: string;
  description: string | null;
}

/** Komercijalista (bezbedan podskup — backend nikad ne vraća lozinku/nalog). */
export interface SalespersonRef {
  id: number;
  name: string | null;
  firstName: string | null;
}

/** Uplatni račun (`UplatniRacuni` → `payment_accounts`). */
export interface PaymentAccountRef {
  id: number;
  accountNumber: string;
  bankName: string | null;
  bankCode: string | null;
  countryCode: string | null;
}

// ---------------------------------------------------------------------- ARTIKLI

/**
 * Artikal u listi — 22 kolone BigBit pregleda „Pregled artikala", TAČNO onim
 * redosledom kojim ih BigBit crta (izvor: izvoz forme iz `OnLine_BigBit_APL.MDB`,
 * `Detail` sekcija sortirana po `Left` koordinati; polja su niže numerisana 1–22).
 *
 * Redosled se NE „poboljšava" — zahtev vlasnika 04.08.2026: „kolone u pregledu da
 * budu istim redosledom, svi korisnici su navikli". Isto važi i za labele
 * (`app/artikli/page.tsx`) i za CSV izvoz.
 */
export interface ItemRow {
  /** `items.id` — ključ reda u 3.0/4.0. NIJE BigBit šifra (v. `externalItemId`). */
  id: number;
  /** 1 · Kataloški broj */
  catalogNumber: string;
  /** 2 · Naziv */
  name: string;
  /** 3 · J.m. */
  unit: string | null;
  /** 4 · Polica */
  shelf: string | null;
  /** 5 · Težina */
  weight: number | null;
  /** 6 · Grupa (`R_Grupa.Grupa`) */
  groupCode: string;
  /** 7 · Podgrupa (`R_Podgrupa.Podgrupa`) */
  subgroupCode: string;
  /** 8 · PodPodgrupa — BigBit labela polja `Poreklo`; NE zvati ga „Poreklo". */
  originCode: string;
  /** 9 · VP cena — `Decimal(19,4)` → STRING (BACKEND_RULES §6), prikaz kroz `formatDecimal`. */
  wholesalePrice: string | null;
  /** 10 · MP cena — Decimal → string. */
  retailPrice: string | null;
  /** 11 · Tarifa robe */
  goodsTaxRateCode: string;
  /** 12 · PPD — checkbox „Uvek porez na robu" u BigBitu. */
  alwaysTaxGoods: boolean | null;
  /** 13 · Debljina ploče */
  thickness: number | null;
  /** 14 · Kg u kom. (BigBit kolona `Kutija`) */
  box: number | null;
  /** 15 · Devizna cena (`ProdDevCena`) — Decimal → string. */
  fxSalePrice: string | null;
  /** 16 · Kng. šifra 1 */
  accountingCode: string | null;
  /** 17 · Kng. šifra 2 */
  accountingCode2: string | null;
  /** 18 · PLU */
  plu: number | null;
  /**
   * 19 · ID — BigBit „Šifra artikla" = `items.external_item_id`, NIKAD `items.id`
   * (BIGBIT_ARTIKLI.md §5.1: `items.id` je QBigTehn IDENTITY). 0 = red otvoren u
   * 4.0, koji BigBit šifru nema — tabela tu prikazuje oznaku, ne nulu.
   */
  externalItemId: number;
  /** 20 · Bar kod */
  barCode: string | null;
  /** 21 · Ext. šifra */
  externalCode: string | null;
  /** 22 · INO naziv */
  foreignName: string | null;
  /** Van 22 kolone: filter „Samo aktivni" i oznaka na kartici. */
  active: boolean | null;
  /**
   * Van 22 kolone: `true` = red je otvoren u 4.0 (`items.id ≥ 900.000.000`,
   * `items.write-policy.ts`). Kolona „ID" bez ovoga ne može da razlikuje „nema
   * BigBit porekla" od „BigBit šifra je baš 0" i prikazala bi golu nulu.
   */
  native: boolean;
  /** Opis grupe iz šifarnika — u tabeli ide kao tooltip uz šifru. */
  group: CodeRef | null;
  /** Opis podgrupe iz šifarnika (tooltip). */
  subgroup: CodeRef | null;
  /** Opis podpodgrupe iz šifarnika (tooltip). */
  origin: CodeRef | null;
}

/**
 * Pun slog artikla (`R_Artikli`, 67 kolona — v. `docs/migration/BIGBIT_ARTIKLI.md` §1).
 * Redosled polja prati sekcije detalja: identitet · klasifikacija · cene · PDV/carina ·
 * dimenzije · opisi · linkovi · ostalo.
 *
 * Uz same kolone slog nosi i EHO IZ ŠIFARNIKA — sve što BigBit forma „Unos artikala"
 * ispisuje PORED šifre (naziv grupe/podgrupe/porekla, naziv dimenzije i kvaliteta,
 * zbirne PDV stope). Backend ih razrešava u istom pozivu
 * (`backend/src/modules/masters/items.service.ts`, `findOne`), pa kartica ne pravi
 * dodatne upite; polja su read-only i nikad se ne šalju nazad.
 */
export interface ItemDetail {
  id: number;
  // Identitet
  catalogNumber: string;
  barCode: string | null;
  plu: number | null;
  externalCode: string | null;
  externalItemId: number;
  name: string;
  // Klasifikacija
  groupCode: string;
  subgroupCode: string;
  originCode: string;
  qualityTypeId: number | null;
  group: CodeRef | null;
  subgroup: CodeRef | null;
  origin: CodeRef | null;
  /**
   * Naziv kvaliteta iz `item_quality_types` (`R_KvalitetArtikla.KvalitetArtikal`) —
   * ono što BigBit combo „Kvalitet artikla" PRIKAZUJE, dok se u kolonu upisuje id.
   * `null` = šifra nije u šifarniku (ili polje nije popunjeno).
   */
  qualityName: string | null;
  // Cene / marže / rabati
  wholesalePrice: number | null;
  retailPrice: number | null;
  fxPurchasePrice: number | null;
  fxSalePrice: number | null;
  priceToWritePricelist: number | null;
  /** Decimal → string. */
  manualMarkupPercent: string | null;
  maxDiscountPercent: number | null;
  promotionDiscount: number | null;
  finalProcessingCost: number | null;
  retailLossPercent: number | null;
  wholesaleLossPercent: number | null;
  minQuantity: number | null;
  paymentTermDays: number | null;
  // PDV / carina
  goodsTaxRateCode: string;
  serviceTaxRateCode: string;
  /**
   * BigBit `RobaZbirnaStopa` (%) — ZBIR svih komponenti tarife (osnovna + železnica +
   * gradska + ratna + posebna), isto što combo ispisuje u koloni „Stopa". `null` (a ne
   * 0) kad tarife nema u registru: nula bi značila „stopa je 0%", što je druga tvrdnja.
   */
  goodsTaxTotalRate: number | null;
  /** BigBit `UslugeZbirnaStopa` (%) — isto pravilo kao za robu. */
  serviceTaxTotalRate: number | null;
  alwaysTaxGoods: boolean | null;
  alwaysTaxServices: boolean | null;
  nonTaxablePart: number | null;
  itemFee: number | null;
  itemExcise: number | null;
  customsRate: number | null;
  customsTariff: string | null;
  originCountry: string | null;
  accountingCode: string | null;
  accountingCode2: string | null;
  // Dimenzije / pakovanje
  unit: string | null;
  baseUnit: string | null;
  packaging: string | null;
  quantityInPackage: number | null;
  box: number | null;
  transportPackaging: number | null;
  weight: number | null;
  weightKg: number | null;
  volume: number | null;
  area: number | null;
  thickness: number | null;
  // Opisi i prevodi
  itemDescription: string | null;
  webDescription: string | null;
  foreignName: string | null;
  foreignUnit: string | null;
  memo: string | null;
  note2: string | null;
  // Linkovi (putanje do fajlova na fajl-serveru — NE učitavati, samo prikazati)
  symbolImageLink: string | null;
  pdfLink: string | null;
  wordLocation: string | null;
  // Ostalo
  supplierId: number | null;
  manufacturer: string | null;
  shelf: string | null;
  issuePlaceId: number | null;
  rasterId: number | null;
  /**
   * Naziv dimenzije iz `item_rasters` (`RasterDefZag.RasterNaziv`) — ono što BigBit
   * combo „Dimenzija (mm)" PRIKAZUJE, dok se u kolonu upisuje `IDRaster`.
   */
  rasterName: string | null;
  sortOrder: number | null;
  hps: string | null;
  notStockTracked: boolean | null;
  toDelete: boolean | null;
  active: boolean | null;
  signature: string | null;
  createdAt: string | null;
  /**
   * `true` = artikal je otvoren u 4.0 (`items.id ≥ 900.000.000`), tj. nema BigBit
   * porekla. Isto značenje kao `ItemRow.native` — bez toga se „BigBit šifra 0" ne
   * razlikuje od „nema BigBit šifre".
   */
  native: boolean;
}

/**
 * Filteri pregleda artikala — isti skup koji nosi BigBit forma „Pregled artikala"
 * (`ZaKatBroj`, `FilterZaGrupu`, `ZaPodgrupu`, `FilterZaPoreklo`, `ZaDimenziju`,
 * `ZaKvalitet`, `ZaDupleKatBrojeve`) + jedno objedinjeno polje pretrage umesto tri
 * BigBit combo-a (po kat. broju / nazivu / bar kodu).
 */
export interface ItemListParams {
  page?: number;
  pageSize?: number;
  /** Objedinjena pretraga: kat. broj / naziv / barkod / ext. šifra. */
  q?: string;
  /** Šifra grupe — tačno poklapanje. */
  groupCode?: string;
  /** Šifra podgrupe — tačno poklapanje. */
  subgroupCode?: string;
  /** Šifra podpodgrupe (BigBit `Poreklo`) — tačno poklapanje. */
  originCode?: string;
  /** PREFIKS kataloškog broja (BigBit `ZaKatBroj` radi „počinje sa"). */
  catalogNumber?: string;
  /** Deo naziva (`contains`, insensitive). */
  name?: string;
  /** Dimenzija (raster) — `RasterDefZag.IDRaster`. */
  rasterId?: number;
  /** Kvalitet artikla — `R_KvalitetArtikla.IDKvalitetArtikla`. */
  qualityTypeId?: number;
  /** Samo artikli čiji se kataloški broj pojavljuje više puta (BigBit toggle). */
  duplicateCatalogNumbers?: boolean;
  /** `true` = samo aktivni, `false` = samo neaktivni, izostavljeno = svi. */
  active?: boolean;
}

/**
 * `ItemListParams` → query string. Isti izvor za hook liste i za izvoz, da se
 * filter ne bi razišao između onoga što se vidi i onoga što se izveze.
 */
function buildItemQuery(params: ItemListParams): string {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.q) qs.set('q', params.q);
  if (params.groupCode) qs.set('groupCode', params.groupCode);
  if (params.subgroupCode) qs.set('subgroupCode', params.subgroupCode);
  if (params.originCode) qs.set('originCode', params.originCode);
  if (params.catalogNumber) qs.set('catalogNumber', params.catalogNumber);
  if (params.name) qs.set('name', params.name);
  if (params.rasterId !== undefined) qs.set('rasterId', String(params.rasterId));
  if (params.qualityTypeId !== undefined)
    qs.set('qualityTypeId', String(params.qualityTypeId));
  if (params.duplicateCatalogNumbers) qs.set('duplicateCatalogNumbers', 'true');
  if (params.active !== undefined) qs.set('active', String(params.active));
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/**
 * Paginirana lista artikala (~91k redova → uvek server-side, default 50/strana).
 * Sort je BigBit-ov: grupa → kataloški broj → naziv (radi ga backend).
 */
export function useArtikli(params: ItemListParams) {
  const query = buildItemQuery(params);
  return useQuery({
    queryKey: ['masters', 'artikli', params],
    queryFn: () => apiFetch<Paginated<ItemRow>>(`/v1/artikli${query}`),
  });
}

/** Gornja granica jednog izvoza — bez nje bi „Export" povukao svih ~91k redova. */
export const IZVOZ_ARTIKALA_LIMIT = 5000;

/** Osigurač protiv petlje kad server vrati neočekivanu paginaciju. */
const IZVOZ_MAX_ZAHTEVA = 60;

/**
 * Jednokratno povlačenje CELE filtrirane liste za izvoz (BigBit dugme „Export"):
 * izvozi se filter, ne tekuća strana. Nije hook — poziva se na klik.
 *
 * Lista se skuplja u koracima jer backend tvrdo ograničava `pageSize`
 * (`parsePagination`, max 200): tražimo `pageSize = limit`, server ga skrati, a mi
 * nastavljamo po stranama dok ne skupimo `limit` redova ili ne potrošimo listu.
 * `truncated` kaže da filter ima više redova nego što je izvezeno — ekran to mora
 * reći korisniku, inače misli da ima ceo spisak.
 */
export async function fetchArtikliZaIzvoz(
  params: ItemListParams,
  limit = IZVOZ_ARTIKALA_LIMIT,
): Promise<{ rows: ItemRow[]; total: number; truncated: boolean }> {
  const rows: ItemRow[] = [];
  let total = 0;
  let page = 1;

  for (let zahtev = 0; zahtev < IZVOZ_MAX_ZAHTEVA; zahtev += 1) {
    const query = buildItemQuery({ ...params, page, pageSize: limit });
    const res = await apiFetch<Paginated<ItemRow>>(`/v1/artikli${query}`);
    total = res.meta.pagination.total;
    rows.push(...res.data);
    if (res.data.length === 0) break;
    if (rows.length >= limit || rows.length >= total) break;
    if (page >= res.meta.pagination.totalPages) break;
    page += 1;
  }

  const izvezeno = rows.slice(0, limit);
  return { rows: izvezeno, total, truncated: izvezeno.length < total };
}

/** Jedan artikal — pun slog za karticu artikla. */
export function useArtikal(id: number | null) {
  return useQuery({
    queryKey: ['masters', 'artikli', 'detail', id],
    queryFn: () => apiFetch<{ data: ItemDetail }>(`/v1/artikli/${id}`),
    enabled: id != null,
  });
}

// ------------------------------------------------ šifarnici filtera (lookups)

/** Podgrupa nosi svoju grupu — kaskada „Grupa → Podgrupa" u filter baru. */
export interface ItemSubgroupRef extends CodeRef {
  parentGroup: string | null;
}

/** Podpodgrupa (BigBit `Poreklo`) nosi svoju podgrupu — druga stepenica kaskade. */
export interface ItemOriginRef extends CodeRef {
  subgroupCode: string | null;
}

/** Kvalitet artikla (`R_KvalitetArtikla`). */
export interface ItemQualityTypeRef {
  id: number;
  code: string;
  description: string | null;
}

/** Dimenzija / raster (`RasterDefZag`) — u BigBitu labela „Dimenzija (mm)". */
export interface ItemRasterRef {
  id: number;
  name: string | null;
  description: string | null;
  widthMm: number | null;
  lengthMm: number | null;
}

/**
 * Poreska tarifa (`R_Tarife`). BigBit combo prikazuje ZBIRNU stopu (osnovna +
 * železnica + gradska + ratna + posebna), ne pet komponenti — backend ih zato
 * sabira i šalje `totalRate`.
 */
export interface ItemTaxRateRef extends CodeRef {
  totalRate: number | null;
}

/**
 * Šifarnici za padajuće liste pregleda/kartice artikla — isti izvori koje BigBit
 * forma vezuje za svoje combo-e. `units` / `manufacturers` / `countries` nemaju
 * šifarnik nego su DISTINCT iz `items` (BigBit ih tako i puni).
 */
export interface ItemLookups {
  groups: CodeRef[];
  subgroups: ItemSubgroupRef[];
  origins: ItemOriginRef[];
  qualityTypes: ItemQualityTypeRef[];
  rasters: ItemRasterRef[];
  taxRates: ItemTaxRateRef[];
  units: string[];
  manufacturers: string[];
  countries: string[];
}

/** Šifarnici filtera — menjaju se retko, pa duže stoje sveži u kešu. */
export function useItemLookups() {
  return useQuery({
    queryKey: ['masters', 'artikli', 'lookups'],
    queryFn: () => apiFetch<{ data: ItemLookups }>('/v1/artikli/lookups'),
    staleTime: 5 * 60_000,
  });
}

/** „1200×2500" iz rastera; bez dimenzija pada na naziv, pa na `#id`. */
export function rasterLabel(r: ItemRasterRef): string {
  if (r.name) return r.name;
  if (r.widthMm != null && r.lengthMm != null) return `${r.widthMm}×${r.lengthMm}`;
  return `#${r.id}`;
}

// -------------------------------------------------------------------- KOMITENTI

/** Komitent u listi — samo kolone koje tabela prikazuje. */
export interface CustomerRow {
  id: number;
  name: string;
  city: string | null;
  taxId: string;
  codeTypeCode: string | null;
  salespersonId: number | null;
  codeType: CodeRef | null;
  salesperson: SalespersonRef | null;
}

/**
 * Pun slog komitenta (`Komitenti`, 57 kolona — v. `docs/migration/BIGBIT_KOMITENTI.md` §1).
 * Redosled polja prati sekcije detalja: osnovno · adresa/kontakt · računi · porezi/SEF ·
 * komercijala · napomene · audit.
 */
export interface CustomerDetail {
  id: number;
  // Osnovno
  name: string;
  shortName: string | null;
  branch: string | null;
  codeTypeCode: string | null;
  codeType: CodeRef | null;
  // Adresa / kontakt
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  region: number | null;
  phone: string | null;
  fax: string | null;
  mobile: string | null;
  email: string | null;
  webAddress: string | null;
  contact: string | null;
  birthDate: string | null;
  mailToDifferentAddress: boolean | null;
  newsletter: boolean | null;
  // Računi
  bankAccount1: string | null;
  bankAccount2: string | null;
  bankAccount3: string | null;
  paymentAccountId: number | null;
  paymentAccount: PaymentAccountRef | null;
  // Porezi / SEF
  taxId: string;
  skipTaxIdValidation: boolean | null;
  gln: string | null;
  publicSectorId: string | null;
  registrationNumber: string | null;
  vatStatus: number | null;
  centralInvoiceRegistry: boolean | null;
  einvoiceXmlPerItemDiscount: boolean | null;
  invoicePerDeliveryAddress: boolean | null;
  // Komercijala
  salespersonId: number | null;
  salesperson: SalespersonRef | null;
  customerDiscount: number | null;
  fictitiousDiscount: number | null;
  commissionPercent: number | null;
  /** Decimal → string. */
  manualMarkupPercent: string | null;
  priceListCode: string | null;
  paymentTermDays: number | null;
  paymentMethod: string | null;
  /** Decimal → string. */
  creditLimit: string | null;
  checkDebt: boolean | null;
  externalCode: string | null;
  pantheonId: string | null;
  buyerProtectionCode: string | null;
  routeId: number | null;
  driverId: number | null;
  hideInOverview: boolean | null;
  // Napomene
  note: string | null;
  balanceNote: string | null;
  // Audit
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  recordCreatedAt: string | null;
  signature: string | null;
}

export interface CustomerListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  codeTypeCode?: string;
}

/** Paginirana lista komitenata (pretraga naziv/PIB/mesto). */
export function useKomitenti(params: CustomerListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.q) qs.set('q', params.q);
  if (params.codeTypeCode) qs.set('codeTypeCode', params.codeTypeCode);
  const query = qs.toString();
  return useQuery({
    queryKey: ['masters', 'komitenti', params],
    queryFn: () => apiFetch<Paginated<CustomerRow>>(`/v1/komitenti${query ? `?${query}` : ''}`),
  });
}

/** Jedan komitent — pun slog za karticu komitenta. */
export function useKomitent(id: number | null) {
  return useQuery({
    queryKey: ['masters', 'komitenti', 'detail', id],
    queryFn: () => apiFetch<{ data: CustomerDetail }>(`/v1/komitenti/${id}`),
    enabled: id != null,
  });
}

// ------------------------------------------------------------------- pomoćnici

/** „Ana Petrović" iz `SalespersonRef` (firstName + name); prazno → null. */
export function salespersonLabel(s: SalespersonRef | null | undefined): string | null {
  if (!s) return null;
  return [s.firstName, s.name].filter(Boolean).join(' ') || null;
}

/** „SIR — Sirovine" (kod + naziv) ili samo kod dok šifarnik nije sinkovan. */
export function codeRefLabel(ref: CodeRef | null | undefined): string | null {
  if (!ref) return null;
  return ref.description ? `${ref.code} — ${ref.description}` : ref.code;
}

// ------------------------------------------------------ dupli PIB (O-7, 30.07.2026)

export interface DupliPibGrupa {
  taxId: string;
  customers: { id: number; name: string; city: string | null; source: string }[];
}

/**
 * Trajan spisak duplih PIB-ova. Dupli PIB se TOLERIŠE (BigBit ga toleriše, tvrda
 * brana bi obarala uvoz) — ali broj treba da PADA; rešava se u BigBitu dok je on
 * vlasnik podatka. Na nuli sme tvrda brana.
 */
export function useDupliPib() {
  return useQuery({
    queryKey: ['masters', 'komitenti', 'dupli-pib'],
    queryFn: () =>
      apiFetch<{
        data: DupliPibGrupa[];
        meta: { groups: number; customers: number; note: string };
      }>('/v1/komitenti/dupli-pib'),
    staleTime: 5 * 60_000, // spisak se menja samo posle noćnog uvoza
  });
}
