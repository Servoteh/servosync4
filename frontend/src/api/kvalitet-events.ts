'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Škart i dorada — evidencija događaja kvaliteta (MODULE_SPEC_kvalitet_skart_dorada,
 * presuda 26.07). Backend: /v1/kvalitet/events (+ /reason-codes). ODVOJENO od starije
 * evidencije neusaglašenosti (api/kvalitet.ts, `reports`). TRI statusa:
 * PRIJAVLJEN (kiosk signal) → POTVRDJEN (kontrolor) / ODBACEN; u Pareto ulazi SAMO POTVRDJEN.
 * Kontrolor unosi direktno kao POTVRDJEN; radnik na kiosku šalje prijavu koju kontrolor
 * potvrđuje/odbacuje. Endpoints:
 *   GET   /v1/kvalitet/reason-codes         · aktivni razlozi (padajuća lista)
 *   GET   /v1/kvalitet/events               · lista + filteri + meta.pendingCount
 *   GET   /v1/kvalitet/events/pareto        · zbir po razlogu/mašini (samo POTVRDJEN)
 *   POST  /v1/kvalitet/events               · kontrolorski unos → POTVRDJEN
 *   PATCH /v1/kvalitet/events/:id/potvrdi   · potvrda prijave → POTVRDJEN
 *   PATCH /v1/kvalitet/events/:id/odbaci    · odbacivanje prijave → ODBACEN
 */

// ─────────────────────────────────────────────────────────────── konstante

export const QUALITY_EVENT_TYPE = { SKART: 'SKART', DORADA: 'DORADA' } as const;
export type QualityEventType = (typeof QUALITY_EVENT_TYPE)[keyof typeof QUALITY_EVENT_TYPE];

export const QUALITY_EVENT_STATUS = {
  PRIJAVLJEN: 'PRIJAVLJEN',
  POTVRDJEN: 'POTVRDJEN',
  ODBACEN: 'ODBACEN',
} as const;
export type QualityEventStatus =
  (typeof QUALITY_EVENT_STATUS)[keyof typeof QUALITY_EVENT_STATUS];

// ─────────────────────────────────────────────────────────────── tipovi

export interface QualityReasonCode {
  id: number;
  code: string;
  label: string;
  sortOrder: number;
}

export interface UserRef {
  id: number;
  fullName: string | null;
}

export interface QualityEvent {
  id: number;
  type: QualityEventType;
  status: QualityEventStatus;
  workOrderId: number;
  /** Poslovni broj RN-a (work_orders.ident_number) — UI prikazuje njega, ne interni id. */
  workOrderIdent: string | null;
  techProcessId: number | null;
  /** Decimal-as-string (BACKEND_RULES §5). */
  qty: string | null;
  unit: string;
  reasonCodeId: number | null;
  reason: { id: number; code: string; label: string } | null;
  note: string | null;
  machineId: number | null;
  workUnitCode: string | null;
  reportedByWorkerId: number | null;
  reportedByWorker: UserRef | null;
  reportedAt: string;
  confirmedBy: UserRef | null;
  confirmedAt: string | null;
  rejectedBy: UserRef | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  photoPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QualityEventsResponse {
  data: QualityEvent[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    /** Broj PRIJAVLJEN u redu čekanja (poštuje tip filter) — brojač na tabu. */
    pendingCount: number;
  };
}

export interface QualityEventsParams {
  page?: number;
  type?: QualityEventType | '';
  status?: QualityEventStatus | '';
  workOrderId?: number;
  /** Radna jedinica / mašina (RC kod, ILIKE). */
  machine?: string;
  reasonCodeId?: number;
  from?: string;
  to?: string;
}

/** Telo kontrolorskog unosa (nastaje POTVRDJEN). */
export interface CreateQualityEventInput {
  type: QualityEventType;
  workOrderId: number;
  qty: number;
  unit?: string;
  reasonCodeId: number;
  techProcessId?: number | null;
  workUnitCode?: string | null;
  note?: string | null;
  reportedByWorkerId?: number | null;
}

/** Telo potvrde prijave (dopuna razloga/količine/operacije). */
export interface ConfirmQualityEventInput {
  reasonCodeId: number;
  qty?: number;
  techProcessId?: number | null;
  workUnitCode?: string | null;
  note?: string | null;
}

export interface ParetoRow {
  label: string;
  count: number;
  qty: number;
  percent: number;
}
export interface QualityParetoResponse {
  data: {
    byReason: (ParetoRow & { reasonCodeId: number | null })[];
    byMachine: (ParetoRow & { workUnitCode: string | null })[];
  };
  meta: { totalQty: number; from: string | null; to: string | null; type: string | null };
}

export interface QualityParetoParams {
  type?: QualityEventType | '';
  from?: string;
  to?: string;
}

// ─────────────────────────────────────────────────────────────── hook-ovi

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['kvalitet-events'] });
}

/** Aktivni razlozi (za padajuću listu forme). Kratko keširano. */
export function useReasonCodes() {
  return useQuery({
    queryKey: ['kvalitet-events', 'reason-codes'],
    queryFn: () => apiFetch<{ data: QualityReasonCode[] }>('/v1/kvalitet/reason-codes'),
    staleTime: 5 * 60_000,
  });
}

/** Paginirana lista događaja (server-side filteri) + meta.pendingCount. */
export function useQualityEvents(
  params: QualityEventsParams,
  opts: { enabled?: boolean } = {},
) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.type) qs.set('type', params.type);
  if (params.status) qs.set('status', params.status);
  if (params.workOrderId) qs.set('workOrderId', String(params.workOrderId));
  if (params.machine) qs.set('machine', params.machine);
  if (params.reasonCodeId) qs.set('reasonCodeId', String(params.reasonCodeId));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['kvalitet-events', 'list', params],
    queryFn: () =>
      apiFetch<QualityEventsResponse>(`/v1/kvalitet/events${query ? `?${query}` : ''}`),
    enabled: opts.enabled ?? true,
  });
}

/** Pareto agregat (samo POTVRDJEN) — zbir po razlogu i po mašini, procenti. */
export function useQualityPareto(
  params: QualityParetoParams,
  opts: { enabled?: boolean } = {},
) {
  const qs = new URLSearchParams();
  if (params.type) qs.set('type', params.type);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['kvalitet-events', 'pareto', params],
    queryFn: () =>
      apiFetch<QualityParetoResponse>(`/v1/kvalitet/events/pareto${query ? `?${query}` : ''}`),
    enabled: opts.enabled ?? true,
  });
}

/** Kontrolorski unos (nastaje POTVRDJEN). */
export function useCreateQualityEvent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateQualityEventInput) =>
      apiFetch<{ data: QualityEvent }>('/v1/kvalitet/events', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Potvrda prijave (PRIJAVLJEN → POTVRDJEN). */
export function useConfirmQualityEvent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: ConfirmQualityEventInput }) =>
      apiFetch<{ data: QualityEvent }>(`/v1/kvalitet/events/${id}/potvrdi`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/** Odbacivanje prijave (PRIJAVLJEN → ODBACEN) — razlog odbacivanja je obavezan. */
export function useRejectQualityEvent() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, rejectReason }: { id: number; rejectReason: string }) =>
      apiFetch<{ data: QualityEvent }>(`/v1/kvalitet/events/${id}/odbaci`, {
        method: 'PATCH',
        body: JSON.stringify({ rejectReason }),
      }),
    onSuccess: invalidate,
  });
}

/** StatusBadge ton po statusu događaja (kanonska mapa DESIGN_SYSTEM §7). */
export function eventStatusTone(status: QualityEventStatus): 'warn' | 'success' | 'neutral' {
  if (status === QUALITY_EVENT_STATUS.POTVRDJEN) return 'success';
  if (status === QUALITY_EVENT_STATUS.ODBACEN) return 'neutral';
  return 'warn';
}

export const EVENT_STATUS_LABEL: Record<QualityEventStatus, string> = {
  PRIJAVLJEN: 'Prijavljen',
  POTVRDJEN: 'Potvrđen',
  ODBACEN: 'Odbačen',
};

export const EVENT_TYPE_LABEL: Record<QualityEventType, string> = {
  SKART: 'Škart',
  DORADA: 'Dorada',
};
