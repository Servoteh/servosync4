'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

// ---------------------------------------------------------------------------
// Zajednički tipovi (odgovaraju backend `structures` modulu — vidi
// backend/src/modules/structures/*.service.ts za tačan oblik odgovora).
// ---------------------------------------------------------------------------

export interface WorkUnitRef {
  code: string;
  name: string;
}

export interface OperationRef {
  workCenterCode: string;
  workCenterName: string;
  workUnitCode: string;
}

export interface WorkerTypeRef {
  id: number;
  name: string;
  additionalPrivileges: boolean;
}

/** URL query string iz mape parametara (prazne/undefined vrednosti se izostavljaju). */
function qs(params: Record<string, string | number | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Invalidira ceo `structures` namespace — sve mutacije osvežavaju liste + brojače. */
function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['structures'] });
}

// ===========================================================================
// RADNICI — /v1/structures/workers
// ===========================================================================

export interface Worker {
  id: number;
  username: string;
  fullName: string | null;
  idNumber: string | null;
  active: boolean | null;
  workUnitCode: string;
  cardId: string;
  loginAccount: string | null;
  workerTypeId: number;
  signatureImage: string | null;
  definesApproval: boolean | null;
  definesLaunch: boolean | null;
  multiAccount: boolean | null;
  commissionPercent: number;
  workUnit: WorkUnitRef | null;
  workerType: WorkerTypeRef | null;
}

export interface WorkerMachineAccess {
  id: number;
  workCenterCode: string;
  note: string | null;
  operation: OperationRef | null;
}

export interface WorkerDetail extends Worker {
  machineAccess: WorkerMachineAccess[];
}

export interface WorkerInput {
  username: string;
  fullName?: string;
  idNumber?: string;
  cardId?: string;
  loginAccount?: string;
  workUnitCode?: string;
  workerTypeId?: number;
  signatureImage?: string;
  definesApproval?: boolean;
  definesLaunch?: boolean;
  multiAccount?: boolean;
  commissionPercent?: number;
  active?: boolean;
}

/** `true` (default aktivni) | `false` (neaktivni) | `all` (svi). */
export type WorkerActiveFilter = 'true' | 'false' | 'all';

export interface WorkersListParams {
  page?: number;
  pageSize?: number;
  q?: string;
  active?: WorkerActiveFilter;
  workUnitCode?: string;
  workerTypeId?: number | '';
}

/** Paginirana lista radnika (+ pretraga, filter aktivnosti / RJ / vrste posla). */
export function useWorkers(params: WorkersListParams) {
  return useQuery({
    queryKey: ['structures', 'workers', params],
    queryFn: () =>
      apiFetch<Paginated<Worker>>(
        `/v1/structures/workers${qs({
          page: params.page && params.page > 1 ? params.page : undefined,
          pageSize: params.pageSize,
          q: params.q,
          active: params.active,
          workUnitCode: params.workUnitCode,
          workerTypeId: params.workerTypeId === '' ? undefined : params.workerTypeId,
        })}`,
      ),
  });
}

/** Jedan radnik + dodeljene operacije (machineAccess). Učitava se pri expand-u / izboru. */
export function useWorker(id: number | null) {
  return useQuery({
    queryKey: ['structures', 'worker', id],
    queryFn: () => apiFetch<{ data: WorkerDetail }>(`/v1/structures/workers/${id}`),
    enabled: id != null,
  });
}

export function useCreateWorker() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: WorkerInput) =>
      apiFetch<{ data: WorkerDetail }>('/v1/structures/workers', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateWorker() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<WorkerInput> }) =>
      apiFetch<{ data: WorkerDetail }>(`/v1/structures/workers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Soft delete — postavlja active=false. Ovo je PODRAZUMEVANI put za sklanjanje
 * radnika; tvrdo brisanje (useDeleteWorker ispod) postoji samo za radnika bez
 * ijedne reference (typo unos), inače backend vraća 409.
 */
export function useDeactivateWorker() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: WorkerDetail }>(`/v1/structures/workers/${id}/deactivate`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/**
 * Tvrdo brisanje radnika — dozvoljeno SAMO kad radnik nema nijednu referencu
 * (typo unos); backend inače vraća 409 „deaktiviraj umesto brisanja".
 */
export function useDeleteWorker() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/structures/workers/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

// ===========================================================================
// RADNE JEDINICE — /v1/structures/work-units
// ===========================================================================

export interface WorkUnit {
  id: number;
  code: string;
  name: string;
}

export interface WorkUnitInput {
  code: string;
  name: string;
}

export function useWorkUnits(params: { page?: number; pageSize?: number; q?: string } = {}) {
  return useQuery({
    queryKey: ['structures', 'work-units', params],
    queryFn: () =>
      apiFetch<Paginated<WorkUnit>>(
        `/v1/structures/work-units${qs({
          page: params.page && params.page > 1 ? params.page : undefined,
          pageSize: params.pageSize,
          q: params.q,
        })}`,
      ),
  });
}

export function useCreateWorkUnit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: WorkUnitInput) =>
      apiFetch<{ data: WorkUnit }>('/v1/structures/work-units', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateWorkUnit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<WorkUnitInput> }) =>
      apiFetch<{ data: WorkUnit }>(`/v1/structures/work-units/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/** Brisanje RJ — backend vraća 409 ako je referišu operacije/radnici ili je code="0". */
export function useDeleteWorkUnit() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/structures/work-units/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

// ===========================================================================
// VRSTE POSLOVA — /v1/structures/worker-types
// ===========================================================================

export interface WorkerType {
  id: number;
  name: string;
  additionalPrivileges: boolean;
}

export interface WorkerTypeInput {
  name: string;
  additionalPrivileges?: boolean;
}

export function useWorkerTypes(params: { page?: number; pageSize?: number; q?: string } = {}) {
  return useQuery({
    queryKey: ['structures', 'worker-types', params],
    queryFn: () =>
      apiFetch<Paginated<WorkerType>>(
        `/v1/structures/worker-types${qs({
          page: params.page && params.page > 1 ? params.page : undefined,
          pageSize: params.pageSize,
          q: params.q,
        })}`,
      ),
  });
}

export function useCreateWorkerType() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: WorkerTypeInput) =>
      apiFetch<{ data: WorkerType }>('/v1/structures/worker-types', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateWorkerType() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<WorkerTypeInput> }) =>
      apiFetch<{ data: WorkerType }>(`/v1/structures/worker-types/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/** Brisanje vrste posla — backend vraća 409 ako postoji ijedan radnik te vrste ili je id=0 (NN). */
export function useDeleteWorkerType() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/structures/worker-types/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

// ===========================================================================
// OPERACIJE — /v1/structures/operations (prirodni ključ = workCenterCode)
// ===========================================================================

export interface Operation {
  id: number;
  workCenterCode: string;
  workCenterName: string;
  note: string | null;
  workUnitCode: string;
  withoutProcess: boolean | null;
  significantForFinishing: boolean | null;
  usesPriority: boolean;
  isSkippable: boolean;
  workUnit: WorkUnitRef | null;
  workersWithAccess: number;
}

export interface OperationCreateInput {
  workCenterCode: string;
  workCenterName: string;
  workUnitCode: string;
  note?: string;
  withoutProcess?: boolean;
  significantForFinishing?: boolean;
  usesPriority?: boolean;
  isSkippable?: boolean;
}

export type OperationUpdateInput = Partial<Omit<OperationCreateInput, 'workCenterCode'>>;

export function useOperations(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  workUnitCode?: string;
} = {}) {
  return useQuery({
    queryKey: ['structures', 'operations', params],
    queryFn: () =>
      apiFetch<Paginated<Operation>>(
        `/v1/structures/operations${qs({
          page: params.page && params.page > 1 ? params.page : undefined,
          pageSize: params.pageSize,
          q: params.q,
          workUnitCode: params.workUnitCode,
        })}`,
      ),
  });
}

export function useCreateOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: OperationCreateInput) =>
      apiFetch<{ data: Operation }>('/v1/structures/operations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ code, data }: { code: string; data: OperationUpdateInput }) =>
      apiFetch<{ data: Operation }>(
        `/v1/structures/operations/${encodeURIComponent(code)}`,
        {
          method: 'PATCH',
          body: JSON.stringify(data),
        },
      ),
    onSuccess: invalidate,
  });
}

/** Brisanje operacije — backend vraća 409 ako je referencirana (RN / pristup mašinama). */
export function useDeleteOperation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (code: string) =>
      apiFetch<{ data: { workCenterCode: string; deleted: boolean } }>(
        `/v1/structures/operations/${encodeURIComponent(code)}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

// ===========================================================================
// RADNICI PO MAŠINAMA — /v1/structures/machine-access
// ===========================================================================

export interface MachineAccessRow {
  id: number;
  workerId: number;
  workCenterCode: string;
  note: string | null;
  worker: WorkerRef | null;
  operation: OperationRef | null;
}

export interface BatchMachineAccessInput {
  workerId: number;
  add?: string[];
  remove?: string[];
}

export function useMachineAccess(params: {
  workerId?: number;
  workCenterCode?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: ['structures', 'machine-access', params],
    queryFn: () =>
      apiFetch<Paginated<MachineAccessRow>>(
        `/v1/structures/machine-access${qs({
          workerId: params.workerId,
          workCenterCode: params.workCenterCode,
          page: params.page && params.page > 1 ? params.page : undefined,
          pageSize: params.pageSize,
        })}`,
      ),
    enabled: params.workerId != null || params.workCenterCode != null,
  });
}

/** Ukloni jedan par (radnik, operacija). */
export function useDeleteMachineAccess() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(
        `/v1/structures/machine-access/${id}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

/** Atomarna dodela/oduzimanje operacija jednom radniku (UI matrica). */
export function useBatchMachineAccess() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: BatchMachineAccessInput) =>
      apiFetch<{ data: WorkerMachineAccess[] }>('/v1/structures/machine-access/batch', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}
