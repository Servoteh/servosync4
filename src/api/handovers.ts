'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';
import { useDrawings, type Drawing } from './pdm';

/**
 * Status primopredaje (`drawing_handovers.status_id`) — ISTA `handover_statuses`
 * lookup tabela koju koristi i `work_orders.handover_status_id` (vidi
 * backend/src/modules/handovers/handovers.service.ts — komentar iznad
 * `HANDOVER_STATUS`: vrednosti 1:1 preslikane iz `WO_STATUS`, isti state machine).
 */
export const HANDOVER_STATUS = {
  PENDING: 0, // U OBRADI — na čekanju odobravanja
  APPROVED: 1, // SAGLASAN
  REJECTED: 2, // ODBIJENO
  LAUNCHED: 3, // LANSIRAN
} as const;

// ─────────────────────────────────────────────────────────────── zajednički tipovi

export interface StatusRef {
  id: number;
  name: string;
}

export interface ProjectRef {
  id: number;
  projectNumber: string;
  projectName: string | null;
  customerId: number;
}

/** Podskup polja crteža — isti oblik za nacrte (sa `weight`) i primopredaje (bez). */
export interface DrawingRef {
  id: number;
  drawingNumber: string;
  revision: string;
  name: string;
  material: string | null;
  dimensions: string | null;
  weight?: number | null;
}

// ─────────────────────────────────────────────────────────────── Nacrti (handover-drafts)

export interface HandoverDraftItem {
  id: number;
  draftId: number;
  drawingId: number;
  quantityToProduce: number;
  mainDrawingId: number | null;
  isMain: boolean;
  preCheckDuplicate: boolean;
  preCheckDraftId: number | null;
  preCheckWorkOrderId: number | null;
  excludeFromHandover: boolean;
  decisionAction: number;
  decisionDateTime: string | null;
  quantityDefinedInDrawing: number | null;
  note: string | null;
  drawing: DrawingRef | null;
  mainDrawing: DrawingRef | null;
}

interface HandoverDraftBase {
  id: number;
  draftNumber: string;
  draftDate: string;
  draftType: number;
  designerId: number;
  projectId: number;
  mainDrawingId: number | null;
  pieceCount: number;
  statusId: number;
  note: string | null;
  isLocked: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  designer: WorkerRef | null;
  project: ProjectRef | null;
  mainDrawing: DrawingRef | null;
  status: StatusRef | null;
}

/** Red u listi nacrta — GET /v1/handover-drafts. */
export interface HandoverDraft extends HandoverDraftBase {
  itemsCount: number;
}

/** Detalj nacrta (+ stavke) — GET /v1/handover-drafts/:id. */
export interface HandoverDraftDetail extends HandoverDraftBase {
  items: HandoverDraftItem[];
}

export interface CreateHandoverDraftItemInput {
  drawingId: number;
  quantityToProduce?: number;
  mainDrawingId?: number;
  isMain?: boolean;
  note?: string;
  quantityDefinedInDrawing?: number;
}

export interface CreateHandoverDraftInput {
  designerId: number;
  projectId: number;
  mainDrawingId?: number;
  draftType?: number;
  pieceCount: number;
  note?: string;
  items?: CreateHandoverDraftItemInput[];
}

export interface UpdateHandoverDraftInput {
  projectId?: number;
  mainDrawingId?: number | null;
  draftType?: number;
  pieceCount?: number;
  note?: string | null;
  statusId?: number;
}

export interface HandoverDraftListParams {
  page?: number;
  q?: string;
  statusId?: number | '';
  designerId?: number | '';
  projectId?: number | '';
  isLocked?: '' | 'true' | 'false';
  from?: string;
  to?: string;
}

function buildQuery(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `?${query}` : '';
}

/** Paginirana lista nacrta primopredaje (+ pretraga i filteri). */
export function useHandoverDrafts(params: HandoverDraftListParams) {
  const query = buildQuery({
    page: params.page && params.page > 1 ? params.page : undefined,
    q: params.q,
    statusId: params.statusId === '' ? undefined : params.statusId,
    designerId: params.designerId === '' ? undefined : params.designerId,
    projectId: params.projectId === '' ? undefined : params.projectId,
    isLocked: params.isLocked || undefined,
    from: params.from,
    to: params.to,
  });
  return useQuery({
    queryKey: ['handover-drafts', params],
    queryFn: () => apiFetch<Paginated<HandoverDraft>>(`/v1/handover-drafts${query}`),
  });
}

/** Detalj nacrta sa stavkama (učitava se pri expand-u reda). */
export function useHandoverDraft(id: number | null) {
  return useQuery({
    queryKey: ['handover-drafts', 'detail', id],
    queryFn: () => apiFetch<{ data: HandoverDraftDetail }>(`/v1/handover-drafts/${id}`),
    enabled: id != null,
  });
}

function useInvalidateDrafts() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['handover-drafts'] });
}

/** Kreiranje novog nacrta (zaglavlje + opciono stavke) — broj generiše server. */
export function useCreateHandoverDraft() {
  const invalidate = useInvalidateDrafts();
  return useMutation({
    mutationFn: (input: CreateHandoverDraftInput) =>
      apiFetch<{ data: HandoverDraftDetail }>('/v1/handover-drafts', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena zaglavlja nacrta (samo dok nije zaključan). */
export function useUpdateHandoverDraft() {
  const invalidate = useInvalidateDrafts();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdateHandoverDraftInput }) =>
      apiFetch<{ data: HandoverDraftDetail }>(`/v1/handover-drafts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}

/** Brisanje nacrta (samo dok nije zaključan — hard delete, vidi servis). */
export function useDeleteHandoverDraft() {
  const invalidate = useInvalidateDrafts();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { id: number; deleted: boolean } }>(`/v1/handover-drafts/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: invalidate,
  });
}

// ─────────────────────────────────────────────────────────────── Primopredaje (handovers)

export interface DraftContextRef {
  draftId: number;
  draftNumber: string;
  projectId: number;
  itemId: number;
  quantityToProduce: number;
}

/** Red primopredaje — GET /v1/handovers, /v1/handovers/pending-approval, /v1/handovers/:id. */
export interface Handover {
  id: number;
  drawingId: number;
  handoverDate: string;
  handoverWorkerId: number;
  statusId: number;
  statusChangedAt: string | null;
  statusChangedById: number | null;
  statusChangeComment: string | null;
  launchedAt: string | null;
  launchedById: number | null;
  note: string | null;
  isLocked: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
  drawing: DrawingRef | null;
  status: StatusRef | null;
  handoverWorker: WorkerRef | null;
  statusChangedBy: WorkerRef | null;
  launchedBy: WorkerRef | null;
  /** Najbolji-pokušaj veza ka nacrtu/stavci (`resolveDraftContext` — heuristika, vidi servis). */
  draftContext: DraftContextRef | null;
}

export interface HandoverListParams {
  page?: number;
  statusId?: number | '';
  drawingNumber?: string;
  projectId?: number | '';
  handoverWorkerId?: number | '';
  from?: string;
  to?: string;
}

function buildHandoverQuery(params: HandoverListParams): string {
  return buildQuery({
    page: params.page && params.page > 1 ? params.page : undefined,
    statusId: params.statusId === '' ? undefined : params.statusId,
    drawingNumber: params.drawingNumber,
    projectId: params.projectId === '' ? undefined : params.projectId,
    handoverWorkerId: params.handoverWorkerId === '' ? undefined : params.handoverWorkerId,
    from: params.from,
    to: params.to,
  });
}

/** Paginirana lista svih primopredaja (+ filteri). */
export function useHandovers(params: HandoverListParams) {
  const query = buildHandoverQuery(params);
  return useQuery({
    queryKey: ['handovers', 'list', params],
    queryFn: () => apiFetch<Paginated<Handover>>(`/v1/handovers${query}`),
  });
}

/** Tehnolog inbox — primopredaje na čekanju odobravanja (status U OBRADI). */
export function usePendingApprovalHandovers(params: HandoverListParams) {
  const query = buildHandoverQuery(params);
  return useQuery({
    queryKey: ['handovers', 'pending-approval', params],
    queryFn: () => apiFetch<Paginated<Handover>>(`/v1/handovers/pending-approval${query}`),
  });
}

/** Draft statusi + primopredaja statusi (lookup za filtere/forme). */
export function useHandoverLookups() {
  return useQuery({
    queryKey: ['handovers', 'lookups'],
    queryFn: () =>
      apiFetch<{ data: { draftStatuses: StatusRef[]; handoverStatuses: StatusRef[] } }>(
        '/v1/handovers/lookups',
      ),
    staleTime: 5 * 60_000,
  });
}

/** Radnici sa `defines_approval=true` — tehnolozi za dijalog/filter "Izbor tehnologa". */
export function useTechnologists() {
  return useQuery({
    queryKey: ['handovers', 'technologists'],
    queryFn: () => apiFetch<{ data: WorkerRef[] }>('/v1/handovers/technologists'),
    staleTime: 5 * 60_000,
  });
}

function useInvalidateHandovers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['handovers'] });
}

/** Odobri primopredaju (U OBRADI → SAGLASAN). */
export function useApproveHandover() {
  const invalidate = useInvalidateHandovers();
  return useMutation({
    mutationFn: ({ id, comment }: { id: number; comment?: string }) =>
      apiFetch<{ data: Handover }>(`/v1/handovers/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ comment }),
      }),
    onSuccess: invalidate,
  });
}

/** Odbij primopredaju (U OBRADI → ODBIJENO) — `reason` je OBAVEZAN. */
export function useRejectHandover() {
  const invalidate = useInvalidateHandovers();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      apiFetch<{ data: Handover }>(`/v1/handovers/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Adapter za `ComboBox`: pretraga crteža po broju (nema zaseban "lookup"
 * endpoint za crteže — koristi se postojeći `GET /v1/pdm/drawings?q=` iz
 * `api/pdm.ts`, isti obrazac kao `useMaterialsLookup`/`useDesignersLookup`).
 * Koristi se za biranje `mainDrawingId` / stavki nacrta pri kreiranju.
 */
export function useDrawingsLookup(q: string) {
  const list = useDrawings({ q: q.trim() || undefined });
  return { data: { data: list.data?.data ?? [] }, isLoading: list.isLoading };
}
export type { Drawing };

/** Lansiraj primopredaju (SAGLASAN → LANSIRAN) — kreira `work_orders` red. */
export function useLaunchHandover() {
  const invalidate = useInvalidateHandovers();
  return useMutation({
    mutationFn: ({ id, comment, dueDate }: { id: number; comment?: string; dueDate?: string }) =>
      apiFetch<{ data: { handover: Handover; workOrder: { id: number; identNumber: string } } }>(
        `/v1/handovers/${id}/launch`,
        { method: 'POST', body: JSON.stringify({ comment, dueDate }) },
      ),
    onSuccess: invalidate,
  });
}
