'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';

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
  DRAFT: 'DRAFT', // U pripremi — nalog tek kreiran
  POSTED: 'POSTED', // Proknjižen — stavke ušle u glavnu knjigu
  LOCKED: 'LOCKED', // Zaključan period — samo pregled
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
  /** Mesto troška (salda po poslovima) — može biti null. */
  costCenter: string | null;
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
    /** Primenjeni filter mesta troška (echo) — null ako nije zadat. */
    costCenter: string | null;
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
  /** Mesto troška (salda po poslovima) — opcioni filter. */
  costCenter?: string;
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
 *
 * `enabled` (isti obrazac kao `useStockDocuments`) postoji da ekran može da drži upit
 * isključenim dok `useListQueryState` ne pročita filtere iz adrese — bez toga svaki
 * povratak sa detalja naloga šalje jedan uzaludan zahtev nad PODRAZUMEVANIM ključem.
 */
export function useJournalEntries(filters: JournalFilters = {}, opts: { enabled?: boolean } = {}) {
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
    enabled: opts.enabled ?? true,
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
    costCenter: filters.costCenter?.trim() || undefined,
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
  /** Mesto troška (salda po poslovima) — opciono, upisuje se po liniji. */
  costCenter?: string | null;
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

/**
 * Masovno zaključavanje starih naloga — POST /gl/journal/lock-older. Svi `posted`
 * nalozi sa postingDate < beforeDate → `locked`. Vraća sirov `{ count, dryRun }`.
 *
 * `dryRun: true` SAMO prebroji (bez izmene) — korak potvrde pre nepovratne radnje
 * (backend odbija i datum u budućnosti). Menja status naloga, pa invalidira ceo
 * `gl` ključ. Permisija GL_WRITE.
 */
export function useLockOlderJournals() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (input: { beforeDate: string; dryRun?: boolean }) =>
      apiFetch<{ count: number; dryRun: boolean }>(`${BASE}/journal/lock-older`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    // Dry-run ništa ne menja — ne treba invalidacija; pravi lock invalidira.
    onSuccess: (res) => {
      if (!res.dryRun) invalidate();
    },
  });
}

/**
 * Otključavanje naloga (locked→posted) — POST /gl/journal/:id/unlock. Ispravka
 * greške pri zaključavanju perioda: vraća nalog u `posted` da bi se mogao
 * stornirati/ispraviti. Permisija GL_WRITE.
 */
export function useUnlockJournalEntry() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ id: number; status: string }>(`${BASE}/journal/${id}/unlock`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Štampa naloga za knjiženje (temeljnica) — GET /gl/journal/:id/pdf. Endpoint traži
 * JWT, pa se PDF povlači kroz `apiBlob` (Authorization header) i otvara preko
 * `openPdf`. Permisija GL_READ.
 */
export function useJournalPdf() {
  return useMutation({
    mutationFn: (id: number) => apiBlob(`${BASE}/journal/${id}/pdf`),
  });
}

/**
 * Štampa DNEVNIKA KNJIŽENJA — GET /gl/journal-book/pdf. Knjiga svih proknjiženih
 * stavki u periodu (A4 položeno, zaglavlje kolona se ponavlja). Filteri se
 * poklapaju sa ekranom dnevnika + period po datumu knjiženja. Permisija GL_READ.
 */
export function useJournalBookPdf() {
  return useMutation({
    mutationFn: (input: {
      orderType?: string;
      year?: number | '';
      from?: string;
      to?: string;
    }) => {
      const query = buildQuery({
        orderType: input.orderType || undefined,
        year: input.year === '' ? undefined : input.year,
        from: input.from || undefined,
        to: input.to || undefined,
      });
      return apiBlob(`${BASE}/journal-book/pdf${query}`);
    },
  });
}

/**
 * Štampa KARTICE KONTA — GET /gl/account-card/pdf; isti filteri kao
 * `useAccountCard` (konto obavezan). Permisija GL_READ.
 */
export function useAccountCardPdf() {
  return useMutation({
    mutationFn: (input: {
      accountCode: string;
      analyticalCode?: number | '';
      costCenter?: string;
      from?: string;
      to?: string;
    }) => {
      const query = buildQuery({
        accountCode: input.accountCode.trim(),
        analyticalCode: input.analyticalCode === '' ? undefined : input.analyticalCode,
        costCenter: input.costCenter?.trim() || undefined,
        from: input.from || undefined,
        to: input.to || undefined,
      });
      return apiBlob(`${BASE}/account-card/pdf${query}`);
    },
  });
}

/**
 * Štampa BRUTO BILANSA (zaključni list) za godinu — GET /gl/trial-balance/pdf.
 * PS / promet / saldo po kontu, sa međuzbirovima po sintetici i klasi.
 * Permisija GL_READ.
 */
export function useTrialBalancePdf() {
  return useMutation({
    mutationFn: (input: { year: number; accountClass?: string }) => {
      const query = buildQuery({
        year: input.year,
        class: input.accountClass?.trim() || undefined,
      });
      return apiBlob(`${BASE}/trial-balance/pdf${query}`);
    },
  });
}

/** Otvori PDF Blob u novom tabu (browser preview + download). */
export { openPdf } from '@/lib/open-pdf';

// ─────────────────────────────────── početno stanje / carry-over godine (B2)

/** Ulaz za prenos salda u novu godinu — POST /gl/year-open. */
export interface YearOpenInput {
  fromYear: number;
  toYear: number;
  /** Datum PS naloga (ISO) — podrazumevano 01.01. toYear. */
  postingDate?: string;
  /** Konto rezultata (override) — podrazumevano auto po prefiksu (klasa 3). */
  resultAccount?: string;
}

/** Rezultat prenosa — id-evi naloga + broj linija + dokumentacija izbora konta rezultata. */
export interface YearOpenResult {
  /** Zaključni nalog (zatvaranje klasa 5/6) — null ako nije bilo salda za zatvaranje. */
  closingEntryId: number | null;
  /** PS nalog (početno stanje klasa 0–4 za toYear). */
  openingEntryId: number;
  /** Ukupno kreiranih linija (zaključni + PS). */
  lines: number;
  closingLines: number;
  openingLines: number;
  /** Izabrani konto rezultata (null ako rezultat = 0 ili nije bilo zatvaranja). */
  resultAccount: string | null;
  /** Dokumentovan izbor konta rezultata (DOKUMENTUJ izbor). */
  notes: string;
}

/**
 * Prenos salda u novu godinu (BigBit paritet) — POST /gl/year-open. Nepovratno bez storna;
 * ako PS nalog za toYear već postoji → 409. Menja dnevnik, pa invalidira ceo `gl` ključ.
 * Permisija GL_WRITE.
 */
export function useYearOpen() {
  const invalidate = useInvalidateGl();
  return useMutation({
    mutationFn: (input: YearOpenInput) =>
      apiFetch<YearOpenResult>(`${BASE}/year-open`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
