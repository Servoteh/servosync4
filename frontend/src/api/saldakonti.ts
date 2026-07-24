'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

/**
 * SALDAKONTI — data sloj (Faza 4 §A). TanStack Query hooks nad NestJS
 * `/api/v1/saldakonti/*`. Tipovi 1:1 sa backend servisima:
 *   backend/src/modules/saldakonti/open-items.service.ts     (OpenItem, AgingByPartnerRow)
 *   backend/src/modules/saldakonti/reconciliation.service.ts (ReconcileResult)
 *   backend/src/modules/saldakonti/saldakonti.controller.ts  (rute, envelope)
 *
 * ENVELOPE: domenski endpointi vraćaju `{ data }` (open-items/aging dodaju
 * `meta.count`). Otvorene stavke se NE materijalizuju — izveden pogled nad
 * ledger_entries; nema paginacije (filter po kontu/komitentu sužava skup).
 *
 * NOVAC: Decimal u JSON-u je STRING (BACKEND_RULES §6) — `formatDecimal` na
 * prikazu, a sabiranje ide preko `Number(...)` (dovoljno za prikaz salda;
 * knjiženje presuđuje backend). Komponente NE zovu API direktno — samo kroz
 * ove hook-ove (frontend/CLAUDE.md §8).
 */

const BASE = '/v1/saldakonti';

// ─────────────────────────────────────────────────────────────── tipovi (envelope)

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Lista + `meta.count` (open-items / aging). */
export interface ListWithCount<T> {
  data: T[];
  meta: { count: number };
}

/**
 * Otvorena stavka (izveden pogled nad `ledger_entries`) — 1:1 sa
 * `OpenItem` u open-items.service.ts. Decimal polja stižu kao STRING.
 * `side` = receivable | payable (iz saldakonto registra).
 */
export interface OpenItem {
  accountCode: string;
  /** Analitička = komitent (null = sintetika bez analitike). */
  analyticalCode: number | null;
  documentNumber: string | null;
  /** Σ debit − Σ credit; dugovni saldo pozitivan (Decimal-as-string). */
  balance: string;
  totalDebit: string;
  totalCredit: string;
  /** Najranije dospeće u grupi (ISO datum) ili null. */
  dueDate: string | null;
  /** asOf − dueDate (dana); null ako nema dospeća. */
  daysOverdue: number | null;
  currency: string | null;
  side: string; // receivable | payable
  /** Svi ledger_entries.id koji čine ovaj red — za uparivanje (reconcile) i kompenzaciju. */
  ledgerEntryIds: number[];
}

/** Aging red po komitentu — saldo raspoređen po dospelosti (Decimal-as-string). */
export interface AgingByPartnerRow {
  analyticalCode: number | null;
  bucket0_30: string;
  bucket31_60: string;
  bucket61_90: string;
  bucket90plus: string;
  total: string;
}

/** Rezultat uparivanja (reconcile) — 1:1 sa `ReconcileResult`. */
export interface ReconcileResult {
  groupId: number;
  entryIds: number[];
  totalDebit: string;
  totalCredit: string;
  /** Σdebit − Σcredit (kursna razlika/otpis; ≤ tolerancija za auto). */
  residual: string;
  balanced: boolean;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['saldakonti'] as const,
  openItems: ['saldakonti', 'open-items'] as const,
  aging: ['saldakonti', 'aging'] as const,
};

// ─────────────────────────────────────────────────────────────── ulazni tipovi

export interface OpenItemsFilters {
  /** Tačan konto iz saldakonto registra (opciono; podrazumeva sve). */
  accountCode?: string;
  /** Analitička = komitent (opciono). */
  partnerId?: number | '';
  /** Presek na dan (ISO datum; default backend = danas). */
  asOf?: string;
}

export interface AgingFilters {
  accountCode?: string;
  asOf?: string;
}

/** Telo POST /saldakonti/reconcile — uparivanje datih ledger stavki. */
export interface ReconcileInput {
  entryIds: number[];
  /** auto (default) traži balans; manual je za ručno zatvaranje sa ostatkom. */
  mode?: 'auto' | 'manual';
  note?: string;
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
 * Lista otvorenih stavki (+ filter po kontu i komitentu). Bez filtera vraća sve
 * otvorene stavke svih saldakonto konta. Permisija SALDAKONTI_READ.
 */
export function useOpenItems(filters: OpenItemsFilters = {}) {
  const query = buildQuery({
    accountCode: filters.accountCode || undefined,
    partnerId: filters.partnerId === '' ? undefined : filters.partnerId,
    asOf: filters.asOf || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.openItems, filters],
    queryFn: () => apiFetch<ListWithCount<OpenItem>>(`${BASE}/open-items${query}`),
  });
}

/**
 * Aging po komitentu za dati konto (default svi saldakonto konti). Bucketi
 * 0-30 / 31-60 / 61-90 / 90+ po dospelosti (asOf − dueDate). Permisija
 * SALDAKONTI_READ.
 */
export function useAging(accountCode?: string, asOf?: string) {
  const query = buildQuery({
    accountCode: accountCode || undefined,
    asOf: asOf || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.aging, { accountCode: accountCode ?? '', asOf: asOf ?? '' }],
    queryFn: () => apiFetch<ListWithCount<AgingByPartnerRow>>(`${BASE}/aging${query}`),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateSaldakonti() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Upari (zatvori) otvorene stavke — POST /saldakonti/reconcile { entryIds, mode?, note? }.
 * `auto` (default) zahteva balans u granici tolerancije; sve stavke moraju biti
 * isti (kontrolni konto, komitent) i otvorene. Backend vraća 400 za <2 stavke ili
 * duplikate, 422 za nebalansirano/različit konto. Menja ledger stavke (reconciled_at),
 * pa invalidira ceo `saldakonti` ključ. Permisija SALDAKONTI_RECONCILE.
 */
export function useReconcile() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (input: ReconcileInput) =>
      apiFetch<Envelope<ReconcileResult>>(`${BASE}/reconcile`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Razveži uparenu grupu — POST /saldakonti/reconcile/unreconcile { groupId }.
 * Backend čisti reconciled_at + group na svim redovima grupe (404 ako grupa ne
 * postoji). Permisija SALDAKONTI_RECONCILE.
 */
export function useUnreconcile() {
  const invalidate = useInvalidateSaldakonti();
  return useMutation({
    mutationFn: (groupId: number) =>
      apiFetch<Envelope<unknown>>(`${BASE}/reconcile/unreconcile`, {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── kompenzacije (BigBit paritet — FE nad postojećim BE)

export interface CompensationProposalLine {
  ledgerEntryId: number | null;
  accountCode: string;
  documentNumber: string | null;
  side: 'receivable' | 'payable';
  openAmount: string;
  suggestedOffset: string;
}

export interface CompensationProposal {
  partnerId: number;
  totalReceivable: string;
  totalPayable: string;
  offsetAmount: string;
  lines: CompensationProposalLine[];
}

export interface CompensationLineInput {
  ledgerEntryId: number;
  side: 'receivable' | 'payable';
  amount: string;
}

/** Predlog kompenzacije iz otvorenih stavki partnera (GET /saldakonti/compensation/proposal). */
export function useCompensationProposal(partnerId: number | null) {
  return useQuery({
    queryKey: ['saldakonti', 'compensation', 'proposal', partnerId],
    queryFn: () =>
      apiFetch<{ data: CompensationProposal | null; meta?: { error?: string } }>(
        `${BASE}/compensation/proposal?partnerId=${partnerId}`,
      ),
    enabled: partnerId != null && partnerId > 0,
  });
}

/** Kreiraj (i knjiži) kompenzaciju — POST /saldakonti/compensation. */
export function useCreateCompensation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      partnerId: number;
      date?: string;
      note?: string;
      lines: CompensationLineInput[];
      post?: boolean;
    }) =>
      apiFetch<Envelope<{ id: number; number: string; status: string }>>(`${BASE}/compensation`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saldakonti'] }),
  });
}

// ─────────────────────────────────── IOS/NIOS obrazac usaglašavanja (E3 — PDF)

/** Ulaz IOS štampe — komitent + opcioni datum preseka (default backend = danas). */
export interface IosPdfInput {
  partnerId: number;
  /** Datum preseka (ISO datum); bez njega backend uzima danas. */
  asOf?: string;
}

/**
 * Preuzmi IOS/NIOS obrazac usaglašavanja salda za komitenta — GET
 * /saldakonti/ios-pdf?partnerId=&asOf=. Zakonski godišnji obrazac: otvorene
 * stavke komitenta na dan preseka + polja za saglasnost/osporavanje i potpise.
 * NIOS = isti obrazac kad nema otvorenih stavki (saldo 0) — svejedno se štampa.
 * Vraća PDF Blob (otvori kroz `openPdf`). read = SALDAKONTI_READ.
 */
export function useIosPdf() {
  return useMutation({
    mutationFn: (input: IosPdfInput) => {
      const qs = new URLSearchParams({ partnerId: String(input.partnerId) });
      if (input.asOf) qs.set('asOf', input.asOf);
      return apiBlob(`${BASE}/ios-pdf?${qs.toString()}`);
    },
  });
}

/** Otvori PDF Blob u novom tabu (browser preview + download). */
export function openPdf(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
