'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Blagajna (gotovinski dnevnik) — data sloj. TanStack Query hooks nad
 * `/api/v1/blagajna/*`. Tipovi 1:1 sa backend BlagajnaService. Decimal-as-string.
 */
const BASE = '/v1/blagajna';

export const CASH_DIRECTION = {
  IN: 'IN', // uplatnica (uplata u blagajnu)
  OUT: 'OUT', // isplatnica (isplata iz blagajne)
} as const;
export type CashDirection = (typeof CASH_DIRECTION)[keyof typeof CASH_DIRECTION];

export interface CashJournal {
  id: number;
  companyId: number;
  name: string;
  accountCode: string;
  currency: string;
  isActive: boolean;
  balance: string; // Decimal-as-string (tekući saldo)
}

export interface CashEntry {
  id: number;
  entryNumber: string;
  direction: CashDirection;
  amount: string;
  entryDate: string;
  partnerId: number | null;
  contraAccount: string;
  description: string | null;
  status: string;
  journalEntryId: number | null;
}

/** Blagajne + tekući saldo (GET /blagajna/journals). */
export function useCashJournals() {
  return useQuery({
    queryKey: ['blagajna', 'journals'],
    queryFn: () => apiFetch<{ data: CashJournal[] }>(`${BASE}/journals`),
  });
}

/** Stavke blagajne (GET /blagajna/journals/:id/entries). */
export function useCashEntries(journalId: number | null) {
  return useQuery({
    queryKey: ['blagajna', 'entries', journalId],
    queryFn: () =>
      apiFetch<{ data: CashEntry[]; meta: { total: number } }>(
        `${BASE}/journals/${journalId}/entries`,
      ),
    enabled: journalId != null && journalId > 0,
  });
}

function useInvalidateBlagajna() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['blagajna'] });
}

/** Nova blagajna (POST /blagajna/journals). */
export function useCreateCashJournal() {
  const invalidate = useInvalidateBlagajna();
  return useMutation({
    mutationFn: (input: { name: string; accountCode: string; currency?: string }) =>
      apiFetch<CashJournal>(`${BASE}/journals`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Uplatnica/isplatnica (POST /blagajna/journals/:id/entries) — auto-GL knjiženje. */
export function useCreateCashEntry() {
  const invalidate = useInvalidateBlagajna();
  return useMutation({
    mutationFn: (vars: {
      journalId: number;
      input: {
        direction: CashDirection;
        amount: number;
        entryDate?: string;
        partnerId?: number | null;
        contraAccount: string;
        description?: string | null;
      };
    }) =>
      apiFetch<{ id: number; entryNumber: string; status: string }>(
        `${BASE}/journals/${vars.journalId}/entries`,
        { method: 'POST', body: JSON.stringify(vars.input) },
      ),
    onSuccess: invalidate,
  });
}
