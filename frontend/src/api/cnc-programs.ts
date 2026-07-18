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
  /** Crtež RN-a (`work_orders.drawing_id`); 0 = nema — za „PDF crteža". */
  drawingId: number;
  cam: {
    isDone: boolean;
    completedAt: string | null;
    completedBy: CncProgramCompletedBy | null;
    note: string | null;
    /** Redosled CAM reda (1..N) ili null kad nije rangiran. */
    queueOrder: number | null;
  };
}

export interface CncProgramsParams {
  page?: number;
  q?: string;
  /** true = samo nečekirane pozicije (CAM još nije završen). */
  onlyPending?: boolean;
}

/**
 * Lokalni max stranice za OVAJ endpoint (backend dozvoljava do 500 samo ovde) —
 * FE traži ceo rangirani skup jednom stranom da redosled prevlačenjem radi nad
 * potpunom listom.
 */
const CNC_PAGE_SIZE = 500;

/** Paginirana lista pozicija za CAM (+ pretraga i filter „samo neurađene"). */
export function useCncPrograms(params: CncProgramsParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  qs.set('pageSize', String(CNC_PAGE_SIZE));
  if (params.q) qs.set('q', params.q);
  if (params.onlyPending) qs.set('onlyPending', 'true');
  const query = qs.toString();
  return useQuery({
    queryKey: ['cnc-programs', { ...params, pageSize: CNC_PAGE_SIZE }],
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

/**
 * Ulaz za promenu redosleda CAM reda (PATCH /:workOrderId/queue).
 * Tačno jedna semantika po zahtevu:
 *  - `{ afterWorkOrderId: number | null }` — ubaci ODMAH ISPOD reda sa tim id-em
 *    (null = na vrh rangiranih);
 *  - `{ remove: true }` — skini red iz rangiranja (queue_order → NULL).
 */
export type MoveCncQueueInput =
  | { workOrderId: number; afterWorkOrderId: number | null; remove?: never }
  | { workOrderId: number; remove: true; afterWorkOrderId?: never };

/**
 * Lokalna reinsercija reda u već sortiranoj listi po ugovoru semantike:
 * prevučeni red se ubacuje ODMAH ISPOD `afterWorkOrderId` (ili na vrh kad je
 * null), a rangiranom skupu se preračuna `queueOrder` 1..N po prikazanom
 * redosledu. Kod `remove` red gubi `queueOrder` (pada u nerangirani rep).
 * Obrazac keša isti kao `useSetCncProgramDone` (getQueriesData/setQueriesData).
 */
function reinsertQueue(
  rows: CncProgram[],
  input: MoveCncQueueInput,
): CncProgram[] {
  const moved = rows.find((r) => r.id === input.workOrderId);
  if (!moved) return rows;

  const rest = rows.filter((r) => r.id !== input.workOrderId);

  if (input.remove) {
    // Nerangiran red: queueOrder = null. Preračunaj rang za preostale rangirane
    // po njihovom trenutnom redosledu i sortiraj (rangirani pre nerangiranih).
    const cleared: CncProgram = { ...moved, cam: { ...moved.cam, queueOrder: null } };
    return renumberAndSort([...rest, cleared]);
  }

  // afterWorkOrderId semantika: ubaci ODMAH ISPOD tog reda (null = na vrh).
  const after = input.afterWorkOrderId;
  const next = [...rest];
  let idx = 0;
  if (after != null) {
    const afterIdx = next.findIndex((r) => r.id === after);
    idx = afterIdx >= 0 ? afterIdx + 1 : 0;
  }
  next.splice(idx, 0, { ...moved, cam: { ...moved.cam, queueOrder: 0 } });
  return renumberAndSort(next);
}

/**
 * Rangiranima (queueOrder != null) dodeli 1..N po tekućem redosledu u nizu,
 * pa sortiraj: rangirani (asc) pre nerangiranih; nerangirani po roku asc pa
 * id desc (isti ključ kao backend list()).
 */
function renumberAndSort(rows: CncProgram[]): CncProgram[] {
  let rank = 0;
  const withRank = rows.map((r) =>
    r.cam.queueOrder != null
      ? { ...r, cam: { ...r.cam, queueOrder: ++rank } }
      : r,
  );
  return withRank.sort((a, b) => {
    const qa = a.cam.queueOrder;
    const qb = b.cam.queueOrder;
    if (qa != null && qb != null) return qa - qb;
    if (qa != null) return -1;
    if (qb != null) return 1;
    // Oba nerangirana: rok asc (null poslednji) pa id desc.
    const da = a.productionDeadline;
    const db = b.productionDeadline;
    if (da !== db) {
      if (da == null) return 1;
      if (db == null) return -1;
      return da < db ? -1 : 1;
    }
    return b.id - a.id;
  });
}

/**
 * Promeni redosled CAM reda (PATCH /:workOrderId/queue). Iza permisije
 * `tehnologija.cam_prioritet`. Optimistic: lokalna reinsercija liste po
 * `afterWorkOrderId`/`remove` semantici (rollback na grešku) + invalidacija.
 */
export function useMoveCncQueue() {
  const qc = useQueryClient();
  const listKey = ['cnc-programs'];
  return useMutation({
    mutationFn: (input: MoveCncQueueInput) => {
      const body = input.remove
        ? { remove: true }
        : { afterWorkOrderId: input.afterWorkOrderId };
      return apiFetch<{ data: { workOrderId: number; queueOrder: number | null } }>(
        `/v1/cnc-programs/${input.workOrderId}/queue`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: listKey });
      const snapshots = qc.getQueriesData<Paginated<CncProgram>>({ queryKey: listKey });
      qc.setQueriesData<Paginated<CncProgram>>({ queryKey: listKey }, (old) =>
        old ? { ...old, data: reinsertQueue(old.data, input) } : old,
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
