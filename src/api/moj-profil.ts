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

export interface ProfileContract {
  type: string | null;
  dateFrom: string | null;
  dateTo: string | null;
}
export interface ProfileEmployee {
  id: string;
  full_name: string | null;
  positionId: number | null;
  /** P6 (Drop 2) proširenje /me: header + „Dokumenti i rokovi" kartice. */
  slava?: string | null;
  /** 'MMDD' — dan slave (formatira se u DD.MM.). */
  slavaDay?: string | null;
  hireDate?: string | null;
  medicalExamExpires?: string | null;
  medicalExamDate?: string | null;
  contract?: ProfileContract | null;
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
  /** Raw kolone iz v_attendance_daily (paritet 1.0: first_in/last_out/open_intervals). */
  first_in?: string | null;
  last_out?: string | null;
  open_intervals?: number | null;
  /** Postoji korekcija za ovaj dan (✎) — ako BE red nosi flag. */
  corrected?: boolean | null;
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
  talk_type?: string;
  title?: string | null;
  status?: string;
  shared_at?: string | null;
  acknowledged_at?: string | null;
} & Record<string, unknown>;

// ---------------------------------------------- P6 (Drop 2): onboarding / odsustva / prisustvo drill / razgovor detalji

/** 🚀 Moje uvođenje — jedan onboarding/offboarding run (read-only, status vodi HR). */
export interface OnboardingTask {
  id: string;
  runId: string;
  title: string;
  status: 'done' | 'skipped' | 'open' | string;
  due_date: string | null;
  assignee_hint: string | null;
}
export interface OnboardingRun {
  id: string;
  title: string;
  status: string;
  /** 0–100 (BE agregat po zadacima). */
  progress: number;
}
export interface OnboardingData {
  runs: OnboardingRun[];
  tasks: OnboardingTask[];
}

/** 🗓 Moja odsustva — jedan red (tekuća godina). */
export type AbsenceRow = {
  type: string;
  date_from: string;
  date_to: string;
  days_count: number | null;
  note: string | null;
} & Record<string, unknown>;

/** Prisustvo drill — jedan prolaz sa terminala. */
export type AttendanceEvent = {
  event_ts_local: string;
  direction: string;
  terminal_name: string | null;
  reason: string | null;
} & Record<string, unknown>;

/** Detalji jednog razgovora (zapisnik + odluka o zaradi + korektivne mere). */
export interface TalkMeasure {
  description_md: string | null;
  status: string;
  due_date: string | null;
}
export interface TalkCorrectivePlan {
  id: string;
  reason_md: string | null;
  status: string;
  followup_date: string | null;
  measures: TalkMeasure[];
}
export type TalkDetail = {
  id: string;
  talk_type?: string;
  title?: string | null;
  talk_date?: string | null;
  conducted_by?: string | null;
  status?: string;
  acknowledged_at?: string | null;
  zapisnik_md?: string | null;
  raise_decision?: string | null;
  raise_percent?: number | null;
  raise_effective_from?: string | null;
  raise_note?: string | null;
  correctivePlans?: TalkCorrectivePlan[];
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
  /** Razvojni plan (dev-plan) čiji je cilj ovo očekivanje; null = samostalno očekivanje. */
  planId: string | null;
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

// ------------------------------------------------------------- Plan razvoja (P3)
// GET /v1/profile/dev-plan → { data: { plan, goals[], checkins[] } | null }.
// Plan/checkin polja prate BE kontrakt (snake_case iz v_development_plans / development_checkins);
// goals su employee_expectations sa plan_id (isti oblik kao Expectation, camelCase Prisma model).
// Napomena o robusnosti: čitanje plana ide kroz `devPlanField` (podnosi i camelCase alias).

/** Zaglavlje razvojnog plana (paritet 1.0 v_development_plans red). */
export interface DevPlan {
  id: string;
  period_label: string;
  career_goal_md: string | null;
  summary_md: string | null;
  self_assessment_md: string | null;
  /** Naziv ciljne pozicije (BE join na job_positions). */
  target_position: string | null;
  /** Ime mentora (BE join na v_employees_safe). */
  mentor: string | null;
  /** Ukupan napredak plana 0–100 (BE agregat po ciljevima). */
  progress: number | null;
  status?: string;
  [k: string]: unknown;
}
/** Beleška 1-na-1 dnevnika (development_checkins). */
export interface DevCheckin {
  id: string;
  /** 'zaposleni' | 'upravljac' (author_kind). */
  kind: string | null;
  note_md: string | null;
  checkin_date: string | null;
  [k: string]: unknown;
}
export interface DevPlanData {
  plan: DevPlan;
  goals: Expectation[];
  checkins: DevCheckin[];
}

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
  devPlan: ['profile', 'dev-plan'] as const,
  position: ['profile', 'position'] as const,
  companyValues: ['profile', 'company-values'] as const,
  colleagues: ['profile', 'colleagues-on-leave'] as const,
  onboarding: ['profile', 'onboarding'] as const,
  absences: ['profile', 'absences'] as const,
  attendanceEvents: ['profile', 'attendance-events'] as const,
  talkDetail: ['profile', 'talk-detail'] as const,
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
/** Razvojni plan zaposlenog (plan + ciljevi + dnevnik 1-na-1). `data:null` = nema plana. */
export function useDevPlan() {
  return useQuery({ queryKey: KEYS.devPlan, queryFn: () => apiFetch<{ data: DevPlanData | null; meta?: EnvelopeMeta }>(`${BASE}/dev-plan`) });
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

// ---------------------------------------------- P6 (Drop 2): onboarding / odsustva / prisustvo drill / razgovor detalji

/** 🚀 Moje uvođenje — aktivni onboarding/offboarding tokovi + zadaci (read-only). */
export function useOnboarding() {
  return useQuery({
    queryKey: KEYS.onboarding,
    queryFn: () => apiFetch<{ data: OnboardingData | null; meta?: EnvelopeMeta }>(`${BASE}/onboarding`),
  });
}
/** 🗓 Moja odsustva (tekuća godina). */
export function useAbsences() {
  return useQuery({
    queryKey: KEYS.absences,
    queryFn: () => apiFetch<{ data: AbsenceRow[] | null; meta?: EnvelopeMeta }>(`${BASE}/absences`),
  });
}
/** Prolazi za jedan dan — lazy (enabled samo kad je red otvoren). */
export function useAttendanceEvents(day: string | null) {
  return useQuery({
    queryKey: [...KEYS.attendanceEvents, day] as const,
    queryFn: () => apiFetch<{ data: AttendanceEvent[] | null; meta?: EnvelopeMeta }>(`${BASE}/attendance/events${qs({ day })}`),
    enabled: !!day,
  });
}
/** Detalji jednog razgovora (zapisnik + odluka o zaradi + korektivne mere). */
export function useTalkDetail(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.talkDetail, id] as const,
    queryFn: () => apiFetch<{ data: TalkDetail | null; meta?: EnvelopeMeta }>(`${BASE}/talks/${id}`),
    enabled: !!id,
  });
}

export interface AckRow {
  ref_type: string;
  ref_id: string;
  label: string | null;
  acked_at: string | null;
  acked_by: string | null;
}
/** Postojeće e-saglasnosti zaposlenog — za inicijalni „✓ Potvrđeno" status bez klika. */
export function useAcks() {
  return useQuery({ queryKey: ['profile', 'acks'] as const, queryFn: () => apiFetch<{ data: AckRow[] }>(`${BASE}/acks`) });
}

// ------------------------------------------------------------------ mutations

function useProfileMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }) });
}
function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function put<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
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

// READ kontrakt (P4-BE, GET /v1/profile/assessment/self?period=): agregat scope+framework+
// rater+moje ocene/odgovori + rezultati (radar) za samoprocenu. assessmentId=null → profil/
// pozicija nisu povezani; prazan scope → pozicija nema profil kompetencija.

export interface SelfAssessmentInfo {
  id: string;
  status: string; // draft | collecting | closed | shared
  periodLabel?: string | null;
  visibleToEmployee?: boolean;
}
export interface SelfRater {
  id: string;
  status?: string; // pending | submitted
}
/** Red opsega procene (v_assessment_scope): grupa→kompetencija profila pozicije. */
export interface AssessmentScopeRow {
  group_id: number;
  group_name: string;
  group_sort?: number;
  scope: string; // core | strucna | liderska
  competence_id: number;
  competence_name: string;
  comp_sort?: number;
}
/** Grupa okvira (v_competence_framework) sa kompetencijama i nivoima 0–5. */
export interface FrameworkLevel {
  level: number;
  descriptor: string;
}
export interface FrameworkCompetence {
  id: number;
  name: string;
  levels: FrameworkLevel[];
}
export interface FrameworkGroup {
  id: number;
  name: string;
  scope?: string;
  competences: FrameworkCompetence[];
}
export interface CompetenceQuestion {
  code: string;
  text_sr: string;
  group_id: number | null;
}
export interface SelfScore {
  competence_id: number;
  level: number | null;
  comment: string | null;
}
export interface SelfAnswer {
  question_code: string;
  answer_text: string | null;
}
/** Agregat rezultat (assessment_results) — po grupi/kompetenciji, za radar/tabelu. */
export interface AssessmentResultRow {
  scope_kind: string; // group | competence
  ref_id: number;
  self_avg?: number | null;
  peer_avg?: number | null;
  leader_val?: number | null;
  target_val?: number | null;
}
export interface SelfAssessmentData {
  assessmentId: string | null;
  assessment: SelfAssessmentInfo | null;
  scope: AssessmentScopeRow[];
  selfRater: SelfRater | null;
  framework: FrameworkGroup[];
  questions: CompetenceQuestion[];
  scores: SelfScore[];
  answers: SelfAnswer[];
  results: AssessmentResultRow[];
  visibleToEmployee: boolean;
}

/** Samoprocena (360°) — agregat za modal na /profil. `period` opciono (default tekuća godina na BE). */
export function useSelfAssessment(period?: string, enabled = true) {
  return useQuery({
    queryKey: ['profile', 'assessment', 'self', period ?? 'current'] as const,
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: SelfAssessmentData | null; meta?: EnvelopeMeta }>(`${BASE}/assessment/self${qs({ period })}`),
  });
}

export const useOpenSelfAssessment = () =>
  useProfileMutation<{ period?: string }, TxResponse<{ assessmentId: unknown }>>((v) => post('/assessment/self/open', v));
export const useSaveSelfScores = () =>
  useProfileMutation<{ raterId: string; items: { competenceId: number; level?: number | null; comment?: string }[] }>((v) =>
    post('/assessment/self/scores', v),
  );
export const useSaveSelfAnswers = () =>
  useProfileMutation<{ raterId: string; items: { questionCode: string; answerText?: string }[] }>((v) => post('/assessment/self/answers', v));
export const useSubmitSelfAssessment = () =>
  useProfileMutation<{ assessmentId: string }>((v) => post('/assessment/self/submit', v));

/* ── Plan razvoja + Moja očekivanja (self-write) — P3 ── */
// Samoprocena razvojnog plana (PATCH self_assessment_md kroz dp_update_self RLS).
// Check-in beleške (zaposleni kind; idempotentno preko clientEventId).
// Očekivanja: progress slider + status tranzicije (u_toku/ispunjeno) kroz ee_update_self RLS.

/** Snimi „Moju samoprocenu" na razvojnom planu (PATCH /dev-plan/:id/self-assessment). */
export const useSaveSelfAssessment = () =>
  useProfileMutation<{ id: string; selfAssessmentMd: string | null }>(
    (v) => apiFetch<TxResponse>(`${BASE}/dev-plan/${v.id}/self-assessment`, {
      method: 'PATCH',
      body: JSON.stringify({ selfAssessmentMd: v.selfAssessmentMd }),
    }),
    KEYS.devPlan,
  );

/** Dodaj belešku u dnevnik 1-na-1 (POST /dev-plan/:id/checkins; idempotentno). */
export const useAddCheckin = () =>
  useProfileMutation<{ id: string; clientEventId: string; noteMd: string }>(
    (v) => post(`/dev-plan/${v.id}/checkins`, { clientEventId: v.clientEventId, noteMd: v.noteMd }),
    KEYS.devPlan,
  );

/** Radnik menja SOPSTVENO očekivanje: progres i/ili status (PATCH /expectations/:id). */
export const useUpdateMyExpectation = () =>
  useProfileMutation<{ id: string; status?: 'u_toku' | 'ispunjeno'; progress?: number; completionNote?: string }>(
    (v) => apiFetch<TxResponse>(`${BASE}/expectations/${v.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: v.status, progress: v.progress, completionNote: v.completionNote }),
    }),
    // Ciljevi žive i u dev-plan-u (goals) i u samostalnim očekivanjima — invalidiraj oba.
    KEYS.all,
  );

/* ── Mesečni sati (karnet self-service) — P1 ── */
// GET /v1/profile/hours?month=YYYY-MM → dnevni redovi + praznici + karnet totali (BE agregat)
// + prikazni chips + moja primedba za mesec. Mutacije: PUT/DELETE primedbe (upsert po
// employee_id+year+month kroz GUC; prazan tekst = brisanje, status→'open').

/** Jedan dan meseca (BE agregat iz grida). Slova + polja mapiraju 1:1 na KarnetRow (camelCase). */
export interface ProfileHoursDay {
  ymd: string;
  day: number;
  letter: string;
  hours: number;
  overtimeHours: number;
  fieldHours: number;
  twoMachineHours: number;
  absenceCode: string | null;
  absenceSubtype: string | null;
}
/** Karnet totali za mesec (isti oblik kao KarnetTotals u hr-pdf). */
export interface ProfileHoursTotals {
  redovanRadSati?: number;
  prekovremeniSati?: number;
  praznikRadSati?: number;
  praznikPlaceniSati?: number;
  dveMasineSati?: number;
  godisnjiSati?: number;
  slobodniDaniSati?: number;
  bolovanje65Sati?: number;
  bolovanje100Sati?: number;
  neplacenoDays?: number;
}
/** Prikazni zbirovi za chips traku. */
export interface ProfileHoursChips {
  radnihSati: number;
  prisustvoSati: number;
  godisnjiDani: number;
  spDani: number;
  bolovanjeDani: number;
  slobodniDani: number;
  prekovremeniH: number;
  terenH: number;
}
export interface ProfileHoursRemark {
  text: string;
  status: string;
  resolvedBy: string | null;
}
export interface ProfileHours {
  month: string; // YYYY-MM
  days: ProfileHoursDay[];
  holidays: string[]; // YMD praznika
  totals: ProfileHoursTotals;
  chips: ProfileHoursChips;
  remark: ProfileHoursRemark | null;
}

export function useProfileHours(month: string) {
  return useQuery({
    queryKey: ['profile', 'hours', month] as const,
    queryFn: () => apiFetch<{ data: ProfileHours | null; meta?: EnvelopeMeta }>(`${BASE}/hours${qs({ month })}`),
    enabled: !!month,
  });
}

const hoursKey = ['profile', 'hours'] as const;

export const useSaveHoursRemark = () =>
  useProfileMutation<{ clientEventId: string; year: number; month: number; text: string }>(
    (v) => put('/hours/remark', v),
    hoursKey,
  );
export const useDeleteHoursRemark = () =>
  useProfileMutation<{ year: number; month: number }>(
    (v) => del(`/hours/remark${qs({ year: v.year, month: v.month })}`),
    hoursKey,
  );
