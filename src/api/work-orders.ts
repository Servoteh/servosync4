'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/** Radni status (handover_statuses id) — MODULE_SPEC_radni_nalozi §4. */
export const WO_STATUS = {
  IN_PROGRESS: 0,
  APPROVED: 1,
  REJECTED: 2,
  LAUNCHED: 3,
} as const;

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
  isLocked: boolean | null;
  handoverStatusId: number;
  enteredAt: string;
  productionDeadline: string | null;
  worker: WorkerRef | null;
  qualityType: { id: number; name: string } | null;
  handoverStatus: { id: number; name: string } | null;
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

export interface WorkOrderApprovalRow {
  id: number;
  isApproved: boolean | null;
  enteredAt: string;
  createdBySignature: string | null;
}

export interface WorkOrderDetail extends WorkOrder {
  handoverWorker: WorkerRef | null;
  operations: WorkOrderOperation[];
  approvals: WorkOrderApprovalRow[];
  launches: { id: number; isLaunched: boolean | null; enteredAt: string }[];
  machinedParts: unknown[];
  blanks: unknown[];
  nonStandardParts: unknown[];
  components: unknown[];
  itemComponents: unknown[];
}

export interface CreateWorkOrderInput {
  projectId: number;
  externalCustomerId: number;
  partName: string;
  drawingNumber: string;
  material: string;
  materialDimension: string;
  pieceCount: number;
  unit?: string;
  revision?: string;
  productionDeadline?: string;
}

export interface WoListParams {
  page?: number;
  q?: string;
  statusId?: number | '';
  from?: string;
  to?: string;
}

/** Paginirana lista radnih naloga (+ pretraga i filteri). */
export function useWorkOrders(params: WoListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.statusId !== '' && params.statusId != null)
    qs.set('statusId', String(params.statusId));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['work-orders', params],
    queryFn: () =>
      apiFetch<Paginated<WorkOrder>>(`/v1/work-orders${query ? `?${query}` : ''}`),
  });
}

/** Jedan RN sa operacijama + statusima + tokom (odobravanja/lansiranja). */
export function useWorkOrder(id: number | null) {
  return useQuery({
    queryKey: ['work-orders', 'detail', id],
    queryFn: () => apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}`),
    enabled: id != null,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['work-orders'] });
}

/** Kreiranje novog RN-a. */
export function useCreateWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateWorkOrderInput) =>
      apiFetch<{ data: WorkOrder }>('/v1/work-orders', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Odobri / odbij RN. */
export function useApproveWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, approve }: { id: number; approve: boolean }) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approve }),
      }),
    onSuccess: invalidate,
  });
}

/** Lansiraj RN (mora biti saglasan). */
export function useLaunchWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}/launch`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Zaključaj / otključaj RN. */
export function useLockWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, locked }: { id: number; locked: boolean }) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}/lock`, {
        method: 'POST',
        body: JSON.stringify({ locked }),
      }),
    onSuccess: invalidate,
  });
}
