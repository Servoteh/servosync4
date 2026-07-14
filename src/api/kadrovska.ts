'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export interface DashboardResponse {
  year: number;
  month: number;
  kpis: unknown;
  miniReports: unknown;
  actionStack: unknown;
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
