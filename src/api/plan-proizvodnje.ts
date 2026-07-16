'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';
import { newClientId } from './plan-montaze';
import { toast } from '@/lib/toast';

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
  // ── Kolone koje BE agent PARALELNO dodaje u /operations/all SELECT (machine/dept nose ih preko SELECT *).
  //    Sve opciono (?:) da tsc/next build prođu nezavisno dok BE još nije živ.
  original_machine_code?: string | null;
  customer_short?: string | null;
  customer_name?: string | null;
  customer_id?: number | string | null;
  is_rework?: boolean | null;
  is_scrap?: boolean | null;
  rework_pieces?: number | null;
  scrap_pieces?: number | null;
  has_bigtehn_drawing?: boolean | null;
  drawings_count?: number | null;
  is_ready_manual?: boolean | null;
  ready_override_by?: string | null;
  ready_override_at?: string | null;
  previous_operation_operacija?: number | string | null;
  // ── TP modal header/log polja (tech-procedure response — header/operations/logs):
  materijal?: string | null;
  dimenzija_materijala?: string | null;
  rn_napomena?: string | null;
  rn_zavrsen?: boolean | null;
  rn_zakljucano?: boolean | null;
  is_done_in_bigtehn?: boolean | null;
  last_finished_at?: string | null;
  [k: string]: unknown;
}

/** Jedan red prijave rada (tech-procedure `logs[]` iz bigtehn_tech_routing_cache). */
export interface TechLog {
  operacija: number | string | null;
  started_at?: string | null;
  finished_at?: string | null;
  machine_code?: string | null;
  worker_id?: number | string | null;
  potpis?: string | null;
  komada?: number | null;
  prn_timer_seconds?: number | null;
  is_completed?: boolean | null;
  napomena?: string | null;
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
  logs: TechLog[];
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

// ─────────────────────────────────────────────────────────────────────────────
// Optimistički obrazac (GAP-PM-20): onMutate patch keširanih OpRow[] + rollback na
// grešku (toast ⚠) + toast ✓ na uspeh. Namena — inline akcije u OpsTable (status,
// hitno, pin, CAM, spremnost, napomena, kooperacija, redosled).
// ─────────────────────────────────────────────────────────────────────────────

/** Ključ otvorene operacije za poređenje u optimističkom patch-u. */
type OpId = { workOrderId: string; lineId: string };

/** Prođi kroz sve keširane operations-liste ({rows}|OpRow[]|search) i patch-uj redove. */
function patchCachedOps(qc: QueryClient, match: (o: OpRow) => boolean, apply: (o: OpRow) => OpRow): void {
  const caches = qc.getQueriesData<unknown>({ queryKey: KEYS.operations });
  for (const [key, data] of caches) {
    if (!data || typeof data !== 'object') continue;
    const d = data as { data?: unknown };
    const payload = d.data;
    if (Array.isArray(payload)) {
      qc.setQueryData(key, { ...d, data: (payload as OpRow[]).map((o) => (match(o) ? apply(o) : o)) });
    } else if (payload && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) {
      const inner = payload as { rows: OpRow[] };
      qc.setQueryData(key, { ...d, data: { ...inner, rows: inner.rows.map((o) => (match(o) ? apply(o) : o)) } });
    }
  }
}

/**
 * Optimistička mutacija sa lokalnim patch-om OpRow-a. `optimistic(v)` vraća delimičan
 * patch koji se primenjuje na red čiji su work_order_id/line_id u `ids(v)`.
 */
function useOptimisticOpMutation<V, R = unknown>(
  fn: (v: V) => Promise<R>,
  ids: (v: V) => OpId,
  optimistic: (v: V) => Partial<OpRow>,
  msgs?: { ok?: string; err?: string },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      const id = ids(v);
      const patch = optimistic(v);
      patchCachedOps(
        qc,
        (o) => o.work_order_id === id.workOrderId && o.line_id === id.lineId,
        (o) => ({ ...o, ...patch }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast(`⚠ ${msgs?.err ?? 'Nije sačuvano — osvežavam.'}`);
    },
    onSuccess: () => {
      if (msgs?.ok) toast(`✓ ${msgs.ok}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.operations }),
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

/**
 * Optimistički overlay upsert za inline akcije u tabeli (GAP-PM-20). Patch mapira
 * camelCase overlay polja na snake_case view kolone da lokalni prikaz odmah reaguje.
 */
export const useOptimisticOverlay = (msgs?: { ok?: string; err?: string }) =>
  useOptimisticOpMutation<OverlayPatch, TxResponse<PpOverlay>>(
    (v) => post<PpOverlay>('/overlays', v),
    (v) => ({ workOrderId: v.workOrderId, lineId: v.lineId }),
    (v) => {
      const p: Partial<OpRow> = {};
      if (v.localStatus !== undefined) p.local_status = v.localStatus;
      if (v.shiftNote !== undefined) p.shift_note = v.shiftNote;
      if (v.shiftSortOrder !== undefined) p.shift_sort_order = v.shiftSortOrder;
      if (v.assignedMachineCode !== undefined) p.assigned_machine_code = v.assignedMachineCode;
      if (v.camReady !== undefined) p.cam_ready = v.camReady;
      if (v.readyOverride !== undefined) p.ready_override = v.readyOverride;
      if (v.cooperationStatus !== undefined) p.cooperation_status = v.cooperationStatus;
      if (v.cooperationPartner !== undefined) p.cooperation_partner = v.cooperationPartner;
      if (v.cooperationExpectedReturn !== undefined) p.cooperation_expected_return = v.cooperationExpectedReturn;
      return p;
    },
    msgs,
  );

export const useReorderOverlays = () =>
  usePpMutation<{ items: { workOrderId: string; lineId: string }[] }>((v) => post('/overlays/reorder', { items: v.items }));

/**
 * Optimistički reorder (drag-drop / „Idi na poziciju N"). Patch-uje red MAŠINE u kešu
 * na novi redosled (rows), a na grešku vraća prethodno stanje + toast (GAP-PM-09/20).
 */
export const useOptimisticReorder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { machine: string | null; orderedRows: OpRow[] }) =>
      post('/overlays/reorder', { items: v.orderedRows.map((x) => ({ workOrderId: x.work_order_id, lineId: x.line_id })) }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      const caches = qc.getQueriesData<unknown>({ queryKey: [...KEYS.operations, 'machine', v.machine] });
      for (const [key, data] of caches) {
        if (!data || typeof data !== 'object') continue;
        const d = data as { data?: { rows?: OpRow[] } };
        if (d.data && Array.isArray(d.data.rows)) {
          qc.setQueryData(key, { ...d, data: { ...d.data, rows: v.orderedRows } });
        }
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast('⚠ Redosled nije sačuvan — osvežavam.');
    },
    onSuccess: () => toast('✓ Redosled sačuvan'),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.operations }),
  });
};

/* ── Urgency ── */

export const useSetUrgent = () =>
  usePpMutation<{ workOrderId: string; reason?: string }>((v) =>
    put(`/urgency/${v.workOrderId}`, { reason: v.reason }),
  );
export const useClearUrgent = () =>
  usePpMutation<{ workOrderId: string }>((v) => del(`/urgency/${v.workOrderId}`));

/** Optimistički HITNO toggle (urgency je po RN-u, pa patch-ujemo sve redove istog work_order_id). */
export const useOptimisticUrgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workOrderId: string; urgent: boolean; reason?: string }) =>
      v.urgent ? put(`/urgency/${v.workOrderId}`, { reason: v.reason }) : del(`/urgency/${v.workOrderId}`),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      patchCachedOps(
        qc,
        (o) => o.work_order_id === v.workOrderId,
        (o) => ({ ...o, is_urgent: v.urgent, urgency_reason: v.urgent ? v.reason ?? o.urgency_reason ?? null : null }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast('⚠ HITNO nije sačuvano — osvežavam.');
    },
    onSuccess: (_r, v) => toast(v.urgent ? '✓ Označeno HITNO' : '✓ HITNO skinuto'),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.operations }),
  });
};

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
