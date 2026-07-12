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
  /**
   * Izvorni RN iz kog je nastao ovaj dorada/škart child (Paket B t.2).
   * null kad RN nije dorada/škart naslednik. Opciono/defanzivno — polje stiže
   * sa novim backendom (stariji ga ne vraća → undefined).
   */
  parentWorkOrder?: { id: number; identNumber: string; variant: number } | null;
  /**
   * Neto lokacije dela kroz proizvodnju (Paket B t.5). Opciono/defanzivno —
   * prazno/undefined dok backend ne isporuči podatak.
   */
  locations?: Array<{ positionCode: string; quantity: number }>;
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
  /**
   * Dorada/škart naslednici ovog RN-a (Paket B t.2, samo na /:id detalju).
   * qualityTypeId: 1 = dorada, 2 = škart. Opciono/defanzivno.
   */
  reworkChildren?: Array<{
    id: number;
    identNumber: string;
    variant: number;
    qualityTypeId: number;
    pieceCount: number;
  }>;
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
  /** true = samo dorada/škart nalozi (imaju izvorni RN) — Paket B t.2. */
  reworkOnly?: boolean;
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
  if (params.reworkOnly) qs.set('reworkOnly', 'true');
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

/**
 * Lansiraj RN (mora biti saglasan). Ako je RN nastao iz primopredaje
 * (`drawing_handover_id > 0`), backend u istoj transakciji diže i primopredaju
 * na LANSIRAN — zato se invalidira i `handovers` cache (tab „Odobrene").
 */
export function useLaunchWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: WorkOrderDetail }>(`/v1/work-orders/${id}/launch`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      qc.invalidateQueries({ queryKey: ['handovers'] });
    },
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

/** Rezultat klona „Prepiši isti postupak" (POST /:id/clone-variant). */
export interface CloneVariantResult {
  workOrderId: number;
  identNumber: string;
  variant: number;
}

/**
 * „Prepiši isti postupak" (legacy klon-varijanta): NOVI RN sa ISTIM identom i
 * `variant = MAX+1` po (predmet, crtež, revizija); kopira zaglavlje + sve stavke,
 * status kreće od U OBRADI. Stari odštampani RN (manja varijanta) od tada pada
 * na kiosk `staleWorkOrder` upozorenje.
 */
export function useCloneVariantWorkOrder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: CloneVariantResult }>(`/v1/work-orders/${id}/clone-variant`, {
        method: 'POST',
        body: '{}',
      }),
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

/** Ulaz za CAM prioritet operacije (PATCH /operations/:id/priority). */
export interface SetOperationPriorityInput {
  operationId: number;
  /** 0–255 (255 = bez prioriteta / dno planske table). */
  priority: number;
}

/** Podskup keširanog reda planske table dovoljan za optimistic update prioriteta. */
type PriorityRow = { id: number; priority: number };

/**
 * CAM prioritet operacije sa planske table „Operacije po prioritetu" (D7).
 * Namenski endpoint iza `tehnologija.write` — CNC programer NEMA `rn.write`;
 * dozvoljeno i na lansiranom RN-u, zaključan RN → 422. Optimistic update
 * keša planske table (rollback na grešku) + invalidacija na kraju.
 */
export function useSetOperationPriority() {
  const qc = useQueryClient();
  const queueKey = ['work-orders', 'operation-queue'];
  return useMutation({
    mutationFn: ({ operationId, priority }: SetOperationPriorityInput) =>
      apiFetch<{ data: { id: number; workOrderId: number; priority: number } }>(
        `/v1/work-orders/operations/${operationId}/priority`,
        { method: 'PATCH', body: JSON.stringify({ priority }) },
      ),
    onMutate: async ({ operationId, priority }) => {
      await qc.cancelQueries({ queryKey: queueKey });
      const snapshots = qc.getQueriesData<{ data: PriorityRow[] }>({ queryKey: queueKey });
      qc.setQueriesData<{ data: PriorityRow[] }>({ queryKey: queueKey }, (old) =>
        old
          ? {
              ...old,
              data: old.data.map((r) => (r.id === operationId ? { ...r, priority } : r)),
            }
          : old,
      );
      return { snapshots };
    },
    onError: (_err, _input, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: queueKey });
    },
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
