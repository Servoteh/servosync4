'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiBlob } from './client';

/**
 * Završni račun / bilansi (Faza 7) — data sloj. TanStack Query hooks nad NestJS
 * `/api/v1/zavrsni/*`. Tipovi 1:1 sa backend servisom:
 *   backend/src/modules/zavrsni/zavrsni.controller.ts        (rute)
 *   backend/src/modules/zavrsni/balance-sheet.service.ts     (oblik odgovora)
 *   Prisma FinancialStatement / FinancialStatementLine        (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): zavrsni endpointi vraćaju SIROV objekat (NEMA `{ data }`
 * omotača — kontroler vraća rezultat servisa direktno, nema envelope interceptora).
 * Svi iznosi stižu kao Decimal-string (BACKEND_RULES §6) — formatDecimal na prikazu.
 * Bruto bilans iznosi su .toFixed(4); obračun linije .toFixed(4).
 */

const BASE = '/v1/zavrsni';

// ─────────────────────────────────────────────────────────────── tipovi obrazaca

/** Tip obrasca (`financial_statements.statement_type`) — 1:1 sa backend STATEMENT_TYPE. */
export const STATEMENT_TYPE = {
  BALANCE_SHEET: 'BALANCE_SHEET', // Bilans stanja (BS)
  INCOME_STATEMENT: 'INCOME_STATEMENT', // Bilans uspeha (BU)
  POPDV_ANNUAL: 'POPDV_ANNUAL', // Statistički izveštaj (SI)
} as const;

export type StatementType = (typeof STATEMENT_TYPE)[keyof typeof STATEMENT_TYPE];

/** Status obračuna (`financial_statements.status`) — DRAFT | FINALIZED. */
export const STATEMENT_STATUS = {
  DRAFT: 'DRAFT', // Nacrt — može se ponovo generisati
  FINALIZED: 'FINALIZED', // Predat (immutable) — ne generiše se ponovo
} as const;

export type StatementStatus = (typeof STATEMENT_STATUS)[keyof typeof STATEMENT_STATUS];

// ─────────────────────────────────────────────────────────────── data tipovi

/** Jedan red bruto bilansa (konto Σduguje/Σpotražuje/saldo). Decimal-string (.toFixed(4)). */
export interface GrossTrialBalanceRow {
  accountCode: string;
  accountName: string | null;
  totalDebit: string;
  totalCredit: string;
  balance: string;
}

/** Odgovor bruto bilansa — GET /zavrsni/bruto-bilans (sirov, bez envelope-a). */
export interface GrossTrialBalance {
  year: number;
  /** 31.12. te godine (ISO) — gornja granica postingDate. */
  asOf: string;
  rows: GrossTrialBalanceRow[];
  totals: {
    totalDebit: string;
    totalCredit: string;
    balance: string;
  };
}

/** Jedna AOP linija obračuna (`financial_statement_lines`). amount = Decimal-string (.toFixed(4)). */
export interface StatementLine {
  aop: string;
  label: string | null;
  amount: string;
  /** null = ručni/sirovi red (OS pozicija ili fallback po kontu); inače GKEval formula. */
  formula: string | null;
}

/** Sačuvan obračun (`financial_statements`) sa linijama — BS/BU/SI. */
export interface FinancialStatement {
  id: number;
  statementType: string;
  periodYear: number;
  status: string;
  /** false = nema AOP seed-a → pao na sirovi bruto bilans po kontu. */
  seeded: boolean;
  /** Prisutno na compute odgovoru kad je fallback (bez seed formula). */
  note?: string;
  lines: StatementLine[];
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['zavrsni'] as const,
  grossTrialBalance: (year: number) => ['zavrsni', 'bruto-bilans', year] as const,
  statements: (filter: StatementsFilter) => ['zavrsni', 'statements', filter] as const,
};

// ─────────────────────────────────────────────────────────────── queries

/**
 * Sirovi bruto bilans za godinu (konto Σduguje/Σpotražuje/saldo + totali).
 * Uvek radi, nezavisno od seed-a AOP formula. GET /zavrsni/bruto-bilans?year=YYYY.
 * Permisija ZR_READ.
 */
export function useGrossTrialBalance(year: number) {
  return useQuery({
    queryKey: KEYS.grossTrialBalance(year),
    queryFn: () =>
      apiFetch<GrossTrialBalance>(`${BASE}/bruto-bilans?year=${year}`),
  });
}

export interface StatementsFilter {
  type?: StatementType | '';
  year?: number | '';
}

/**
 * Lista sačuvanih obračuna (filter po tipu/godini). GET /zavrsni/statements.
 * Vraća niz obračuna sa linijama (sirov, bez envelope-a). Permisija ZR_READ.
 */
export function useStatements(filter: StatementsFilter = {}) {
  const qs = new URLSearchParams();
  if (filter.type) qs.set('type', filter.type);
  if (filter.year !== undefined && filter.year !== '') qs.set('year', String(filter.year));
  const query = qs.toString();
  return useQuery({
    queryKey: KEYS.statements(filter),
    queryFn: () =>
      apiFetch<FinancialStatement[]>(`${BASE}/statements${query ? `?${query}` : ''}`),
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateZavrsni() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/**
 * Generiši bilans stanja (BS) za godinu — POST /zavrsni/bilans-stanja {year}.
 * Kreira/osvežava FinancialStatement(DRAFT) + linije; FINALIZED obračun se ne dira.
 * Invalidira ceo `zavrsni` ključ (lista + bruto bilans). Permisija ZR_COMPUTE.
 */
export function useComputeBalanceSheet() {
  const invalidate = useInvalidateZavrsni();
  return useMutation({
    mutationFn: (year: number) =>
      apiFetch<FinancialStatement>(`${BASE}/bilans-stanja`, {
        method: 'POST',
        body: JSON.stringify({ year }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Generiši bilans uspeha (BU) za godinu — POST /zavrsni/bilans-uspeha {year}.
 * Kreira/osvežava FinancialStatement(DRAFT) + linije; FINALIZED obračun se ne dira.
 * Invalidira ceo `zavrsni` ključ. Permisija ZR_COMPUTE.
 */
export function useComputeIncomeStatement() {
  const invalidate = useInvalidateZavrsni();
  return useMutation({
    mutationFn: (year: number) =>
      apiFetch<FinancialStatement>(`${BASE}/bilans-uspeha`, {
        method: 'POST',
        body: JSON.stringify({ year }),
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────── APR eFI XML export (BigBit paritet)

/**
 * Skini APR eFI FiForma XML za sačuvan obračun (GET /zavrsni/statements/:id/apr-xml).
 * Endpoint vraća text/xml; povlači se kao Blob (Authorization header) i skida kao fajl.
 * BigBit paritet: bez ovoga se bilans ne može predati APR-u.
 */
export function useAprXmlDownload() {
  return useMutation({
    mutationFn: (id: number) => apiBlob(`${BASE}/statements/${id}/apr-xml`),
  });
}

/** Pokreni download Blob-a kao .xml fajl (isti obrazac kao FX TXT izvoz). */
export function downloadXml(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
