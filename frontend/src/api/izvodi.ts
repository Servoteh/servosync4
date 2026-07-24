'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * IZVODI (bankovni izvodi) — data sloj (Faza 4 §B). TanStack Query hooks nad NestJS
 * `/api/v1/izvodi/*`. Tipovi 1:1 sa backend modelima:
 *   backend/src/modules/izvodi/izvodi.controller.ts       (rute)
 *   backend/src/modules/izvodi/bank-statement.service.ts  (envelope, status-mašina)
 *   Prisma BankStatement / BankStatementLine              (polja)
 *
 * Tok: uvoz TXT (FileReader → txtContent string) → BankStatement(IMPORTED) + stavke →
 * uparivanje (match: žiro komitenta → analitika; otvorena stavka po PNB/iznosu) →
 * knjiženje (post: dvojno banka↔analitika pod jednim nalogom) → status POSTED.
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): NIJE domenski `{ data }` envelope kao robno. Lista vraća
 *   `{ data, meta: { total, skip, take } }` (skip/take paginacija, kao nabavka);
 * detalj / match / import vraćaju SAM entitet (BankStatement + `lines`), ne uvijen.
 * Decimal polja (iznos, stanja) stižu kao STRING (BACKEND_RULES §6) — formatDecimal
 * na prikazu. Permisije: read=IZVODI_READ, uvoz/uparivanje=IZVODI_IMPORT, knjiženje=IZVODI_POST.
 */

const BASE = '/v1/izvodi';

// ─────────────────────────────────────────────────────────────── statusi

/**
 * Status izvoda (`bank_statements.status`) — 1:1 sa backend servisom. Uvoz kreira
 * IMPORTED; DRAFT je default šeme (retko van uvoza); knjiženje → POSTED. Kanonska
 * mapa statusa (DESIGN_SYSTEM §7) domen „Izvodi — izvod".
 */
export const STATEMENT_STATUS = {
  DRAFT: 'DRAFT', // U pripremi (default šeme)
  IMPORTED: 'IMPORTED', // Uvezen iz TXT — čeka uparivanje/knjiženje
  POSTED: 'POSTED', // Proknjižen u glavnoj knjizi
} as const;

export type StatementStatus = (typeof STATEMENT_STATUS)[keyof typeof STATEMENT_STATUS];

/**
 * Status stavke izvoda (`bank_statement_lines.status`) — 1:1 sa backend servisom.
 * Kanonska mapa statusa (DESIGN_SYSTEM §7) domen „Izvodi — stavka".
 */
export const LINE_STATUS = {
  UNMATCHED: 'UNMATCHED', // Nije uparen komitent
  MATCHED: 'MATCHED', // Uparen komitent (i po mogućnosti otvorena stavka)
  POSTED: 'POSTED', // Proknjižen
} as const;

export type LineStatus = (typeof LINE_STATUS)[keyof typeof LINE_STATUS];

/** Smer stavke izvoda (`bank_statement_lines.direction`) — priliv/odliv. */
export const LINE_DIRECTION = {
  DEBIT: 'DEBIT', // Odliv (banka potražuje)
  CREDIT: 'CREDIT', // Priliv (banka duguje)
} as const;

export type LineDirection = (typeof LINE_DIRECTION)[keyof typeof LINE_DIRECTION];

/**
 * Dozvoljene valute izvoda (E6, O2 presuda) — 1:1 sa backend `STATEMENT_CURRENCIES`.
 * RSD = dinarski izvod (default, bez FX polja na stavkama); EUR/USD/CHF = devizni izvod
 * (stavke nose devizni iznos + PRODAJNI kurs, `amount` je RSD protivvrednost).
 */
export const STATEMENT_CURRENCIES = ['RSD', 'EUR', 'USD', 'CHF'] as const;
export type StatementCurrency = (typeof STATEMENT_CURRENCIES)[number];

/** Devizni izvod = valuta nije RSD (null/prazno/RSD = dinarski). */
export function isForeignCurrency(currency: string | null | undefined): boolean {
  return currency != null && currency.trim() !== '' && currency.trim().toUpperCase() !== 'RSD';
}

// ─────────────────────────────────────────────────────────────── envelope tipovi

/** Paginirani odgovor liste izvoda — backend šalje `meta.{total,skip,take}` (skip/take). */
export interface StatementListResponse {
  data: BankStatement[];
  meta: {
    total: number;
    skip: number;
    take: number;
  };
}

/**
 * Zaglavlje izvoda (`bank_statements`) — Decimal polja (stanja) kao string
 * (BACKEND_RULES §6). Lista dodaje `_count.lines` (broj stavki bez povlačenja stavki).
 */
export interface BankStatement {
  id: number;
  bankAccount: string;
  statementNumber: string;
  statementDate: string;
  importedFileName: string | null;
  status: StatementStatus;
  openingBalance: string;
  closingBalance: string;
  currency: string;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
  /** Samo na listi (include `_count`). Detalj umesto toga nosi `lines`. */
  _count?: { lines: number };
}

/**
 * Stavka izvoda (`bank_statement_lines`) — `amount` Decimal-as-string. Uparivanje
 * puni `matchedCustomerId` (žiro komitenta → komitent) i `matchedLedgerEntryId`
 * (otvorena stavka po PNB/iznosu).
 */
export interface BankStatementLine {
  id: number;
  statementId: number;
  lineNo: number;
  partnerAccount: string | null;
  partnerName: string | null;
  /** RSD iznos (za devizne stavke = protivvrednost foreignAmount × exchangeRate). */
  amount: string;
  /** Devizni izvod (E6): originalni iznos u valuti izvoda; null za dinarske stavke. */
  foreignAmount: string | null;
  /** Devizni izvod (E6): primenjeni PRODAJNI kurs na dan izvoda; null za dinarske stavke. */
  exchangeRate: string | null;
  /** Valuta stavke (nasleđena sa izvoda); null/RSD = dinarska. */
  currency: string | null;
  direction: LineDirection;
  referenceNumber: string | null;
  documentDate: string | null;
  matchedCustomerId: number | null;
  matchedLedgerEntryId: number | null;
  status: LineStatus;
}

/** Detalj izvoda — zaglavlje + stavke (GET /:id vraća SAM entitet sa `lines`). */
export interface BankStatementDetail extends BankStatement {
  lines: BankStatementLine[];
}

/** Rezultat uparivanja (`match`) — detalj + broj uparenih stavki. */
export interface MatchResult extends BankStatementDetail {
  matchedCount: number;
}

/** Rezultat knjiženja (`post`) — sažetak naloga glavne knjige. */
export interface PostResult {
  journalEntryId: number;
  journalNumber: string;
  lineCount: number;
  totalDebit: string;
  totalCredit: string;
}

// ─────────────────────────────────────────────────────────────── ulazni tipovi

/**
 * Telo uvoza (POST /izvodi) — 1:1 sa backend `ImportStatementDto`. `txtContent` je
 * sirov TXT sadržaj pročitan preko FileReader-a. Idempotencija: (bankAccount,
 * statementNumber) je unique → ponovni uvoz istog izvoda vraća 409.
 */
export interface ImportStatementInput {
  bankAccount: string;
  statementNumber: string;
  statementDate: string;
  /** Opcion: bez TXT-a se kreira prazan izvod za ručni unos (E6 devizni izvod). */
  txtContent?: string;
  fileName?: string;
  openingBalance?: number;
  closingBalance?: number;
  currency?: string;
}

export interface StatementFilters {
  status?: StatementStatus | '';
  bankAccount?: string;
  /** skip/take paginacija (backend default take=50, max 200). */
  skip?: number;
  take?: number;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['izvodi'] as const,
  list: ['izvodi', 'list'] as const,
  statement: (id: number) => ['izvodi', 'statement', id] as const,
};

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
 * Lista izvoda (filter po statusu i žiro računu, skip/take paginacija). Vraća
 * `{ data, meta: { total, skip, take } }`. Redovi nose `_count.lines`. Permisija
 * IZVODI_READ.
 */
export function useStatements(filters: StatementFilters = {}) {
  const query = buildQuery({
    status: filters.status === '' ? undefined : filters.status,
    bankAccount: filters.bankAccount || undefined,
    skip: filters.skip && filters.skip > 0 ? filters.skip : undefined,
    take: filters.take && filters.take > 0 ? filters.take : undefined,
  });
  return useQuery({
    queryKey: [...KEYS.list, filters],
    queryFn: () => apiFetch<StatementListResponse>(`${BASE}${query}`),
  });
}

/**
 * Detalj jednog izvoda (zaglavlje + stavke) — GET /izvodi/:id. Vraća SAM entitet
 * (nije `{ data }` envelope). `enabled` gasi upit dok id nije poznat. Permisija
 * IZVODI_READ.
 */
export function useStatement(id: number | null) {
  return useQuery({
    queryKey: id != null ? KEYS.statement(id) : [...KEYS.list, 'detail', null],
    queryFn: () => apiFetch<BankStatementDetail>(`${BASE}/${id}`),
    enabled: id != null,
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateIzvodi() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Uvezi izvod iz TXT sadržaja (POST /izvodi) → BankStatement(IMPORTED) + stavke.
 * `txtContent` čita komponenta preko FileReader-a. 409 = izvod već uvezen (isti
 * bankAccount+statementNumber), 422 = TXT bez parsabilnih stavki. Menja listu, pa
 * invalidira ceo `izvodi` ključ. Permisija IZVODI_IMPORT.
 */
export function useImportStatement() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (input: ImportStatementInput) =>
      apiFetch<BankStatementDetail>(`${BASE}`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Upari stavke izvoda (POST /izvodi/:id/match): za svaku stavku traži komitenta po
 * žiro računu (fallback po nazivu) i otvorenu stavku po PNB/iznosu; puni
 * matchedCustomerId / matchedLedgerEntryId i status=MATCHED. 409 ako je izvod već
 * proknjižen. Menja stavke, pa invalidira ceo `izvodi` ključ. Permisija IZVODI_IMPORT.
 */
export function useMatchLines() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<MatchResult>(`${BASE}/${id}/match`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Auto-knjiženje izvoda u glavnu knjigu (POST /izvodi/:id/post): jedan nalog sa
 * dvojnim stavkama banka↔analitika. `bankAccountCode` je opcioni override konta
 * banke (inače se izvodi iz PaymentAccount.bankCode). 409 ako je već proknjižen,
 * 422 ako nalog ne balansira / konto banke nije definisan. Menja status izvoda +
 * stavki, pa invalidira ceo `izvodi` ključ. Permisija IZVODI_POST.
 */
export function usePostStatement() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (vars: { id: number; bankAccountCode?: string }) =>
      apiFetch<PostResult>(`${BASE}/${vars.id}/post`, {
        method: 'POST',
        body: JSON.stringify(
          vars.bankAccountCode ? { bankAccountCode: vars.bankAccountCode } : {},
        ),
      }),
    onSuccess: invalidate,
  });
}

// ── Ručni unos / korekcija stavke (BigBit paritet) ────────────────────────

/** Telo za ručni unos/izmenu stavke izvoda — 1:1 sa backend statement-line.dto. */
export interface StatementLineInput {
  partnerAccount?: string | null;
  partnerName?: string | null;
  amount?: number; // RSD iznos (dinarski izvod)
  foreignAmount?: number | null; // devizni iznos (E6, devizni izvod) — RSD preračun na backendu
  direction?: string; // DEBIT | CREDIT
  referenceNumber?: string | null;
  documentDate?: string | null;
  matchedCustomerId?: number | null;
}

/** Ručno dodaj stavku izvoda (POST /izvodi/:id/lines). Vraća ceo izvod sa stavkama. */
export function useAddStatementLine() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (vars: { id: number; input: StatementLineInput }) =>
      apiFetch<BankStatementDetail>(`${BASE}/${vars.id}/lines`, {
        method: 'POST',
        body: JSON.stringify(vars.input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmeni stavku (PATCH /izvodi/:id/lines/:lineId) — korekcija analitike/PNB/iznosa. */
export function useUpdateStatementLine() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (vars: { id: number; lineId: number; input: StatementLineInput }) =>
      apiFetch<BankStatementDetail>(`${BASE}/${vars.id}/lines/${vars.lineId}`, {
        method: 'PATCH',
        body: JSON.stringify(vars.input),
      }),
    onSuccess: invalidate,
  });
}

/** Obriši ručno/pogrešno unetu stavku (DELETE /izvodi/:id/lines/:lineId). */
export function useDeleteStatementLine() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (vars: { id: number; lineId: number }) =>
      apiFetch<BankStatementDetail>(`${BASE}/${vars.id}/lines/${vars.lineId}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

/** Ručno poveži stavku sa otvorenom stavkom naloga (POST /izvodi/:id/lines/:lineId/link). */
export function useLinkStatementLine() {
  const invalidate = useInvalidateIzvodi();
  return useMutation({
    mutationFn: (vars: { id: number; lineId: number; ledgerEntryId: number }) =>
      apiFetch<BankStatementDetail>(
        `${BASE}/${vars.id}/lines/${vars.lineId}/link`,
        {
          method: 'POST',
          body: JSON.stringify({ ledgerEntryId: vars.ledgerEntryId }),
        },
      ),
    onSuccess: invalidate,
  });
}
