'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/**
 * Preuzmi RN dokument (PDF) i otvori ga u novom tabu za štampu.
 * `bez-barkoda` = varijanta bez operacionih barkoda (MODULE_SPEC_stampa §4).
 * Endpoint traži JWT, pa se PDF povlači kroz `apiBlob` (Authorization header),
 * ne prostim `window.open` na URL.
 */
export async function openWorkOrderRnPdf(
  id: number,
  variant?: 'std' | 'bez-barkoda',
): Promise<void> {
  const qs = variant === 'bez-barkoda' ? '?variant=bez-barkoda' : '';
  const blob = await apiBlob(`/v1/work-orders/${id}/print${qs}`);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Oslobodi objectURL kad se tab otvori (dovoljno vremena da browser učita PDF).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Radni status (handover_statuses id) — MODULE_SPEC_radni_nalozi §4. */
export const WO_STATUS = {
  IN_PROGRESS: 0,
  APPROVED: 1,
  REJECTED: 2,
  LAUNCHED: 3,
} as const;

/** Vrsta child naloga za doradu/škart (part_quality_types id) — MODULE_SPEC §3.4. */
export const REWORK_QUALITY = {
  DORADA: 1,
  SKART: 2,
} as const;
export type ReworkQuality = (typeof REWORK_QUALITY)[keyof typeof REWORK_QUALITY];

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
  /** RN završen (sve značajne operacije gotove). */
  status: boolean | null;
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
  toolWeight: number | null;
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
  /** RN završen: '' = svi, 'true' = završeni, 'false' = u radu. */
  completed?: '' | 'true' | 'false';
}

/** Ulaz za DORADA/ŠKART child nalog (POST /:id/rework). */
export interface ReworkWorkOrderInput {
  /** Izvorni RN iz kog nastaje child. */
  id: number;
  /** Dorađena/škartirana količina — ceo broj ≥ 1. */
  pieceCount: number;
  /** 1 = DORADA (sufiks -D), 2 = ŠKART (sufiks -S). */
  qualityTypeId: ReworkQuality;
  /** Napomena child naloga (prazno → preuzima napomenu izvora). */
  note?: string;
}

/** Ulaz za bulk-clone predmeta (POST /projects/:sourceProjectId/bulk-clone). */
export interface BulkCloneInput {
  /** Izvorni predmet (u putanji). */
  sourceProjectId: number;
  /** Ciljni (novi) prazan predmet. */
  targetProjectId: number;
  /** Množilac količina (> 0). */
  coefficient: number;
  /** Opciono: samo izabrani nalozi izvornog predmeta (prazno → svi). */
  workOrderIds?: number[];
}

export interface BulkCloneResult {
  sourceProjectId: number;
  targetProjectId: number;
  coefficient: number;
  count: number;
  workOrders: { sourceId: number; id: number; identNumber: string }[];
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
  if (params.completed) qs.set('completed', params.completed);
  const query = qs.toString();
  return useQuery({
    queryKey: ['work-orders', params],
    queryFn: () =>
      apiFetch<Paginated<WorkOrder>>(`/v1/work-orders${query ? `?${query}` : ''}`),
  });
}

/**
 * Wrapper nad `useWorkOrders` za ComboBox (`useSearch: (q) => …`) — pretraga
 * izvornog RN-a u dijalogu „Kopiraj iz naloga". Vraća prvu stranu liste.
 */
export function useWorkOrdersLookup(q: string) {
  return useWorkOrders({ q: q || undefined });
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

/** Kopiraj sve stavke iz izvornog RN-a (`sourceId`) u prazan cilj (`id`). */
export function useCopyFromWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, sourceId }: { id: number; sourceId: number }) =>
      apiFetch<{ data: WorkOrderDetail }>(
        `/v1/work-orders/${id}/copy-from/${sourceId}`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: invalidate,
  });
}

/** DORADA/ŠKART: kreiraj child RN iz izvora (sufiks -D/-S). */
export function useReworkWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, pieceCount, qualityTypeId, note }: ReworkWorkOrderInput) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}/rework`, {
        method: 'POST',
        body: JSON.stringify({
          pieceCount,
          qualityTypeId,
          note: note?.trim() || undefined,
        }),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena zaglavlja RN-a (samo poslata polja). Identitet se ne menja. */
export interface UpdateWorkOrderInput {
  id: number;
  partName?: string;
  drawingNumber?: string;
  material?: string;
  materialDimension?: string;
  pieceCount?: number;
  unit?: string;
  product?: string;
  note?: string;
  revision?: string;
  qualityTypeId?: number;
  workerId?: number;
  productionDeadline?: string | null;
  externalProjectName?: string;
  externalCustomerId?: number;
}

/** Unos/izmena reda operacije TP-a (RC + norme Tpz/Tk + opis + prioritet). */
export interface WorkOrderOperationInput {
  operationNumber?: number;
  workCenterCode: string;
  workDescription: string;
  toolsFixtures?: string;
  setupTime?: number;
  cycleTime?: number;
  toolWeight?: number;
  priority?: number;
  workerId?: number;
}

/** Izmena zaglavlja RN-a (PATCH /:id). */
export function useUpdateWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateWorkOrderInput) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
  });
}

/** Dodaj operaciju TP na RN (POST /:id/operations). */
export function useAddOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ workOrderId, ...op }: WorkOrderOperationInput & { workOrderId: number }) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${workOrderId}/operations`, {
        method: 'POST',
        body: JSON.stringify(op),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena operacije RN-a (PATCH /:id/operations/:opId). */
export function useUpdateOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      workOrderId,
      operationId,
      ...patch
    }: Partial<WorkOrderOperationInput> & { workOrderId: number; operationId: number }) =>
      apiFetch<{ data: WorkOrderDetail }>(
        `/v1/work-orders/${workOrderId}/operations/${operationId}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      ),
    onSuccess: invalidate,
  });
}

/** Brisanje operacije RN-a (DELETE /:id/operations/:opId). */
export function useDeleteOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ workOrderId, operationId }: { workOrderId: number; operationId: number }) =>
      apiFetch<{ data: WorkOrderDetail }>(
        `/v1/work-orders/${workOrderId}/operations/${operationId}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

/** Brisanje kompletnog RN-a (DELETE /:id). 422 ako zaključan / proizvodnja započeta. */
export function useDeleteWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: true } }>(`/v1/work-orders/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

/** Kloniraj sve (ili izabrane) naloge izvornog predmeta u nov prazan predmet. */
export function useBulkCloneWorkOrders() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      sourceProjectId,
      targetProjectId,
      coefficient,
      workOrderIds,
    }: BulkCloneInput) =>
      apiFetch<{ data: BulkCloneResult }>(
        `/v1/work-orders/projects/${sourceProjectId}/bulk-clone`,
        {
          method: 'POST',
          body: JSON.stringify({
            targetProjectId,
            coefficient,
            workOrderIds: workOrderIds?.length ? workOrderIds : undefined,
          }),
        },
      ),
    onSuccess: invalidate,
  });
}
