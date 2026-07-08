'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Bezbedan podskup radnika (backend nikad ne vraća lozinke). */
export interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

export interface TechProcess {
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
  signature: string | null;
  note: string | null;
  worker: WorkerRef | null;
}

export interface TechProcessDocument {
  id: number;
  fileLink: string;
  fileName: string;
}

export interface TechProcessDetail extends TechProcess {
  documents: TechProcessDocument[];
}

export interface Paginated<T> {
  data: T[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface TpListParams {
  page?: number;
  q?: string;
}

/** Paginirana lista tehnoloških postupaka (+ filter po ident broju). */
export function useTechProcesses(params: TpListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('identNumber', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', params],
    queryFn: () =>
      apiFetch<Paginated<TechProcess>>(
        `/v1/tech-processes${query ? `?${query}` : ''}`,
      ),
  });
}

/** Jedan TP sa radnikom + dokumentacijom (učitava se pri otvaranju reda). */
export function useTechProcess(id: number | null) {
  return useQuery({
    queryKey: ['tech-processes', 'detail', id],
    queryFn: () => apiFetch<{ data: TechProcessDetail }>(`/v1/tech-processes/${id}`),
    enabled: id != null,
  });
}
