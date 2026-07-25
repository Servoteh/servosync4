'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Robno / magacin — data sloj (Faza 3). TanStack Query hooks nad NestJS
 * `/api/v1/robno/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/robno/robno.controller.ts (rute)
 *   backend/src/modules/robno/robno.service.ts     (envelope, status-mašina)
 *   Prisma StockDocument / StockDocumentItem        (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): robno lista paginira preko `page`/`pageSize` i vraća
 * `{ data, meta: { pagination: { page, pageSize, total, totalPages } } }` (pageMeta,
 * NE skip/take kao nabavka). Detalj vraća `{ data }`. Decimal polja stižu kao string
 * (BACKEND_RULES §6) — formatDecimal na prikazu.
 */

const BASE = '/v1/robno';

// ─────────────────────────────────────────────────────────────── status + kind

/**
 * Status robnog dokumenta (`stock_documents.status`) — 1:1 sa backend servisom.
 * DRAFT → CALCULATED (kalkulacija) → POSTED (knjiženje u GK); LOCKED je zaključan
 * period. Ulaze u kanonsku mapu statusa (DESIGN_SYSTEM §7) kao ROBNO domen.
 */
export const ROBNO_STATUS = {
  DRAFT: 'DRAFT', // U pripremi — dokument tek kreiran
  CALCULATED: 'CALCULATED', // Kalkulisan — landed cost izračunat, čeka knjiženje
  POSTED: 'POSTED', // Proknjižen — nalog u glavnoj knjizi
  LOCKED: 'LOCKED', // Zaključan period — samo pregled
} as const;

export type RobnoStatus = (typeof ROBNO_STATUS)[keyof typeof ROBNO_STATUS];

/** Diskriminator robnog dokumenta (`stock_documents.kind`) — 1:1 sa backend `StockDocumentKind`. */
export const ROBNO_KIND = {
  UL: 'UL', // Ulaz (prijem/nabavka)
  IZ: 'IZ', // Izlaz
  NIV: 'NIV', // Nivelacija (promena cene)
  PRENOS: 'PRENOS', // Prenos između magacina
  VISAK: 'VISAK', // Višak (popis)
  MANJAK: 'MANJAK', // Manjak (popis)
} as const;

export type RobnoKind = (typeof ROBNO_KIND)[keyof typeof ROBNO_KIND];

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Paginirani odgovor (`pageMeta`) — backend šalje `meta.pagination`. */
export interface Paginated<T> {
  data: T[];
  meta: {
    pagination: {
      page: number;
      pageSize: number;
      total: number;
      totalPages: number;
    };
  };
}

/**
 * Stavka robnog dokumenta (`stock_document_items`) — Decimal polja kao string
 * (BACKEND_RULES §6). Sirovi ulazni iznosi + landed (kalkulisana) polja koja
 * popunjava `CalculationService` pri kalkulaciji.
 */
export interface StockDocumentItem {
  id: number;
  documentId: number;
  itemId: number;
  warehouseId: number;
  lineNo: number;
  /** Uvek pozitivna količina — znak izlaza se izvodi iz tipa dokumenta. */
  quantity: string;
  kgQuantity: string | null;
  // — sirovi ulazni iznosi (domaća kaskada) —
  invoicePrice: string | null;
  discountPercent: string | null;
  cashDiscountPercent: string | null;
  /** Nabavna neto cena (posle rabata/kase) — landed baza. */
  purchasePriceNet: string | null;
  // — landed / kalkulisano —
  /** Izračunata VP (kalkulacija landed cost). */
  calculatedWholesalePrice: string | null;
  /** Stvarna VP (transakciona / prodajna) — uneta. */
  actualWholesalePrice: string | null;
}

/** Nivelacioni par (`stock_leveling_items`) — nastaje pri kalkulaciji UL dokumenta. */
export interface StockLevelingItem {
  id: number;
  documentId: number;
  itemId: number;
  warehouseId: number;
  /** Stara VP pre nivelacije (Decimal-as-string). */
  oldWholesalePrice: string | null;
  /** Nova VP posle nivelacije (Decimal-as-string). */
  newWholesalePrice: string | null;
  quantity: string | null;
}

/** Red radne liste robnih dokumenata — GET /robno/documents (zaglavlje bez stavki). */
export interface StockDocument {
  id: number;
  kind: RobnoKind;
  documentTypeCode: string;
  /** Broj „NNNN/god" (server generiše). */
  documentNumber: string;
  year: number;
  warehouseId: number;
  targetWarehouseId: number | null;
  supplierId: number | null;
  customerId: number | null;
  documentDate: string;
  postingDate: string | null;
  status: RobnoStatus;
  isCalculated: boolean;
  isImport: boolean;
  /** Nalog GK (meki ref) — `!= null` znači „proknjižen" (booked); uslov za zaključavanje. */
  journalEntryId: number | null;
  projectId: number | null;
  workOrderId: number | null;
  purchaseOrderId: number | null;
  note: string | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string | null;
}

/** Detalj robnog dokumenta — zaglavlje + stavke + nivelacioni parovi (GET /:id). */
export interface StockDocumentDetail extends StockDocument {
  items: StockDocumentItem[];
  stockLevelingItems: StockLevelingItem[];
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['robno'] as const,
  documents: ['robno', 'documents'] as const,
  document: (id: number) => ['robno', 'documents', id] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface RobnoFilters {
  /** 1-bazna strana (UI). */
  page?: number;
  /** Veličina strane (backend default 50). */
  pageSize?: number;
  kind?: RobnoKind | '';
  status?: RobnoStatus | '';
  documentTypeCode?: string;
  warehouseId?: number | '';
  year?: number | '';
  /** Opseg po `documentDate` (ISO). */
  from?: string;
  to?: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

// ─────────────────────────────────────────────────────────────── queries

/**
 * Radna lista robnih dokumenata (filter po tipu/statusu/magacinu/godini/opsegu
 * datuma, server-side paginacija preko `page`/`pageSize`). Vraća `{ data, meta:
 * { pagination } }`. `pageSize` podrazumevano 50.
 */
export function useStockDocuments(filters: RobnoFilters = {}) {
  const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : 50;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const query = buildQuery({
    page: page > 1 ? page : undefined,
    pageSize: pageSize !== 50 ? pageSize : undefined,
    kind: filters.kind === '' ? undefined : filters.kind,
    status: filters.status === '' ? undefined : filters.status,
    documentTypeCode: filters.documentTypeCode || undefined,
    warehouseId: filters.warehouseId === '' ? undefined : filters.warehouseId,
    year: filters.year === '' ? undefined : filters.year,
    from: filters.from || undefined,
    to: filters.to || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.documents, filters],
    queryFn: () => apiFetch<Paginated<StockDocument>>(`${BASE}/documents${query}`),
  });
}

/**
 * Detalj jednog robnog dokumenta (zaglavlje + stavke + nivelacioni parovi) —
 * GET /robno/documents/:id. `enabled` gasi upit dok id nije poznat.
 */
export function useStockDocument(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.document(id) : [...KEYS.documents, 'detail', null],
    queryFn: () =>
      apiFetch<Envelope<StockDocumentDetail>>(`${BASE}/documents/${id}`),
    enabled: id != null,
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateRobno() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Kalkulacija landed cost (DRAFT → CALCULATED) — POST /robno/documents/:id/calculate.
 * UL okida nivelaciju (puni `stockLevelingItems`). Menja dokument + stavke + nivelaciju,
 * pa invalidira ceo `robno` ključ. Permisija ROBNO_WRITE.
 */
export function useCalculate() {
  const invalidate = useInvalidateRobno();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<StockDocumentDetail>>(`${BASE}/documents/${id}/calculate`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Rezultat knjiženja — sažetak (backend ne vraća interni LedgerLineDraft[]). */
export interface PostResult {
  docId: number;
  ledgerLines: number;
  posted: boolean;
}

/**
 * Knjiženje u glavnu knjigu (CALCULATED → POSTED) — POST /robno/documents/:id/post.
 * StockDocument → nalog GK. Menja status dokumenta, pa invalidira ceo `robno` ključ.
 * Permisija ROBNO_POST.
 */
export function usePost() {
  const invalidate = useInvalidateRobno();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<PostResult>>(`${BASE}/documents/${id}/post`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Rezultat zaključavanja robnog dokumenta (status → LOCKED). */
export interface LockResult {
  id: number;
  status: RobnoStatus;
  isLocked: boolean;
}

/**
 * Zaključaj proknjižen robni dokument (booked → LOCKED) — POST /robno/documents/:id/lock.
 * Zaključan dokument je immutable (calculate/post ga odbijaju). Menja status, pa invalidira
 * ceo `robno` ključ. Permisija ROBNO_WRITE.
 */
export function useLockDocument() {
  const invalidate = useInvalidateRobno();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<Envelope<LockResult>>(`${BASE}/documents/${id}/lock`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── stavke: soft-delete + Undo (Batch B)

/** Odgovor brisanja stavke — nosi prozor za „Poništi" (ms). */
export interface DeleteItemResult {
  docId: number;
  itemLineId: number;
  deleted: boolean;
  /** Trajanje undo prozora u ms (backend `UNDO_WINDOW_MS`, 30000). */
  undoWindowMs: number;
}

/** Odgovor poništavanja (undo) brisanja stavke. */
export interface RestoreItemResult {
  docId: number;
  itemLineId: number;
  restored: boolean;
}

/**
 * Meko obriši stavku dokumenta (poništivo) — DELETE /robno/documents/:docId/items/:itemLineId.
 * Obrisana stavka nestaje iz detalja; invalidira `robno` ključ (detalj se osvežava).
 * Guard je na backendu (dokument nije proknjižen/zaključan → 409). Permisija ROBNO_WRITE.
 */
export function useDeleteStockItem() {
  const invalidate = useInvalidateRobno();
  return useMutation({
    mutationFn: ({ docId, itemLineId }: { docId: number; itemLineId: number }) =>
      apiFetch<Envelope<DeleteItemResult>>(
        `${BASE}/documents/${docId}/items/${itemLineId}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

/**
 * Poništi brisanje stavke (undo) — POST /robno/documents/:docId/items/:itemLineId/restore.
 * Radi samo unutar 30 s (inače 409 — rok istekao). Invalidira `robno` ključ. Permisija ROBNO_WRITE.
 */
export function useRestoreStockItem() {
  const invalidate = useInvalidateRobno();
  return useMutation({
    mutationFn: ({ docId, itemLineId }: { docId: number; itemLineId: number }) =>
      apiFetch<Envelope<RestoreItemResult>>(
        `${BASE}/documents/${docId}/items/${itemLineId}/restore`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── lager lista (BigBit paritet)

/** Jedan red lagera — 1:1 sa backend listLager(). Sve količine/cene kao string. */
export interface LagerRow {
  itemId: number;
  warehouseId: number;
  itemName: string | null;
  itemCode: string | null;
  unit: string | null;
  onHand: string;
  reserved: string;
  avgPurchaseNet: string;
  avgWholesalePrice: string;
  stockValue: string;
}

export interface LagerResponse {
  data: LagerRow[];
  meta: { total: number; skip: number; take: number };
}

/** Lager lista — stanje zaliha po magacinu + prosečne cene (GET /robno/lager). */
export function useLager(filters: { warehouseId?: number; onlyInStock?: boolean; q?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.warehouseId != null) params.set('warehouseId', String(filters.warehouseId));
  if (filters.onlyInStock) params.set('onlyInStock', 'true');
  if (filters.q) params.set('q', filters.q);
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['robno', 'lager', filters],
    queryFn: () => apiFetch<LagerResponse>(`${BASE}/lager${query}`),
  });
}

// ─────────────────────────────────── kreiranje robnog dokumenta (BigBit paritet)

/** Stavka novog robnog dokumenta (osnovni skup — napredna polja opciona). */
export interface CreateStockItemInput {
  itemId: number;
  quantity: number;
  invoicePrice?: number;
}

/** Telo POST /robno/documents — kind + zaglavlje + stavke (1:1 sa backend DTO, osnovni skup). */
export interface CreateStockDocumentInput {
  kind: RobnoKind;
  documentTypeCode: string;
  warehouseId: number;
  supplierId?: number;
  customerId?: number;
  documentDate?: string;
  items: CreateStockItemInput[];
}

/** Kreiraj robni dokument (POST /robno/documents) — status DRAFT. */
export function useCreateStockDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStockDocumentInput) =>
      apiFetch<Envelope<StockDocumentDetail>>(`${BASE}/documents`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['robno'] }),
  });
}

// ─────────────────────────────────── carry-over (prepis dokumenata, Batch B)

/**
 * Opcije prepisa (carry-over) — magacin i vrsta dokumenta se preklapaju sa podrazumevanih
 * (backend default: magacin 1, UFROB za prijem / IFR za izdatnicu). 1:1 sa `CarryOverOptions`.
 */
export interface CarryOverInput {
  warehouseId?: number;
  documentTypeCode?: string;
}

/**
 * Prepis narudžbenice → robni ulaz (Primka, UL) — POST /robno/documents/from-purchase-order/:orderId.
 * Stavke/količine/cene iz narudžbenice; veže `purchaseOrderId`. Nacrt narudžbenica = 422,
 * ponovni prepis = 409. Vraća kreiran robni dokument (envelope `{ data }`).
 */
export function useCarryOverFromPurchaseOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ orderId, ...body }: CarryOverInput & { orderId: number }) =>
      apiFetch<Envelope<StockDocumentDetail>>(
        `${BASE}/documents/from-purchase-order/${orderId}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['robno'] }),
  });
}

/**
 * Prepis predračuna/fakture → izdatnica (robni izlaz IZ) — POST /robno/documents/from-invoice/:invoiceId.
 * Stavke sa artiklom iz fakture; IZ prolazi kroz proveru dovoljnog stanja (nedovoljno = 422),
 * već prenet dokument = 409. Vraća kreiran robni dokument (envelope `{ data }`).
 */
export function useCarryOverFromInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, ...body }: CarryOverInput & { invoiceId: number }) =>
      apiFetch<Envelope<StockDocumentDetail>>(
        `${BASE}/documents/from-invoice/${invoiceId}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['robno'] }),
  });
}

// ─────────────────────────────────── kartica artikla (BigBit paritet)

/** Jedan red kartice artikla — kretanje po magacinu (ulaz/izlaz/running-stanje). */
export interface ItemCardLine {
  itemLineId: number;
  documentId: number;
  documentNumber: string;
  kind: RobnoKind;
  documentTypeCode: string;
  documentDate: string;
  direction: 'IN' | 'OUT';
  /** Ulaz (Decimal-as-string; 0 za izlazne redove). */
  in: string;
  /** Izlaz (Decimal-as-string; 0 za ulazne redove). */
  out: string;
  /** Running stanje posle ovog reda (Decimal-as-string). */
  balance: string;
}

/** Odgovor kartice artikla — GET /robno/item-card. Sve količine kao string (Decimal). */
export interface ItemCardResponse {
  itemId: number;
  warehouseId: number;
  from: string | null;
  to: string;
  item: { id: number; name: string | null; code: string | null; unit: string | null } | null;
  /** Stanje pre `from` (početno stanje). */
  openingBalance: string;
  /** Running stanje na kraju prozora — jednako `stateAsOf`. */
  closingBalance: string;
  /** Nezavisno izračunato stanje na dan `to` (costing) — kontrolna vrednost. */
  stateAsOf: string;
  totalIn: string;
  totalOut: string;
  lines: ItemCardLine[];
}

export interface ItemCardFilters {
  itemId: number | null;
  warehouseId: number | null;
  from?: string;
  to?: string;
}

/**
 * Kartica artikla — hronološko kretanje po (artikal, magacin) sa running stanjem
 * (GET /robno/item-card). Upit je isključen dok artikal i magacin nisu poznati.
 */
export function useItemCard(filters: ItemCardFilters) {
  const { itemId, warehouseId } = filters;
  const enabled = itemId != null && itemId > 0 && warehouseId != null && warehouseId > 0;
  const params = new URLSearchParams();
  if (enabled) {
    params.set('itemId', String(itemId));
    params.set('warehouseId', String(warehouseId));
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  const query = params.toString() ? `?${params.toString()}` : '';
  return useQuery({
    queryKey: ['robno', 'item-card', filters],
    queryFn: () => apiFetch<Envelope<ItemCardResponse>>(`${BASE}/item-card${query}`),
    enabled,
  });
}
