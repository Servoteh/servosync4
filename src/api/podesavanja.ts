'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

// ============================================================================
// Podešavanja — RBAC admin konzola + matični + sistem — 3.0 TALAS D (§3.3).
// Data sloj: TanStack Query hooks nad NestJS `/v1/admin/*`. Korisnici = sy15
// `user_roles` (email-based, snake_case raw). Katalog uloga + živa matrica
// (ROLE_PERMISSIONS) se serviraju iz koda (jedan izvor istine, zamena erpRbacMatrix).
// Dvostrano upravljanje nalozima (D1): invite/edit/reset piše u OBA sveta (2.0 master
// → sy15 propagacija); FE prikazuje `sy15Synced` iz odgovora. Row-odluke (user_roles
// ALL=admin, audit SELECT=admin) presuđuje sy15 RLS — FE mapira 403/409/422.
// ============================================================================

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const BASE = '/v1/admin';

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ------------------------------------------------------------------ tipovi

/** `user_roles` red (sy15, snake_case raw). */
export interface UserRoleRow {
  id: string;
  email: string;
  role: string;
  project_id: string | null;
  is_active: boolean | null;
  full_name: string | null;
  team: string | null;
  created_at: string | null;
  updated_at: string | null;
  created_by: string | null;
  must_change_password: boolean | null;
  user_id: string | null;
  managed_departments: unknown;
  managed_sub_department_ids: number[] | null;
  plan_montaze_readonly: boolean | null;
  kadrovska_access: boolean | null;
  kadrovska_hide_contracts: boolean | null;
}

export interface RoleMeta {
  key: string;
  label: string;
  origin: string;
  module: string;
  tier: string;
  note?: string;
}
export interface PermMatrix {
  permissions: string[];
  roles: { role: string; label: string; tier: string; permissions: string[] }[];
}

export interface GridEditor {
  email: string;
  note: string;
  createdAt: string;
}
export interface Department {
  id: number;
  name: string;
  sortOrder: number;
}
export interface SubDepartment {
  id: number;
  departmentId: number;
  name: string;
  sortOrder: number;
}
export interface JobPosition {
  id: number;
  departmentId: number;
  subDepartmentId: number | null;
  name: string;
  sortOrder: number;
  summaryMd: string | null;
  expectationsMd: string | null;
  responsibilitiesMd: string | null;
  dutiesMd: string | null;
  profileUpdatedAt: string | null;
  profileUpdatedBy: string | null;
}
export interface OrgStructure {
  departments: Department[];
  subDepartments: SubDepartment[];
  jobPositions: JobPosition[];
}
export interface Holiday {
  id: string;
  holidayDate: string;
  name: string;
  isWorkday: boolean;
  note: string | null;
}
export interface CompanyProfile {
  id: number;
  missionMd: string | null;
  visionMd: string | null;
  valuesMd: string | null;
  updatedAt: string;
  updatedBy: string | null;
}
export interface AdminExpectation {
  id: string;
  employeeId: string;
  title: string;
  descriptionMd: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  category: string;
  createdBy: string;
  createdAt: string;
}
export interface CompetenceFramework {
  groups: Record<string, unknown>[];
  competences: Record<string, unknown>[];
  levels: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  profilePositions: Record<string, unknown>[];
}
export type PredmetRow = Record<string, unknown>;
export type AuditRow = {
  changed_at?: string;
  table_name?: string;
  action?: string;
  record_id?: string;
  actor_email?: string;
  /** v_settings_audit_log kolona izmenjenih polja (verifikovano protiv žive baze). */
  diff_keys?: string[] | null;
  changed_fields?: string[] | null;
} & Record<string, unknown>;
export type AiModelSetting = { id: number; model: string; updated_at: string; updated_by: string | null } | null;

/** Odgovor D1 mutacija (2.0 master + sy15 propagacija). */
export interface DualWriteResult {
  email: string;
  role?: string;
  sy15Synced?: boolean;
  sy15Error?: string;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['admin'] as const,
  users: ['admin', 'users'] as const,
  rolesCatalog: ['admin', 'roles-catalog'] as const,
  permMatrix: ['admin', 'permissions-matrix'] as const,
  gridEditors: ['admin', 'grid-editors'] as const,
  orgStructure: ['admin', 'org-structure'] as const,
  holidays: ['admin', 'holidays'] as const,
  companyProfile: ['admin', 'company-profile'] as const,
  expectations: ['admin', 'expectations'] as const,
  competence: ['admin', 'competence-framework'] as const,
  predmet: ['admin', 'predmet-aktivacija'] as const,
  audit: ['admin', 'audit-log'] as const,
  aiModels: ['admin', 'ai-models'] as const,
};

// ------------------------------------------------------------------ queries

export interface UsersParams {
  q?: string;
  role?: string;
  isActive?: 'true' | 'false';
}
export function useUsers(params: UsersParams = {}) {
  return useQuery({
    queryKey: [...KEYS.users, params],
    queryFn: () => apiFetch<{ data: UserRoleRow[] }>(`${BASE}/users${qs({ ...params })}`),
  });
}
export function useRolesCatalog() {
  return useQuery({ queryKey: KEYS.rolesCatalog, queryFn: () => apiFetch<{ data: RoleMeta[] }>(`${BASE}/roles/catalog`) });
}
export function usePermissionsMatrix() {
  return useQuery({ queryKey: KEYS.permMatrix, queryFn: () => apiFetch<{ data: PermMatrix }>(`${BASE}/permissions/matrix`) });
}
export function useGridEditors() {
  return useQuery({ queryKey: KEYS.gridEditors, queryFn: () => apiFetch<{ data: GridEditor[] }>(`${BASE}/grid-editors`) });
}
export function useOrgStructure() {
  return useQuery({ queryKey: KEYS.orgStructure, queryFn: () => apiFetch<{ data: OrgStructure }>(`${BASE}/org/structure`) });
}
export function useHolidays() {
  return useQuery({ queryKey: KEYS.holidays, queryFn: () => apiFetch<{ data: Holiday[] }>(`${BASE}/holidays`) });
}
export function useCompanyProfile() {
  return useQuery({ queryKey: KEYS.companyProfile, queryFn: () => apiFetch<{ data: CompanyProfile | null }>(`${BASE}/company-profile`) });
}
export function useAdminExpectations() {
  return useQuery({ queryKey: KEYS.expectations, queryFn: () => apiFetch<{ data: AdminExpectation[] }>(`${BASE}/expectations`) });
}
export function useCompetenceFramework() {
  return useQuery({ queryKey: KEYS.competence, queryFn: () => apiFetch<{ data: CompetenceFramework }>(`${BASE}/competence-framework`) });
}
export function usePredmetAktivacija() {
  return useQuery({ queryKey: KEYS.predmet, queryFn: () => apiFetch<{ data: PredmetRow[] | { data?: PredmetRow[] } | null }>(`${BASE}/predmet-aktivacija`) });
}
export function useAuditLog(params: { tableName?: string; page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.audit, params],
    queryFn: () => apiFetch<{ data: AuditRow[]; meta: PageMeta }>(`${BASE}/audit-log${qs({ ...params })}`),
  });
}
export function useAiModels() {
  return useQuery({ queryKey: KEYS.aiModels, queryFn: () => apiFetch<{ data: { sastanci: AiModelSetting } }>(`${BASE}/system/ai-models`) });
}

// ------------------------------------------------------------------ mutations (D1 dvostrani tok)

function useAdminMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.users) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }) });
}

export interface UserRbacFields {
  fullName?: string;
  team?: string;
  projectId?: string | null;
  managedSubDepartmentIds?: number[] | null;
  planMontazeReadonly?: boolean;
  kadrovskaAccess?: boolean;
  kadrovskaHideContracts?: boolean;
}
export interface InviteUserVars extends UserRbacFields {
  email: string;
  role: string;
  password?: string;
  clientEventId?: string;
}
export const useInviteUser = () =>
  useAdminMutation<InviteUserVars, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/invite`, { method: 'POST', body: JSON.stringify(v) }),
  );

export interface UpdateUserVars extends UserRbacFields {
  id: string;
  role?: string;
  isActive?: boolean;
  mustChangePassword?: boolean;
}
export const useUpdateUser = () =>
  useAdminMutation<UpdateUserVars, { data: DualWriteResult }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  });

export const useResetPassword = () =>
  useAdminMutation<{ id: string; password?: string }, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${v.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: v.password }),
    }),
  );
export const useDeactivateUser = () =>
  useAdminMutation<{ id: string }, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${v.id}/deactivate`, { method: 'POST' }),
  );
export const useActivateUser = () =>
  useAdminMutation<{ id: string }, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${v.id}/activate`, { method: 'POST' }),
  );
export const useSetMustChangePassword = () =>
  useAdminMutation<{ id: string; value: boolean }, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${v.id}/must-change-password`, {
      method: 'POST',
      body: JSON.stringify({ value: v.value }),
    }),
  );
export const useSoftDeleteUser = () =>
  useAdminMutation<{ id: string; confirmEmail: string }, { data: DualWriteResult }>((v) =>
    apiFetch<{ data: DualWriteResult }>(`${BASE}/users/${v.id}`, { method: 'DELETE', body: JSON.stringify({ confirmEmail: v.confirmEmail }) }),
  );
