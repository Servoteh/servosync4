'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Poreske tarife (R_Tarife → tax_rates) — data sloj. Hooks nad `/api/v1/pdv/tax-rates/*`.
 * Tipovi 1:1 sa backend TaxRatesService. Stope stižu kao Decimal-as-string (npr. 20.00).
 * `ratePct` = efektivna stopa na dan (zbir svih pet komponenti).
 */
const BASE = '/v1/pdv/tax-rates';

export interface TaxRate {
  id: number;
  code: string;
  description: string | null;
  baseRate: string;
  railwayRate: string;
  cityRate: string;
  warRate: string;
  specialRate: string;
  /** Efektivna stopa (%) = zbir komponenti; ono sto se prikazuje u koloni Stopa %. */
  ratePct: string;
  vatGroup: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface CreateTaxRateInput {
  code: string;
  description?: string | null;
  baseRate?: number;
  railwayRate?: number;
  cityRate?: number;
  warRate?: number;
  specialRate?: number;
  vatGroup?: string | null;
  validFrom: string; // ISO
  validTo?: string | null;
}

export type UpdateTaxRateInput = Partial<Omit<CreateTaxRateInput, 'code'>>;

/** Registar poreskih tarifa (GET /pdv/tax-rates). */
export function useTaxRates() {
  return useQuery({
    queryKey: ['tax-rates'],
    queryFn: () => apiFetch<{ data: TaxRate[] }>(BASE),
  });
}

/** Efektivna stopa za šifru na dan (GET /pdv/tax-rates/resolve). Aktivira se tek uz `code`. */
export function useResolveTaxRate(code: string | null, on?: string) {
  return useQuery({
    queryKey: ['tax-rates', 'resolve', code, on ?? null],
    enabled: !!code,
    queryFn: () => {
      const params = new URLSearchParams({ code: code as string });
      if (on) params.set('on', on);
      return apiFetch<{ data: TaxRate & { on: string } }>(
        `${BASE}/resolve?${params.toString()}`,
      );
    },
  });
}

function useInvalidateTaxRates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['tax-rates'] });
}

/** Nova tarifa (POST /pdv/tax-rates). */
export function useCreateTaxRate() {
  const invalidate = useInvalidateTaxRates();
  return useMutation({
    mutationFn: (input: CreateTaxRateInput) =>
      apiFetch<{ data: TaxRate }>(BASE, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena tarife (PATCH /pdv/tax-rates/:id). */
export function useUpdateTaxRate() {
  const invalidate = useInvalidateTaxRates();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateTaxRateInput }) =>
      apiFetch<{ data: TaxRate }>(`${BASE}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
