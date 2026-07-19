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
