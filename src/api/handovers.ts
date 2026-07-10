'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBlob, apiFetch } from './client';
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

/**
 * Predaja nacrta u primopredaju (§6.3) — POST /v1/handover-drafts/:id/submit.
 * Server zaključa nacrt i kreira po jedan `drawing_handovers` red (status U OBRADI)
 * za svaku ne-isključenu stavku. Menja i nacrte (postaje zaključan) i primopredaje
 * (novi redovi), pa invalidira OBA cache ključa. Dozvoljeno samo dok nacrt nije
 * zaključan (backend vraća 409 inače) — UI drži dugme disabled za zaključan nacrt.
 */
export function useSubmitHandoverDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{
        data: { draft: HandoverDraftDetail; handoversCreated: number; handovers: Handover[] };
      }>(`/v1/handover-drafts/${id}/submit`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['handover-drafts'] });
      qc.invalidateQueries({ queryKey: ['handovers'] });
    },
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

/** RN kreiran iz primopredaje (`work_orders.drawing_handover_id`) — null dok ne postoji. */
export interface WorkOrderRef {
  id: number;
  identNumber: string;
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
  /** Dodeljeni tehnolog koji piše TP (0 = nije dodeljen — dodela ide kroz approve). */
  technologistId: number;
  /**
   * Red deriviran sync-om iz QBigTehn tRN-a (`legacy_rn_id != null`, backend
   * enrich). Benigno za čitanje/štampu; odobri/odbij/lansiraj/vrati do
   * cutover-a blokira backend guard sa 409 — UI drži dugmad disabled.
   */
  isLegacy: boolean;
  drawing: DrawingRef | null;
  status: StatusRef | null;
  handoverWorker: WorkerRef | null;
  statusChangedBy: WorkerRef | null;
  launchedBy: WorkerRef | null;
  technologist: WorkerRef | null;
  /** RN otkucan iz ove primopredaje (prepare-work-order / launch) — null dok ne postoji. */
  workOrder: WorkOrderRef | null;
  /** Najbolji-pokušaj veza ka nacrtu/stavci (`resolveDraftContext` — heuristika, vidi servis). */
  draftContext: DraftContextRef | null;
}

export interface HandoverListParams {
  page?: number;
  statusId?: number | '';
  drawingNumber?: string;
  projectId?: number | '';
  handoverWorkerId?: number | '';
  technologistId?: number | '';
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
    technologistId: params.technologistId === '' ? undefined : params.technologistId,
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

/**
 * Adapter za `ComboBox`: tehnolozi filtrirani klijentski — lista je mala i
 * endpoint nema `q` parametar (isti obrazac kao `useDrawingsLookup` ispod).
 */
export function useTechnologistsLookup(q: string) {
  const list = useTechnologists();
  const needle = q.trim().toLowerCase();
  const all = list.data?.data ?? [];
  const data = needle
    ? all.filter((t) =>
        [t.fullName ?? '', t.username].some((s) => s.toLowerCase().includes(needle)),
      )
    : all;
  return { data: { data }, isLoading: list.isLoading };
}

function useInvalidateHandovers() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['handovers'] });
}

/**
 * Odobri primopredaju (U OBRADI → SAGLASAN) + dodeli tehnologa koji piše TP.
 * `technologistId` je OBAVEZAN (backend 422 ako fali / nije aktivan tehnolog).
 */
export function useApproveHandover() {
  const invalidate = useInvalidateHandovers();
  return useMutation({
    mutationFn: ({
      id,
      technologistId,
      comment,
    }: {
      id: number;
      technologistId: number;
      comment?: string;
    }) =>
      apiFetch<{ data: Handover }>(`/v1/handovers/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ technologistId, comment }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * Vrati odobrenu primopredaju na čekanje (SAGLASAN → U OBRADI, undo odobravanja).
 * Backend vraća 409 ako RN za primopredaju već postoji (poruka nosi identNumber
 * + uput da se RN prvo obriše/razreši) — prikazuje se u dijalogu.
 */
export function useReturnHandoverToPending() {
  const invalidate = useInvalidateHandovers();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      apiFetch<{ data: Handover }>(`/v1/handovers/${id}/return-to-pending`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: invalidate,
  });
}

/**
 * "Otkucaj TP" — kreiraj RN iz odobrene primopredaje BEZ lansiranja (primopredaja
 * ostaje SAGLASAN). Idempotentno: ako RN već postoji vraća ga sa `existing: true`.
 */
export function usePrepareHandoverWorkOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ data: { workOrderId: number; identNumber: string; existing: boolean } }>(
        `/v1/handovers/${id}/prepare-work-order`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['handovers'] });
      qc.invalidateQueries({ queryKey: ['work-orders'] });
    },
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

/** RN u odgovoru lansiranja (novi ili postojeći iz prepare toka). */
export interface LaunchedWorkOrderRef {
  id: number;
  identNumber: string;
  variant: number;
  projectId: number;
  drawingNumber: string;
  revision: string;
  pieceCount: number;
  handoverStatusId: number;
}

/**
 * Lansiraj primopredaju (SAGLASAN → LANSIRAN) — kreira `work_orders` red, ili
 * podiže postojeći RN (prepare tok) na LANSIRAN. PAŽNJA: namerno NE invalidira
 * cache — success ekran (`LaunchHandoverDialog`) živi u expandovanom redu liste,
 * pa bi invalidacija sklonila red (i dijalog) pre nego što korisnik stigne do
 * „Otvori RN"/„Štampaj RN". Invalidaciju handovers+work-orders radi dijalog
 * pri zatvaranju.
 */
export function useLaunchHandover() {
  return useMutation({
    mutationFn: ({ id, comment, dueDate }: { id: number; comment?: string; dueDate?: string }) =>
      apiFetch<{ data: { handover: Handover; workOrder: LaunchedWorkOrderRef } }>(
        `/v1/handovers/${id}/launch`,
        { method: 'POST', body: JSON.stringify({ comment, dueDate }) },
      ),
  });
}

// ─────────────────────────────────────────────────────── Štampa crteža (print-bundle, P3)

/** Detektovan format prve strane PDF-a crteža — 'custom' = ne-ISO dimenzije ili nečitljiv PDF. */
export type PrintPageFormat = 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'custom';

/** Stavka print bundle-a — sve stavke nacrta dedupovane po crtežu (backend PrintBundleService). */
export interface PrintBundleItem {
  drawingId: number;
  /** null za orphan drawingId (nema DB FK-a — crtež ne postoji u `drawings`). */
  drawingNumber: string | null;
  revision: string | null;
  name: string | null;
  /** Isključena iz primopredaje — ostaje u listi radi prikaza, ali se NE štampa. */
  excluded: boolean;
  hasPdf: boolean;
  /** Veličina PDF-a u KB (server računa bez učitavanja bloba); null bez PDF-a. */
  sizeKb: number | null;
  /** null = nema PDF-a ili isključena stavka (format se ne detektuje). */
  pageFormat: PrintPageFormat | null;
}

/** Grupa za štampu — samo ne-isključene stavke sa PDF-om, redosled A0→A4→custom. */
export interface PrintBundleGroup {
  format: PrintPageFormat;
  count: number;
  drawingIds: number[];
}

export interface PrintBundle {
  items: PrintBundleItem[];
  groups: PrintBundleGroup[];
  /** Ne-isključene stavke bez PDF-a — ne mogu se štampati. */
  missingCount: number;
}

/** Nivo štampe: nacrt (svi crteži) ili primopredaja (jedan crtež) — iste rute, različit koren. */
export interface PrintBundleScope {
  kind: 'draft' | 'handover';
  id: number;
}

function printBundleBase(scope: PrintBundleScope): string {
  return scope.kind === 'draft' ? `/v1/handover-drafts/${scope.id}` : `/v1/handovers/${scope.id}`;
}

/** Pregled crteža NACRTA za štampu — GET /v1/handover-drafts/:id/print-bundle. */
export function useDraftPrintBundle(id: number | null) {
  return useQuery({
    queryKey: ['handover-drafts', 'print-bundle', id],
    queryFn: () => apiFetch<{ data: PrintBundle }>(`/v1/handover-drafts/${id}/print-bundle`),
    enabled: id != null,
  });
}

/** Pregled crteža PRIMOPREDAJE za štampu (uvek 1 stavka) — GET /v1/handovers/:id/print-bundle. */
export function useHandoverPrintBundle(id: number | null) {
  return useQuery({
    queryKey: ['handovers', 'print-bundle', id],
    queryFn: () => apiFetch<{ data: PrintBundle }>(`/v1/handovers/${id}/print-bundle`),
    enabled: id != null,
  });
}

/**
 * Preuzmi JEDAN spojen PDF izabranih crteža kao `Blob` (za skriveni iframe +
 * `print()` ili otvaranje u novom tabu). `format` XOR `drawingIds` — backend
 * vraća 422 za oba zajedno; bez ijednog = svi ne-isključeni crteži sa PDF-om.
 * Endpoint traži JWT, pa se PDF povlači kroz `apiBlob` (Authorization header),
 * isti obrazac kao `openWorkOrderRnPdf` — ne prosti `window.open` na URL.
 */
export async function fetchPrintBundlePdf(
  scope: PrintBundleScope,
  selection: { format?: PrintPageFormat; drawingIds?: number[] } = {},
): Promise<Blob> {
  const query = buildQuery({
    format: selection.format,
    drawingIds: selection.drawingIds?.length ? selection.drawingIds.join(',') : undefined,
  });
  return apiBlob(`${printBundleBase(scope)}/print-bundle/pdf${query}`);
}
