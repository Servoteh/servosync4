'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Glavna knjiga (GK) — data sloj (Faza 2, READ). TanStack Query hooks nad NestJS
 * `/api/v1/gl/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/gl/gl.controller.ts     (rute, query params)
 *   backend/src/modules/gl/gl-read.service.ts   (envelope, running saldo)
 *   Prisma JournalEntry / LedgerEntry            (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope):
 *   • dnevnik lista paginira preko `skip`/`take` i vraća `{ data, meta: { total } }`.
 *   • nalog detalj vraća `{ data: nalog + lines }`.
 *   • kartica konta vraća `{ data: stavke sa running saldom, meta: { totalDebit,
 *     totalCredit, balance, count } }`.
 * Decimal polja (duguje/potražuje/saldo) stižu kao string (BACKEND_RULES §6) —
 * formatDecimal na prikazu.
 */

const BASE = '/v1/gl';

// ─────────────────────────────────────────────────────────────── status

/**
 * Status naloga glavne knjige (`journal_entries.status`) — 1:1 sa backend servisom.
 * DRAFT → POSTED (proknjižen u GK) → LOCKED (zaključan period). Ulazi u kanonsku
 * mapu statusa (DESIGN_SYSTEM §7) kao GK domen.
 */
export const GL_STATUS = {
  DRAFT: 'draft', // U pripremi — nalog tek kreiran
  POSTED: 'posted', // Proknjižen — stavke ušle u glavnu knjigu
  LOCKED: 'locked', // Zaključan period — samo pregled
} as const;

export type GlStatus = (typeof GL_STATUS)[keyof typeof GL_STATUS];

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Ne-paginirani odgovor domenskog endpointa (`{ data }` ili `{ data, meta }`). */
export interface Envelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

/** Paginirani odgovor dnevnika — backend šalje `meta.total` (skip/take). */
export interface SkipTakePaginated<T> {
  data: T[];
  meta: { total: number };
}

// ─────────────────────────────────────────────────────────────── modeli

/** Red dnevnika — nalog glavne knjige (`journal_entries`), bez stavki. */
export interface JournalEntry {
  id: number;
  /** Broj naloga „NNNN" (server generiše). */
  number: string;
  /** Vrsta naloga (šifra tipa dokumenta, npr. „IFR", „UL"…). */
  orderTypeCode: string;
  year: number;
  documentDate: string;
  status: GlStatus;
  /** Ako je OVAJ nalog storniran — id kontra-naloga koji ga poništava (inače null). */
  reversedByEntryId?: number | null;
  /** Ako je OVO storno nalog — id izvornog naloga koji stornira (inače null). */
  reversesEntryId?: number | null;
}

/** Stavka naloga (`ledger_entries`) — konto/komitent/duguje/potražuje. */
export interface LedgerEntry {
  id: number;
  journalEntryId: number;
  accountCode: string;
  /** Analitika (komitent/partner) — može biti null (sintetički konto). */
  analyticalCode: number | null;
  /** Decimal-as-string (BACKEND_RULES §6). */
  debit: string;
  /** Decimal-as-string. */
  credit: string;
  description: string | null;
  documentNumber: string | null;
}

/** Detalj naloga — zaglavlje + stavke (`GET /gl/journal/:id`). */
export interface JournalEntryDetail extends JournalEntry {
  lines: LedgerEntry[];
}

/** Red kartice konta — stavka sa tekućim saldom (running balance). */
export interface AccountCardLine {
  id: number;
  journalNumber: string;
  documentDate: string;
  documentNumber: string | null;
  analyticalCode: number | null;
  description: string | null;
  /** Decimal-as-string. */
  debit: string;
  credit: string;
  /** Tekući saldo posle ove stavke (Decimal-as-string). */
  balance: string;
}

/** Odgovor kartice konta — stavke + zbirovi u `meta`. */
export interface AccountCardResult {
  data: AccountCardLine[];
  meta: {
    accountCode: string;
    /** Ukupno duguje/potražuje + krajnji saldo (Decimal-as-string). */
    totalDebit: string;
    totalCredit: string;
    balance: string;
    count: number;
  };
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['gl'] as const,
  journal: ['gl', 'journal'] as const,
  journalEntry: (id: number) => ['gl', 'journal', id] as const,
  accountCard: ['gl', 'account-card'] as const,
};

// ─────────────────────────────────────────────────────────────── filteri

export interface JournalFilters {
  /** 1-bazna strana (UI); prevodi se u `skip = (page-1) * take`. */
  page?: number;
  /** Veličina strane (backend default 50). */
  pageSize?: number;
  /** Vrsta naloga (`orderType` query). */
  orderType?: string;
  status?: GlStatus | '';
  year?: number | '';
}

export interface AccountCardFilters {
  /** Analitika (komitent) — opciono. */
  analyticalCode?: number | '';
  /** Opseg po datumu dokumenta (ISO). */
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
 * Dnevnik: lista naloga (filter po vrsti/godini/statusu, server-side paginacija
 * preko `skip`/`take`). Vraća `{ data, meta: { total } }`. `pageSize` podrazumevano 50.
 */
export function useJournalEntries(filters: JournalFilters = {}) {
  const pageSize = filters.pageSize && filters.pageSize > 0 ? filters.pageSize : 50;
  const page = filters.page && filters.page > 0 ? filters.page : 1;
  const skip = (page - 1) * pageSize;
  const query = buildQuery({
    orderType: filters.orderType || undefined,
    status: filters.status === '' ? undefined : filters.status,
    year: filters.year === '' ? undefined : filters.year,
    skip: skip > 0 ? skip : undefined,
    take: pageSize !== 50 ? pageSize : undefined,
  });
  return useQuery({
    queryKey: [...KEYS.journal, filters],
    queryFn: () => apiFetch<SkipTakePaginated<JournalEntry>>(`${BASE}/journal${query}`),
  });
}

/**
 * Detalj jednog naloga (zaglavlje + stavke) — `GET /gl/journal/:id`.
 * `enabled` gasi upit dok id nije poznat.
 */
export function useJournalEntry(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.journalEntry(id) : [...KEYS.journal, 'detail', null],
    queryFn: () => apiFetch<Envelope<JournalEntryDetail>>(`${BASE}/journal/${id}`),
    enabled: id != null,
  });
}

/**
 * Kartica konta (analitička/sintetička): sve stavke jednog konta hronološki sa
 * tekućim saldom + zbirovi duguje/potražuje/saldo u `meta`. `GET /gl/account-card`.
 * `enabled` gasi upit dok konto nije unet.
 */
export function useAccountCard(accountCode: string, filters: AccountCardFilters = {}) {
  const code = accountCode.trim();
  const query = buildQuery({
    accountCode: code,
    analyticalCode: filters.analyticalCode === '' ? undefined : filters.analyticalCode,
    from: filters.from || undefined,
    to: filters.to || undefined,
  });
  return useQuery({
    queryKey: [...KEYS.accountCard, code, filters],
    queryFn: () => apiFetch<AccountCardResult>(`${BASE}/account-card${query}`),
    enabled: code.length > 0,
  });
}

// ─────────────────────────────────── ručni unos + status naloga (BigBit paritet)

/** Stavka ručnog naloga — 1:1 sa backend create-journal-entry.dto. */
export interface JournalLineInput {
  accountCode: string;
  analyticalCode?: number | null;
  debit?: number;
  credit?: number;
  description?: string;
  documentNumber?: string | null;
}

export interface CreateJournalInput {
  orderType: string;
  documentDate: string;
  description?: string;
  lines: JournalLineInput[];
}

/** Kontni plan — pretraga (picker konta). */
export function useAccountSearch(q: string, allowsAnalytics?: boolean) {
  const query = buildQuery({
    q: q.trim() || undefined,
    allowsAnalytics: allowsAnalytics == null ? undefined : String(allowsAnalytics),
  });
  return useQuery({
    queryKey: ['gl', 'accounts', q, allowsAnalytics],
    queryFn: () =>
      apiFetch<{ data: Array<{ code: string; name: string; accountClass: number; allowsAnalytics: boolean }> }>(
        `${BASE}/accounts${query}`,
      ),
  });
}

function useInvalidateGl() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/** Ručni unos naloga (temeljnica) — POST /gl/journal. */
export function useCreateJournalEntry() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (input: CreateJournalInput) =>
      apiFetch<Envelope<{ journalEntryId: number; number: string; lineCount: number }>>(
        `${BASE}/journal`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: invalidate,
  });
}

/**
 * Proknjiži nalog (draft→posted) — POST /gl/journal/:id/post.
 * Backend (gl-write.service.markPosted) vraća SIROV objekat `{ id, status }` (bez
 * `{ data }` omotača — status-mašina nije domenski read endpoint).
 */
export function usePostJournalEntry() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ id: number; status: string }>(`${BASE}/journal/${id}/post`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Zaključaj nalog (posted→locked) — POST /gl/journal/:id/lock. Vraća sirov `{ id, status }`. */
export function useLockJournalEntry() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ id: number; status: string }>(`${BASE}/journal/${id}/lock`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Storno naloga — POST /gl/journal/:id/reverse. Kreira NOVI kontra-nalog (obrnute
 * strane) i na izvornom postavlja `reversedByEntryId`. Backend (gl-write.reverse)
 * vraća sirov `{ stornoEntryId, number, reversedEntryId }`.
 */
export function useReverseJournalEntry() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ stornoEntryId: number; number: string; reversedEntryId: number }>(
        `${BASE}/journal/${id}/reverse`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: invalidate,
  });
}
