'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ============================================================================
// Projektni biro — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30.md §3.1).
// Data sloj: TanStack Query hooks nad NestJS `/v1/pb/*`. Podaci žive u sy15 (1.0)
// bazi; backend vraća DVA oblika:
//   • pb_tasks embed (raw $queryRaw) → snake_case kolone + project_code/project_name/
//     employee_name; status/vrsta/prioritet su 1.0 LABELE (tekst),
//   • Prisma modeli (komentari/zavisnosti/prilozi/notif-config/work-reports) → camelCase,
//   • DEFINER RPC (projects/engineers/load-stats/summary/tips) → snake_case iz fn.
// Mutacije sa nus-efektima nose `clientEventId` (idempotency; runIdempotentRls). Row-nivo
// (work_reports self-scope, eng-tips draft/org-članstvo, komentar-1h prozor) presuđuje sy15
// RLS/DEFINER na backendu — FE ga NE duplira (samo mapira 403/409/422 u UX).
// ============================================================================

// ------------------------------------------------------------------ helpers

/** Idempotency ključ mutacije (kopija reversi/sastanci obrasca; secure-context fallback). */
export function newClientEventId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const BASE = '/v1/pb';

export interface TxResponse<T = unknown> {
  data: T;
  meta?: { idempotent?: boolean };
}
export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ------------------------------------------------------------------ 1.0 enum labele (§C)

export const PB_STATUSI = ['Nije počelo', 'U toku', 'Pregled', 'Završeno', 'Blokirano'] as const;
export const PB_VRSTE = ['Projektovanje 3D', 'Dokumentacija', 'Nabavka', 'Algoritam', 'Montaža'] as const;
export const PB_PRIORITETI = ['Visok', 'Srednji', 'Nizak'] as const;
export type PbStatus = (typeof PB_STATUSI)[number];

// ------------------------------------------------------------------ tipovi

/** `pb_tasks` red (raw $queryRaw — snake_case) + embed. */
export interface PbTask {
  id: string;
  naziv: string;
  opis: string | null;
  problem: string | null;
  project_id: string | null;
  employee_id: string | null;
  vrsta: string | null;
  prioritet: string | null;
  status: string;
  datum_pocetka_plan: string | null;
  datum_zavrsetka_plan: string | null;
  datum_pocetka_real: string | null;
  datum_zavrsetka_real: string | null;
  procenat_zavrsenosti: number | null;
  norma_sati_dan: number | null;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
  // embed
  project_code: string | null;
  project_name: string | null;
  employee_name: string | null;
}

/** Prisma model komentara (camelCase). */
export interface PbComment {
  id: string;
  taskId: string;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
  createdByUserId: string | null;
  editedAt: string | null;
}

export interface PbDep {
  id: string;
  taskId: string;
  dependsOnTaskId: string;
  createdAt: string;
  createdBy: string | null;
}

export interface PbFile {
  id: string;
  taskId: string;
  fileName: string;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  category: string | null;
  description: string | null;
  deletedAt: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  uploadedByEmail: string | null;
}

/** Van-planski sati (Prisma model; sati → Number). */
export interface PbWorkReport {
  id: string;
  employeeId: string | null;
  datum: string;
  sati: number;
  opis: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface PbNotifConfig {
  id: number;
  enabled: boolean;
  deadlineWarningDays: number;
  overloadThresholdPct: number;
  emailRecipients: string[];
  notifyOnBlocked: boolean;
  notifyOnOverload: boolean;
  notifyOnDeadlineWarning: boolean;
  notifyOnDeadlineOverdue: boolean;
  notifyOnNoEngineer: boolean;
  digestMode: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** DEFINER RPC redovi (snake_case; oblik iz žive fn — permisivno tipizovano). */
export type PbProject = { id: string; project_code: string | null; project_name: string | null } & Record<string, unknown>;
export type PbEngineer = { id: string; full_name: string | null } & Record<string, unknown>;
export type PbLoadStat = { employee_id?: string; full_name?: string; employee_name?: string } & Record<string, unknown>;
export type PbSummaryRow = Record<string, unknown>;
export type PbTipRow = {
  id: string;
  naslov: string;
  telo?: string | null;
  category_id?: string | null;
  category_name?: string | null;
  tags?: string[] | null;
  vendor?: string | null;
  url?: string | null;
  status?: string;
  author_id?: string | null;
  author_name?: string | null;
  likes_count?: number;
  liked_by_me?: boolean;
  views_count?: number;
  created_at?: string;
  updated_at?: string;
} & Record<string, unknown>;
export type PbTipCategory = {
  id: string;
  naziv: string;
  slug?: string | null;
  ikona?: string | null;
  boja?: string | null;
  redosled?: number | null;
  je_aktivna?: boolean;
} & Record<string, unknown>;

export interface SignedUrl {
  url: string;
  expiresIn: number;
}

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['pb'] as const,
  projects: ['pb', 'projects'] as const,
  engineers: ['pb', 'engineers'] as const,
  tasks: ['pb', 'tasks'] as const,
  task: (id: string) => ['pb', 'task', id] as const,
  loadStats: ['pb', 'load-stats'] as const,
  teamLoadStats: ['pb', 'team-load-stats'] as const,
  workReports: ['pb', 'work-reports'] as const,
  tips: ['pb', 'tips'] as const,
  tipCategories: ['pb', 'tips', 'categories'] as const,
  notifConfig: ['pb', 'notification-config'] as const,
};

// ------------------------------------------------------------------ queries

export function useProjects() {
  return useQuery({ queryKey: KEYS.projects, queryFn: () => apiFetch<{ data: PbProject[] }>(`${BASE}/projects`) });
}
export function useEngineers() {
  return useQuery({ queryKey: KEYS.engineers, queryFn: () => apiFetch<{ data: PbEngineer[] }>(`${BASE}/engineers`) });
}

export interface TasksParams {
  projectId?: string;
  employeeId?: string;
  status?: string;
  vrsta?: string;
  q?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}
export function useTasks(params: TasksParams = {}) {
  const query = { ...params, includeDeleted: params.includeDeleted ? 'true' : undefined };
  return useQuery({
    queryKey: [...KEYS.tasks, params],
    queryFn: () => apiFetch<{ data: PbTask[]; meta: PageMeta }>(`${BASE}/tasks${qs(query)}`),
  });
}
export function useTask(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.task(id) : ['pb', 'task', 'none'],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: PbTask }>(`${BASE}/tasks/${id}`),
  });
}
export function useTaskComments(taskId: string | null) {
  return useQuery({
    queryKey: [...KEYS.task(taskId ?? 'none'), 'comments'],
    enabled: !!taskId,
    queryFn: () => apiFetch<{ data: PbComment[] }>(`${BASE}/tasks/${taskId}/comments`),
  });
}
export function useTaskDeps(taskId: string | null) {
  return useQuery({
    queryKey: [...KEYS.task(taskId ?? 'none'), 'deps'],
    enabled: !!taskId,
    queryFn: () => apiFetch<{ data: PbDep[] }>(`${BASE}/tasks/${taskId}/deps`),
  });
}
export function useTaskFiles(taskId: string | null) {
  return useQuery({
    queryKey: [...KEYS.task(taskId ?? 'none'), 'files'],
    enabled: !!taskId,
    queryFn: () => apiFetch<{ data: PbFile[] }>(`${BASE}/tasks/${taskId}/files`),
  });
}

export function useLoadStats(windowDays?: number) {
  return useQuery({
    queryKey: [...KEYS.loadStats, windowDays ?? null],
    queryFn: () => apiFetch<{ data: PbLoadStat[] }>(`${BASE}/load-stats${qs({ windowDays })}`),
  });
}
export function useTeamLoadStats(windowDays?: number) {
  return useQuery({
    queryKey: [...KEYS.teamLoadStats, windowDays ?? null],
    queryFn: () => apiFetch<{ data: PbLoadStat[] }>(`${BASE}/team-load-stats${qs({ windowDays })}`),
  });
}

export interface WorkReportsParams {
  employeeId?: string;
  from?: string;
  to?: string;
}
export function useWorkReports(params: WorkReportsParams = {}) {
  return useQuery({
    queryKey: [...KEYS.workReports, params],
    queryFn: () => apiFetch<{ data: PbWorkReport[] }>(`${BASE}/work-reports${qs({ ...params })}`),
  });
}
export function useWorkReportSummary(params: { from: string; to: string; employeeId?: string } | null) {
  return useQuery({
    queryKey: [...KEYS.workReports, 'summary', params],
    enabled: !!params,
    queryFn: () => apiFetch<{ data: PbSummaryRow[] }>(`${BASE}/work-reports/summary${qs({ ...(params as object) })}`),
  });
}

export interface TipsParams {
  q?: string;
  categoryId?: string;
  tags?: string;
  myOnly?: boolean;
  includeDrafts?: boolean;
  sort?: 'recent' | 'popular';
  limit?: number;
  offset?: number;
}
export function useTips(params: TipsParams = {}) {
  const query = {
    ...params,
    myOnly: params.myOnly ? 'true' : undefined,
    includeDrafts: params.includeDrafts ? 'true' : undefined,
  };
  return useQuery({
    queryKey: [...KEYS.tips, params],
    queryFn: () => apiFetch<{ data: PbTipRow[] }>(`${BASE}/tips${qs(query)}`),
  });
}
export function useTip(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.tips, 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: PbTipRow }>(`${BASE}/tips/${id}`),
  });
}
export function useTipCategories() {
  return useQuery({ queryKey: KEYS.tipCategories, queryFn: () => apiFetch<{ data: PbTipCategory[] }>(`${BASE}/tips/categories`) });
}
export function useNotifConfig() {
  return useQuery({ queryKey: KEYS.notifConfig, queryFn: () => apiFetch<{ data: PbNotifConfig | null }>(`${BASE}/notification-config`) });
}

// ------------------------------------------------------------------ mutations

function usePbMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }) });
}
function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function patch<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/* ── Taskovi ── */

export interface TaskFields {
  naziv?: string;
  opis?: string;
  problem?: string;
  projectId?: string;
  employeeId?: string;
  vrsta?: string;
  prioritet?: string;
  status?: string;
  datumPocetkaPlan?: string;
  datumZavrsetkaPlan?: string;
  datumPocetkaReal?: string;
  datumZavrsetkaReal?: string;
  procenatZavrsenosti?: number;
  normaSatiDan?: number;
}
export const useCreateTask = () =>
  usePbMutation<{ clientEventId: string } & TaskFields & { naziv: string }, TxResponse<PbTask>>((v) => post<PbTask>('/tasks', v));

export const useUpdateTask = () =>
  usePbMutation<{ id: string; patch: TaskFields & { expectedUpdatedAt?: string } }, TxResponse<PbTask>>((v) =>
    patch<PbTask>(`/tasks/${v.id}`, v.patch),
  );

export const useBulkUpdateTasks = () =>
  usePbMutation<{ ids: string[]; status?: string; prioritet?: string; employeeId?: string }>((v) => patch('/tasks/bulk', v));

export const useSoftDeleteTask = () => usePbMutation<{ id: string }>((v) => post(`/tasks/${v.id}/soft-delete`));
export const useBulkSoftDeleteTasks = () => usePbMutation<{ ids: string[] }>((v) => post('/tasks/soft-delete', { ids: v.ids }));

/** Restriktovani edit inženjera — samo status/procenat (pb_update_task_progress). */
export const useUpdateProgress = () =>
  usePbMutation<{ id: string; status?: string; procenat?: number }, TxResponse<PbTask>>((v) =>
    post<PbTask>(`/tasks/${v.id}/progress`, { status: v.status, procenat: v.procenat }),
  );

/* ── Komentari ── */

export const useCreateComment = () =>
  usePbMutation<{ taskId: string; clientEventId: string; body: string }>((v) =>
    post(`/tasks/${v.taskId}/comments`, { clientEventId: v.clientEventId, body: v.body }),
  );
export const useUpdateComment = () =>
  usePbMutation<{ cid: string; body: string }>((v) => patch(`/comments/${v.cid}`, { body: v.body }));
export const useDeleteComment = () => usePbMutation<{ cid: string }>((v) => del(`/comments/${v.cid}`));

/* ── Zavisnosti ── */

export const useAddDep = () =>
  usePbMutation<{ taskId: string; dependsOnTaskId: string }>((v) =>
    post(`/tasks/${v.taskId}/deps`, { dependsOnTaskId: v.dependsOnTaskId }),
  );
export const useDeleteDep = () => usePbMutation<{ depId: string }>((v) => del(`/deps/${v.depId}`));

/* ── Prilozi taska (multipart) ── */

export const useUploadTaskFile = () =>
  usePbMutation<{ taskId: string; file: File; clientEventId: string; category?: string; description?: string }>((v) => {
    const fd = new FormData();
    fd.append('file', v.file, v.file.name);
    fd.append('clientEventId', v.clientEventId);
    if (v.category) fd.append('category', v.category);
    if (v.description) fd.append('description', v.description);
    return apiUpload<TxResponse<unknown>>(`${BASE}/tasks/${v.taskId}/files`, fd);
  });
export const useDeleteTaskFile = () => usePbMutation<{ fileId: string }>((v) => del(`/files/${v.fileId}`));
export function signTaskFile(fileId: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/files/${fileId}/sign`);
}

/* ── Work reports ── */

export const useCreateWorkReport = () =>
  usePbMutation<{ clientEventId: string; datum: string; sati: number; opis?: string; employeeId?: string }>((v) =>
    post('/work-reports', v),
  );
export const useDeleteWorkReport = () => usePbMutation<{ id: string }>((v) => del(`/work-reports/${v.id}`));

/* ── Notif config (pb.admin) ── */

export const useUpdateNotifConfig = () =>
  usePbMutation<Partial<Omit<PbNotifConfig, 'id' | 'updatedAt' | 'updatedBy'>>>((v) => patch('/notification-config', v), KEYS.notifConfig);

/* ── Saveti (eng tips) ── */

export interface SaveTipVars {
  clientEventId: string;
  id?: string;
  naslov: string;
  telo: string;
  categoryId?: string;
  tags?: string[];
  vendor?: string;
  url?: string;
  projectId?: string;
  status?: 'draft' | 'published';
}
export const useSaveTip = () => usePbMutation<SaveTipVars>((v) => post('/tips', v), KEYS.tips);
export const useToggleTipLike = () => usePbMutation<{ id: string }>((v) => post(`/tips/${v.id}/like`), KEYS.tips);
export const useSoftDeleteTip = () => usePbMutation<{ id: string }>((v) => post(`/tips/${v.id}/soft-delete`), KEYS.tips);

export const useUpsertTipCategory = () =>
  usePbMutation<{ id?: string; naziv: string; slug?: string; ikona?: string; boja?: string; redosled?: number; jeAktivna?: boolean }>(
    (v) => post('/tips/categories', v),
    KEYS.tipCategories,
  );
export const useDeleteTipCategory = () => usePbMutation<{ id: string }>((v) => del(`/tips/categories/${v.id}`), KEYS.tipCategories);

export const useUploadTipFile = () =>
  usePbMutation<{ tipId: string; file: File; clientEventId: string }>((v) => {
    const fd = new FormData();
    fd.append('file', v.file, v.file.name);
    fd.append('clientEventId', v.clientEventId);
    return apiUpload<TxResponse<unknown>>(`${BASE}/tips/${v.tipId}/files`, fd);
  }, KEYS.tips);
export const useDeleteTipFile = () => usePbMutation<{ fileId: string }>((v) => del(`/tip-files/${v.fileId}`), KEYS.tips);
export function signTipFile(fileId: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/tip-files/${fileId}/sign`);
}
