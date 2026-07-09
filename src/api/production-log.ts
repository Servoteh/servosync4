'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/**
 * „Evidencija u proizvodnji" — otkucane operacije (`tech_processes`) sa filterima,
 * i ispravke (storno / audited delete). Nadograđuje write-path iz backend/tech-processes.
 * Kvalitet: 0=Dobar, 1=Dorada, 2=Škart.
 */

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
  operation: { workCenterCode: string; workCenterName: string; workUnitCode: string } | null;
  qualityType: { id: number; name: string } | null;
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
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'log', params],
    queryFn: () =>
      apiFetch<Paginated<ProductionLogEntry>>(
        `/v1/tech-processes${query ? `?${query}` : ''}`,
      ),
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
