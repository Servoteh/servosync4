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

/** Prioritet liste predmeta (Plan montaže / PB / Lokacije) — server istina + podesiv max. */
export interface PredmetPrioritet {
  ids: number[];
  max: number;
}
/** Telo `POST /predmet-aktivacija/:itemId`. napomena: null/undefined=keep, ''=clear, string=postavi. */
export interface TogglePredmetVars {
  itemId: number;
  aktivan?: boolean;
  projektovanjeMontaza?: boolean;
  napomena?: string | null;
}
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
/** Cilj (target) AI podešavanja u Sistem tabu. */
export type AiModelTarget = 'sastanci' | 'montaza';
/** Odgovor `GET /system/ai-models` — oba modela; svaki `null` ako još nije podešen. */
export interface AiModelsResponse {
  sastanci: AiModelSetting;
  montaza: AiModelSetting;
}

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
  predmetPrioritet: ['admin', 'predmet-aktivacija', 'prioritet'] as const,
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
/** Trenutna lista prioriteta + podesiv maksimum (server istina). */
export function usePredmetPrioritet() {
  return useQuery({
    queryKey: KEYS.predmetPrioritet,
    queryFn: () => apiFetch<{ data: PredmetPrioritet }>(`${BASE}/predmet-aktivacija/prioritet`),
  });
}
export function useAuditLog(params: { tableName?: string; action?: string; page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.audit, params],
    queryFn: () => apiFetch<{ data: AuditRow[]; meta: PageMeta }>(`${BASE}/audit-log${qs({ ...params })}`),
  });
}
export function useAiModels() {
  return useQuery({ queryKey: KEYS.aiModels, queryFn: () => apiFetch<{ data: AiModelsResponse }>(`${BASE}/system/ai-models`) });
}

/** Postavi AI model za jedan cilj (`sastanci`|`montaza`); 42501 → 403 (samo admin). */
export function useSetAiModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { target: AiModelTarget; model: string }) =>
      apiFetch<{ data: AiModelSetting }>(`${BASE}/system/ai-models`, { method: 'PUT', body: JSON.stringify(v) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.aiModels }),
  });
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

// ------------------------------------------------------------------ Grid urednici (allowlist CRUD)

/** Dodaj urednika mesečnog grida (POST). 409 = već postoji (duplikat). */
export const useAddGridEditor = () =>
  useAdminMutation<{ email: string; note?: string }, { data: GridEditor }>(
    (v) => apiFetch<{ data: GridEditor }>(`${BASE}/grid-editors`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.gridEditors,
  );

/** Ukloni urednika mesečnog grida po email-u (DELETE). */
export const useRemoveGridEditor = () =>
  useAdminMutation<{ email: string }, unknown>(
    (v) => apiFetch<unknown>(`${BASE}/grid-editors/${encodeURIComponent(v.email)}`, { method: 'DELETE' }),
    KEYS.gridEditors,
  );

// ------------------------------------------------------------------ Podešavanje predmeta (WRITE — P11)
// Paritet 1.0 `podesavanjePredmeta/*` + `services/predmetAktivacija.js` + `predmetPrioritet.js`.
// Toggle aktivan/proj.-montaža/napomena kroz JEDAN endpoint (set_predmet_aktivacija RPC);
// prioritet lista/max/prev su odvojeni (set_predmet_plan_prioritet_* RPC). 42501→403, 23514→422.

/**
 * Postavi aktivaciju predmeta (POST /:itemId). Aktivan/proj.-montaža/napomena su
 * nezavisni — telo prosleđuje samo prosleđena polja (napomena null=keep, ''=clear).
 * Invalidira listu predmeta; komponenta radi optimistic sa rollback-om na grešku.
 */
export const useTogglePredmet = () =>
  useAdminMutation<TogglePredmetVars, { data?: PredmetRow } | unknown>((v) => {
    const { itemId, ...body } = v;
    return apiFetch<{ data?: PredmetRow } | unknown>(`${BASE}/predmet-aktivacija/${itemId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }, KEYS.predmet);

/** Snimi celu listu prioriteta (PUT). Swap/push cele liste — telo `{ itemIds }`. */
export const useSetPredmetPrioritet = () =>
  useAdminMutation<{ itemIds: number[] }, { data: PredmetPrioritet }>(
    (v) => apiFetch<{ data: PredmetPrioritet }>(`${BASE}/predmet-aktivacija/prioritet`, { method: 'PUT', body: JSON.stringify(v) }),
    KEYS.predmetPrioritet,
  );

/** Postavi maksimalan broj prioriteta 1–50 (PUT /prioritet/max). 23514→422. */
export const useSetPredmetPrioritetMax = () =>
  useAdminMutation<{ max: number }, { data: PredmetPrioritet }>(
    (v) => apiFetch<{ data: PredmetPrioritet }>(`${BASE}/predmet-aktivacija/prioritet/max`, { method: 'PUT', body: JSON.stringify(v) }),
    KEYS.predmetPrioritet,
  );

/**
 * Vrati prethodnu (poslednju različitu, nepraznu) listu iz audita (GET /prioritet/prev).
 * Ne menja stanje — samo dobavlja kandidat listu; primenu radi komponenta kroz
 * `useSetPredmetPrioritet` posle potvrde. Mutacija (ne query) jer je akcija na klik.
 */
export const usePredmetPrioritetPrev = () =>
  useMutation({
    mutationFn: () => apiFetch<{ data: { ids: number[] } }>(`${BASE}/predmet-aktivacija/prioritet/prev`),
  });

// ------------------------------------------------------------------ Vrednosti firme (WRITE — P9; settings.org_profile)
// Paritet 1.0 `companyProfileTab.js` + `services/orgProfile.js`. Jedinstven red company_profile
// (id=1) sa 3 markdown polja. PUT prepisuje sva 3 (null = prazno). 42501→403.

/** Ulaz `PUT /company-profile` — 3 markdown polja jedinstvenog reda (company_profile id=1). */
export interface SaveCompanyProfileVars {
  missionMd: string | null;
  visionMd: string | null;
  valuesMd: string | null;
}
/** Snimi vrednosti firme (PUT). Invalidira companyProfile; 42501 → 403 (samo org_profile krug). */
export const useSaveCompanyProfile = () =>
  useAdminMutation<SaveCompanyProfileVars, { data: CompanyProfile }>(
    (v) => apiFetch<{ data: CompanyProfile }>(`${BASE}/company-profile`, { method: 'PUT', body: JSON.stringify(v) }),
    KEYS.companyProfile,
  );

// ------------------------------------------------------------------ Očekivanja (CRUD — P9; settings.org_profile; DELETE = admin)
// Paritet 1.0 `employeeExpectationsTab.js` + `services/orgProfile.js`. CRUD po zaposlenom +
// „Dodaj za više" (bulk POST). DELETE je admin-only (42501→403). Invalidira expectations.

/** Zajednička polja očekivanja (paritet 1.0 employee_expectations). */
export interface ExpectationFields {
  title: string;
  descriptionMd?: string | null;
  dueDate?: string | null;
  priority: string;
  status: string;
  completionNote?: string | null;
}
export interface CreateExpectationVars extends ExpectationFields {
  employeeId: string;
}
export interface CreateExpectationsBulkVars extends ExpectationFields {
  employeeIds: string[];
}
export interface UpdateExpectationVars extends Partial<ExpectationFields> {
  id: string;
}

/** Kreiraj jedno očekivanje (POST). */
export const useCreateExpectation = () =>
  useAdminMutation<CreateExpectationVars, { data: AdminExpectation }>(
    (v) => apiFetch<{ data: AdminExpectation }>(`${BASE}/expectations`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.expectations,
  );

/** Kreiraj isto očekivanje za više zaposlenih (POST /bulk). Vraća broj kreiranih redova. */
export const useCreateExpectationsBulk = () =>
  useAdminMutation<CreateExpectationsBulkVars, { data: { created: number; expectations?: AdminExpectation[] } }>(
    (v) => apiFetch<{ data: { created: number; expectations?: AdminExpectation[] } }>(`${BASE}/expectations/bulk`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.expectations,
  );

/** Izmeni očekivanje (PATCH /:id). */
export const useUpdateExpectation = () =>
  useAdminMutation<UpdateExpectationVars, { data: AdminExpectation }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: AdminExpectation }>(`${BASE}/expectations/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.expectations);

/** Obriši očekivanje (DELETE /:id — samo admin; 42501 → 403). */
export const useDeleteExpectation = () =>
  useAdminMutation<{ id: string }, unknown>(
    (v) => apiFetch<unknown>(`${BASE}/expectations/${v.id}`, { method: 'DELETE' }),
    KEYS.expectations,
  );

// ------------------------------------------------------------------ Organizacija — struktura CRUD + opis pozicije (WRITE — P8)
// Paritet 1.0 `podesavanja/orgStructureTab.js` + `services/orgStructure.js` + `orgProfile.js`.
// Struktura (odeljenja/pododeljenja/radna mesta) = admin (settings.users); opis pozicije
// (4 md polja) = settings.org_profile; bulk import = sekvencijalni PATCH kroz jedan endpoint.
// Sve mutacije invalidiraju KEYS.orgStructure. Casing: BE prima/vraća camelCase (JobPosition).
// 42501 → 403, 23505 → 409, 23514/P0001 → 422.

// ---- Departments
export interface CreateDepartmentVars {
  name: string;
  sortOrder?: number;
}
export const useCreateDepartment = () =>
  useAdminMutation<CreateDepartmentVars, { data: Department }>(
    (v) => apiFetch<{ data: Department }>(`${BASE}/org/departments`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.orgStructure,
  );
export const useUpdateDepartment = () =>
  useAdminMutation<{ id: number; name?: string; sortOrder?: number }, { data: Department }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: Department }>(`${BASE}/org/departments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.orgStructure);
export const useDeleteDepartment = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${BASE}/org/departments/${v.id}`, { method: 'DELETE' }),
    KEYS.orgStructure,
  );

// ---- Sub-departments
export interface CreateSubDepartmentVars {
  departmentId: number;
  name: string;
  sortOrder?: number;
}
export const useCreateSubDepartment = () =>
  useAdminMutation<CreateSubDepartmentVars, { data: SubDepartment }>(
    (v) => apiFetch<{ data: SubDepartment }>(`${BASE}/org/sub-departments`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.orgStructure,
  );
export const useUpdateSubDepartment = () =>
  useAdminMutation<{ id: number; name?: string; sortOrder?: number }, { data: SubDepartment }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: SubDepartment }>(`${BASE}/org/sub-departments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.orgStructure);
export const useDeleteSubDepartment = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${BASE}/org/sub-departments/${v.id}`, { method: 'DELETE' }),
    KEYS.orgStructure,
  );

// ---- Job positions (struktura)
export interface CreateJobPositionVars {
  departmentId: number;
  subDepartmentId?: number | null;
  name: string;
  sortOrder?: number;
}
export const useCreateJobPosition = () =>
  useAdminMutation<CreateJobPositionVars, { data: JobPosition }>(
    (v) => apiFetch<{ data: JobPosition }>(`${BASE}/org/job-positions`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.orgStructure,
  );
export const useUpdateJobPosition = () =>
  useAdminMutation<{ id: number; name?: string; sortOrder?: number; subDepartmentId?: number | null }, { data: JobPosition }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: JobPosition }>(`${BASE}/org/job-positions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.orgStructure);
export const useDeleteJobPosition = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${BASE}/org/job-positions/${v.id}`, { method: 'DELETE' }),
    KEYS.orgStructure,
  );

// ---- Opis pozicije (4 md polja; settings.org_profile)
/** Telo `PATCH /org/job-positions/:id/profile`. null=obriši sekciju, string=postavi. */
export interface SaveJobPositionProfileVars {
  id: number;
  summaryMd?: string | null;
  expectationsMd?: string | null;
  responsibilitiesMd?: string | null;
  dutiesMd?: string | null;
}
export const useSaveJobPositionProfile = () =>
  useAdminMutation<SaveJobPositionProfileVars, { data: JobPosition }>((v) => {
    const { id, ...body } = v;
    return apiFetch<{ data: JobPosition }>(`${BASE}/org/job-positions/${id}/profile`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.orgStructure);

// ---- Bulk import opisa (POST /org/job-positions/bulk-profile)
export interface BulkProfileItem {
  id: number;
  summaryMd?: string | null;
  expectationsMd?: string | null;
  responsibilitiesMd?: string | null;
  dutiesMd?: string | null;
}
export interface BulkProfileResult {
  ok: number;
  fail: number;
  results: { id: number; ok: boolean; error?: string }[];
}
export const useBulkJobPositionProfiles = () =>
  useAdminMutation<{ items: BulkProfileItem[] }, { data: BulkProfileResult }>(
    (v) => apiFetch<{ data: BulkProfileResult }>(`${BASE}/org/job-positions/bulk-profile`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.orgStructure,
  );

// ------------------------------------------------------------------ Okvir kompetencija — editor CRUD (WRITE — P10; admin)
// Paritet 1.0 `ui/podesavanja/competenceFrameworkEditor.js`. GET framework (`useCompetenceFramework`)
// vraća Prisma camelCase (nameSr/groupId/descriptorSr/textSr/sortOrder). CRUD ide na
// `/v1/admin/competence/{groups,competences,questions}` (drugi agent BE). Sve invalidira KEYS.competence.
// Guard = admin (current_user_is_admin u DB); 42501 → 403, 23514/P0001 → 422, 23505 → 409.

/** Ulaz za grupu (osu). `sortOrder` opciono (BE auto-next kad izostane). */
export interface CompetenceGroupInput {
  nameSr: string;
  descriptionSr?: string | null;
  scope: string;
  sortOrder?: number;
}
/** Jedan opis nivoa u telu kompetencije (prazan `descriptorSr` = obriši nivo). */
export interface CompetenceLevelInput {
  level: number;
  descriptorSr: string;
}
/** Ulaz za kompetenciju (naziv + redosled + nivoi 0–5). */
export interface CompetenceInput {
  groupId: number;
  nameSr: string;
  sortOrder?: number;
  levels: CompetenceLevelInput[];
}
/** Ulaz za pitanje (`groupId` null/izostavljen = opšte pitanje). */
export interface CompetenceQuestionInput {
  groupId?: number | null;
  textSr: string;
  sortOrder?: number;
}

const COMP = `${BASE}/competence`;

// ---- Grupe (ose)
export const useCreateCompetenceGroup = () =>
  useAdminMutation<CompetenceGroupInput, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/groups`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.competence,
  );
export const useUpdateCompetenceGroup = () =>
  useAdminMutation<{ id: number } & Partial<CompetenceGroupInput>, unknown>((v) => {
    const { id, ...body } = v;
    return apiFetch<unknown>(`${COMP}/groups/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.competence);
export const useDeleteCompetenceGroup = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/groups/${v.id}`, { method: 'DELETE' }),
    KEYS.competence,
  );

// ---- Kompetencije (uklj. nivoe 0–5; prazan descriptorSr = obriši nivo)
export const useCreateCompetence = () =>
  useAdminMutation<CompetenceInput, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/competences`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.competence,
  );
export const useUpdateCompetence = () =>
  useAdminMutation<{ id: number } & Partial<CompetenceInput>, unknown>((v) => {
    const { id, ...body } = v;
    return apiFetch<unknown>(`${COMP}/competences/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.competence);
export const useDeleteCompetence = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/competences/${v.id}`, { method: 'DELETE' }),
    KEYS.competence,
  );

// ---- Pitanja (po grupi ili opšta — groupId null)
export const useCreateCompetenceQuestion = () =>
  useAdminMutation<CompetenceQuestionInput, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/questions`, { method: 'POST', body: JSON.stringify(v) }),
    KEYS.competence,
  );
export const useUpdateCompetenceQuestion = () =>
  useAdminMutation<{ id: number } & Partial<CompetenceQuestionInput>, unknown>((v) => {
    const { id, ...body } = v;
    return apiFetch<unknown>(`${COMP}/questions/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }, KEYS.competence);
export const useDeleteCompetenceQuestion = () =>
  useAdminMutation<{ id: number }, unknown>(
    (v) => apiFetch<unknown>(`${COMP}/questions/${v.id}`, { method: 'DELETE' }),
    KEYS.competence,
  );
