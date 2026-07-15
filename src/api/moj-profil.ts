'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import { newClientEventId } from './projektni-biro';
import type { GoLedgerBlock } from './kadrovska';

// ============================================================================
// Moj profil — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30.md §0.2/§3.2).
// KLJUČNI NALAZ: Moj profil NEMA NIJEDNU SVOJU TABELU — čist agregator nad tuđim
// domenima (Kadrovska/G, Reversi, Podešavanja/D) kroz GUC. Scope visi na email→
// v_employees_safe aktivan red (bez reda = prazan profil, meta.message). Mutacije
// zovu POSTOJEĆE G-RPC-ove (potpisi netaknuti — presuda D6); FE ne duplira row-odluku.
// Zaduženja (revers) = reuse `/reversi/reports/my-*` (api/reversi.ts) — bez novog koda.
// ============================================================================

export { newClientEventId };

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const BASE = '/v1/profile';

export interface TxResponse<T = unknown> {
  data: T;
  meta?: { idempotent?: boolean; message?: string };
}
export interface EnvelopeMeta {
  message?: string;
}

// ------------------------------------------------------------------ tipovi

export interface ProfileEmployee {
  id: string;
  full_name: string | null;
  positionId: number | null;
}
export interface ProfileMe {
  hasProfile: boolean;
  employee: ProfileEmployee | null;
  roles: Record<string, unknown>[];
  message?: string;
}
export interface ProfileSummary {
  employee: { id: string; fullName: string | null };
  vacationDaysRemaining: number | null;
  openVacationRequests: number;
  monthPresenceHours: number;
  unacknowledgedTalks: number;
}

export type VacationBalance = { days_remaining?: number | null; year?: number } & Record<string, unknown>;
export type VacationRequest = {
  id: string;
  year: number;
  date_from: string;
  date_to: string;
  days_count: number;
  note: string | null;
  status: string;
  submitted_by: string | null;
  created_at?: string;
} & Record<string, unknown>;
export type VacationHistoryRow = { year: number } & Record<string, unknown>;
export interface VacationData {
  balance: VacationBalance | null;
  requests: VacationRequest[];
  history: VacationHistoryRow[];
  /** Jedinstveni presek GO po godinama (grid ∪ Excel po datumu, usklađeno sa saldom). */
  ledger?: GoLedgerBlock[];
}

export type MakeupRequest = {
  id: string;
  absence_date: string;
  absence_hours: number;
  reason: string | null;
  makeup_plan: string | null;
  makeup_deadline: string | null;
  compensation_type: string;
  weekend_work_date: string | null;
  status: string;
  created_at?: string;
} & Record<string, unknown>;
export type PaidLeaveRequest = {
  id: string;
  leave_type: string;
  date_from: string;
  date_to: string;
  days_count: number;
  reason: string | null;
  proof_note: string | null;
  status: string;
  created_at?: string;
} & Record<string, unknown>;
export interface MakeupPaidLeaveData {
  makeup: MakeupRequest[];
  paidLeave: PaidLeaveRequest[];
}

export type AttendanceDay = {
  day: string;
  presence_hours?: number | null;
  time_in?: string | null;
  time_out?: string | null;
  status?: string | null;
} & Record<string, unknown>;
export interface AttendanceData {
  from: string;
  to: string;
  days: AttendanceDay[];
}

export type TalkRow = {
  id: string;
  talk_date?: string;
  title?: string | null;
  status?: string;
  shared_at?: string | null;
  acknowledged_at?: string | null;
} & Record<string, unknown>;

export interface Expectation {
  id: string;
  employeeId: string;
  title: string;
  descriptionMd: string | null;
  dueDate: string | null;
  priority: string;
  status: string;
  category: string;
  progress: number;
  completedAt: string | null;
  completionNote: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface JobPositionInfo {
  id: number;
  name: string;
  summaryMd: string | null;
  expectationsMd: string | null;
  responsibilitiesMd: string | null;
  dutiesMd: string | null;
  authorityMd: string | null;
  kpiMd: string | null;
  qualificationsMd: string | null;
  collaborationMd: string | null;
  reportsToLine: string | null;
}
export interface CompanyValues {
  id: number;
  missionMd: string | null;
  visionMd: string | null;
  valuesMd: string | null;
  updatedAt: string;
}
export type ColleagueOnLeave = {
  employee_id: string;
  type: string;
  date_from: string;
  date_to: string;
  full_name: string | null;
  department: string | null;
} & Record<string, unknown>;

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['profile'] as const,
  me: ['profile', 'me'] as const,
  summary: ['profile', 'summary'] as const,
  vacation: ['profile', 'vacation'] as const,
  makeupPaidLeave: ['profile', 'makeup-paid-leave'] as const,
  attendance: ['profile', 'attendance'] as const,
  talks: ['profile', 'talks'] as const,
  expectations: ['profile', 'expectations'] as const,
  position: ['profile', 'position'] as const,
  companyValues: ['profile', 'company-values'] as const,
  colleagues: ['profile', 'colleagues-on-leave'] as const,
};

// ------------------------------------------------------------------ queries

export function useProfileMe() {
  return useQuery({ queryKey: KEYS.me, queryFn: () => apiFetch<{ data: ProfileMe }>(`${BASE}/me`) });
}
export function useProfileSummary() {
  return useQuery({ queryKey: KEYS.summary, queryFn: () => apiFetch<{ data: ProfileSummary | null; meta?: EnvelopeMeta }>(`${BASE}/summary`) });
}
export function useVacation() {
  return useQuery({ queryKey: KEYS.vacation, queryFn: () => apiFetch<{ data: VacationData | null; meta?: EnvelopeMeta }>(`${BASE}/vacation`) });
}
export function useMakeupPaidLeave() {
  return useQuery({
    queryKey: KEYS.makeupPaidLeave,
    queryFn: () => apiFetch<{ data: MakeupPaidLeaveData | null; meta?: EnvelopeMeta }>(`${BASE}/makeup-paid-leave`),
  });
}
export function useAttendance(range: { from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.attendance, range],
    queryFn: () => apiFetch<{ data: AttendanceData | null; meta?: EnvelopeMeta }>(`${BASE}/attendance${qs(range)}`),
  });
}
export function useTalks() {
  return useQuery({ queryKey: KEYS.talks, queryFn: () => apiFetch<{ data: TalkRow[] | null; meta?: EnvelopeMeta }>(`${BASE}/talks`) });
}
export function useExpectations() {
  return useQuery({ queryKey: KEYS.expectations, queryFn: () => apiFetch<{ data: Expectation[] | null; meta?: EnvelopeMeta }>(`${BASE}/expectations`) });
}
export function usePosition() {
  return useQuery({ queryKey: KEYS.position, queryFn: () => apiFetch<{ data: JobPositionInfo | null; meta?: EnvelopeMeta }>(`${BASE}/position`) });
}
export function useCompanyValues() {
  return useQuery({ queryKey: KEYS.companyValues, queryFn: () => apiFetch<{ data: CompanyValues | null }>(`${BASE}/company-values`) });
}
export function useColleaguesOnLeave() {
  return useQuery({ queryKey: KEYS.colleagues, queryFn: () => apiFetch<{ data: ColleagueOnLeave[] }>(`${BASE}/colleagues-on-leave`) });
}

// ------------------------------------------------------------------ mutations

function useProfileMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }) });
}
function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/* ── GO zahtevi ── */

export const useSubmitVacation = () =>
  useProfileMutation<{ clientEventId: string; dateFrom: string; dateTo: string; daysCount: number; note?: string; employeeId?: string }>(
    (v) => post('/vacation-requests', v),
    KEYS.vacation,
  );
export const useReviseVacation = () =>
  useProfileMutation<{ id: string; dateFrom: string; dateTo: string; daysCount: number; note?: string; forceReapproval?: boolean }>(
    (v) => post(`/vacation-requests/${v.id}/revise`, v),
    KEYS.vacation,
  );
export const useCancelVacation = () =>
  useProfileMutation<{ id: string }>((v) => post(`/vacation-requests/${v.id}/cancel`), KEYS.vacation);
export const useDeleteVacation = () =>
  useProfileMutation<{ id: string }>((v) => del(`/vacation-requests/${v.id}`), KEYS.vacation);

/* ── Nadoknada / plaćeno ── */

export const useSubmitMakeup = () =>
  useProfileMutation<{
    clientEventId: string;
    absenceDate: string;
    absenceHours: number;
    reason?: string;
    makeupPlan?: string;
    makeupDeadline?: string;
    compensationType?: 'nadoknada' | 'dan_odmora';
    weekendWorkDate?: string;
    employeeId?: string;
  }>((v) => post('/makeup', v), KEYS.makeupPaidLeave);
export const useDeleteMakeup = () => useProfileMutation<{ id: string }>((v) => del(`/makeup/${v.id}`), KEYS.makeupPaidLeave);

export const useSubmitPaidLeave = () =>
  useProfileMutation<{
    clientEventId: string;
    leaveType: string;
    dateFrom: string;
    dateTo: string;
    daysCount: number;
    reason?: string;
    proofNote?: string;
    employeeId?: string;
  }>((v) => post('/paid-leave', v), KEYS.makeupPaidLeave);
export const useDeletePaidLeave = () => useProfileMutation<{ id: string }>((v) => del(`/paid-leave/${v.id}`), KEYS.makeupPaidLeave);

/* ── Prisustvo korekcija ── */

export const useSubmitCorrection = () =>
  useProfileMutation<{ clientEventId: string; day: string; timeIn?: string; timeOut?: string; reason: string; employeeId?: string }>(
    (v) => post('/attendance/corrections', v),
    KEYS.attendance,
  );

/* ── e-saglasnost / razgovori ── */

export const useAckDocument = () =>
  useProfileMutation<{ clientEventId: string; refType: string; refId: string; label?: string }>((v) => post('/acks', v));
export const useAcknowledgeTalk = () =>
  useProfileMutation<{ id: string }>((v) => post(`/talks/${v.id}/acknowledge`), KEYS.talks);

/* ── 360 samoprocena ── */

export const useOpenSelfAssessment = () =>
  useProfileMutation<{ period?: string }, TxResponse<{ assessmentId: unknown }>>((v) => post('/assessment/self/open', v));
export const useSaveSelfScores = () =>
  useProfileMutation<{ raterId: string; items: { competenceId: string; level?: number | null; comment?: string }[] }>((v) =>
    post('/assessment/self/scores', v),
  );
export const useSaveSelfAnswers = () =>
  useProfileMutation<{ raterId: string; items: { questionCode: string; answerText?: string }[] }>((v) => post('/assessment/self/answers', v));
export const useSubmitSelfAssessment = () =>
  useProfileMutation<{ assessmentId: string }>((v) => post('/assessment/self/submit', v));
