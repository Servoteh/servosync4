'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

/**
 * Zahtevi — AI PM modul (MODULE_SPEC_zahtevi.md). Tipizovan klijent + TanStack
 * hooks nad NestJS `/api/v1/zahtevi/*`. Tipovi prate STVARNE backend odgovore
 * (ne samo spec): vidi backend/src/modules/zahtevi/{zahtevi.controller.ts,
 * zahtevi.service.ts, dto/*}. Envelope svuda `{ data }` ili `{ data, meta }`.
 *
 * Row-scope presuđuje SERVIS (ne-admin vidi SAMO svoje) — FE ovim samo krije
 * afordanse (permisije kroz useCan). Komponente NE zovu API direktno —
 * isključivo kroz ove hookove (frontend/CLAUDE.md §8).
 *
 * F2 obim: CRUD/submit/withdraw/prilozi/komentari/decision/status/slicni/inbox-meta.
 * F3 (AI): retriage/approve-analysis/analyses PATCH — hookovi već postoje (spremni),
 * ali AI tabovi dolaze u F3. F4: nagrade/odluke — NEMA hookova ovde (drugi fajlovi).
 */

const BASE = '/v1/zahtevi';

// ─────────────────────────────────────────────────────────────── idempotencija

/**
 * clientEventId za create (postojeći obrazac): jedinstven po klik-akciji; retry
 * ISTE akcije nosi ISTI ključ. `crypto.randomUUID` postoji samo u secure context-u
 * (https/localhost); na LAN http:// pada na `getRandomValues` (kao odrzavanje.ts).
 */
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

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ─────────────────────────────────────────────────────────────── envelope tipovi

interface One<T> {
  data: T;
}
interface Rows<T> {
  data: T[];
}
/** Paginirani odgovor `list` — BE šalje `meta.pagination` (pageMeta helper). */
export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}
interface List<T> {
  data: T[];
  meta: PageMeta;
}

// ─────────────────────────────────────────────────────────────── enumi/skupovi

/** Tip zahteva (`kind`) — 1:1 sa create-change-request.dto.ts REQUEST_KINDS. */
export const REQUEST_KINDS = [
  'BUG',
  'MISSING_1_0',
  'IMPROVEMENT_3_0',
  'FEATURE_4_0',
  'UI_UX',
  'BUSINESS_RULE',
  'OTHER',
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_KIND_LABEL: Record<RequestKind, string> = {
  BUG: 'Greška (bug)',
  MISSING_1_0: 'Fali iz 1.0',
  IMPROVEMENT_3_0: 'Dorada 3.0',
  FEATURE_4_0: 'Nova funkcija 4.0',
  UI_UX: 'Izgled / UX',
  BUSINESS_RULE: 'Poslovno pravilo',
  OTHER: 'Ostalo',
};

/** Oblast (`areas`) — 1:1 sa REQUEST_AREAS. */
export const REQUEST_AREAS = ['DATABASE', 'BACKEND', 'FRONTEND', 'MOBILE'] as const;
export type RequestArea = (typeof REQUEST_AREAS)[number];
export const REQUEST_AREA_LABEL: Record<RequestArea, string> = {
  DATABASE: 'Baza',
  BACKEND: 'Backend',
  FRONTEND: 'Frontend',
  MOBILE: 'Mobilna',
};

/** Prioritet (`priorityUser`/`priorityFinal`). */
export const REQUEST_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number];
export const REQUEST_PRIORITY_LABEL: Record<RequestPriority, string> = {
  LOW: 'Nizak',
  MEDIUM: 'Srednji',
  HIGH: 'Visok',
  CRITICAL: 'Kritičan',
};

/** Status zahteva (`status`) — String iz BE (MODULE_SPEC §1.2). */
export const ZAHTEV_STATUS = [
  'DRAFT',
  'SUBMITTED',
  'NEEDS_INFO',
  'ANALYSIS_APPROVED',
  'ANALYZED',
  'APPROVED',
  'PLANNED',
  'IN_PROGRESS',
  'READY_FOR_TEST',
  'TESTING',
  'DONE',
  'REJECTED',
  'MERGED',
  'DEFERRED',
  'ARCHIVED',
] as const;
export type ZahtevStatus = (typeof ZAHTEV_STATUS)[number];

/** Reward status (`rewardStatus`). */
export type RewardStatus = 'NONE' | 'PROPOSED' | 'CONFIRMED' | 'PAID' | 'EXCLUDED';

// ─────────────────────────────────────────────────────────────── entiteti

/** Red liste/kartica — `change_requests` (Prisma model, camelCase). */
export interface ChangeRequest {
  id: number;
  reqNo: string;
  title: string;
  description: string;
  expectedBehavior: string | null;
  currentBehavior: string | null;
  kind: string | null;
  module: string | null;
  areas: string[];
  priorityUser: string | null;
  priorityFinal: string | null;
  aiScore: number | null;
  aiScoreReason: string | null;
  finalScore: number | null;
  /** Decimal-as-string u JSON-u (BACKEND_RULES §6) — formatDecimal na prikazu. */
  rewardAmount: string | null;
  rewardStatus: RewardStatus;
  rewardMonth: string | null;
  status: ZahtevStatus;
  createdByUserId: number;
  submittedAt: string | null;
  decidedAt: string | null;
  decidedByUserId: number | null;
  decisionNote: string | null;
  mergedIntoId: number | null;
  branchName: string | null;
  prUrl: string | null;
  commitSha: string | null;
  deliveredVersion: string | null;
  implementedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Prilog — `change_request_attachments`. */
export interface ChangeRequestAttachment {
  id: number;
  requestId: number;
  kind: 'IMAGE' | 'AUDIO' | 'FILE';
  bucket: string;
  storagePath: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  transcript: string | null;
  transcriptModel: string | null;
  createdByUserId: number;
  createdAt: string;
  deletedAt: string | null;
}

/** AI prolaz — `change_request_ai_analyses` (F3 popunjava `result`/`claudePackage`). */
export interface ChangeRequestAiAnalysis {
  id: number;
  requestId: number;
  kind: 'TRIAGE' | 'DETAILED';
  status: 'PENDING' | 'DONE' | 'FAILED';
  model: string | null;
  result: unknown | null;
  claudePackage: string | null;
  errorCode: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  startedByUserId: number | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Komentar/pitanje — `change_request_comments`. */
export interface ChangeRequestComment {
  id: number;
  requestId: number;
  authorUserId: number;
  body: string;
  isQuestion: boolean;
  createdAt: string;
}

/** Event (insert-only timeline) — `change_request_events`. `data` je slobodan JSON. */
export interface ChangeRequestEvent {
  id: number;
  requestId: number;
  type: string;
  actorUserId: number | null;
  data: Record<string, unknown> | null;
  createdAt: string;
}

/** Detalj — GET /zahtevi/:id (include: prilozi/analize/komentari/events). */
export interface ChangeRequestDetail extends ChangeRequest {
  attachments: ChangeRequestAttachment[];
  analyses: ChangeRequestAiAnalysis[];
  comments: ChangeRequestComment[];
  events: ChangeRequestEvent[];
}

/** Red iz GET /zahtevi/slicni (uži select). */
export interface SimilarRequest {
  id: number;
  reqNo: string;
  title: string;
  status: ZahtevStatus;
  module: string | null;
  kind: string | null;
}

/** GET /zahtevi/inbox-meta — brojači statusa koji čekaju admina. */
export interface InboxMeta {
  byStatus: Record<string, number>;
  total: number;
}

// ─────────────────────────────────────────────────────────────── query keys

const KEYS = {
  all: ['zahtevi'] as const,
  list: (f: unknown) => ['zahtevi', 'list', f] as const,
  detail: (id: number | null) => ['zahtevi', 'detail', id] as const,
  inboxMeta: ['zahtevi', 'inbox-meta'] as const,
  slicni: (q: string) => ['zahtevi', 'slicni', q] as const,
};

// ─────────────────────────────────────────────────────────────── ulazni tipovi

export interface CreateZahtevInput {
  title: string;
  description: string;
  expectedBehavior?: string;
  currentBehavior?: string;
  kind?: string;
  module?: string;
  areas?: string[];
  priorityUser?: string;
  /** true = kreiraj i ODMAH podnesi (DRAFT→SUBMITTED + trijaža). */
  submit?: boolean;
}

export interface UpdateZahtevInput {
  title?: string;
  description?: string;
  expectedBehavior?: string | null;
  currentBehavior?: string | null;
  kind?: string | null;
  module?: string | null;
  areas?: string[];
  priorityUser?: string | null;
  /** Samo admin (BE 403 inače). */
  priorityFinal?: string | null;
}

export type DecisionAction = 'approve' | 'reject' | 'needs-info' | 'merge' | 'defer' | 'archive';
export interface DecisionInput {
  action: DecisionAction;
  note?: string;
  mergeIntoId?: number;
  logDecision?: boolean;
}

export type RealizationAction = 'planned' | 'in-progress' | 'ready-for-test' | 'testing' | 'done';
export interface StatusInput {
  action: RealizationAction;
  branchName?: string;
  prUrl?: string;
  commitSha?: string;
  deliveredVersion?: string;
  implementedBy?: string;
  note?: string;
}

export interface ZahteviFilters {
  status?: string;
  module?: string;
  kind?: string;
  q?: string;
  createdBy?: number | '';
  page?: number;
  pageSize?: number;
}

// ─────────────────────────────────────────────────────────────── queries

/** Lista zahteva (server-side paginacija; ne-admin sužen na svoje u servisu). */
export function useZahtevi(filters: ZahteviFilters = {}) {
  const query = qs({
    status: filters.status,
    module: filters.module,
    kind: filters.kind,
    q: filters.q,
    createdBy: filters.createdBy === '' ? undefined : filters.createdBy,
    page: filters.page,
    pageSize: filters.pageSize,
  });
  return useQuery({
    queryKey: KEYS.list(filters),
    queryFn: () => apiFetch<List<ChangeRequest>>(`${BASE}${query}`),
  });
}

/** Detalj jednog zahteva (+ prilozi/analize/komentari/events). */
export function useZahtev(id: number | null, opts?: { refetchInterval?: number | false }) {
  return useQuery({
    queryKey: KEYS.detail(id),
    enabled: id != null,
    refetchInterval: opts?.refetchInterval,
    queryFn: () => apiFetch<One<ChangeRequestDetail>>(`${BASE}/${id}`),
  });
}

/** Inbox brojači (admin) — SUBMITTED/ANALYZED/TESTING. */
export function useInboxMeta(enabled = true) {
  return useQuery({
    queryKey: KEYS.inboxMeta,
    enabled,
    queryFn: () => apiFetch<One<InboxMeta>>(`${BASE}/inbox-meta`),
  });
}

/**
 * Živa provera sličnih (BEZ AI) — forma novog zahteva (debounce). BE traži q ≥ 3
 * znaka (kraće → prazna lista); zato `enabled` kad je term dovoljno dug.
 */
export function useSlicni(term: string) {
  const q = term.trim();
  return useQuery({
    queryKey: KEYS.slicni(q),
    enabled: q.length >= 3,
    staleTime: 10_000,
    queryFn: () => apiFetch<Rows<SimilarRequest>>(`${BASE}/slicni${qs({ q })}`),
  });
}

/** Jednokratna (van hook-a) provera sličnih — koristi je debounce efekat u formi. */
export function fetchSlicni(term: string): Promise<Rows<SimilarRequest>> {
  return apiFetch<Rows<SimilarRequest>>(`${BASE}/slicni${qs({ q: term.trim() })}`);
}

/** Signed URL priloga (on-demand; 1h). */
export function signAttachmentUrl(
  requestId: number,
  attId: number,
): Promise<One<{ url: string; expiresIn: number }>> {
  return apiFetch(`${BASE}/${requestId}/attachments/${attId}/url`);
}

// ─────────────────────────────────────────────────────────────── mutacije

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: KEYS.all });
}

/** Kreiraj zahtev (DRAFT ili uz `submit:true` odmah podnet). clientEventId idempotencija. */
export function useCreateZahtev() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateZahtevInput) =>
      apiFetch<One<ChangeRequest>>(`${BASE}`, {
        method: 'POST',
        body: JSON.stringify({ clientEventId: newClientEventId(), ...input }),
      }),
    onSuccess: invalidate,
  });
}

/** PATCH sadržaja/meta (servis presuđuje šta sme po ulozi/statusu). */
export function useUpdateZahtev() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateZahtevInput }) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
  });
}

/** Hard delete nacrta (SAMO owner + SAMO DRAFT). */
export function useDeleteZahtev() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<{ id: number; deleted: boolean }>>(`${BASE}/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

/** Podnesi (DRAFT→SUBMITTED, re-submit iz NEEDS_INFO) — okida trijažu (F3). */
export function useSubmitZahtev() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/submit`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
}

/** Povuci (→ ARCHIVED) iz DRAFT|SUBMITTED|NEEDS_INFO. */
export function useWithdrawZahtev() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/withdraw`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
}

/** Komentar (owner + admin; admin sme `isQuestion:true` → NEEDS_INFO). */
export function useAddComment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, body, isQuestion }: { id: number; body: string; isQuestion?: boolean }) =>
      apiFetch<One<ChangeRequestComment>>(`${BASE}/${id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body, isQuestion }),
      }),
    onSuccess: invalidate,
  });
}

/** Admin presuda (approve/reject/needs-info/merge/defer/archive). */
export function useDecision() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: number } & DecisionInput) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Realizacioni prelazi + link polja (admin). */
export function useSetRealizationStatus() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: number } & StatusInput) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/status`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Upload priloga (multipart, do 10; servis validira mime/veličinu). */
export function useUploadAttachments() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, files }: { id: number; files: File[] }) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      return apiUpload<Rows<ChangeRequestAttachment>>(`${BASE}/${id}/attachments`, fd);
    },
    onSuccess: invalidate,
  });
}

/** Soft-delete priloga (owner u DRAFT/SUBMITTED/NEEDS_INFO; admin uvek). */
export function useDeleteAttachment() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, attId }: { id: number; attId: number }) =>
      apiFetch<One<{ id: number; deleted: boolean }>>(
        `${BASE}/${id}/attachments/${attId}`,
        { method: 'DELETE' },
      ),
    onSuccess: invalidate,
  });
}

/** Retry STT za audio prilog (F1 vraća 422 „stiže sa AI cevovodom F3"). */
export function useRetryTranscribe() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, attId }: { id: number; attId: number }) =>
      apiFetch<One<ChangeRequestAttachment>>(
        `${BASE}/${id}/attachments/${attId}/transcribe`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: invalidate,
  });
}

// ── F3 (AI) ────────────────────────────────────────────────────────────────

/** Strukturisan izlaz trijaže (`result` na TRIAGE redu) — 1:1 sa BE normalizeTriage. */
export interface TriageResult {
  summary: string;
  module: string | null;
  kind: string | null;
  areas: string[];
  priorityProposal: string | null;
  duplicates: { requestId: number; confidence: 'HIGH' | 'MEDIUM'; reason: string }[];
  score: number | null;
  scoreReason: string | null;
  questions: string[];
}

/** Strukturisan izlaz detaljne analize (`result` na DETAILED redu) — 1:1 sa BE normalizeAnalysis. */
export interface AnalysisResult {
  understanding: string;
  affectedModules: string[];
  impact: string;
  risks: string[];
  conflicts: string[];
  openQuestions: string[];
  acceptanceCriteria: string[];
  testScenarios: string[];
  estimate: string | null;
  priorityProposal: string | null;
  claudePackage: string;
}

/** Ponovi trijažu (admin). */
export function useRetriage() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<{ id: number; triage: string }>>(`${BASE}/${id}/retriage`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Odobri AI analizu (admin, odobrenje #1): SUBMITTED→ANALYSIS_APPROVED + detaljna analiza. */
export function useApproveAnalysis() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/approve-analysis`, {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: invalidate,
  });
}

/** Vrati AI-odbačen (ocena 0) zahtev u obradu (admin) — sigurnosni ventil auto-reject-a. */
export function useRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: number) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/restore`, { method: 'POST', body: '{}' }),
    onSuccess: invalidate,
  });
}

/** Dorada Claude paketa (admin) na redu detaljne analize. */
export function usePatchAnalysis() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      id,
      analysisId,
      claudePackage,
    }: {
      id: number;
      analysisId: number;
      claudePackage: string;
    }) =>
      apiFetch<One<ChangeRequestAiAnalysis>>(`${BASE}/${id}/analyses/${analysisId}`, {
        method: 'PATCH',
        body: JSON.stringify({ claudePackage }),
      }),
    onSuccess: invalidate,
  });
}

// ── F4: NAGRADE (§12) ────────────────────────────────────────────────────────

/** Potvrdi/koriguj ocenu 0–5 (admin): 0→REJECTED; ≥1→snapshot iznosa + CONFIRMED. */
export function useScore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, score }: { id: number; score: number }) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/score`, {
        method: 'POST',
        body: JSON.stringify({ score }),
      }),
    onSuccess: invalidate,
  });
}

/** Isključi predlog iz nagrađivanja (admin) — rewardStatus=EXCLUDED. */
export function useExcludeReward() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason?: string }) =>
      apiFetch<One<ChangeRequest>>(`${BASE}/${id}/exclude`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: invalidate,
  });
}

/** Jedan red tarife (ocena→iznos, važeći / istorijski). Decimal-as-string. */
export interface TariffRow {
  score: number;
  amount: string;
  validFrom: string;
}
export interface TariffHistoryRow extends TariffRow {
  id: number;
  currency: string;
  createdByUserId: number;
  createdAt: string;
}
export interface TariffsResponse {
  current: TariffRow[];
  history: TariffHistoryRow[];
}

/** GET /zahtevi/nagrade/tarife (admin) — aktuelna tarifa + istorija. */
export function useTariffs(enabled = true) {
  return useQuery({
    queryKey: ['zahtevi', 'nagrade', 'tarife'] as const,
    enabled,
    queryFn: () => apiFetch<One<TariffsResponse>>(`${BASE}/nagrade/tarife`),
  });
}

/** PUT /zahtevi/nagrade/tarife (admin) — 5 iznosa (nov red od danas). */
export function usePutTariffs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (amounts: Record<string, number>) =>
      apiFetch<One<TariffRow[]>>(`${BASE}/nagrade/tarife`, {
        method: 'PUT',
        body: JSON.stringify({ amounts }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['zahtevi', 'nagrade'] });
    },
  });
}

/** Stavka obračuna po korisniku. */
export interface PayoutItem {
  id: number;
  reqNo: string;
  title: string;
  score: number | null;
  amount: string | null;
  rewardStatus: RewardStatus;
}
export interface PayoutUserRow {
  userId: number;
  userName: string;
  countByScore: Record<string, number>;
  count: number;
  total: string;
  items: PayoutItem[];
}
export interface PayoutReport {
  month: string;
  closed: boolean;
  total: string;
  userCount: number;
  itemCount: number;
  users: PayoutUserRow[];
}

/** GET /zahtevi/nagrade/obracun?month= (admin) — mesečni obračun. */
export function usePayoutReport(month: string, enabled = true) {
  return useQuery({
    queryKey: ['zahtevi', 'nagrade', 'obracun', month] as const,
    enabled: enabled && /^\d{4}-\d{2}$/.test(month),
    queryFn: () =>
      apiFetch<One<PayoutReport>>(`${BASE}/nagrade/obracun${qs({ month })}`),
  });
}

/** POST /zahtevi/nagrade/obracun/:month/zakljuci (admin) — CONFIRMED→PAID. */
export function useCloseMonth() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (month: string) =>
      apiFetch<One<{ month: string; paidCount: number; total: string }>>(
        `${BASE}/nagrade/obracun/${month}/zakljuci`,
        { method: 'POST', body: '{}' },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['zahtevi'] });
    },
  });
}

/** Stavka „Moje nagrade". */
export interface MyRewardItem {
  id: number;
  reqNo: string;
  title: string;
  score: number | null;
  amount: string | null;
  rewardStatus: RewardStatus;
}
export interface MyRewards {
  month: string;
  total: string;
  count: number;
  items: MyRewardItem[];
}

/** GET /zahtevi/nagrade/moje?month= — SVOJE nagrade za mesec (row-scope, tačan zbir). */
export function useMyRewards(month: string) {
  return useQuery({
    queryKey: ['zahtevi', 'nagrade', 'moje', month] as const,
    queryFn: () =>
      apiFetch<One<MyRewards>>(`${BASE}/nagrade/moje${qs({ month })}`),
  });
}

// ── F4: DECISION LOG (§6) ────────────────────────────────────────────────────

export interface DecisionLogEntry {
  id: number;
  title: string;
  decision: string;
  context: string | null;
  consequences: string | null;
  tags: string[];
  relatedRequestId: number | null;
  status: 'ACTIVE' | 'SUPERSEDED';
  supersededById: number | null;
  decidedOn: string;
  createdByUserId: number;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionFilters {
  q?: string;
  tag?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface CreateDecisionInput {
  title: string;
  decision: string;
  context?: string;
  consequences?: string;
  tags?: string[];
  relatedRequestId?: number;
  decidedOn?: string;
}
export interface UpdateDecisionInput {
  title?: string;
  decision?: string;
  context?: string | null;
  consequences?: string | null;
  tags?: string[];
  relatedRequestId?: number | null;
  decidedOn?: string;
}

const DEC_KEYS = {
  all: ['zahtevi', 'odluke'] as const,
  list: (f: unknown) => ['zahtevi', 'odluke', 'list', f] as const,
  detail: (id: number | null) => ['zahtevi', 'odluke', 'detail', id] as const,
};

/** GET /zahtevi/odluke — lista (decisions.read). */
export function useDecisions(filters: DecisionFilters = {}, enabled = true) {
  const query = qs({
    q: filters.q,
    tag: filters.tag,
    status: filters.status,
    page: filters.page,
    pageSize: filters.pageSize,
  });
  return useQuery({
    queryKey: DEC_KEYS.list(filters),
    enabled,
    queryFn: () => apiFetch<List<DecisionLogEntry>>(`${BASE}/odluke${query}`),
  });
}

/** GET /zahtevi/odluke/:id — detalj. */
export function useDecisionEntry(id: number | null) {
  return useQuery({
    queryKey: DEC_KEYS.detail(id),
    enabled: id != null,
    queryFn: () => apiFetch<One<DecisionLogEntry>>(`${BASE}/odluke/${id}`),
  });
}

function useInvalidateDecisions() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: DEC_KEYS.all });
}

/** POST /zahtevi/odluke (decisions.write) — nova odluka. */
export function useCreateDecision() {
  const invalidate = useInvalidateDecisions();
  return useMutation({
    mutationFn: (input: CreateDecisionInput) =>
      apiFetch<One<DecisionLogEntry>>(`${BASE}/odluke`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** PATCH /zahtevi/odluke/:id (decisions.write) — sitne ispravke. */
export function useUpdateDecision() {
  const invalidate = useInvalidateDecisions();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateDecisionInput }) =>
      apiFetch<One<DecisionLogEntry>>(`${BASE}/odluke/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidate,
  });
}

/** POST /zahtevi/odluke/:id/supersede (decisions.write) — nova odluka zamenjuje staru. */
export function useSupersedeDecision() {
  const invalidate = useInvalidateDecisions();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: number } & CreateDecisionInput) =>
      apiFetch<One<{ created: DecisionLogEntry; superseded: DecisionLogEntry }>>(
        `${BASE}/odluke/${id}/supersede`,
        { method: 'POST', body: JSON.stringify(input) },
      ),
    onSuccess: invalidate,
  });
}
