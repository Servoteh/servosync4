'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ============================================================================
// Kadrovska (HR) — 3.0 TALAS G (MODULE_SPEC_kadrovska_30.md §3). Data sloj:
// TanStack Query nad NestJS `/v1/kadrovska/*`. Podaci žive u sy15 (1.0) bazi.
//
// ⚠️ Oblik odgovora zavisi od IZVORA (BE ugovor):
//   • Prisma modeli → camelCase (Contract, Absence, WorkHours, VacationEntitlement…)
//   • sy15 view/RPC rows → snake_case (v_employees_safe, v_vacation_balance,
//     v_attendance_*, medical/cert/dev/expectations/salaryCurrent/salaryPayroll…)
// Zamke: medical/certs/expectations/devPlans/salaryPayroll READ vraćaju snake_case
// view redove, dok njihove MUTACIJE vraćaju camelCase Prisma redove.
//
// PII/zarade maska + row-scope presuđuje sy15 RLS na backendu — FE NE duplira;
// FE SAMO krije afordanse permisijama (zarade/PII se ne prikazuju bez ključa).
// Mutacije koje kreiraju red nose OBAVEZAN `clientEventId`; odluke/prelazi opcioni.
// ============================================================================

const BASE = '/v1/kadrovska';

/** Idempotency ključ (backend runIdempotentRls) — jednom po korisničkoj akciji. */
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

/** Odgovor mutacije: `{ data }` (+ `meta.idempotent` za idempotentne POST-ove). */
export interface TxResponse<T = unknown> {
  data: T;
  meta?: { idempotent?: boolean };
}

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ------------------------------------------------------------------ tipovi

/** Red raw sy15 view-a (snake_case) — poznata polja + prolaz ostalih kolona. */
type ViewRow = Record<string, unknown>;

/** GET /me — bespoke camelCase (prava tekućeg korisnika). */
export interface KadrMe {
  email: string;
  isAdmin: boolean;
  isHr: boolean;
  isHrOrAdmin: boolean;
  poslovniAdmin: boolean;
  isManagement: boolean;
  canSalary: boolean;
  canPii: boolean;
  gridEditor: boolean;
  vacationEditor: boolean;
  canManageVacreq: boolean;
  vacreqAdmin: boolean;
  employeeId: string | null;
  managedSubDeptIds: number[];
}

/** v_employees_safe red (PII-maskiran, snake_case). */
export interface EmployeeSafe extends ViewRow {
  id: string;
  full_name: string;
  position: string | null;
  department: string | null;
  team: string | null;
  phone_work: string | null;
  phone_private: string | null;
  email: string | null;
  is_active: boolean;
}

export interface VacationEntitlement {
  id: string;
  employeeId: string;
  year: number;
  daysTotal: number;
  daysCarriedOver: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  reviewFlag: boolean | null;
  source: string | null;
  openingUsed: number | null;
  accrualModel: boolean;
  accrualBase: number | null;
  accrualStart: string | null;
  advanceApproved: boolean;
  advanceApprovedBy: string | null;
  advanceApprovedAt: string | null;
  advanceNote: string | null;
}

export interface VacationHistory {
  id: string;
  employeeId: string;
  year: number;
  entitledDays: number | null;
  usedDays: number | null;
  remainingDays: number | null;
  entries: unknown;
  rawBlock: string | null;
  source: string;
  sourceFile: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VacationRequest {
  id: string;
  employeeId: string;
  year: number;
  dateFrom: string;
  dateTo: string;
  daysCount: number;
  note: string | null;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  rejectionNote: string | null;
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
  level1By: string | null;
  level1At: string | null;
  source: 'vacation';
}
export interface MakeupRequest {
  id: string;
  employeeId: string;
  absenceDate: string;
  absenceHours: string;
  reason: string | null;
  makeupPlan: string | null;
  makeupDeadline: string | null;
  status: string;
  compensationType: string | null;
  weekendWorkDate: string | null;
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'makeup';
  [k: string]: unknown;
}
export interface PaidLeaveRequest {
  id: string;
  employeeId: string;
  leaveType: string;
  dateFrom: string;
  dateTo: string;
  daysCount: number;
  reason: string | null;
  proofNote: string | null;
  status: string;
  submittedBy: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'paid_leave';
  [k: string]: unknown;
}
export interface NopRequest {
  id: string;
  employeeId: string;
  workDate: string;
  reason: string | null;
  status: string;
  requestedBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  updatedAt: string;
  source: 'nop';
}
export interface RequestsBundle {
  vacation: VacationRequest[];
  makeup: MakeupRequest[];
  paidLeave: PaidLeaveRequest[];
  nop: NopRequest[];
}

export interface Absence {
  id: string;
  employeeId: string;
  type: string;
  dateFrom: string;
  dateTo: string;
  daysCount: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  paidReason: string | null;
  absenceSubtype: string | null;
  slobodanReason: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
}

export interface WorkHours {
  id: string;
  employeeId: string;
  workDate: string;
  hours: string | null;
  overtimeHours: string | null;
  projectRef: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  fieldHours: string | null;
  absenceCode: string | null;
  twoMachineHours: string | null;
  fieldSubtype: string | null;
  absenceSubtype: string | null;
  lastEditedBy: string | null;
  fieldPredmetBroj: string | null;
  fieldPredmetNaziv: string | null;
}
export interface WorkHoursRemark {
  id: string;
  employeeId: string;
  year: number;
  month: number;
  note: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}
export interface KadrHoliday {
  id: string;
  holidayDate: string;
  name: string | null;
  isWorkday: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface GridResponse {
  year: number;
  month: number;
  rows: WorkHours[];
  remarks: WorkHoursRemark[];
  holidays: KadrHoliday[];
}

export interface AttendanceCorrection {
  id: string;
  employeeId: string;
  day: string;
  correctedIn: string | null;
  correctedOut: string | null;
  reason: string | null;
  status: string;
  createdBy: string | null;
  createdForSelf: boolean;
  eventIds: number[];
  cancelledBy: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeChild {
  id: string;
  employeeId: string;
  firstName: string;
  birthDate: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EmployeeBankCard {
  id: string;
  employeeId: string;
  bank: string;
  cardNumber: string | null;
  validThru: string | null;
  isActive: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EmployeeDocument {
  id: string;
  employeeId: string;
  docType: string;
  fileName: string | null;
  storagePath: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  description: string | null;
  uploadedAt: string;
  uploadedBy: string | null;
  deletedAt: string | null;
}

export interface Contract {
  id: string;
  employeeId: string;
  contractType: string;
  contractNumber: string | null;
  position: string | null;
  dateFrom: string;
  dateTo: string | null;
  isActive: boolean | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: string | null;
  probniRad: boolean;
  probniMeseci: number | null;
}

export interface OnboardingRun {
  id: string;
  employeeId: string;
  templateId: string;
  kind: string;
  startDate: string | null;
  status: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}
export interface OnboardingTask {
  id: string;
  runId: string;
  title: string;
  description: string | null;
  sortOrder: number;
  dueDate: string | null;
  assigneeHint: string | null;
  status: string;
  doneAt: string | null;
  doneBy: string | null;
  note: string | null;
}

export interface EmployeeTalk {
  id: string;
  employeeId: string;
  talkType: string;
  talkDate: string | null;
  title: string | null;
  zapisnikMd: string | null;
  status: string;
  conductedBy: string | null;
  planId: string | null;
  raiseDecision: string | null;
  raisePercent: string | null;
  raiseEffectiveFrom: string | null;
  raiseNote: string | null;
  sharedAt: string | null;
  acknowledgedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
}
export interface CorrectivePlan {
  id: string;
  employeeId: string;
  talkId: string | null;
  closingTalkId: string | null;
  reasonMd: string | null;
  status: string;
  followupDate: string | null;
  followupNotifiedAt: string | null;
  visibleToEmployee: boolean;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
  updatedAt: string;
}
export interface CorrectiveMeasure {
  id: string;
  planId: string;
  descriptionMd: string;
  dueDate: string | null;
  responsibleEmployeeId: string | null;
  status: string;
  completedAt: string | null;
  note: string | null;
  sort: number;
  escalatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface TalksBundle {
  talks: EmployeeTalk[];
  correctivePlans: CorrectivePlan[];
  correctiveMeasures: CorrectiveMeasure[];
}

export interface Assessment {
  id: string;
  cycleId: string | null;
  employeeId: string;
  planId: string | null;
  profileId: number | null;
  periodLabel: string | null;
  status: string;
  visibleToEmployee: boolean;
  openedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SalaryTerm {
  id: string;
  employeeId: string;
  salaryType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  amount: string | null;
  amountType: string | null;
  currency: string | null;
  compensationModel: string | null;
  netoRsd: string | null;
  brutoRsd: string | null;
  transportAllowanceRsd: string | null;
  perDiemRsd: string | null;
  perDiemEur: string | null;
  payrollGroup: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  [k: string]: unknown;
}

export interface NotificationConfig {
  id: number;
  enabled: boolean;
  medicalLeadDays: number | null;
  contractLeadDays: number | null;
  birthdayEnabled: boolean;
  workAnniversaryEnabled: boolean;
  whatsappRecipients: string[];
  emailRecipients: string[];
  updatedAt: string;
  updatedBy: string | null;
  childBirthdayEnabled: boolean;
  birthdayOversightEnabled: boolean;
  birthdayDigestEnabled: boolean;
  lkLeadDays: number | null;
  passportLeadDays: number | null;
  driverLicenseLeadDays: number | null;
  medicalEmpLeadDays: number | null;
}

/** Scope pozivaoca koji RPC vraća (kadr_dashboard_kpis.scope_kind). */
export type DashboardScopeKind =
  | 'admin'
  | 'hr'
  | 'menadzment_full'
  | 'menadzment_scoped'
  | 'viewer'
  | 'no_access';

/** KPI blok (RPC kadr_dashboard_kpis) — brojevi za KPI strip Pregleda. */
export interface DashboardKpis {
  year: number;
  month: number;
  scope_kind: DashboardScopeKind;
  managed_sub_department_ids: number[] | null;
  active_employees: number;
  on_absence_today: number;
  pending_vac_requests: number;
  pending_makeup: number;
  pending_paid_leave: number;
  grid_fill_percent: number;
}

/** Mini izveštaji (RPC kadr_dashboard_mini_reports) — feed za kompaktne pregled-trake. */
export interface DashboardMiniReports {
  year: number;
  month: number;
  scope_kind: DashboardScopeKind;
  employees_by_department: { department: string; count: number }[];
  hours_per_day: { date: string; hours: number }[];
  absences_by_type: { type: string; days: number }[];
}

/** Stavka action-steka (RPC kadr_dashboard_action_stack) — „Šta čeka mene". */
export interface DashboardActionItem {
  id: string;
  type: string;
  priority: number;
  title: string;
  subtitle: string;
  deep_link_tab: string;
  deep_link_filter?: Record<string, unknown> | null;
}

export interface DashboardResponse {
  year: number;
  month: number;
  kpis: DashboardKpis | null;
  miniReports: DashboardMiniReports | null;
  actionStack: DashboardActionItem[] | null;
}

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['kadrovska'] as const,
  me: ['kadrovska', 'me'] as const,
  dashboard: ['kadrovska', 'dashboard'] as const,
  employees: ['kadrovska', 'employees'] as const,
  employee: (id: string) => ['kadrovska', 'employee', id] as const,
  vacation: ['kadrovska', 'vacation'] as const,
  requests: ['kadrovska', 'requests'] as const,
  absences: ['kadrovska', 'absences'] as const,
  grid: ['kadrovska', 'grid'] as const,
  workHours: ['kadrovska', 'work-hours'] as const,
  attendance: ['kadrovska', 'attendance'] as const,
  contracts: ['kadrovska', 'contracts'] as const,
  medical: ['kadrovska', 'medical'] as const,
  certificates: ['kadrovska', 'certificates'] as const,
  directory: ['kadrovska', 'directory'] as const,
  onboarding: ['kadrovska', 'onboarding'] as const,
  dev: ['kadrovska', 'dev'] as const,
  talks: ['kadrovska', 'talks'] as const,
  assessments: ['kadrovska', 'assessments'] as const,
  salary: ['kadrovska', 'salary'] as const,
  notifications: ['kadrovska', 'notifications'] as const,
  pii: (id: string) => ['kadrovska', 'pii', id] as const,
};

// ------------------------------------------------------------------ reads

export function useKadrMe() {
  return useQuery({ queryKey: KEYS.me, queryFn: () => apiFetch<{ data: KadrMe }>(`${BASE}/me`) });
}

export function useKadrDashboard(params: { year?: number; month?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.dashboard, params],
    queryFn: () => apiFetch<{ data: DashboardResponse }>(`${BASE}/dashboard${qs({ ...params })}`),
  });
}

export interface EmployeesParams {
  q?: string;
  active?: boolean;
  department?: string;
  page?: number;
  pageSize?: number;
}
export function useEmployees(params: EmployeesParams = {}) {
  return useQuery({
    queryKey: [...KEYS.employees, params],
    queryFn: () => apiFetch<{ data: EmployeeSafe[]; meta: PageMeta }>(`${BASE}/employees${qs({ ...params })}`),
  });
}
export function useEmployee(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.employee(id) : ['kadrovska', 'employee', 'none'],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: EmployeeSafe }>(`${BASE}/employees/${id}`),
  });
}
export function useDirectory() {
  return useQuery({ queryKey: KEYS.directory, queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/directory`) });
}

/* PII pod-resursi (enabled samo kad pozivalac ima kadrovska.pii) */
export function useEmployeeChildren(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'children'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: EmployeeChild[] }>(`${BASE}/employees/${id}/children`),
  });
}
export function useEmployeeBankCards(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'bank-cards'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: EmployeeBankCard[] }>(`${BASE}/employees/${id}/bank-cards`),
  });
}
export function useEmployeeForeignDocs(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'foreign-docs'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/employees/${id}/foreign-docs`),
  });
}
export function useEmployeePersonalDocs(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'personal-docs'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/employees/${id}/personal-docs`),
  });
}
export function useEmployeeDocuments(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'documents'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: EmployeeDocument[] }>(`${BASE}/employees/${id}/documents`),
  });
}

/* Odmori */
export function useVacationBalance(params: { employeeId?: string; year?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.vacation, 'balance', params],
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/vacation/balance${qs({ ...params })}`),
  });
}
export function useVacationHistory(params: { employeeId?: string; year?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.vacation, 'history', params],
    queryFn: () => apiFetch<{ data: VacationHistory[] }>(`${BASE}/vacation/history${qs({ ...params })}`),
  });
}
export function useVacationEntitlements(params: { employeeId?: string; year?: number } = {}) {
  return useQuery({
    queryKey: [...KEYS.vacation, 'entitlements', params],
    queryFn: () => apiFetch<{ data: VacationEntitlement[] }>(`${BASE}/vacation/entitlements${qs({ ...params })}`),
  });
}
export function useRequests(params: { status?: string; source?: string; employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.requests, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: RequestsBundle }>(`${BASE}/requests${qs({ ...params })}`),
  });
}
export function useAbsences(params: { employeeId?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.absences, params],
    queryFn: () => apiFetch<{ data: Absence[] }>(`${BASE}/absences${qs({ ...params })}`),
  });
}
export function useAbsentNow() {
  return useQuery({
    queryKey: [...KEYS.absences, 'now'],
    queryFn: () => apiFetch<{ data: Absence[] }>(`${BASE}/absences/absent-now`),
  });
}

/* Sati */
export function useGrid(params: { year?: number; month?: number; employeeId?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.grid, params],
    queryFn: () => apiFetch<{ data: GridResponse }>(`${BASE}/grid${qs({ ...params })}`),
  });
}
export function useWorkHours(params: { employeeId?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.workHours, params],
    queryFn: () => apiFetch<{ data: WorkHours[] }>(`${BASE}/work-hours${qs({ ...params })}`),
  });
}

/* Prisustvo */
export function useAttendanceNow(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'now'],
    enabled,
    retry: false,
    refetchInterval: 60000,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/attendance/now`),
  });
}
export function useAttendanceShadow(params: { year?: number; month?: number } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'shadow', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/attendance/shadow${qs({ ...params })}`),
  });
}
export function useAttendanceDaily(params: { employeeId?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'daily', params],
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/attendance/daily${qs({ ...params })}`),
  });
}
export function useAttendanceCorrections(params: { employeeId?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'corrections', params],
    queryFn: () => apiFetch<{ data: AttendanceCorrection[] }>(`${BASE}/attendance/corrections${qs({ ...params })}`),
  });
}

/* Ostali read-ovi */
export function useContracts(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.contracts, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: Contract[] }>(`${BASE}/contracts${qs({ ...params })}`),
  });
}
export function useMedicalExams(params: { employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.medical, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/medical-exams${qs({ ...params })}`),
  });
}
export function useCertificates(params: { employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.certificates, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/certificates${qs({ ...params })}`),
  });
}
export function useDevPlans(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.dev, 'plans', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/dev-plans${qs({ ...params })}`),
  });
}
export function useTalks(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.talks, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: TalksBundle }>(`${BASE}/talks${qs({ ...params })}`),
  });
}
export function useAssessments(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: Assessment[] }>(`${BASE}/assessments${qs({ ...params })}`),
  });
}

/* Zarade (admin — enabled samo uz kadrovska.salary) */
export function useSalaryTerms(params: { employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.salary, 'terms', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: SalaryTerm[] }>(`${BASE}/salary/terms${qs({ ...params })}`),
  });
}
export function useSalaryCurrent(params: { employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.salary, 'current', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/salary/current${qs({ ...params })}`),
  });
}
export function useSalaryPayroll(params: { year?: number; month?: number } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.salary, 'payroll', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/salary/payroll${qs({ ...params })}`),
  });
}

export function useNotifications(params: { status?: string; type?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.notifications, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/notifications${qs({ ...params })}`),
  });
}
export function useNotificationConfig(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.notifications, 'config'],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: NotificationConfig | null }>(`${BASE}/notification-config`),
  });
}

// ------------------------------------------------------------------ mutations

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function patch<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/** Sve mutacije invalidiraju širok ['kadrovska'] ključ (paritet sastanci/reversi). */
function useKadrMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

/* ── Odmori: zahtevi (self + odobravanje) ── */
export interface SubmitVacationVars {
  clientEventId: string;
  employeeId?: string;
  year: number;
  dateFrom: string;
  dateTo: string;
  daysCount: number;
  note?: string;
}
export const useSubmitVacation = () =>
  useKadrMutation<SubmitVacationVars>((v) => post('/requests/vacation', v));

export const useVacationApprove = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/vacation/${v.id}/approve`, { clientEventId: v.clientEventId }));
export const useVacationVacreqApprove = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/vacation/${v.id}/vacreq-approve`, { clientEventId: v.clientEventId }));
export const useVacationReject = () =>
  useKadrMutation<{ id: string; note?: string; clientEventId?: string }>((v) => post(`/requests/vacation/${v.id}/reject`, { note: v.note, clientEventId: v.clientEventId }));
export const useVacationReschedule = () =>
  useKadrMutation<{ id: string; dateFrom: string; dateTo: string; daysCount: number; clientEventId?: string }>((v) => {
    const { id, ...body } = v;
    return post(`/requests/vacation/${id}/reschedule`, body);
  });
export const useVacationRevise = () =>
  useKadrMutation<{ id: string; dateFrom: string; dateTo: string; daysCount: number; note?: string; forceReapproval?: boolean; clientEventId?: string }>((v) => {
    const { id, ...body } = v;
    return post(`/requests/vacation/${id}/revise`, body);
  });
export const useVacationCancel = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/vacation/${v.id}/cancel`, { clientEventId: v.clientEventId }));
export const useVacationDelete = () =>
  useKadrMutation<{ id: string }>((v) => del(`/requests/vacation/${v.id}`));

/* Nadoknada / plaćeno / neplaćeno (odobravanje) */
export const useMakeupApprove = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/makeup/${v.id}/approve`, { clientEventId: v.clientEventId }));
export const useMakeupReject = () => useKadrMutation<{ id: string; note?: string }>((v) => post(`/requests/makeup/${v.id}/reject`, { note: v.note }));
export const useMakeupComplete = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/makeup/${v.id}/complete`, { clientEventId: v.clientEventId }));
export const useMakeupStorno = () => useKadrMutation<{ id: string; note?: string }>((v) => post(`/requests/makeup/${v.id}/storno`, { note: v.note }));
export const usePaidLeaveApprove = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/paid-leave/${v.id}/approve`, { clientEventId: v.clientEventId }));
export const usePaidLeaveReject = () => useKadrMutation<{ id: string; note?: string }>((v) => post(`/requests/paid-leave/${v.id}/reject`, { note: v.note }));
export const useNopApprove = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/requests/nop/${v.id}/approve`, { clientEventId: v.clientEventId }));
export const useNopReject = () => useKadrMutation<{ id: string; note?: string }>((v) => post(`/requests/nop/${v.id}/reject`, { note: v.note }));

/* GO saldo / akrual / avans / rollover / bonus (vacation_edit) */
export const useSaveEntitlement = () =>
  useKadrMutation<{ clientEventId: string; employeeId: string; year: number; daysTotal: number; daysCarriedOver?: number; openingUsed?: number; accrualModel?: boolean; accrualBase?: number; accrualStart?: string; note?: string }>((v) => post('/vacation/entitlements', v));
export const useCorrectBalance = () =>
  useKadrMutation<{ employeeId: string; year: number; targetRemaining: number; accrual?: number; clientEventId?: string }>((v) => post('/vacation/correct', v));
export const useSetAdvance = () =>
  useKadrMutation<{ employeeId: string; year: number; approved: boolean; note?: string; clientEventId?: string }>((v) => post('/vacation/advance', v));
export const useRollover = () =>
  useKadrMutation<{ fromYear: number; toYear: number; dryRun?: boolean }>((v) => post('/vacation/rollover', v));
export const useGrantBonusGo = () =>
  useKadrMutation<{ clientEventId: string; employeeId: string; workDate: string; days?: number; reason?: string; makeupRequestId?: string }>((v) => post('/vacation/bonus', v));

/* Odsustva CRUD */
export const useCreateAbsence = () =>
  useKadrMutation<{ clientEventId: string; employeeId: string; type: string; dateFrom: string; dateTo: string; daysCount?: number; note?: string; paidReason?: string; absenceSubtype?: string; slobodanReason?: string }>((v) => post('/absences', v));
export const useUpdateAbsence = () =>
  useKadrMutation<{ id: string; patch: Partial<Absence> }>((v) => patch(`/absences/${v.id}`, v.patch));
export const useDeleteAbsence = () => useKadrMutation<{ id: string }>((v) => del(`/absences/${v.id}`));

/* Sati grid */
export interface GridRowInput {
  employeeId: string;
  workDate: string;
  hours?: number;
  overtimeHours?: number;
  fieldHours?: number;
  fieldSubtype?: 'domestic' | 'foreign';
  twoMachineHours?: number;
  absenceCode?: string;
  absenceSubtype?: string;
  note?: string;
  projectRef?: string;
}
export const useGridBatch = () =>
  useKadrMutation<{ rows: GridRowInput[]; clientEventId?: string }>((v) => post('/grid/batch', v), KEYS.grid);
export const useGridSetGo = () =>
  useKadrMutation<{ employeeId: string; dateFrom: string; dateTo: string; clientEventId?: string }>((v) => post('/grid/go/set', v), KEYS.grid);
export const useGridUnsetGo = () =>
  useKadrMutation<{ employeeId: string; dateFrom: string; dateTo: string; clientEventId?: string }>((v) => post('/grid/go/unset', v), KEYS.grid);
export const useCreateRemark = () =>
  useKadrMutation<{ clientEventId: string; employeeId: string; year: number; month: number; note: string }>((v) => post('/work-hours/remarks', v), KEYS.grid);
export const useResolveRemark = () =>
  useKadrMutation<{ id: string; status?: 'open' | 'resolved' }>((v) => patch(`/work-hours/remarks/${v.id}/resolve`, { status: v.status }), KEYS.grid);

/* Prisustvo korekcije (self ∨ manager) */
export const useSubmitCorrection = () =>
  useKadrMutation<{ employeeId: string; day: string; in?: string; out?: string; reason?: string; clientEventId?: string }>((v) => post('/attendance/corrections', v), KEYS.attendance);
export const useCancelCorrection = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/attendance/corrections/${v.id}/cancel`, { clientEventId: v.clientEventId }), KEYS.attendance);

/* Zaposleni CRUD */
export const useCreateEmployee = () =>
  useKadrMutation<{ clientEventId: string; fullName: string; workType: string; [k: string]: unknown }>((v) => post('/employees', v));
export const useUpdateEmployee = () =>
  useKadrMutation<{ id: string; patch: Record<string, unknown>; expectedUpdatedAt?: string }>((v) => patch(`/employees/${v.id}`, { patch: v.patch, expectedUpdatedAt: v.expectedUpdatedAt }));
export const useDeactivateEmployee = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/employees/${v.id}/deactivate`, { clientEventId: v.clientEventId }));

/* PII pod-resursi CRUD (kadrovska.pii) */
export const useCreateChild = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; firstName: string; birthDate?: string; note?: string }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/children`, body);
  });
export const useUpdateChild = () => useKadrMutation<{ id: string; patch: Partial<EmployeeChild> }>((v) => patch(`/children/${v.id}`, v.patch));
export const useDeleteChild = () => useKadrMutation<{ id: string }>((v) => del(`/children/${v.id}`));
export const useCreateBankCard = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; bank: string; cardNumber?: string; validThru?: string; isActive?: boolean; note?: string }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/bank-cards`, body);
  });
export const useUpdateBankCard = () => useKadrMutation<{ id: string; patch: Partial<EmployeeBankCard> }>((v) => patch(`/bank-cards/${v.id}`, v.patch));
export const useDeleteBankCard = () => useKadrMutation<{ id: string }>((v) => del(`/bank-cards/${v.id}`));
export const useCreateForeignDoc = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; data: Record<string, unknown> }>((v) => post(`/employees/${v.employeeId}/foreign-docs`, { clientEventId: v.clientEventId, data: v.data }));
export const useUpdateForeignDoc = () => useKadrMutation<{ id: string; data: Record<string, unknown> }>((v) => patch(`/foreign-docs/${v.id}`, { data: v.data }));
export const useDeleteForeignDoc = () => useKadrMutation<{ id: string }>((v) => del(`/foreign-docs/${v.id}`));
export const useCreatePersonalDoc = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; data: Record<string, unknown> }>((v) => post(`/employees/${v.employeeId}/personal-docs`, { clientEventId: v.clientEventId, data: v.data }));
export const useUpdatePersonalDoc = () => useKadrMutation<{ id: string; data: Record<string, unknown> }>((v) => patch(`/personal-docs/${v.id}`, { data: v.data }));
export const useDeletePersonalDoc = () => useKadrMutation<{ id: string }>((v) => del(`/personal-docs/${v.id}`));

/* Dokumenta (storage proxy, kadrovska.pii) */
export const useUploadDocument = () =>
  useKadrMutation<{ employeeId: string; file: File; docType: string; description?: string; queueEmail?: boolean; emailLabel?: string; clientEventId?: string }>((v) => {
    const fd = new FormData();
    fd.append('file', v.file, v.file.name);
    fd.append('docType', v.docType);
    if (v.description) fd.append('description', v.description);
    if (v.queueEmail) fd.append('queueEmail', String(v.queueEmail));
    if (v.emailLabel) fd.append('emailLabel', v.emailLabel);
    if (v.clientEventId) fd.append('clientEventId', v.clientEventId);
    return apiUpload<TxResponse<EmployeeDocument>>(`${BASE}/employees/${v.employeeId}/documents`, fd);
  });
export function signDocument(docId: string): Promise<{ data: string }> {
  return apiFetch<{ data: string }>(`${BASE}/documents/${docId}/sign`, { method: 'POST' });
}
export const useDeleteDocument = () => useKadrMutation<{ docId: string }>((v) => del(`/documents/${v.docId}`));

/* Ugovori */
export const useCreateContract = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; contractType: string; dateFrom: string; [k: string]: unknown }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/contracts`, body);
  }, KEYS.contracts);
export const useUpdateContract = () => useKadrMutation<{ id: string; patch: Partial<Contract> }>((v) => patch(`/contracts/${v.id}`, v.patch), KEYS.contracts);
export const useArchiveContract = () => useKadrMutation<{ id: string }>((v) => post(`/contracts/${v.id}/archive`), KEYS.contracts);
export const useRestoreContract = () => useKadrMutation<{ id: string }>((v) => post(`/contracts/${v.id}/restore`), KEYS.contracts);
export const useSetContractSalary = () =>
  useKadrMutation<{ employeeId: string; neto: number; bruto: number; effectiveFrom?: string; clientEventId?: string }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/contract-salary`, body);
  });

/* Medical / Certs (manage) */
export const useCreateMedical = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; examDate: string; examType: string; [k: string]: unknown }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/medical-exams`, body);
  }, KEYS.medical);
export const useDeleteMedical = () => useKadrMutation<{ id: string }>((v) => del(`/medical-exams/${v.id}`), KEYS.medical);
export const useCreateCert = () =>
  useKadrMutation<{ employeeId: string; clientEventId: string; certType: string; certName: string; issuedOn: string; [k: string]: unknown }>((v) => {
    const { employeeId, ...body } = v;
    return post(`/employees/${employeeId}/certificates`, body);
  }, KEYS.certificates);
export const useDeleteCert = () => useKadrMutation<{ id: string }>((v) => del(`/certificates/${v.id}`), KEYS.certificates);

/* Zarade (admin) */
export const useCreateSalaryTerm = () =>
  useKadrMutation<{ clientEventId: string; employeeId: string; salaryType: string; effectiveFrom: string; [k: string]: unknown }>((v) => post('/salary/terms', v), KEYS.salary);
export const useUpdateSalaryTerm = () => useKadrMutation<{ id: string; patch: Record<string, unknown> }>((v) => patch(`/salary/terms/${v.id}`, v.patch), KEYS.salary);
export const useDeleteSalaryTerm = () => useKadrMutation<{ id: string }>((v) => del(`/salary/terms/${v.id}`), KEYS.salary);
export const usePayrollInit = () => useKadrMutation<{ year: number; month: number; clientEventId?: string }>((v) => post('/salary/payroll/init', v), KEYS.salary);
export interface PayrollRecomputeRow { [k: string]: unknown }
export const usePayrollRecompute = () =>
  useKadrMutation<{ year: number; month: number; employeeId?: string; persist?: boolean; clientEventId?: string }, TxResponse<{ year: number; month: number; count: number; rows: PayrollRecomputeRow[] }>>((v) => post('/salary/payroll/recompute', v), KEYS.salary);
export const usePayrollLock = () => useKadrMutation<{ id: string; expectedUpdatedAt: string; clientEventId?: string }>((v) => post(`/salary/payroll/${v.id}/lock`, { expectedUpdatedAt: v.expectedUpdatedAt, clientEventId: v.clientEventId }), KEYS.salary);
export const usePayrollUnlock = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/salary/payroll/${v.id}/unlock`, { clientEventId: v.clientEventId }), KEYS.salary);

/* ── P2 (Zaposleni) dopune — append-only ── */

/** Trajno brisanje zaposlenog (admin; DELETE /employees/:id). FK-vezani podaci → BE greška. */
export const useDeleteEmployee = () => useKadrMutation<{ id: string }>((v) => del(`/employees/${v.id}`));

/**
 * Server-side lista zaposlenih (P1a parami — ListEmployeesQueryDto):
 * q (full_name ILIKE) / department (tekst) / active / filter (quick čip) /
 * conType (aktivan ugovor) / sort+dir (whitelist; 'birthday' = days_to_bday).
 * BE klampuje pageSize na 200 (parsePagination maxSize).
 */
export interface EmployeesListParams extends EmployeesParams {
  filter?: 'med-soon' | 'bday-soon' | 'missing-jmbg' | 'no-email' | 'no-phone';
  conType?: string;
  sort?: 'name' | 'position' | 'department' | 'subDepartment' | 'email' | 'medical' | 'birthday' | 'status';
  dir?: 'asc' | 'desc';
}
export function useEmployeesList(params: EmployeesListParams = {}) {
  return useQuery({
    queryKey: [...KEYS.employees, 'list', params],
    queryFn: () => apiFetch<{ data: EmployeeSafe[]; meta: PageMeta }>(`${BASE}/employees${qs({ ...params })}`),
  });
}

/**
 * SVI zaposleni (Imenik i sl.) — BE klampuje pageSize na 200, pa prolazi kroz
 * strane dok ne pokupi sve (cap 10 strana = 2000; ~157 zaposlenih danas).
 * Paritet obrasca useAllLocations (lokacije.ts).
 */
export function useAllEmployees(active?: boolean) {
  return useQuery({
    queryKey: [...KEYS.employees, 'all', active ?? null],
    staleTime: 60_000,
    queryFn: async () => {
      const pageSize = 200;
      const out: EmployeeSafe[] = [];
      for (let page = 1; page <= 10; page++) {
        const res = await apiFetch<{ data: EmployeeSafe[]; meta: PageMeta }>(
          `${BASE}/employees${qs({ active, page, pageSize })}`,
        );
        out.push(...res.data);
        if (out.length >= res.meta.pagination.total || res.data.length < pageSize) break;
      }
      return out;
    },
  });
}

// ============================================================================
// ── P3 (Dosije) dopune — append-only ──
// PII karton + lekarski/sertifikati/audit. Ugovor po IZVORU (vidi §Zamke gore):
//   • personal-docs / foreign-docs READ = Prisma model → camelCase; WRITE `data`
//     nosi SNAKE_CASE ključeve (BE mapForeign/mapPersonal snake→model).
//   • medical/certs READ = status view (snake_case). ⚠️ v_kadr_medical_exam_status
//     je PER-ZAPOSLENI (jedan red: medical_exam_date/expires/status), NEMA istorije
//     pojedinačnih pregleda ni exam id — edit/delete pojedinačnog reda nije moguć
//     bez BE dopune. v_kadr_certificate_status je PER-SERTIFIKAT (id + status) →
//     pun CRUD radi.
//   • reports/audit vraća CEO v_kadr_audit_log (bez filtera) → filtriraj po
//     employee_id klijentski; guard = kadrovska.admin.
// ============================================================================

/** Lični dokument (LK/pasoš/vozačka) — Prisma model, camelCase (READ). */
export interface EmployeePersonalDoc {
  id: string;
  employeeId: string;
  lkNumber: string | null;
  lkExpiry: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  driverLicenseNumber: string | null;
  driverLicenseExpiry: string | null;
  driverLicenseCategories: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}
/** Strani dokument (pasoš/viza/radna/boravišna) — Prisma model, camelCase (READ). */
export interface EmployeeForeignDoc {
  id: string;
  employeeId: string;
  passportNumber: string | null;
  passportExpiry: string | null;
  visaNumber: string | null;
  visaExpiry: string | null;
  workPermitNumber: string | null;
  workPermitExpiry: string | null;
  residencePermitNumber: string | null;
  residencePermitExpiry: string | null;
  residenceAddress: string | null;
  bankAccount: string | null;
  foreignIdNumber: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// P4 — UGOVORI + HR DOKUMENTA AUTO-TOK (append-only). Novi BE endpointi
// (kb1/p1a-core): GET org-structure, GET employees/:id/pii, GET
// employees/:id/contract-bruto, DELETE contracts/:id, PATCH notification-config.
// Hrane: Ugovori tab (lista/forma/generator), doc-gen auto-save+mejl+prefill,
// PDF Opis radnog mesta, lead-days podešavanje.
// ============================================================================

/** Org struktura (job_positions sa opisnim *_md poljima + reports_to_line) —
 *  auto-popuna radnog mesta/aneksa/opisa + kaskadni selekti. camelCase (Prisma). */
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
  authorityMd: string | null;
  kpiMd: string | null;
  qualificationsMd: string | null;
  collaborationMd: string | null;
  reportsToLine: string | null;
  profileUpdatedAt: string | null;
  profileUpdatedBy: string | null;
}

/** PII karton (unmaskirano, samo kadrovska.pii) — JMBG/prebivalište/sprema za
 *  auto-prefill Ugovora o radu i HR dokumenata. snake_case (sy15 view). */
export interface EmployeePii extends ViewRow {
  id: string;
  full_name: string;
  birth_date: string | null;
  gender: string | null;
  education_level: string | null;
  education_title: string | null;
  personal_id: string | null;
  bank_name: string | null;
  bank_account: string | null;
  address: string | null;
  city: string | null;
  postal_code: string | null;
  phone_private: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relation: string | null;
  emergency_contact_phone_alt: string | null;
}

/** v_kadr_audit_log red (snake_case). before/after su JSON snapshotovi. */
export interface AuditLogRow extends ViewRow {
  id: number;
  actor_user_id: string | null;
  actor_email: string | null;
  action: 'INSERT' | 'UPDATE' | 'DELETE' | string;
  table_name: string | null;
  row_id: string | null;
  employee_id: string | null;
  employee_name: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  changed_at: string | null;
}

/** PII karton (deca/adresa/rođenje/sprema/banka/kontakti). enabled samo uz kadrovska.pii. */
/** Uska bruto per-zaposleni (kadr_get_contract_bruto DEFINER) — poslovni admin
 *  generiše ugovor bez taba Zarade. `bruto` je null kad nema unete zarade. */
export interface ContractBruto {
  employeeId: string;
  bruto: number | null;
}

export function useEmployeePii(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'card'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: EmployeePii }>(`${BASE}/employees/${id}/pii`),
  });
}
// ------------------------------------------------------------------ P5 GO dopune

/** Praznici u rasponu (most odsustvo→grid; datum povratka na Rešenju). Baza read. */
export function useHolidays(params: { from?: string; to?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: ['kadrovska', 'holidays', params],
    enabled,
    queryFn: () => apiFetch<{ data: KadrHoliday[] }>(`${BASE}/holidays${qs({ ...params })}`),
  });
}

// ============================================================================
// P6 — GRID RADNIH SATI (inline editor). Append-only (v3.0 Talas G / P6).
// BE ugovor: C:/kb1 (kadrovska-be/p1a-core). Sve pod /v1/kadrovska osim
// predmeti lookup (/v1/montaza/lookups/predmeti — vidi usePredmetiLookup).
// ============================================================================

/** GET /grid + `locked` (paid mesec) + refetch (realtime zamena, 30s polling). */
export interface GridResponseLocked extends GridResponse {
  locked?: boolean;
}
export function useGridLive(
  params: { year?: number; month?: number; employeeId?: string } = {},
  opts: { refetchMs?: number } = {},
) {
  return useQuery({
    queryKey: [...KEYS.grid, params],
    refetchInterval: opts.refetchMs && opts.refetchMs > 0 ? opts.refetchMs : (false as const),
    queryFn: () => apiFetch<{ data: GridResponseLocked }>(`${BASE}/grid${qs({ ...params })}`),
  });
}

/** GET /grid/payable — Σ isplata (payableHours) + HoursAgg po radniku (gate grid_edit). */
export interface GridPayableRow {
  employeeId: string;
  workType: string | null;
  redovanRadSati: number;
  prekovremeniSati: number;
  praznikRadSati: number;
  praznikPlaceniSati: number;
  godisnjiSati: number;
  slobodniDaniSati: number;
  bolovanje65Sati: number;
  bolovanje100Sati: number;
  dveMasineSati: number;
  neplacenoDays: number;
  sanitized: Partial<Record<string, number>>;
  payableHours: number;
  warnings: { code: string; message: string; [k: string]: unknown }[];
}
export interface GridPayableResponse {
  year: number;
  month: number;
  fondSati: number;
  perEmployee: GridPayableRow[];
}
export function useGridPayable(params: { year?: number; month?: number; employeeId?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.grid, 'payable', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: GridPayableResponse }>(`${BASE}/grid/payable${qs({ ...params })}`),
  });
}

/** GET /holidays (raspon). Grid već nosi holidays; ovo za copyPrev/karnet van meseca. */
export function useKadrHolidays(params: { from?: string; to?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.grid, 'holidays', params],
    enabled,
    queryFn: () => apiFetch<{ data: KadrHoliday[] }>(`${BASE}/holidays${qs({ ...params })}`),
  });
}

/** Uski bruto (za auto-popunu ugovora) — GET /employees/:id/contract-bruto (PII). */
export function useContractBruto(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.pii(id ?? 'none'), 'contract-bruto'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: { employeeId: string; bruto: number | null } }>(`${BASE}/employees/${id}/contract-bruto`),
  });
}

/** Audit log (CEO v_kadr_audit_log; filter po zaposlenom = klijentski). Guard = admin. */
export function useAuditReport(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.all, 'reports', 'audit'],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: AuditLogRow[] }>(`${BASE}/reports/audit`),
  });
}

/** Izmena lekarskog pregleda (manage) — PATCH /medical-exams/:id. Id dolazi iz
 *  istorije pojedinačnih pregleda (useMedicalExamHistory). */
export const useUpdateMedical = () =>
  useKadrMutation<{ id: string; patch: Record<string, unknown> }>((v) => patch(`/medical-exams/${v.id}`, v.patch), KEYS.medical);

/** Pojedinačni lekarski pregled (kadr_medical_exams red) — camelCase (Prisma), exam_date DESC.
 *  Odvojeno od `useMedicalExams` (v_kadr_medical_exam_status = per-zaposleni status view). */
export interface MedicalExam {
  id: string;
  employeeId: string;
  examDate: string;
  validUntil: string | null;
  examType: string;
  institution: string | null;
  costRsd: number | null;
  documentUrl: string | null;
  note: string | null;
  createdAt: string;
}
/** Istorija pregleda zaposlenog — GET /employees/:id/medical-exams → { data: MedicalExam[] }.
 *  Ključ pod KEYS.medical da POST/PATCH/DELETE (KEYS.medical invalidacija) osveže i istoriju. */
export function useMedicalExamHistory(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.medical, 'history', id ?? 'none'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: MedicalExam[] }>(`${BASE}/employees/${id}/medical-exams`),
  });
}
/** Izmena sertifikata (manage) — koristi status-view `id` (per-sertifikat). */
export const useUpdateCert = () =>
  useKadrMutation<{ id: string; patch: Record<string, unknown> }>((v) => patch(`/certificates/${v.id}`, v.patch), KEYS.certificates);

/* Org struktura (GET /org-structure) — kaskadni selekti odeljenje→pododeljenje→
   pozicija u kartonu; Prisma camelCase redovi (departments/sub_departments/job_positions). */
export interface OrgDepartment {
  id: number;
  name: string;
  sortOrder: number;
}
export interface OrgSubDepartment {
  id: number;
  departmentId: number;
  name: string;
  sortOrder: number;
}
export interface OrgJobPosition {
  id: number;
  departmentId: number;
  subDepartmentId: number | null;
  name: string;
  sortOrder: number;
  [k: string]: unknown; // summaryMd/expectationsMd/responsibilitiesMd…
}
export interface OrgStructure {
  departments: OrgDepartment[];
  subDepartments: OrgSubDepartment[];
  // BE jobPosition.findMany bez `select` → pun red (opisna *_md polja) = JobPosition (rich).
  jobPositions: JobPosition[];
}
export function useOrgStructure(enabled = true) {
  return useQuery({
    queryKey: ['kadrovska', 'org-structure'],
    enabled,
    retry: false, // ruta stiže sa P1a merge-om — do tada 404 bez retry oluje
    staleTime: 5 * 60_000,
    queryFn: () => apiFetch<{ data: OrgStructure }>(`${BASE}/org-structure`),
  });
}
/** Imperativni fetch-ovi (za tokove na klik dugmeta — generisanje ugovora/mass). */
export function fetchOrgStructure(): Promise<{ data: OrgStructure }> {
  return apiFetch<{ data: OrgStructure }>(`${BASE}/org-structure`);
}
/** Pun red zaposlenog (v_employees_safe — uklj. position_id + PII za PII pozivaoca). */
export function fetchEmployee(id: string): Promise<{ data: EmployeeSafe }> {
  return apiFetch<{ data: EmployeeSafe }>(`${BASE}/employees/${id}`);
}
export function fetchContractBruto(id: string): Promise<{ data: ContractBruto }> {
  return apiFetch<{ data: ContractBruto }>(`${BASE}/employees/${id}/contract-bruto`);
}

/** Trajno brisanje ugovora IZ ARHIVE (aktivan → BE 422). */
export const useDeleteContract = () =>
  useKadrMutation<{ id: string }>((v) => del(`/contracts/${v.id}`), KEYS.contracts);

/** 🔔 Ručni okidač HR dispatch-a (proxy na 1.0 edge hr-notify-dispatch). */
export interface DispatchResult { ok?: boolean; processed?: number; sent?: number; failed?: number; error?: string }
export const useDispatchNotifications = () =>
  useKadrMutation<void, TxResponse<DispatchResult>>(() => post('/notifications/dispatch'));

/** Imperativni fetch PII kartona (JMBG i dr.) — za Rešenje o GO tok (van React tree-a). */
export function fetchEmployeePii(id: string): Promise<{ data: EmployeePii }> {
  return apiFetch<{ data: EmployeePii }>(`${BASE}/employees/${id}/pii`);
}

/** GET /grid za proizvoljan mesec (copyPrev) — jednokratni fetch, van React Query keša. */
export function fetchGridMonth(params: { year: number; month: number }): Promise<{ data: GridResponse }> {
  return apiFetch<{ data: GridResponse }>(`${BASE}/grid${qs({ ...params })}`);
}

/** POST /grid/batch sa predmet poljima (teren→predmet). absence/predmet null = brisanje. */
export interface GridBatchRow {
  employeeId: string;
  workDate: string;
  hours?: number;
  overtimeHours?: number;
  fieldHours?: number;
  fieldSubtype?: 'domestic' | 'foreign' | null;
  twoMachineHours?: number;
  absenceCode?: string | null;
  absenceSubtype?: string | null;
  note?: string | null;
  projectRef?: string | null;
  fieldPredmetBroj?: string | null;
  fieldPredmetNaziv?: string | null;
}
export const useGridBatchFull = () =>
  useKadrMutation<{ rows: GridBatchRow[]; clientEventId?: string }, TxResponse<WorkHours[]>>(
    (v) => post('/grid/batch', v),
    KEYS.grid,
  );

/** DELETE /work-hours/:id (pojedinačni unos — Sati tab). */
export const useDeleteWorkHours = () => useKadrMutation<{ id: string }>((v) => del(`/work-hours/${v.id}`), KEYS.grid);

/** POST /requests/nop — neplaćeno predlog (non-admin → uprava odobrava). */
export const useSubmitNop = () =>
  useKadrMutation<{ clientEventId?: string; employeeId: string; workDate: string; reason?: string }, TxResponse<NopRequest & { deduped?: boolean }>>(
    (v) => post('/requests/nop', v),
    KEYS.requests,
  );

/** POST /notifications/payroll/run — mesečne notifikacije zaposlenima (kadrovska.manage). */
export const usePayrollNotifyRun = () =>
  useKadrMutation<{ year: number; month: number; clientEventId?: string }, TxResponse<number>>(
    (v) => post('/notifications/payroll/run', v),
  );

/** POST /grid/audit (query params!) — istorija izmena ćelije/meseca. null = nedostupno. */
export interface GridAuditRow {
  id: number;
  action: string;
  actorEmail: string | null;
  changedAt: string | null;
  employeeId: string;
  workDate: string | null;
  oldData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  diffKeys: string[];
}
function mapAuditRow(r: Record<string, unknown>): GridAuditRow {
  return {
    id: Number(r.id ?? 0),
    action: String(r.action ?? 'UPDATE'),
    actorEmail: (r.actorEmail as string) ?? (r.actor_email as string) ?? null,
    changedAt: (r.changedAt as string) ?? (r.changed_at as string) ?? null,
    employeeId: (r.employeeId as string) ?? (r.employee_id as string) ?? '',
    workDate: (r.workDate as string) ?? (r.work_date as string) ?? null,
    oldData: (r.oldData as Record<string, unknown>) ?? (r.old_data as Record<string, unknown>) ?? null,
    newData: (r.newData as Record<string, unknown>) ?? (r.new_data as Record<string, unknown>) ?? null,
    diffKeys: (r.diffKeys as string[]) ?? (r.diff_keys as string[]) ?? [],
  };
}
export async function fetchGridAudit(params: { employeeId?: string; from?: string; to?: string }): Promise<GridAuditRow[] | null> {
  try {
    const res = await apiFetch<{ data: Record<string, unknown>[] }>(`${BASE}/grid/audit${qs({ ...params })}`, { method: 'POST' });
    return (res.data || []).map(mapAuditRow);
  } catch {
    return null;
  }
}
// ============================================================================
// PAKET P8 — Odsustva / Nadoknade / Kalendar (append-only; MRG kadr-briefs).
// Sve mutacije/čitanja koje P8 tabovi traže, a nisu ranije postojale. Oblik i
// query-ključevi prate obrasce iznad (broad ['kadrovska'] invalidacija; snake vs
// camel po BE ugovoru: makeup/paidLeave = camelCase Prisma redovi).
// ============================================================================

/* Brisanje zahteva (nadoknada/plaćeno) — HR/admin; BE guard + RPC guard presuđuju.
   makeup: kadr_delete_makeup čuva must_storno_first (approved/completed → 400).
   paidLeave: paid_leave_delete čisti i absences + 'pl' kodove iz grida za approved. */
export const useMakeupDelete = () => useKadrMutation<{ id: string }>((v) => del(`/requests/makeup/${v.id}`));
export const usePaidLeaveDelete = () => useKadrMutation<{ id: string }>((v) => del(`/requests/paid-leave/${v.id}`));

/* Soft-delete odsustva (1.0 paritet): Arhiviraj → pogled „Arhivirana" → Vrati. */
export const useArchiveAbsence = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/absences/${v.id}/archive`, { clientEventId: v.clientEventId }), KEYS.absences);
export const useRestoreAbsence = () =>
  useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/absences/${v.id}/restore`, { clientEventId: v.clientEventId }), KEYS.absences);

/* ── Odsustvo → mesečni grid (most; paritet services/absenceGrid.js) ──
   Godišnji/bolovanje/slobodan/neplaćeno/slava/plaćeno/službeno se NE pišu u
   `absences` nego u work_hours (jedan red po RADNOM danu). Koristi POST /grid/batch. */

/** Meseci [from,to] inclusive kao {year, month} (za dohvat praznika/grida po mesecu). */
export function monthsInRange(from: string, to: string): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  if (!from || !to || from > to) return out;
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  for (let guard = 0; guard < 240 && (y < ey || (y === ey && m <= em)); guard++) {
    out.push({ year: y, month: m });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * Imperativni dohvat skupa NE-radnih praznika (YMD) u opsegu [from,to] —
 * GET /kadrovska/holidays?from&to (kb1). Greška se NE guta: nepotpun holidaySet
 * bi tiho pogrešno ekspandovao period odsustva na praznične dane.
 */
export async function fetchHolidaySet(from: string, to: string): Promise<Set<string>> {
  const set = new Set<string>();
  const res = await apiFetch<{ data: KadrHoliday[] }>(`${BASE}/holidays${qs({ from, to })}`);
  for (const h of res.data ?? []) {
    if (!h.isWorkday) {
      const ymd = String(h.holidayDate).slice(0, 10);
      if (ymd >= from && ymd <= to) set.add(ymd);
    }
  }
  return set;
}

export interface GridMonthsResult {
  rows: WorkHours[];
  holidays: KadrHoliday[];
  /** Set YMD ne-radnih praznika (za preskakanje u ekspanziji perioda). */
  holidaySet: Set<string>;
  isLoading: boolean;
  isFetching: boolean;
}

/**
 * Grid (work_hours + praznici) za više meseci odjednom (useQueries; deli keš sa
 * `useGrid`). Vraća spojene redove + skup praznika. Koristi ga Kalendar (1 mesec),
 * Odsutni (1–2 meseca) i Pregled (do 12 meseci — redovi grida su tu legitimno
 * potrebni; TODO(P1a): namenski report endpoint bi bio jeftiniji za duge periode).
 */
export function useGridMonths(months: { year: number; month: number }[]): GridMonthsResult {
  const results = useQueries({
    queries: months.map((mm) => ({
      queryKey: [...KEYS.grid, { year: mm.year, month: mm.month }],
      queryFn: () => apiFetch<{ data: GridResponse }>(`${BASE}/grid${qs({ year: mm.year, month: mm.month })}`),
    })),
  });
  const rows: WorkHours[] = [];
  const holidays: KadrHoliday[] = [];
  const holidaySet = new Set<string>();
  for (const r of results) {
    const d = r.data?.data;
    if (!d) continue;
    for (const row of d.rows) rows.push(row);
    for (const h of d.holidays) {
      holidays.push(h);
      if (!h.isWorkday) holidaySet.add(String(h.holidayDate).slice(0, 10));
    }
  }
  return {
    rows,
    holidays,
    holidaySet,
    isLoading: results.some((r) => r.isLoading),
    isFetching: results.some((r) => r.isFetching),
  };
}

/** hr_upsert_salary_payroll rezultat (V2 optimistic). Na konflikt BE baca 409
 *  (ConflictException `… (stale|locked|row_exists)`) — pozivalac hvata ApiError. */
export interface PayrollUpsertResult {
  applied: boolean;
  id?: string;
  status?: string;
  total_rsd?: number | string;
  ukupna_zarada?: number | string;
  updated_at?: string;
  reason?: string;
}
/** V2 upsert reda mesečnog obračuna. `row` = snake_case payload (+ id/expected_updated_at za UPDATE). */
export const usePayrollUpsert = () =>
  useKadrMutation<{ row: Record<string, unknown>; clientEventId?: string }, TxResponse<PayrollUpsertResult>>(
    (v) => post('/salary/payroll/upsert', { row: v.row, clientEventId: v.clientEventId }),
    KEYS.salary,
  );
/** Brisanje reda obračuna. Paid red → BE 409 („prvo otključaj pa obriši"). */
export const useDeletePayroll = () => useKadrMutation<{ id: string }>((v) => del(`/salary/payroll/${v.id}`), KEYS.salary);

/* HR outbox (kadr_notification_log) — retarget/cancel/dispatch (tok „tabele knjigovođi"). */
export const useNotifRetarget = () =>
  useKadrMutation<{ id: string; recipient: string; subject?: string; body?: string }>((v) => {
    const { id, ...bodyRest } = v;
    return post(`/notifications/${id}/retarget`, bodyRest);
  }, KEYS.notifications);
/** 🔔 „Pošalji čekaće" — sinhroni BE proxy na 1.0 edge hr-notify-dispatch. */
export const useNotifDispatch = () => useKadrMutation<Record<string, never>>(() => post('/notifications/dispatch'), KEYS.notifications);
/** Imperativni fetch outbox redova (event-handler tok; van React Query keša). */
export function fetchNotifications(params: { status?: string; type?: string } = {}): Promise<{ data: ViewRow[] }> {
  return apiFetch<{ data: ViewRow[] }>(`${BASE}/notifications${qs({ ...params })}`);
}
// ============================================================================
// P10 — Prisustvo + QR kiosk (dodato aditivno; BE ugovor C:/kb1 p1a-core).
// ============================================================================

/** Sirovi red `attendance_events` (LEFT JOIN employees) — feed „Poslednji prolazi".
 *  `employee_id`/`employee_name` su NULL kad kartica nije spojena (nepoznata). */
export interface AttendanceEventRow extends ViewRow {
  id: number;
  event_ts: string;
  direction: string | null;
  terminal_name: string | null;
  source: string | null;
  badge_code: string | null;
  employee_id: string | null;
  employee_name: string | null;
}
/** Odgovor `GET /attendance/events` — feed + brojač današnjih nepoznatih kartica. */
export interface AttendanceEventsData {
  events: AttendanceEventRow[];
  unknownToday: number;
}

/** Feed poslednjih N prolaza sa kapije + brojač nepoznatih kartica danas
 *  (gate kadrovska.attendance). Auto-refresh na 60 s (paritet /attendance/now). */
export function useAttendanceEvents(limit = 40, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'events', limit],
    enabled,
    retry: false,
    refetchInterval: 60000,
    queryFn: () => apiFetch<{ data: AttendanceEventsData }>(`${BASE}/attendance/events${qs({ limit })}`),
  });
}

/** Dnevni drill „prisustvo vs grid" za jednog zaposlenog (gate attendance_shadow).
 *  Vraća v_attendance_vs_grid redove (first_in/last_out/presence/grid/diff…). */
export function useAttendanceVsGrid(params: { employeeId?: string; from?: string; to?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.attendance, 'vs-grid', params],
    enabled: enabled && !!params.employeeId,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/attendance/vs-grid${qs({ ...params })}`),
  });
}

/** Trajni QR token (get-or-create u employee_badges, „SVK-…" format; gate
 *  kadrovska.attendance_shadow — hr/menadzment/admin, posle P1a fixa). Vraća ISTI
 *  token pri ponovnom pozivu — nalepnice ostaju važeće i kiosk ih razrešava.
 *  `created` govori da li je token upravo napravljen. */
export const useEnsureQrBadge = () =>
  useKadrMutation<{ id: string }, TxResponse<{ code: string; created: boolean }>>(
    (v) => post<{ code: string; created: boolean }>(`/employees/${v.id}/badges/qr`),
    // Ne dira live/shadow keširane liste — badge upis ne menja prisustvo; usko
    // invalidiranje sprečava buru refetch-eva pri bulk generisanju (N zaposlenih).
    ['kadrovska', 'badges'],
  );
// ============================================================================
// PAKET P11 — RAZVOJ / RAZGOVORI / 360 / ONBOARDING / NOTIFIKACIJE / IZVEŠTAJI
// Append-only proširenje (paritet 1.0: planRazvojaTab/talksSection/assessment360Modal/
// onboardingTab/hrNotificationsTab/reportsTab). Reads = snake_case view/RPC (dev-plans/
// expectations/scope/framework/reversi/notifications) ILI camelCase Prisma (checkins/
// raters/results/targets/scores/onboarding/templates). Mutacije koje kreiraju red nose
// OBAVEZAN clientEventId; prelazi opcioni. Row-scope/PII presuđuje sy15 RLS na backendu.
// ============================================================================

// ------------------------------------------------------------------ P11 tipovi

/** development_checkins red (1-na-1 dnevnik) — camelCase Prisma. */
export interface DevCheckin {
  id: string;
  planId: string;
  employeeId: string;
  checkinDate: string | null;
  authorKind: string | null;
  authorEmail: string | null;
  noteMd: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** assessment_raters red — ocenjivač + status + pozivnica (camelCase Prisma). */
export interface AssessmentRater {
  id: string;
  assessmentId: string;
  raterKind: string; // self | peer | leader
  raterEmployeeId: string | null;
  raterEmail: string | null;
  status: string; // pending | submitted
  invitedAt: string | null;
  submittedAt: string | null;
  token?: string | null;
}

/** assessment_results agregat po grupi/kompetenciji (Decimal → string). */
export interface AssessmentResult {
  id: string;
  assessmentId: string;
  scopeKind: string; // group | competence
  refId: number;
  selfAvg: string | number | null;
  peerAvg: string | number | null;
  leaderVal: string | number | null;
  targetVal: string | number | null;
}
export interface AssessmentTarget {
  competenceId: number;
  targetLevel: number | null;
}
export interface AssessmentScore {
  competenceId: number;
  level: number | null;
  comment: string | null;
}

/** Kampanja 360 red = Assessment + ciklus + rateri (assembled u servisu). */
export interface CampaignAssessment extends Assessment {
  cycle: { id: string; title: string | null; periodLabel: string | null } | null;
  raters: AssessmentRater[];
}

export interface OnboardingTemplate {
  id: string;
  name: string;
  kind: string; // onboarding | offboarding
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
}
export interface OnboardingTemplateItem {
  id: string;
  templateId: string;
  title: string;
  description: string | null;
  assigneeHint: string | null;
  offsetDays: number | null;
  sortOrder: number;
}

/** Invite (edge fn assessment-invite) rezultat — dry-run kad Resend nije podešen. */
export interface InviteResult {
  ok?: boolean;
  sent?: number;
  skipped?: unknown[];
  reason?: string;
  error?: string;
  [k: string]: unknown;
}

// ------------------------------------------------------------------ P11 reads

/** Dnevnik 1-na-1 jednog plana. */
export function useDevPlanCheckins(planId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.dev, 'checkins', planId ?? 'none'],
    enabled: !!planId && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: DevCheckin[] }>(`${BASE}/dev-plans/${planId}/checkins`),
  });
}
/** Razvojni ciljevi (v_employee_expectations) — planId suženje za detalj plana. */
export function useExpectations(params: { employeeId?: string; planId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.dev, 'expectations', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/expectations${qs({ ...params })}`),
  });
}
/** Pregled kampanja 360 (procene + ciklus + rateri). */
export function useAssessmentCampaigns(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'campaigns', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: CampaignAssessment[] }>(`${BASE}/assessments/campaign${qs({ ...params })}`),
  });
}
export function useAssessmentScope(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'scope', id ?? 'none'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/assessments/${id}/scope`),
  });
}
export function useAssessmentRaters(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'raters', id ?? 'none'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: AssessmentRater[] }>(`${BASE}/assessments/${id}/raters`),
  });
}
export function useAssessmentResults(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'results', id ?? 'none'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: AssessmentResult[] }>(`${BASE}/assessments/${id}/results`),
  });
}
export function useAssessmentTargets(id: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'targets', id ?? 'none'],
    enabled: !!id && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: AssessmentTarget[] }>(`${BASE}/assessments/${id}/targets`),
  });
}
export function useAssessmentRaterScores(raterId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'rater-scores', raterId ?? 'none'],
    enabled: !!raterId && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: AssessmentScore[] }>(`${BASE}/assessments/raters/${raterId}/scores`),
  });
}
export function useAssessmentFramework(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.assessments, 'framework'],
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/assessments/framework`),
  });
}

/** Uvođenje/izlazak — aktivni tokovi + zadaci. */
export function useOnboarding(params: { employeeId?: string; status?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.onboarding, 'runs', params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: { runs: OnboardingRun[]; tasks: OnboardingTask[] } }>(`${BASE}/onboarding${qs({ ...params })}`),
  });
}
export function useOnboardingTemplates(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.onboarding, 'templates'],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: { templates: OnboardingTemplate[]; items: OnboardingTemplateItem[] } }>(`${BASE}/onboarding/templates`),
  });
}
/** Offboarding: neizmirena REVERSI zaduženja zaposlenog (panel „Zaduženja za vraćanje"). */
export function useOffboardingReversi(employeeId: string | null, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.onboarding, 'reversi', employeeId ?? 'none'],
    enabled: !!employeeId && enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: ViewRow[] }>(`${BASE}/onboarding/reversi/${employeeId}`),
  });
}

/** Generički izveštaj (kind: sick/demo/org/vacation/overtime/field/medical/certs/audit/
 *  children/risk). Shape zavisi od kind-a — pozivalac kastuje. */
export function useReport<T = unknown>(kind: string, params: { from?: string; to?: string; year?: number; months?: number } = {}, enabled = true) {
  return useQuery({
    queryKey: ['kadrovska', 'report', kind, params],
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: T }>(`${BASE}/reports/${kind}${qs({ ...params })}`),
  });
}

// ------------------------------------------------------------------ P11 mutacije: Plan razvoja
export interface DevPlanInput {
  employeeId: string;
  periodLabel: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  careerGoalMd?: string | null;
  targetPositionId?: number | null;
  mentorEmployeeId?: string | null;
  status?: string;
}
export const useCreateDevPlan = () =>
  useKadrMutation<DevPlanInput & { clientEventId: string }, TxResponse<Record<string, unknown>>>((v) => post('/dev-plans', v), KEYS.dev);
export const useUpdateDevPlan = () =>
  useKadrMutation<{ id: string; patch: Partial<DevPlanInput & { summaryMd: string | null; selfAssessmentMd: string | null }> }>((v) => patch(`/dev-plans/${v.id}`, v.patch), KEYS.dev);
export const useDeleteDevPlan = () => useKadrMutation<{ id: string }>((v) => del(`/dev-plans/${v.id}`), KEYS.dev);

/* Razvojni ciljevi (expectations) */
export interface ExpectationInput {
  employeeId: string;
  title: string;
  category: string;
  priority: string;
  descriptionMd?: string | null;
  dueDate?: string | null;
  planId?: string;
}
export const useCreateExpectation = () =>
  useKadrMutation<ExpectationInput & { clientEventId: string }>((v) => post('/expectations', v), KEYS.dev);
export const useUpdateExpectation = () =>
  useKadrMutation<{ id: string; patch: Partial<ExpectationInput & { status: string; progress: number; completionNote: string }> }>((v) => patch(`/expectations/${v.id}`, v.patch), KEYS.dev);
export const useDeleteExpectation = () => useKadrMutation<{ id: string }>((v) => del(`/expectations/${v.id}`), KEYS.dev);

/* Dnevnik 1-na-1 (checkins) */
export const useCreateCheckin = () =>
  useKadrMutation<{ planId: string; employeeId: string; checkinDate?: string | null; authorKind?: string; noteMd?: string; clientEventId: string }>((v) => {
    const { planId, ...body } = v;
    return post(`/dev-plans/${planId}/checkins`, body);
  }, KEYS.dev);
export const useDeleteCheckin = () => useKadrMutation<{ id: string }>((v) => del(`/checkins/${v.id}`), KEYS.dev);

// ------------------------------------------------------------------ P11 mutacije: Razgovori
export interface TalkInput {
  employeeId: string;
  talkType: string;
  talkDate?: string | null;
  title?: string | null;
  zapisnikMd?: string | null;
  planId?: string;
  raiseDecision?: string | null;
  raisePercent?: number | null;
  raiseEffectiveFrom?: string | null;
  raiseNote?: string | null;
}
export const useCreateTalk = () =>
  useKadrMutation<TalkInput & { clientEventId: string }, TxResponse<EmployeeTalk>>((v) => post('/talks', v), KEYS.talks);
export const useUpdateTalk = () =>
  useKadrMutation<{ id: string; patch: Partial<TalkInput & { status: string }> }, TxResponse<EmployeeTalk>>((v) => patch(`/talks/${v.id}`, v.patch), KEYS.talks);
export const useDeleteTalk = () => useKadrMutation<{ id: string }>((v) => del(`/talks/${v.id}`), KEYS.talks);
export const useShareTalk = () =>
  useKadrMutation<{ id: string; clientEventId?: string }, TxResponse<{ status?: string; emailed?: boolean }>>((v) => post(`/talks/${v.id}/share`, { clientEventId: v.clientEventId }), KEYS.talks);
export const useUnshareTalk = () =>
  useKadrMutation<{ id: string; clientEventId?: string }, TxResponse<{ status?: string }>>((v) => post(`/talks/${v.id}/unshare`, { clientEventId: v.clientEventId }), KEYS.talks);

/* Korektivni planovi + mere */
export const useCreateCorrectivePlan = () =>
  useKadrMutation<{ employeeId: string; talkId?: string; visibleToEmployee?: boolean; reasonMd?: string | null; status?: string; followupDate?: string | null; clientEventId: string }, TxResponse<CorrectivePlan>>((v) => post('/corrective-plans', v), KEYS.talks);
export const useUpdateCorrectivePlan = () =>
  useKadrMutation<{ id: string; patch: { reasonMd?: string | null; status?: string; followupDate?: string | null; closedAt?: string | null; visibleToEmployee?: boolean } }>((v) => patch(`/corrective-plans/${v.id}`, v.patch), KEYS.talks);
export interface MeasureInput {
  planId: string;
  descriptionMd: string;
  dueDate?: string | null;
  responsibleEmployeeId?: string | null;
  status?: string;
  note?: string | null;
}
export const useCreateMeasure = () =>
  useKadrMutation<MeasureInput & { clientEventId: string }>((v) => post('/corrective-measures', v), KEYS.talks);
export const useUpdateMeasure = () =>
  useKadrMutation<{ id: string; patch: Partial<Omit<MeasureInput, 'planId'>> }>((v) => patch(`/corrective-measures/${v.id}`, v.patch), KEYS.talks);
export const useDeleteMeasure = () => useKadrMutation<{ id: string }>((v) => del(`/corrective-measures/${v.id}`), KEYS.talks);

// ------------------------------------------------------------------ P11 mutacije: 360 (state hooks + imperativne fn)
export const useCloseAssessment = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/assessments/${v.id}/close`, { clientEventId: v.clientEventId }), KEYS.assessments);
export const useReopenAssessment = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/assessments/${v.id}/reopen`, { clientEventId: v.clientEventId }), KEYS.assessments);
export const useShareAssessment = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/assessments/${v.id}/share`, { clientEventId: v.clientEventId }), KEYS.assessments);
export const useUnshareAssessment = () => useKadrMutation<{ id: string; clientEventId?: string }>((v) => post(`/assessments/${v.id}/unshare`, { clientEventId: v.clientEventId }), KEYS.assessments);
export const useOpenCampaign = () =>
  useKadrMutation<{ title: string; period: string; employeeIds: string[]; clientEventId: string }, TxResponse<unknown>>((v) => post('/assessments/campaign', v), KEYS.assessments);

/** Imperativne 360 operacije (modal orkestrira sekvence open→save→setTargets→compute). */
export function openAssessment360(vars: { employeeId: string; period?: string | null; peerEmployeeIds?: string[]; peerEmails?: string[]; cycle?: string; clientEventId: string }): Promise<TxResponse<string>> {
  return post<string>('/assessments/360', vars);
}
export function saveAssessmentScores(raterId: string, items: { competenceId: number; level?: number | null; comment?: string }[]): Promise<TxResponse<{ upserted: number }>> {
  return post(`/assessments/raters/${raterId}/scores`, { items });
}
export function setAssessmentTargets(id: string, targets: { competence_id: number; target_level: number | null }[]): Promise<TxResponse<unknown>> {
  return post(`/assessments/${id}/targets`, { targets });
}
export function computeAssessment(id: string): Promise<TxResponse<unknown>> {
  return post(`/assessments/${id}/compute`, {});
}
export function assessmentGapToGoals(id: string, source = 'leader', minGap = 1): Promise<TxResponse<number>> {
  return post<number>(`/assessments/${id}/gap`, { source, minGap });
}
export function assessmentInvite(id: string): Promise<TxResponse<InviteResult>> {
  return post(`/assessments/${id}/invite`, {});
}
export function assessmentInviteCycle(cycleId: string, notifyCreator = true): Promise<TxResponse<InviteResult>> {
  return post(`/assessments/cycles/${cycleId}/invite`, { notifyCreator });
}

// ------------------------------------------------------------------ P11 mutacije: Onboarding
export const useOnboardingStart = () =>
  useKadrMutation<{ employeeId: string; templateId: string; startDate?: string | null; clientEventId: string }, TxResponse<string>>((v) => post('/onboarding/start', v), KEYS.onboarding);
export const useOnboardingTask = () =>
  useKadrMutation<{ id: string; status?: string; done?: boolean; note?: string }>((v) => patch(`/onboarding/tasks/${v.id}`, { status: v.status, done: v.done, note: v.note }), KEYS.onboarding);
export const useOnboardingRunStatus = () =>
  useKadrMutation<{ id: string; status: string; clientEventId?: string }>((v) => patch(`/onboarding/runs/${v.id}`, { status: v.status, clientEventId: v.clientEventId }), KEYS.onboarding);
export const useCreateOnbTemplate = () =>
  useKadrMutation<{ name: string; kind: string; clientEventId: string }>((v) => post('/onboarding/templates', v), KEYS.onboarding);
export const useDeleteOnbTemplate = () => useKadrMutation<{ id: string }>((v) => del(`/onboarding/templates/${v.id}`), KEYS.onboarding);
export const useCreateOnbItem = () =>
  useKadrMutation<{ templateId: string; title: string; assigneeHint?: string; offsetDays?: number; sortOrder?: number; clientEventId: string }>((v) => post('/onboarding/template-items', v), KEYS.onboarding);
export const useDeleteOnbItem = () => useKadrMutation<{ id: string }>((v) => del(`/onboarding/template-items/${v.id}`), KEYS.onboarding);

// ------------------------------------------------------------------ P11 mutacije: Notifikacije
export const useNotifRetry = () => useKadrMutation<{ id: string }>((v) => post(`/notifications/${v.id}/retry`), KEYS.notifications);
export const useNotifCancel = () => useKadrMutation<{ id: string }>((v) => post(`/notifications/${v.id}/cancel`), KEYS.notifications);
export const useNotifDelete = () => useKadrMutation<{ id: string }>((v) => del(`/notifications/${v.id}`), KEYS.notifications);
export const useUpdateNotificationConfig = () =>
  useKadrMutation<Partial<NotificationConfig>, TxResponse<NotificationConfig>>((v) => patch('/notification-config', v), KEYS.notifications);
export const useTriggerHrReminders = () =>
  useKadrMutation<void, TxResponse<Record<string, unknown>>>(() => post('/notifications/hr-reminders/run'), KEYS.notifications);
export const useTriggerWeeklyRisk = () =>
  useKadrMutation<void, TxResponse<unknown>>(() => post('/reports/risk/run'), KEYS.notifications);
export const useTriggerPayrollNotify = () =>
  useKadrMutation<{ year: number; month: number; clientEventId?: string }, TxResponse<number>>((v) => post('/notifications/payroll/run', v), KEYS.notifications);
