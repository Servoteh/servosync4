'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

export interface WorkOrder {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  externalCustomerId: number;
  externalProjectName: string | null;
  partName: string;
  drawingNumber: string;
  product: string | null;
  pieceCount: number;
  material: string;
  materialDimension: string;
  unit: string;
  revision: string;
  status: boolean | null;
  isLocked: boolean | null;
  enteredAt: string;
  productionDeadline: string | null;
  worker: WorkerRef | null;
  qualityType: { id: number; name: string } | null;
}

export interface WorkOrderOperation {
  id: number;
  operationNumber: number;
  workCenterCode: string;
  workDescription: string;
  toolsFixtures: string | null;
  setupTime: number | null;
  cycleTime: number | null;
  priority: number;
  worker: WorkerRef | null;
  operation: { workCenterCode: string; workCenterName: string } | null;
}

export interface WorkOrderDetail extends WorkOrder {
  handoverWorker: WorkerRef | null;
  handoverStatus: { id: number; name?: string } | null;
  operations: WorkOrderOperation[];
}

interface RnListParams {
  page?: number;
  q?: string;
}

/** Paginirana lista radnih naloga (+ pretraga po ident/naziv/crtež). */
export function useWorkOrders(params: RnListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['work-orders', params],
    queryFn: () =>
      apiFetch<Paginated<WorkOrder>>(`/v1/work-orders${query ? `?${query}` : ''}`),
  });
}

/** Jedan RN sa operacijama + statusima (učitava se pri otvaranju reda). */
export function useWorkOrder(id: number | null) {
  return useQuery({
    queryKey: ['work-orders', 'detail', id],
    queryFn: () => apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}`),
    enabled: id != null,
  });
}
