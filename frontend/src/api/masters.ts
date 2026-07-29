'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * Matični podaci 4.0 — Artikli i Komitenti (read-only pregled BigBit cache tabela).
 * Backend: `src/modules/masters` (BACKEND_RULES §3 — BigBit je vlasnik ovih tabela do
 * cutover-a; unos ostaje u BigBit-u, prelazni režim). Zato ovde postoje SAMO `useQuery`
 * hook-ovi — nijedna mutacija ne sme da nastane.
 *   GET /v1/artikli        · lista (q: naziv/kat. broj/barkod; groupCode, active)
 *   GET /v1/artikli/:id    · pun slog + nazivi grupe/podgrupe/porekla
 *   GET /v1/komitenti      · lista (q: naziv/PIB/mesto; codeTypeCode)
 *   GET /v1/komitenti/:id  · pun slog + vrsta šifre / prodavac / uplatni račun
 *
 * Napomena o tipovima: `Decimal` kolone stižu kao STRING (BACKEND_RULES §6), a
 * legacy `Double` kolone (cene, procenti, dimenzije) kao broj — otud mešavina
 * `number | null` i `string | null` ispod. Prikaz oba ide kroz `formatDecimal`.
 *
 * DVA SLOJA ODGOVORA (odluka 29.07.2026): rute stoje na `directory.read` i vidi ih
 * svako, ali KOMERCIJALNE kolone (cene, marže, rabati, računi, limiti, GK konta)
 * backend vraća samo akteru sa `masters.read`. Zato su tipovi `Osnovno & Partial<
 * Komercijalno>` — polja koja korisnik ne sme da vidi prosto NE POSTOJE u JSON-u
 * (nisu `null`), a `meta.restricted` kaže koji je sloj stigao. FE ništa ne krije
 * sam od sebe; samo ne crta ono čega nema.
 */

/** `{ restricted }` uz svaki odgovor: true = stigao je bazni (suženi) sloj. */
export interface MastersMeta {
  restricted: boolean;
}

/** Paginirani odgovor matičnih podataka (`Paginated` + oznaka sloja). */
export type MastersPaginated<T> = Paginated<T> & { meta: MastersMeta };

/** Detalj matičnog podatka (`{ data }` + oznaka sloja). */
export interface MastersDetail<T> {
  data: T;
  meta: MastersMeta;
}

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

/*
 * CHILD KOLEKCIJE (Talas B) — 6 BigBit tabela koje postoje samo u `.mdb` originalu i
 * stižu kroz `backend/tools/bigbit-bridge`. Dok bridge ne odradi prvi prolaz na produ
 * SVE su prazne — to je normalno stanje, pa ekrani prazne sekcije prosto ne crtaju.
 */

// ---------------------------------------------------------------------- ARTIKLI

/** Barkod ambalaže (`R_Artikli_BarKod`); `multiFactor` = množilac količine (Decimal → string). */
export interface ItemBarcode {
  id: number;
  barCode: string;
  /** Decimal → string. Kutija od 12 kom → „12“. */
  multiFactor: string;
}

/**
 * Prevod naziva/JM po jeziku (`R_Artikli_Ino`). `languageId` je go BROJ — šifarnik
 * jezika nije pronađen u BigBit izvozu (BIGBIT_ARTIKLI.md §8, otvoreno pitanje 4).
 */
export interface ItemTranslation {
  languageId: number;
  foreignName: string;
  foreignUnit: string | null;
}

/** Klasa kvaliteta (`R_KvalitetArtikla`) razrešena po `qualityTypeId`. */
export interface ItemQualityTypeRef {
  id: number;
  qualityCode: string;
  description: string;
}

/** Dobavljač artikla (`DobavljaciZaArtikal`) — KOMERCIJALNO; `supplier` je meki ref. */
export interface ItemSupplier {
  id: number;
  supplierId: number;
  isPrimary: boolean;
  leadTimeDays: number;
  /** Ime iz `customers`; `null` kad dobavljača nema u matičnim podacima. */
  supplier: { id: number; name: string } | null;
}

/** Artikal u listi — samo kolone koje tabela prikazuje (VP cena traži `masters.read`). */
export interface ItemRow {
  id: number;
  catalogNumber: string;
  barCode: string | null;
  name: string;
  unit: string | null;
  groupCode: string;
  /** Komercijalno — postoji samo uz `masters.read`. */
  wholesalePrice?: number | null;
  active: boolean | null;
  group: CodeRef | null;
}

/**
 * BAZNI SLOJ kartona artikla — stiže svakome ko sme da otvori ekran (`directory.read`):
 * identitet · klasifikacija · poreske tarife (šifre stopa) · dimenzije/pakovanje ·
 * opisi i prevodi · linkovi · status. `minQuantity` je logistička količina, ne cena.
 */
export interface ItemBase {
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
  hps: string | null;
  sortOrder: number | null;
  group: CodeRef | null;
  subgroup: CodeRef | null;
  origin: CodeRef | null;
  // Poreske tarife (šifre stopa i zemlja porekla — ne iznosi)
  goodsTaxRateCode: string;
  serviceTaxRateCode: string;
  alwaysTaxGoods: boolean | null;
  alwaysTaxServices: boolean | null;
  originCountry: string | null;
  // Dimenzije / pakovanje
  unit: string | null;
  baseUnit: string | null;
  packaging: string | null;
  quantityInPackage: number | null;
  box: number | null;
  transportPackaging: number | null;
  minQuantity: number | null;
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
  manufacturer: string | null;
  shelf: string | null;
  issuePlaceId: number | null;
  rasterId: number | null;
  notStockTracked: boolean | null;
  toDelete: boolean | null;
  active: boolean | null;
  signature: string | null;
  createdAt: string | null;
  // Child kolekcije (Talas B) — prazne dok bridge ne odradi prvi prolaz.
  /** Razrešen naziv klase kvaliteta za `qualityTypeId` (0 / nepoznat → null). */
  qualityType: ItemQualityTypeRef | null;
  barcodes: ItemBarcode[];
  translations: ItemTranslation[];
}

/**
 * KOMERCIJALNI SLOJ kartona artikla — stiže SAMO uz `masters.read`. Bez tog ključa
 * backend ove kolone ni ne pročita iz baze, pa su u tipu `Partial` (`undefined`).
 */
export interface ItemCommercial {
  // Cene
  wholesalePrice: number | null;
  retailPrice: number | null;
  fxPurchasePrice: number | null;
  fxSalePrice: number | null;
  priceToWritePricelist: number | null;
  // Marže / rabati / kalo
  /** Decimal → string. */
  manualMarkupPercent: string | null;
  maxDiscountPercent: number | null;
  promotionDiscount: number | null;
  retailLossPercent: number | null;
  wholesaleLossPercent: number | null;
  finalProcessingCost: number | null;
  // GK konta i dobavljač
  accountingCode: string | null;
  accountingCode2: string | null;
  supplierId: number | null;
  /** Puna lista dobavljača sa lead time-om — otkriva od koga i pod kojim uslovima kupujemo. */
  suppliers: ItemSupplier[];
  // Takse / akcize / carine / uslovi plaćanja
  itemFee: number | null;
  itemExcise: number | null;
  customsRate: number | null;
  customsTariff: string | null;
  paymentTermDays: number | null;
  nonTaxablePart: number | null;
}

/**
 * Karton artikla (`R_Artikli`, 67 kolona — v. `docs/migration/BIGBIT_ARTIKLI.md` §1).
 * Komercijalna polja su opciona jer ih odgovor NEMA bez `masters.read`.
 */
export type ItemDetail = ItemBase & Partial<ItemCommercial>;

export interface ItemListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  groupCode?: string;
  /** `true` = samo aktivni, `false` = samo neaktivni, izostavljeno = svi. */
  active?: boolean;
}

/** Paginirana lista artikala (~91k redova → uvek server-side, default 50/strana). */
export function useArtikli(params: ItemListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.q) qs.set('q', params.q);
  if (params.groupCode) qs.set('groupCode', params.groupCode);
  if (params.active !== undefined) qs.set('active', String(params.active));
  const query = qs.toString();
  return useQuery({
    queryKey: ['masters', 'artikli', params],
    queryFn: () => apiFetch<MastersPaginated<ItemRow>>(`/v1/artikli${query ? `?${query}` : ''}`),
  });
}

/** Jedan artikal — karton (skup kolona zavisi od `masters.read`, v. `meta.restricted`). */
export function useArtikal(id: number | null) {
  return useQuery({
    queryKey: ['masters', 'artikli', 'detail', id],
    queryFn: () => apiFetch<MastersDetail<ItemDetail>>(`/v1/artikli/${id}`),
    enabled: id != null,
  });
}

// -------------------------------------------------------------------- KOMITENTI

/**
 * Kontakt osoba komitenta (`KomitentiKontaktOsobe`). `Customer.contact` je samo JEDAN
 * string — ova lista je pravi 1:N (nabavka, knjigovodstvo, direktor…).
 * Datum rođenja backend NE vraća (lični podatak — v. `customers.service.ts`).
 */
export interface CustomerContact {
  id: number;
  contactPerson: string | null;
  phone: string | null;
  mobile: string | null;
  fax: string | null;
  email: string | null;
  /** `KontaktDefault` — podrazumevana kontakt osoba komitenta. */
  isDefault: boolean;
}

/**
 * Mesto isporuke (`MestaIsporuke`) — svaka lokacija nosi SVOJ GLN (bitno za SEF).
 * Komercijalna zaduženja lokacije (prodavac, uplatni račun, ruta, kanal prodaje)
 * backend namerno ne vraća.
 */
export interface CustomerDeliveryLocation {
  id: number;
  name: string;
  city: string | null;
  address: string | null;
  postalCode: string | null;
  phone: string | null;
  fax: string | null;
  /** `Podrucje` — područje/region isporuke. */
  area: string | null;
  gln: string | null;
  /** `AktivnoMISP`. */
  active: boolean;
  /** `BrojMestaIsporuke` — interni broj lokacije kod komitenta. */
  locationNumber: string | null;
}

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
 * BAZNI SLOJ kartona komitenta — stiže svakome ko sme da otvori ekran (`directory.read`).
 * Skup je NAMERNO identičan starijem `directory` pregledu (CUSTOMER_BUSINESS_SELECT):
 * identitet, adresa, kontakt, PIB/matični broj, napomena i prodavac.
 */
export interface CustomerBase {
  id: number;
  name: string;
  shortName: string | null;
  branch: string | null;
  // Adresa / kontakt
  address: string | null;
  city: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  fax: string | null;
  mobile: string | null;
  email: string | null;
  webAddress: string | null;
  contact: string | null;
  // Identifikacija
  taxId: string;
  registrationNumber: string | null;
  // Ostalo
  note: string | null;
  salespersonId: number | null;
  salesperson: SalespersonRef | null;
  // Child kolekcije (Talas B) — operativni podaci, pa su i u baznom sloju.
  // Prazne dok bridge ne odradi prvi prolaz.
  contacts: CustomerContact[];
  deliveryLocations: CustomerDeliveryLocation[];
}

/**
 * KOMERCIJALNI SLOJ kartona komitenta — stiže SAMO uz `masters.read`. Bez tog ključa
 * backend ove kolone ni ne pročita iz baze, pa su u tipu `Partial` (`undefined`).
 */
export interface CustomerCommercial {
  // Klasifikacija / marketing
  codeTypeCode: string | null;
  codeType: CodeRef | null;
  region: number | null;
  birthDate: string | null;
  mailToDifferentAddress: boolean | null;
  newsletter: boolean | null;
  hideInOverview: boolean | null;
  // Računi
  bankAccount1: string | null;
  bankAccount2: string | null;
  bankAccount3: string | null;
  paymentAccountId: number | null;
  paymentAccount: PaymentAccountRef | null;
  // Porezi / SEF
  skipTaxIdValidation: boolean | null;
  gln: string | null;
  publicSectorId: string | null;
  vatStatus: number | null;
  centralInvoiceRegistry: boolean | null;
  einvoiceXmlPerItemDiscount: boolean | null;
  invoicePerDeliveryAddress: boolean | null;
  // Komercijala
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
  // Napomene
  balanceNote: string | null;
  // Audit
  createdAt: string | null;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  recordCreatedAt: string | null;
  signature: string | null;
}

/**
 * Karton komitenta (`Komitenti`, 57 kolona — v. `docs/migration/BIGBIT_KOMITENTI.md` §1).
 * Komercijalna polja su opciona jer ih odgovor NEMA bez `masters.read`.
 */
export type CustomerDetail = CustomerBase & Partial<CustomerCommercial>;

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
    queryFn: () =>
      apiFetch<MastersPaginated<CustomerRow>>(`/v1/komitenti${query ? `?${query}` : ''}`),
  });
}

/** Jedan komitent — karton (skup kolona zavisi od `masters.read`, v. `meta.restricted`). */
export function useKomitent(id: number | null) {
  return useQuery({
    queryKey: ['masters', 'komitenti', 'detail', id],
    queryFn: () => apiFetch<MastersDetail<CustomerDetail>>(`/v1/komitenti/${id}`),
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
