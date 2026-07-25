'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { WorkerRef } from './tech-processes';

/**
 * „Evidencija u proizvodnji" — otkucane operacije (`tech_processes`) sa filterima,
 * i ispravke (storno / audited delete). Nadograđuje write-path iz backend/tech-processes.
 * Kvalitet: 0=Dobar, 1=Dorada, 2=Škart.
 *
 * Isti izvor koristi i tab „Aktivnost kontrole" (K4) u Kontroli kvaliteta — otud
 * `entryKind` / `controllersOnly` / `withTotals` parametri.
 */

/**
 * Vrsta unosa (backend `entryKindOf`): završna kontrola (RC „značajan za
 * završetak"), međufazna kontrola (RC sa „kontrol" u nazivu) ili obično kucanje.
 */
export type TechProcessEntryKind = 'control-final' | 'control-mid' | 'work';

/** Zbir nad ISTIM filterom kao lista (samo uz `withTotals`). */
export interface ProductionLogTotals {
  entries: number;
  pieces: number;
  good: number;
  rework: number;
  scrap: number;
}

export interface ProductionLogPage {
  data: ProductionLogEntry[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    totals?: ProductionLogTotals;
  };
}

export interface ProductionLogEntry {
  id: number;
  workerId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  identMark: string;
  pieceCount: number;
  enteredAt: string;
  finishedAt: string | null;
  isProcessFinished: boolean | null;
  workOrderId: number;
  qualityTypeId: number;
  note: string | null;
  worker: WorkerRef | null;
  operation: {
    workCenterCode: string;
    workCenterName: string;
    workUnitCode: string;
    significantForFinishing?: boolean | null;
  } | null;
  qualityType: { id: number; name: string } | null;
  /** Sa RN-a (`work_orders`); null kad je red orphan (workOrderId=0). */
  drawingNumber?: string | null;
  partName?: string | null;
  entryKind?: TechProcessEntryKind;
}

export interface ProductionLogParams {
  page?: number;
  q?: string;
  workCenterCode?: string;
  qualityTypeId?: number | '';
  /** '' = svi, 'true' = završeni, 'false' = otvoreni. */
  finished?: '' | 'true' | 'false';
  from?: string;
  to?: string;
  /** Izvršilac (tačan `workers.id`). */
  workerId?: number;
  /** '' = sve vrste unosa; inače završna kontrola / međufazna / kucanje. */
  entryKind?: '' | TechProcessEntryKind;
  /** true = samo unosi ovlašćenih kontrolora (tip radnika sa dodatnim ovlašćenjima). */
  controllersOnly?: boolean;
  /** true = uz stranicu stiže i `meta.totals` (zbirne kartice). */
  withTotals?: boolean;
}

/** Paginirana evidencija otkucanih operacija (+ filteri). */
export function useProductionLog(params: ProductionLogParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.workCenterCode) qs.set('workCenterCode', params.workCenterCode);
  if (params.qualityTypeId !== '' && params.qualityTypeId != null)
    qs.set('qualityTypeId', String(params.qualityTypeId));
  if (params.finished) qs.set('finished', params.finished);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.workerId) qs.set('workerId', String(params.workerId));
  if (params.entryKind) qs.set('entryKind', params.entryKind);
  if (params.controllersOnly) qs.set('controllersOnly', 'true');
  if (params.withTotals) qs.set('withTotals', 'true');
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'log', params],
    queryFn: () =>
      apiFetch<ProductionLogPage>(`/v1/tech-processes${query ? `?${query}` : ''}`),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['tech-processes'] });
}

/** Storno otkucane operacije — kontra-red sa negativnim komadima (POST /:id/storno). */
export function useStornoTechProcess() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, pieceCount, note }: { id: number; pieceCount: number; note?: string }) =>
      apiFetch<{ data: unknown }>(`/v1/tech-processes/${id}/storno`, {
        method: 'POST',
        body: JSON.stringify({ pieceCount, note: note?.trim() || undefined }),
      }),
    onSuccess: invalidate,
  });
}

/** Audited brisanje otkucane operacije (DELETE /:id) — snapshot u audit_log pa brisanje. */
export function useDeleteTechProcess() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) =>
      apiFetch<{ data: { id: number; deleted: true } }>(`/v1/tech-processes/${id}`, {
        method: 'DELETE',
        body: JSON.stringify({ note: note?.trim() || undefined }),
      }),
    onSuccess: invalidate,
  });
}
