'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

/**
 * PLAĆANJA — data sloj modula „Priprema plaćanja / virmani" (Faza 4 §C).
 * TanStack Query hooks nad NestJS `/api/v1/placanja/*`. Tipovi 1:1 sa backendom:
 *   backend/src/modules/placanja/placanja.controller.ts          (rute)
 *   backend/src/modules/placanja/payment-preparation.service.ts  (DueLiability, createPaymentOrders)
 *   backend/src/modules/placanja/payment-export.service.ts       (FX TXT izvoz)
 *
 * Tok: `useDueLiabilities(cutoff)` čita dospele obaveze → korisnik selektuje i
 * (po želji) edituje iznose → `useCreatePaymentOrders` kreira PaymentOrder redove
 * sa MOD97 pozivom na broj + DEDUP (409 na dvostruko plaćanje) → `useExportPayments`
 * proizvodi FX TXT (text/plain) koji se skida kao fajl (blob download).
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 * Decimal vrednosti stižu kao string (BACKEND_RULES §6) — `formatDecimal` na prikazu.
 */

const BASE = '/v1/placanja';

// ─────────────────────────────────────────────────────────────── status naloga

/**
 * Status naloga za plaćanje (`payment_orders.status`) — 1:1 sa status-mašinom
 * servisa (CREATED → SIGNED → PAID). `isLocked` je ortogonalno. Ulazi u kanonsku
 * mapu statusa (DESIGN_SYSTEM §7) kao PLAĆANJA domen.
 */
export const PAYMENT_ORDER_STATUS = {
  CREATED: 'CREATED', // Kreiran — nalog spreman, još nije potpisan/izvezen
  SIGNED: 'SIGNED', // Potpisan — odobren za slanje u banku
  PAID: 'PAID', // Plaćen — banka izvršila
} as const;

export type PaymentOrderStatus =
  (typeof PAYMENT_ORDER_STATUS)[keyof typeof PAYMENT_ORDER_STATUS];

// ─────────────────────────────────────────────────────────────── tipovi (envelope)

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * Jedna dospela otvorena obaveza (agregat po konto+komitent+dokument) —
 * 1:1 sa `DueLiability` iz payment-preparation.service.ts. `openAmount` je
 * Decimal-as-string; `dueDate` ISO string ili null.
 */
export interface DueLiability {
  accountCode: string;
  supplierId: number | null;
  documentNumber: string | null;
  /** otvoreni saldo obaveze = Σ(credit − debit); pozitivan = dugujemo. */
  openAmount: string;
  currency: string;
  /** ISO timestamp najranijeg dospeća po dokumentu; null = odmah dospelo. */
  dueDate: string | null;
  /** dana kašnjenja u odnosu na cutoff (>0 = kasni). */
  daysOverdue: number;
  /** najstariji ledger_entry.id grupe — traceback ka izvornoj stavci. */
  sourceLedgerEntryId: number;
}

/** Odgovor GET /placanja/due — lista + meta (cutoff, count). */
export interface DueLiabilitiesResponse {
  data: DueLiability[];
  meta: { cutoff: string; count: number };
}

/** Kreirani nalog za plaćanje — 1:1 sa `createPaymentOrders` povratkom. */
export interface CreatedPaymentOrder {
  id: number;
  orderNumber: string;
  supplierId: number;
  /** Decimal-as-string. */
  amount: string;
  referenceNumberCredit: string | null;
  status: PaymentOrderStatus;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['placanja'] as const,
  due: (cutoff: string | undefined) => ['placanja', 'due', cutoff ?? 'today'] as const,
};

// ─────────────────────────────────────────────────────────────── ulazni tipovi

/** Jedna linija naloga za plaćanje — 1:1 sa `CreatePaymentOrderLineInput`. */
export interface CreatePaymentOrderLineInput {
  supplierId: number;
  amount: number;
  documentNumber?: string;
  sourceLedgerEntryId?: number;
  /** PNB model u korist: "97" | "11" | "99" (default "97"). */
  referenceModelCredit?: string;
  /** Osnova poziva na broj u korist (bez kontrolne cifre). */
  referenceBaseCredit?: string;
  purpose?: string;
  currency?: string;
  dueDate?: string;
  supplierAccount?: string;
}

/** Telo POST /placanja/orders. */
export interface CreatePaymentOrdersInput {
  lines: CreatePaymentOrderLineInput[];
  companyId?: number;
  seriesNumber?: string;
  referenceModelDebit?: string;
  debitAccount?: string;
}

/** Telo POST /placanja/export (vodeći slog platioca + izabrani nalozi). */
export interface ExportPaymentsInput {
  orderIds: number[];
  debitAccount: string;
  debitName: string;
  debitPlace?: string;
  /** ISO datum na virmanu; default = danas. */
  orderDate?: string;
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
 * Dospele obaveze na dan `cutoff` (ISO datum; default danas — server odlučuje kad
 * je izostavljen). Vraća `{ data, meta:{ cutoff, count } }` sortirano po najdužem
 * kašnjenju. Permisija PLACANJA_READ.
 */
export function useDueLiabilities(cutoff?: string) {
  const query = buildQuery({ cutoff });
  return useQuery({
    queryKey: KEYS.due(cutoff),
    queryFn: () => apiFetch<DueLiabilitiesResponse>(`${BASE}/due${query}`),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

/**
 * Kreiraj naloge za plaćanje iz selekcije dospelih obaveza — POST /placanja/orders.
 * Po stavci jedan `PaymentOrder`; server računa MOD97 poziv na broj i primenjuje
 * DEDUP (`@@unique(referenceNumberCredit, supplierId)`). Backend baca 409
 * (ApiError.status===409) sa srpskom porukom kad nalog za istu fakturu i dobavljača
 * već postoji — pokušaj dvostrukog plaćanja odbijen. Permisija PLACANJA_PREPARE.
 */
export function useCreatePaymentOrders() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePaymentOrdersInput) =>
      apiFetch<Envelope<CreatedPaymentOrder[]>>(`${BASE}/orders`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

/**
 * Izvezi naloge u banku (FX fiksni TXT / Banca Intesa) — POST /placanja/export.
 * Endpoint vraća čist `text/plain` (NE JSON envelope), pa se povlači kroz
 * `apiBlob` (Authorization header) i vraća kao `Blob` — pozivalac ga skida
 * `createObjectURL`-om. Permisija PLACANJA_EXPORT.
 */
export function useExportPayments() {
  return useMutation({
    mutationFn: (input: ExportPaymentsInput) =>
      apiBlob(`${BASE}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
}

/**
 * Skini FX TXT kao fajl. Prima `Blob` iz `useExportPayments` i pokreće download
 * preko privremenog `<a download>` + `createObjectURL` (isti obrazac kao QC/HR
 * izvozi). URL se oslobađa posle klika (`revokeObjectURL`).
 */
export function downloadFxTxt(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
