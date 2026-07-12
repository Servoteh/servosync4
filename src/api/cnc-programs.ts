'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

/**
 * „CAM programiranje" (Paket B t.7) — radni nalozi sa CNC/CAM operacijama i
 * čekboks „CAM završen". Namenjen CNC programerima (tehnologija.write).
 */

/** Autor „CAM završen" čekiranja (backend nikad ne vraća lozinke). */
export interface CncProgramCompletedBy {
  id: number;
  fullName: string | null;
  username: string | null;
}

export interface CncProgram {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  partName: string;
  drawingNumber: string;
  pieceCount: number;
  productionDeadline: string | null;
  cam: {
    isDone: boolean;
    completedAt: string | null;
    completedBy: CncProgramCompletedBy | null;
    note: string | null;
  };
}

export interface CncProgramsParams {
  page?: number;
  q?: string;
  /** true = samo nečekirane pozicije (CAM još nije završen). */
  onlyPending?: boolean;
}

/** Paginirana lista pozicija za CAM (+ pretraga i filter „samo neurađene"). */
export function useCncPrograms(params: CncProgramsParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.onlyPending) qs.set('onlyPending', 'true');
  const query = qs.toString();
  return useQuery({
    queryKey: ['cnc-programs', params],
    queryFn: () =>
      apiFetch<Paginated<CncProgram>>(`/v1/cnc-programs${query ? `?${query}` : ''}`),
  });
}

/** Ulaz za „CAM završen" čekiranje (PATCH /:workOrderId). */
export interface SetCncProgramDoneInput {
  /** RN (= red liste) na kome se čekira „CAM završen". */
  workOrderId: number;
  isDone: boolean;
  note?: string;
}

/**
 * „CAM završen" čekiranje (Paket B t.7): PATCH /v1/cnc-programs/:workOrderId.
 * Optimistic update keša liste (rollback na grešku) + invalidacija na kraju —
 * obrazac iz `useSetOperationPriority` (src/api/work-orders.ts).
 */
export function useSetCncProgramDone() {
  const qc = useQueryClient();
  const listKey = ['cnc-programs'];
  return useMutation({
    mutationFn: ({ workOrderId, isDone, note }: SetCncProgramDoneInput) =>
      apiFetch<{ data: CncProgram }>(`/v1/cnc-programs/${workOrderId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isDone, note: note?.trim() || undefined }),
      }),
    onMutate: async ({ workOrderId, isDone }) => {
      await qc.cancelQueries({ queryKey: listKey });
      const snapshots = qc.getQueriesData<Paginated<CncProgram>>({ queryKey: listKey });
      qc.setQueriesData<Paginated<CncProgram>>({ queryKey: listKey }, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((r) =>
                r.id === workOrderId ? { ...r, cam: { ...r.cam, isDone } } : r,
              ),
            }
          : old,
      );
      return { snapshots };
    },
    onError: (_err, _input, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: listKey });
    },
  });
}
