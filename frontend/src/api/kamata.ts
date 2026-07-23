'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Kamata (obračun zatezne kamate) — data sloj. Hooks nad `/api/v1/kamata/*`.
 * Tipovi 1:1 sa backend KamataService. Decimal/stope-as-string.
 */
const BASE = '/v1/kamata';

export interface InterestRate {
  id: number;
  kind: string;
  ratePct: string;
  validFrom: string;
  validTo: string | null;
  note: string | null;
}

export interface InterestCalcLine {
  id: number;
  ledgerEntryId: number | null;
  documentNumber: string | null;
  principal: string;
  dueDate: string;
  daysOverdue: number;
  ratePct: string;
  interest: string;
}

export interface InterestCalculation {
  id: number;
  partnerId: number;
  kind: string;
  method: string;
  calcDate: string;
  totalPrincipal: string;
  totalInterest: string;
  status: string;
  journalEntryId: number | null;
  lines: InterestCalcLine[];
}

/** Registar kamatnih stopa (GET /kamata/rates). */
export function useInterestRates(kind?: string) {
  const q = kind ? `?kind=${kind}` : '';
  return useQuery({
    queryKey: ['kamata', 'rates', kind],
    queryFn: () => apiFetch<{ data: InterestRate[] }>(`${BASE}/rates${q}`),
  });
}

function useInvalidateKamata() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['kamata'] });
}

/** Nova kamatna stopa (POST /kamata/rates). */
export function useCreateInterestRate() {
  const invalidate = useInvalidateKamata();
  return useMutation({
    mutationFn: (input: {
      kind: string;
      ratePct: number;
      validFrom: string;
      validTo?: string | null;
      note?: string | null;
    }) =>
      apiFetch<InterestRate>(`${BASE}/rates`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Obračun kamate nad otvorenim dospelim stavkama (POST /kamata/compute). */
export function useComputeInterest() {
  const invalidate = useInvalidateKamata();
  return useMutation({
    mutationFn: (input: {
      partnerId: number;
      kind?: string;
      method?: string;
      calcDate?: string;
    }) =>
      apiFetch<InterestCalculation>(`${BASE}/compute`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
