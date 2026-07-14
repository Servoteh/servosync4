'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';
import { newClientId } from './plan-montaze';

// ============================================================================
// Plan proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3). Data sloj:
// TanStack Query hooks nad NestJS `/v1/plan-proizvodnje/*`. READ = view lanac
// `v_production_operations_effective` (bigtehn keš + overlay + spremnost). Mutacije:
// overlay merge-upsert, urgency set/clear (DELETE nikad), reassign single/bulk (JEDAN
// clientEventId), auto-koop grupe (admin), skice + signed URL. BigInt id-jevi stižu kao
// STRINGOVI (jsonSafe). Row/force odluka presuđuje sy15 kroz withUserRls.
// ============================================================================

const BASE = '/v1/plan-proizvodnje';

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface TxResponse<T = unknown> {
  data: T;
  meta?: Record<string, unknown>;
}
export interface SignedUrl {
  url: string;
  expiresIn: number;
}

// ------------------------------------------------------------------ tipovi

/** Mašina (bigtehn_machines_cache SELECT *). rj_code je stabilan; ostalo tolerantno. */
export interface PpMachine {
  rj_code: string;
  naziv?: string | null;
  name?: string | null;
  [k: string]: unknown;
}

/**
 * Red operacije iz `v_production_operations_effective`. Poznate kolone tipizovane;
 * ostatak view-a dostupan preko index-potpisa (defensivno renderovanje).
 */
export interface OpRow {
  line_id: string;
  work_order_id: string;
  effective_machine_code: string | null;
  assigned_machine_code: string | null;
  broj_crteza: string | null;
  naziv_dela: string | null;
  rn_ident_broj: string | null;
  operacija: number | string | null;
  opis_rada: string | null;
  tpz_min: number | null;
  tk_min: number | null;
  komada_total: number | null;
  komada_done: number | null;
  real_seconds: number | null;
  rok_izrade: string | null;
  prioritet_bigtehn: number | null;
  is_non_machining: boolean | null;
  local_status: string | null;
  shift_note: string | null;
  shift_sort_order: number | null;
  cam_ready: boolean | null;
  ready_override: boolean | null;
  is_ready_for_machine: boolean | null;
  is_urgent: boolean | null;
  auto_sort_bucket: number | null;
  cooperation_status: string | null;
  cooperation_partner: string | null;
  cooperation_expected_return: string | null;
  urgency_reason?: string | null;
  [k: string]: unknown;
}

export interface MachineOpsResult {
  rows: OpRow[];
  has_more: boolean;
  next_work_order_offset: number;
}

export interface CoopGroup {
  rj_group_code: string;
  group_label: string;
  notes: string | null;
  added_at: string | null;
  added_by: string | null;
  removed_at: string | null;
  removed_by: string | null;
}

export interface PpDrawing {
  id: string;
  workOrderId: string;
  lineId: string;
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
  uploadedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface TechProcedure {
  operations: OpRow[];
  logs: Array<Record<string, unknown>>;
  header: OpRow | null;
}

export interface BridgeStatusRow {
  sync_job: string;
  last_finished: string | null;
  status: string | null;
}

/** Overlay (Prisma PpOverlay — camelCase; BigInt-i kao string). */
export interface PpOverlay {
  id: string;
  workOrderId: string;
  lineId: string;
  localStatus: string;
  shiftNote: string | null;
  shiftSortOrder: number | null;
  assignedMachineCode: string | null;
  camReady: boolean;
  readyOverride: boolean;
  cooperationStatus: string;
  cooperationPartner: string | null;
  cooperationExpectedReturn: string | null;
  [k: string]: unknown;
}

/** Deljeni ključ otvorene operacije. */
export function opKey(o: { work_order_id: string; line_id: string }): string {
  return `${o.work_order_id}:${o.line_id}`;
}

export const PP_STATUS_LABELS: Record<string, string> = {
  waiting: 'Čeka',
  in_progress: 'U radu',
  blocked: 'Blokirano',
  completed: 'Završeno',
};

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['pp'] as const,
  machines: ['pp', 'machines'] as const,
  operations: ['pp', 'operations'] as const,
  cooperation: ['pp', 'cooperation'] as const,
  coopGroups: ['pp', 'coop-groups'] as const,
  drawings: ['pp', 'drawings'] as const,
  bridge: ['pp', 'bridge'] as const,
  audit: ['pp', 'audit'] as const,
};

// ------------------------------------------------------------------ queries

export function useMachines() {
  return useQuery({
    queryKey: KEYS.machines,
    queryFn: () => apiFetch<{ data: PpMachine[] }>(`${BASE}/machines`),
  });
}

/** Red operacija po mašini (RPC paginacija) — vraća { rows, has_more, next_… }. */
export function useMachineOperations(machine: string | null, offset = 0, limit = 100) {
  return useQuery({
    queryKey: [...KEYS.operations, 'machine', machine, offset, limit],
    enabled: !!machine,
    queryFn: () =>
      apiFetch<{ data: MachineOpsResult }>(`${BASE}/operations${qs({ machine: machine ?? '', offset, limit })}`),
  });
}

/** Red operacija po odeljenju (view rows). */
export function useDeptOperations(dept: string | null) {
  return useQuery({
    queryKey: [...KEYS.operations, 'dept', dept],
    enabled: !!dept,
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/operations${qs({ dept: dept ?? '' })}`),
  });
}

/** Sve otvorene operacije (agregat) + meta { total, truncated, limit }. */
export function useAllOperations(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.operations, 'all'],
    enabled,
    queryFn: () =>
      apiFetch<{ data: OpRow[]; meta: { total: number; truncated: boolean; limit: number } }>(
        `${BASE}/operations/all`,
      ),
  });
}

export function useOperationsSearch(q: string) {
  return useQuery({
    queryKey: [...KEYS.operations, 'search', q],
    enabled: q.trim().length >= 2,
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/operations/search${qs({ q })}`),
  });
}

export function useCooperation(q = '') {
  return useQuery({
    queryKey: [...KEYS.cooperation, q],
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/cooperation${qs({ q })}`),
  });
}

export function useCooperationGroups() {
  return useQuery({
    queryKey: KEYS.coopGroups,
    queryFn: () => apiFetch<{ data: CoopGroup[] }>(`${BASE}/cooperation/groups`),
  });
}

export function useReassignAudit(enabled = true) {
  return useQuery({
    queryKey: KEYS.audit,
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: Array<Record<string, unknown>> }>(`${BASE}/reassign/audit`),
  });
}

export function useDrawings(workOrder: string | null, line: string | null) {
  return useQuery({
    queryKey: [...KEYS.drawings, workOrder, line],
    enabled: !!workOrder && !!line,
    queryFn: () => apiFetch<{ data: PpDrawing[] }>(`${BASE}/drawings${qs({ workOrder: workOrder!, line: line! })}`),
  });
}

export function useTechProcedure(workOrderId: string | null) {
  return useQuery({
    queryKey: ['pp', 'tech-procedure', workOrderId],
    enabled: !!workOrderId,
    queryFn: () => apiFetch<{ data: TechProcedure }>(`${BASE}/tech-procedure/${workOrderId}`),
  });
}

export function useBridgeStatus() {
  return useQuery({
    queryKey: KEYS.bridge,
    queryFn: () => apiFetch<{ data: BridgeStatusRow[] }>(`${BASE}/bridge-status`),
  });
}

export function fetchDrawingSignUrl(id: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/drawings/${id}/sign`);
}
export function fetchBigtehnDrawingSignUrl(code: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/drawings/bigtehn/sign${qs({ code })}`);
}

// ------------------------------------------------------------------ mutations

function usePpMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.operations) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function put<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
}
function patch<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/* ── Overlay (merge patch) ── */

export interface OverlayPatch {
  workOrderId: string;
  lineId: string;
  localStatus?: string;
  shiftNote?: string | null;
  shiftSortOrder?: number | null;
  assignedMachineCode?: string | null;
  camReady?: boolean;
  readyOverride?: boolean;
  cooperationStatus?: string;
  cooperationPartner?: string | null;
  cooperationExpectedReturn?: string | null;
}
export const useUpsertOverlay = () =>
  usePpMutation<OverlayPatch, TxResponse<PpOverlay>>((v) => post<PpOverlay>('/overlays', v));

export const useReorderOverlays = () =>
  usePpMutation<{ items: { workOrderId: string; lineId: string }[] }>((v) => post('/overlays/reorder', { items: v.items }));

/* ── Urgency ── */

export const useSetUrgent = () =>
  usePpMutation<{ workOrderId: string; reason?: string }>((v) =>
    put(`/urgency/${v.workOrderId}`, { reason: v.reason }),
  );
export const useClearUrgent = () =>
  usePpMutation<{ workOrderId: string }>((v) => del(`/urgency/${v.workOrderId}`));

/* ── Reassign (single/bulk; clientEventId obavezan za idempotenciju) ── */

export interface ReassignVars {
  workOrderId: string;
  lineId: string;
  targetMachine?: string | null;
  force?: boolean;
  reason?: string;
  clientEventId?: string;
}
export const useReassign = () =>
  usePpMutation<ReassignVars>((v) => post('/reassign', { clientEventId: newClientId(), ...v }));

export interface BulkReassignVars {
  pairs: { workOrderId: string; lineId: string }[];
  targetMachine?: string | null;
  force?: boolean;
  reason?: string;
  clientEventId?: string;
}
export const useBulkReassign = () =>
  usePpMutation<BulkReassignVars>((v) => post('/reassign/bulk', { clientEventId: newClientId(), ...v }));

/* ── Kooperacija — auto grupe (admin) ── */

export const useCreateCoopGroup = () =>
  usePpMutation<{ rjGroupCode: string; groupLabel: string; notes?: string }>(
    (v) => post('/cooperation/groups', v),
    KEYS.coopGroups,
  );
export const usePatchCoopGroup = () =>
  usePpMutation<{ code: string; groupLabel?: string; notes?: string; removed?: boolean }>(
    (v) => {
      const { code, ...body } = v;
      return patch(`/cooperation/groups/${encodeURIComponent(code)}`, body);
    },
    KEYS.coopGroups,
  );

/* ── Skice ── */

export const useUploadDrawing = () =>
  usePpMutation<{ workOrder: string; line: string; file: File }, TxResponse<PpDrawing>>((v) => {
    const fd = new FormData();
    fd.append('workOrder', v.workOrder);
    fd.append('line', v.line);
    fd.append('file', v.file, v.file.name);
    return apiUpload<TxResponse<PpDrawing>>(`${BASE}/drawings`, fd);
  }, KEYS.drawings);

export const useDeleteDrawing = () =>
  usePpMutation<{ id: string }>((v) => del(`/drawings/${v.id}`), KEYS.drawings);
