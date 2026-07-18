'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/**
 * „Operacije po prioritetu" (QBigTehn „Prioritet") — planska tabla operacija
 * NEZAVRŠENIH radnih naloga, sortirana po prioritetu (manji broj = hitnije).
 * Read-only; napaja pogonsku odluku „šta raditi prvo".
 */

export interface OperationQueueEntry {
  id: number;
  workOrderId: number;
  operationNumber: number;
  workCenterCode: string;
  workDescription: string;
  priority: number;
  setupTime: number | null;
  cycleTime: number | null;
  workerId: number;
  workOrder: {
    id: number;
    identNumber: string;
    variant: number;
    projectId: number;
    partName: string;
    drawingNumber: string;
    revision: string;
    pieceCount: number;
    productionDeadline: string | null;
    handoverStatusId: number;
    status: boolean | null;
  } | null;
  operation: { workCenterCode: string; workCenterName: string; workUnitCode: string } | null;
  worker: WorkerRef | null;
}

export interface OperationQueueParams {
  page?: number;
  q?: string;
  workCenterCode?: string;
  /** true = samo operacije sa dodeljenim prioritetom (priority < 255). */
  onlyPrioritized?: boolean;
}

export function useOperationQueue(params: OperationQueueParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.workCenterCode) qs.set('workCenterCode', params.workCenterCode);
  if (params.onlyPrioritized) qs.set('onlyPrioritized', '1');
  const query = qs.toString();
  return useQuery({
    queryKey: ['work-orders', 'operation-queue', params],
    queryFn: () =>
      apiFetch<Paginated<OperationQueueEntry>>(
        `/v1/work-orders/operations/queue${query ? `?${query}` : ''}`,
      ),
  });
}
