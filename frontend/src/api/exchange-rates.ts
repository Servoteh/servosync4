'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * KURSNA LISTA (ExchangeRate → `exchange_rates`) — data sloj (Faza 4 §B / E6). TanStack
 * Query hooks nad NestJS `/api/v1/izvodi/exchange-rates/*`. Tipovi 1:1 sa backend:
 *   backend/src/modules/izvodi/exchange-rate.controller.ts (rute + envelope)
 *   backend/src/modules/izvodi/exchange-rate.service.ts    (resolver, prepis)
 *   Prisma ExchangeRate                                    (polja)
 *
 * Komponente NE zovu API direktno — samo kroz ove hook-ove (frontend/CLAUDE.md §8).
 *
 * VAŽNO (envelope): lista vraća `{ data, meta: { count } }`; unos/izmena/resolve/prepis
 * vraćaju `{ data }`. Decimal polja (kupovni/srednji/prodajni) stižu kao STRING
 * (BACKEND_RULES §6) — formatDecimal na prikazu. Permisije: read = IZVODI_READ;
 * unos/izmena/prepis = IZVODI_IMPORT.
 *
 * BigBit pravila kursa: izvodi/nalozi = PRODAJNI (sellRate); blagajna = SREDNJI (middleRate);
 * vikend/praznik = poslednji raniji datum.
 */

const BASE = '/v1/izvodi/exchange-rates';

// ─────────────────────────────────────────────────────────────── tipovi (BE 1:1)

/** Tip kursa koji resolver bira (kupovni/srednji/prodajni). */
export type ExchangeRateType = 'buy' | 'middle' | 'sell';

/**
 * Jedan red kursne liste (`exchange_rates`). Decimal stope kao string (BACKEND_RULES §6).
 * `source`: NBS | RUCNO | PREPIS.
 */
export interface ExchangeRate {
  id: number;
  rateDate: string;
  currency: string;
  buyRate: string;
  middleRate: string;
  sellRate: string;
  source: string | null;
  note: string | null;
}

/** Lista sa brojačem (`{ data, meta: { count } }`). */
export interface CountEnvelope<T> {
  data: T[];
  meta: { count: number };
}

/** Ne-paginirani odgovor (`{ data }`). */
export interface Envelope<T> {
  data: T;
}

/** Rezultat resolvera — izabrana stopa + rateDate koji je STVARNO upotrebljen. */
export interface ResolvedRate {
  currency: string;
  type: ExchangeRateType;
  rate: string;
  rateDate: string;
  requestedOn: string;
  buyRate: string;
  middleRate: string;
  sellRate: string;
  source: string | null;
}

/** Rezultat „Prepiši od datuma za datum" — koliko kopirano/preskočeno. */
export interface CopyResult {
  copied: number;
  skipped: number;
  fromDate: string;
  toDate: string;
}

// ─────────────────────────────────────────────────────────────── ulazni tipovi

export interface CreateExchangeRateInput {
  rateDate: string; // ISO
  currency: string; // 3 slova (normalizuje se na uppercase na backendu)
  buyRate?: number;
  middleRate?: number;
  sellRate?: number;
  source?: string | null;
  note?: string | null;
}

export type UpdateExchangeRateInput = Partial<CreateExchangeRateInput>;

export interface ExchangeRateFilters {
  currency?: string;
  from?: string;
  to?: string;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['exchange-rates'] as const,
  list: (f: ExchangeRateFilters) => ['exchange-rates', 'list', f] as const,
  resolve: (currency: string | null, on: string | null, type: string | null) =>
    ['exchange-rates', 'resolve', currency, on, type] as const,
};

function buildQuery(params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(key, value);
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

// ─────────────────────────────────────────────────────────────── queries

/**
 * Lista kurseva (filter po valuti / opsegu datuma; bez opsega → poslednjih 60 dana).
 * Vraća `{ data, meta: { count } }`. Permisija IZVODI_READ.
 */
export function useExchangeRates(filters: ExchangeRateFilters = {}) {
  const query = buildQuery({
    currency: filters.currency || undefined,
    from: filters.from || undefined,
    to: filters.to || undefined,
  });
  return useQuery({
    queryKey: KEYS.list(filters),
    queryFn: () => apiFetch<CountEnvelope<ExchangeRate>>(`${BASE}${query}`),
  });
}

/**
 * Kurs za valutu na dan (GET /resolve?currency=&on=&type=). Aktivira se tek uz `currency`.
 * 404 ako nema nijednog kursa ≤ traženog dana. Permisija IZVODI_READ.
 */
export function useResolveRate(
  currency: string | null,
  on?: string,
  type: ExchangeRateType = 'sell',
) {
  return useQuery({
    queryKey: KEYS.resolve(currency, on ?? null, type),
    enabled: !!currency,
    queryFn: () => {
      const params = new URLSearchParams({ currency: currency as string, type });
      if (on) params.set('on', on);
      return apiFetch<Envelope<ResolvedRate>>(`${BASE}/resolve?${params.toString()}`);
    },
  });
}

// ─────────────────────────────────────────────────────────────── mutations

function useInvalidateExchangeRates() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEYS.all });
}

/** Nova kursna stavka (POST /). 409 = duplikat (datum,valuta). Permisija IZVODI_IMPORT. */
export function useCreateExchangeRate() {
  const invalidate = useInvalidateExchangeRates();
  return useMutation({
    mutationFn: (input: CreateExchangeRateInput) =>
      apiFetch<Envelope<ExchangeRate>>(BASE, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena kursne stavke (PATCH /:id). 409 = duplikat (datum,valuta). Permisija IZVODI_IMPORT. */
export function useUpdateExchangeRate() {
  const invalidate = useInvalidateExchangeRates();
  return useMutation({
    mutationFn: ({ id, input }: { id: number; input: UpdateExchangeRateInput }) =>
      apiFetch<Envelope<ExchangeRate>>(`${BASE}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Prepiši sve valute sa `fromDate` na `toDate` (POST /copy-from). Postojeći (toDate,valuta)
 * parovi se preskaču. 422 ako nema kursa za `fromDate`. Permisija IZVODI_IMPORT.
 */
export function useCopyExchangeRates() {
  const invalidate = useInvalidateExchangeRates();
  return useMutation({
    mutationFn: (input: { fromDate: string; toDate: string }) =>
      apiFetch<Envelope<CopyResult>>(`${BASE}/copy-from`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
