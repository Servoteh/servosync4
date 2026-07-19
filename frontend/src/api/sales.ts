'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Sales / Fakturisanje — data sloj (Faza 5 §A). TanStack Query hooks nad NestJS
 * `/api/v1/sales/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/sales/sales.controller.ts        (rute)
 *   backend/src/modules/sales/fakturisanje.service.ts    (envelope, status-mašina)
 *   Prisma Invoice / InvoiceItem                          (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): lista računa paginira preko `skip`/`take` (NE page/pageSize kao
 * robno) i vraća `{ data, meta: { total, skip, take } }`. Detalj i mutacije vraćaju
 * SIROV Invoice objekat (bez `{ data }` omotača — servis ne obmotava). Decimal polja
 * stižu kao string (BACKEND_RULES §6) — formatDecimal na prikazu.
 */

const BASE = '/v1/sales';

// ─────────────────────────────────────────────────────────────── status + tip

/**
 * Status računa (`invoices.status`) — 1:1 sa backend servisom. DRAFT (predračun /
 * pre knjiženja) → POSTED (proknjižen, definitivan broj + nalog GK); SENT (poslat
 * kupcu/SEF), PAID (plaćen), CANCELLED (storniran). Ulaze u kanonsku mapu statusa
 * (DESIGN_SYSTEM §7) kao SALES domen.
 */
export const SALES_STATUS = {
  DRAFT: 'DRAFT', // U pripremi — predračun ili račun pre knjiženja
  POSTED: 'POSTED', // Proknjižen — rezervisan broj + nalog u glavnoj knjizi
  SENT: 'SENT', // Poslat — kupcu / na SEF
  PAID: 'PAID', // Plaćen — zatvorena stavka
  CANCELLED: 'CANCELLED', // Storniran / otkazan
} as const;

export type SalesStatus = (typeof SALES_STATUS)[keyof typeof SALES_STATUS];

/**
 * Vrsta dokumenta (`invoices.document_type`) — 1:1 sa backend `documentType`.
 * PON/PROF = draft predračun/ponuda (level 250); IFR/IFGP/IFUSL = domaći račun
 * (level 0); IZVRO/IZVGP/IZVUS = izvoz; AVR = avansni; REV = revers.
 */
export const SALES_DOCUMENT_TYPE = {
  PON: 'PON', // Ponuda (draft)
  PROF: 'PROF', // Predračun (draft)
  IFR: 'IFR', // Izlazni račun — roba
  IFGP: 'IFGP', // Izlazni račun — gotov proizvod
  IFUSL: 'IFUSL', // Izlazni račun — usluga
  IZVRO: 'IZVRO', // Izvozni račun — roba
  IZVGP: 'IZVGP', // Izvozni račun — gotov proizvod
  IZVUS: 'IZVUS', // Izvozni račun — usluga
  AVR: 'AVR', // Avansni račun
  REV: 'REV', // Revers
} as const;

export type SalesDocumentType =
  (typeof SALES_DOCUMENT_TYPE)[keyof typeof SALES_DOCUMENT_TYPE];

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Paginirani odgovor liste računa — backend šalje `meta: { total, skip, take }`. */
export interface SalesListResponse<T> {
  data: T[];
  meta: {
    total: number;
    skip: number;
    take: number;
  };
}

// ─────────────────────────────────────────────────────────────── entiteti

/**
 * Stavka izlaznog računa (`invoice_items`) — Decimal polja kao string
 * (BACKEND_RULES §6). `unitPrice` = transakciona VP (PricingService); `vatBase` =
 * osnovica posle rabata/kase; `lineTotal` = osnovica + PDV.
 */
export interface InvoiceItem {
  id: number;
  invoiceId: number;
  lineNo: number;
  itemId: number | null;
  description: string | null;
  /** Decimal-as-string. */
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  cashDiscountPercent: string;
  vatRateCode: string;
  vatBase: string;
  vatAmount: string;
  lineTotal: string;
  copiedFromItemId: number | null;
}

/** Red radne liste računa — GET /sales/invoices (zaglavlje bez stavki). */
export interface Invoice {
  id: number;
  documentType: SalesDocumentType | string;
  documentNumber: string;
  /** 250 = draft/predračun; 0 = knjižen račun. */
  level: number;
  companyId: number;
  customerId: number | null;
  documentDate: string;
  dueDate: string | null;
  currency: string;
  /** Zbirni iznosi (Decimal-as-string, denormalizovano iz stavki). */
  netTotal: string;
  vatTotal: string;
  grossTotal: string;
  status: SalesStatus | string;
  isExport: boolean;
  journalEntryId: number | null;
  stockDocumentId: number | null;
  salespersonId: number | null;
  workOrderId: number | null;
  linkedInvoiceDocId: number | null;
  copiedFromDocId: number | null;
  note: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Detalj računa — zaglavlje + stavke (GET /sales/invoices/:id). */
export interface InvoiceDetail extends Invoice {
  items: InvoiceItem[];
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['sales'] as const,
  invoices: ['sales', 'invoices'] as const,
  invoice: (id: number) => ['sales', 'invoices', id] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface InvoiceFilters {
  /** 1-bazna strana (UI); prevodi se u `skip`/`take`. */
  page?: number;
  /** Veličina strane (backend default 50, max 200). */
  pageSize?: number;
  documentType?: SalesDocumentType | '';
  status?: SalesStatus | '';
  level?: number | '';
  customerId?: number | '';
  isExport?: boolean;
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
 * Radna lista računa (filter po tipu/statusu/nivou/kupcu/izvozu, server-side
 * paginacija preko `skip`/`take`). Vraća `{ data, meta: { total, skip, take } }`.
 * `pageSize` podrazumevano 50.
 */
export function useInvoices(filters: InvoiceFilters = {}) {
  const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : 50;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const skip = (page - 1) * pageSize;
  const query = buildQuery({
    skip: skip > 0 ? skip : undefined,
    take: pageSize !== 50 ? pageSize : undefined,
    documentType: filters.documentType === '' ? undefined : filters.documentType,
    status: filters.status === '' ? undefined : filters.status,
    level: filters.level === '' ? undefined : filters.level,
    customerId: filters.customerId === '' ? undefined : filters.customerId,
    isExport: filters.isExport === undefined ? undefined : String(filters.isExport),
  });
  return useQuery({
    queryKey: [...KEYS.invoices, filters],
    queryFn: () => apiFetch<SalesListResponse<Invoice>>(`${BASE}/invoices${query}`),
  });
}

/**
 * Detalj jednog računa (zaglavlje + stavke) — GET /sales/invoices/:id. Vraća SIROV
 * Invoice (bez `{ data }` omotača). `enabled` gasi upit dok id nije poznat.
 */
export function useInvoice(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.invoice(id) : [...KEYS.invoices, 'detail', null],
    queryFn: () => apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}`),
    enabled: id != null,
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateSales() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/** Ulazna stavka predračuna (POST /sales/proformas) — 1:1 sa `CreateProformaItemInput`. */
export interface CreateProformaItemInput {
  itemId?: number;
  description?: string;
  quantity: number;
  unitPrice?: number;
  discountPercent?: number;
  cashDiscountPercent?: number;
  vatRateCode?: string;
}

/** Telo za kreiranje predračuna/ponude (POST /sales/proformas) — 1:1 sa `CreateProformaDto`. */
export interface CreateProformaInput {
  /** PON | PROF — draft (level 250). Default PROF. */
  documentType?: 'PON' | 'PROF';
  companyId?: number;
  customerId: number;
  documentDate?: string;
  dueDate?: string;
  currency?: string;
  isExport?: boolean;
  note?: string;
  items: CreateProformaItemInput[];
}

/**
 * Kreiraj predračun/ponudu (PON/PROF, level 250, DRAFT) — POST /sales/proformas.
 * Vraća SIROV Invoice sa stavkama. Permisija SALES_WRITE. Invalidira `sales` ključ.
 */
export function useCreateProforma() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: (input: CreateProformaInput) =>
      apiFetch<InvoiceDetail>(`${BASE}/proformas`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Carry-over predračun → račun (PROF → IFR/IFGP/IFUSL/IZVRO…) — POST
 * /sales/invoices/:id/from-proforma. `targetType` = ciljna level-0 vrsta.
 * Vraća SIROV novi Invoice (level-0 draft). Permisija SALES_WRITE.
 */
export function useCreateInvoiceFromProforma() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: (args: { id: number; targetType: string }) =>
      apiFetch<InvoiceDetail>(`${BASE}/invoices/${args.id}/from-proforma`, {
        method: 'POST',
        body: JSON.stringify({ targetType: args.targetType }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Knjiženje računa (DRAFT → POSTED: rezerviši definitivan broj + nalog GK) —
 * POST /sales/invoices/:id/post. Vraća SIROV proknjižen Invoice. Permisija
 * SALES_POST. Invalidira `sales` ključ.
 */
export function usePostInvoice() {
  const invalidate = useInvalidateSales();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<InvoiceDetail>(`${BASE}/invoices/${id}/post`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}
