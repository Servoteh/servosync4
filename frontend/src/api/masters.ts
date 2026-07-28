'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * Matični podaci 4.0 — Artikli i Komitenti (read-only pregled BigBit cache tabela).
 * Backend: `src/modules/masters` — modul ima ISKLJUČIVO GET rute
 * (`items.controller.ts`, `customers.controller.ts`).
 *   GET /v1/artikli        · lista (q: naziv/kat. broj/barkod; groupCode, active)
 *   GET /v1/artikli/:id    · pun slog + nazivi grupe/podgrupe/porekla
 *   GET /v1/komitenti      · lista (q: naziv/PIB/mesto; codeTypeCode)
 *   GET /v1/komitenti/:id  · pun slog + vrsta šifre / prodavac / uplatni račun
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

/** Artikal u listi — samo kolone koje tabela prikazuje. */
export interface ItemRow {
  id: number;
  catalogNumber: string;
  barCode: string | null;
  name: string;
  unit: string | null;
  groupCode: string;
  wholesalePrice: number | null;
  active: boolean | null;
  group: CodeRef | null;
}

/**
 * Pun slog artikla (`R_Artikli`, 67 kolona — v. `docs/migration/BIGBIT_ARTIKLI.md` §1).
 * Redosled polja prati sekcije detalja: identitet · klasifikacija · cene · PDV/carina ·
 * dimenzije · opisi · linkovi · ostalo.
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
  sortOrder: number | null;
  hps: string | null;
  notStockTracked: boolean | null;
  toDelete: boolean | null;
  active: boolean | null;
  signature: string | null;
  createdAt: string | null;
}

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
    queryFn: () => apiFetch<Paginated<ItemRow>>(`/v1/artikli${query ? `?${query}` : ''}`),
  });
}

/** Jedan artikal — pun slog za karticu artikla. */
export function useArtikal(id: number | null) {
  return useQuery({
    queryKey: ['masters', 'artikli', 'detail', id],
    queryFn: () => apiFetch<{ data: ItemDetail }>(`/v1/artikli/${id}`),
    enabled: id != null,
  });
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
