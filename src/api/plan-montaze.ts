'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ============================================================================
// Plan montaže + izveštaji montera — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3).
// Data sloj: TanStack Query hooks nad NestJS `/v1/montaza/*`. Podaci žive u sy15 (1.0)
// bazi. BE vraća DVA oblika:
//   • lista projekata iz `pb_list_projects()` (snake_case ProjectRow),
//   • WP/faze/izveštaji-detalj/fotke = Prisma modeli (camelCase).
// Lista izveštaja je snake_case (raw SELECT). Idempotentni POST (kreiranje izveštaja)
// nosi klijentski UUID `id` — retry ISTE akcije nosi ISTI ključ. Row-nivo (has_edit_role
// project-scope, autor-scope) presuđuje sy15 kroz withUserRls — FE ga NE duplira.
// ============================================================================

const BASE = '/v1/montaza';

/** Idempotency/klijentski UUID (crypto.randomUUID uz fallback za ne-secure LAN). */
export function newClientId(): string {
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

export interface TxResponse<T = unknown> {
  data: T;
  meta?: Record<string, unknown>;
}
export interface SignedUrl {
  url: string;
  expiresIn: number;
}

// ------------------------------------------------------------------ tipovi

/** Red iz `pb_list_projects()` (snake_case). */
export interface PmProjectRow {
  id: string;
  project_code: string;
  project_name: string;
  status: string | null;
  predmet_item_id: number | null;
  projectm: string | null;
  project_deadline: string | null;
  pm_email: string | null;
  leadpm_email: string | null;
  reminder_enabled: boolean | null;
}

/** Faza (Prisma model PmPhase — camelCase). `checks` = 8×bool; `linkedDrawings` = string[]. */
export interface PmPhase {
  id: string;
  projectId: string;
  workPackageId: string;
  phaseName: string;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  responsibleEngineer: string | null;
  montageLead: string | null;
  status: number | null;
  pct: number | null;
  checks: boolean[] | null;
  blocker: string | null;
  note: string | null;
  sortOrder: number | null;
  phaseType: string | null;
  description: string | null;
  linkedDrawings: string[] | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Nalog montaže (WP, Prisma PmWorkPackage — camelCase) + ugnežđene faze. */
export interface PmWorkPackage {
  id: string;
  projectId: string;
  rnCode: string | null;
  rnOrder: number | null;
  name: string;
  location: string | null;
  responsibleEngineerDefault: string | null;
  montageLeadDefault: string | null;
  deadline: string | null;
  sortOrder: number | null;
  isActive: boolean | null;
  assemblyDrawingNo: string;
  createdAt: string | null;
  updatedAt: string | null;
  phases: PmPhase[];
}

export type PmProjectTree = PmProjectRow & { workPackages: PmWorkPackage[] };

/** Red liste izveštaja montera (raw SELECT — snake_case). */
export interface ReportRow {
  id: string;
  broj_izvestaja: string | null;
  status: string;
  datum_rada: string | null;
  predmet_broj: string | null;
  naziv_projekta: string | null;
  klijent: string | null;
  lokacija: string | null;
  pocetak_rada: string | null;
  kraj_rada: string | null;
  opis_radova: string | null;
  problemi: string | null;
  otvorene_stavke: string | null;
  dodatni_clanovi: string[] | null;
  autor_ime: string | null;
  sirovi_tekst: string | null;
  ai_model: string | null;
  pdf_path: string | null;
  pdf_naziv: string | null;
  created_at: string;
}

/** Fotka izveštaja (Prisma PmIzvestajFoto — camelCase). */
export interface ReportFoto {
  id: string;
  izvestajId: string;
  redniBroj: number;
  storagePath: string;
  opis: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

/** Detalj izveštaja (Prisma PmIzvestaj — camelCase) + fotke. */
export interface ReportDetail {
  id: string;
  brojIzvestaja: string | null;
  status: string;
  datumRada: string | null;
  predmetItemId: number | null;
  predmetBroj: string | null;
  nazivProjekta: string | null;
  klijent: string | null;
  lokacija: string | null;
  pocetakRada: string | null;
  krajRada: string | null;
  opisRadova: string | null;
  problemi: string | null;
  otvoreneStavke: string | null;
  dodatniClanovi: string[] | null;
  autorIme: string | null;
  siroviTekst: string | null;
  aiModel: string | null;
  aiJson: Record<string, unknown> | null;
  pdfPath: string | null;
  pdfNaziv: string | null;
  createdAt: string;
  finalizedAt: string | null;
  updatedAt: string;
  fotke: ReportFoto[];
}

export interface AiModelSetting {
  id: number;
  model: string;
  updated_at: string;
  updated_by: string | null;
}

/** Red predmet-lookup-a (bigtehn_items_cache + short komitent). */
export interface PredmetLookup {
  id: number;
  broj_predmeta: string;
  naziv_predmeta: string | null;
  opis: string | null;
  status: string | null;
  department_code: string | null;
  broj_ugovora: string | null;
  broj_narudzbenice: string | null;
  rok_zavrsetka: string | null;
  datum_zakljucenja: string | null;
  customer_id: number | null;
  customer_name: string | null;
}

export interface DrawingLookup {
  drawing_no: string;
  exists: boolean;
  storage_path: string | null;
  file_name: string | null;
}

/** Rezultat AI strukturiranja (port edge montaza-izvestaj-ai). */
export interface AiGenerateOut {
  datum: string;
  predmet: string;
  naziv_projekta: string;
  klijent: string;
  lokacija: string;
  pocetak_rada: string;
  kraj_rada: string;
  opis_radova: string;
  problemi: string;
  otvorene_stavke: string;
  status: string;
  dodatni_clanovi_tima: string[];
  fotodokumentacija: Array<{ redni_broj: number; opis: string }>;
  predmet_item_id: number | null;
  nedostajuci_podaci: string[];
}

export const MONTAZA_STATUS_LABELS: Record<string, string> = {
  zavrseno: 'Završeno',
  delimicno: 'Delimično',
  u_toku: 'U toku',
  ceka_materijal: 'Čeka materijal',
  ceka_potvrdu: 'Čeka potvrdu',
  dodatna_intervencija: 'Dodatna intervencija',
};

export const MONTAZA_AI_MODELS = ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['montaza'] as const,
  projects: ['montaza', 'projects'] as const,
  reports: ['montaza', 'reports'] as const,
  report: (id: string) => ['montaza', 'reports', id] as const,
  aiModel: ['montaza', 'ai-model'] as const,
};

// ------------------------------------------------------------------ queries

export function useProjectsTree() {
  return useQuery({
    queryKey: KEYS.projects,
    queryFn: () => apiFetch<{ data: PmProjectTree[] }>(`${BASE}/projects?include=tree`),
  });
}

export interface ReportsParams {
  status?: string;
  q?: string;
  limit?: number;
}
export function useReports(params: ReportsParams = {}) {
  return useQuery({
    queryKey: [...KEYS.reports, params],
    queryFn: () => apiFetch<{ data: ReportRow[] }>(`${BASE}/reports${qs({ ...params })}`),
  });
}

export function useReportDetail(id: string | null) {
  return useQuery({
    queryKey: id ? KEYS.report(id) : ['montaza', 'reports', 'none'],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: ReportDetail }>(`${BASE}/reports/${id}`),
  });
}

export function fetchReportPdfUrl(id: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/reports/${id}/pdf`);
}
export function fetchPhotoUrl(photoId: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/reports/photo/${photoId}/sign`);
}

export function useAiModel() {
  return useQuery({
    queryKey: KEYS.aiModel,
    queryFn: () => apiFetch<{ data: AiModelSetting | null }>(`${BASE}/ai-model`),
  });
}

/** Predmet-lookup hook za ComboBox (default vraća i zatvorene — paritet montaža picker). */
export function usePredmetiLookup(q: string, onlyActive = false) {
  return useQuery({
    queryKey: ['montaza', 'lookup-predmeti', q, onlyActive],
    queryFn: () =>
      apiFetch<{ data: PredmetLookup[] }>(
        `${BASE}/lookups/predmeti${qs({ q, onlyActive: onlyActive ? '1' : '' })}`,
      ),
  });
}

/** Exists-check + storage_path za listu brojeva crteža (CSV). */
export function fetchDrawingsLookup(codes: string[]): Promise<{ data: DrawingLookup[] }> {
  return apiFetch<{ data: DrawingLookup[] }>(`${BASE}/lookups/drawings${qs({ codes: codes.join(',') })}`);
}

// ------------------------------------------------------------------ mutations

function useMontazaMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function patch<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });
}
function put<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PUT', body: JSON.stringify(body) });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/* ── Projekti ── */

export interface ProjectInput {
  id?: string;
  projectCode: string;
  projectName: string;
  projectm?: string;
  projectDeadline?: string | null;
  pmEmail?: string;
  leadpmEmail?: string;
  status?: string;
}
export const useUpsertProject = () =>
  useMontazaMutation<ProjectInput>((v) => post('/projects', v), KEYS.projects);
export const useUpdateProject = () =>
  useMontazaMutation<{ id: string; patch: Partial<Omit<ProjectInput, 'id'>> }>(
    (v) => patch(`/projects/${v.id}`, v.patch),
    KEYS.projects,
  );
export const useDeleteProject = () =>
  useMontazaMutation<{ id: string }>((v) => del(`/projects/${v.id}`), KEYS.projects);

/* ── Nalozi montaže (WP) ── */

export interface WorkPackageInput {
  id?: string;
  projectId: string;
  rnCode?: string;
  rnOrder?: number;
  name: string;
  location?: string;
  responsibleEngineerDefault?: string;
  montageLeadDefault?: string;
  deadline?: string | null;
  isActive?: boolean;
  assemblyDrawingNo?: string;
}
export const useUpsertWorkPackage = () =>
  useMontazaMutation<WorkPackageInput>((v) => post('/work-packages', v), KEYS.projects);
export const useUpdateWorkPackage = () =>
  useMontazaMutation<{ id: string; patch: Partial<Omit<WorkPackageInput, 'id' | 'projectId'>> }>(
    (v) => patch(`/work-packages/${v.id}`, v.patch),
    KEYS.projects,
  );
export const useDeleteWorkPackage = () =>
  useMontazaMutation<{ id: string }>((v) => del(`/work-packages/${v.id}`), KEYS.projects);

/* ── Faze ── */

export interface PhaseInput {
  id?: string;
  projectId: string;
  workPackageId: string;
  phaseName: string;
  location?: string;
  startDate?: string | null;
  endDate?: string | null;
  responsibleEngineer?: string;
  montageLead?: string;
  status?: number;
  pct?: number;
  checks?: boolean[];
  blocker?: string;
  note?: string;
  sortOrder?: number;
  phaseType?: string;
  description?: string;
  linkedDrawings?: string[];
  actualStartDate?: string | null;
  actualEndDate?: string | null;
}
export const useUpsertPhase = () =>
  useMontazaMutation<PhaseInput, TxResponse<PmPhase>>((v) => post<PmPhase>('/phases', v), KEYS.projects);
export const useUpdatePhase = () =>
  useMontazaMutation<{ id: string; patch: Partial<Omit<PhaseInput, 'id' | 'projectId' | 'workPackageId'>> }>(
    (v) => patch(`/phases/${v.id}`, v.patch),
    KEYS.projects,
  );
export const useDeletePhase = () =>
  useMontazaMutation<{ id: string }>((v) => del(`/phases/${v.id}`), KEYS.projects);

/* ── Izveštaji montera ── */

export interface CreateReportVars {
  id: string; // klijentski UUID (idempotencija)
  status?: string;
  datum?: string;
  predmetItemId?: number | null;
  predmet?: string;
  nazivProjekta?: string;
  klijent?: string;
  lokacija?: string;
  pocetakRada?: string;
  krajRada?: string;
  opisRadova?: string;
  problemi?: string;
  otvoreneStavke?: string;
  dodatniClanovi?: string[];
  autorIme?: string;
  siroviTekst?: string;
  aiModel?: string;
  aiJson?: Record<string, unknown>;
}
export const useCreateReport = () =>
  useMontazaMutation<CreateReportVars, TxResponse<ReportDetail>>((v) => post<ReportDetail>('/reports', v), KEYS.reports);

export interface LinkPredmetVars {
  id: string;
  predmetItemId?: number | null;
  predmetBroj?: string;
  nazivProjekta?: string;
  klijent?: string;
}
export const useLinkPredmet = () =>
  useMontazaMutation<LinkPredmetVars>((v) => {
    const { id, ...body } = v;
    return patch(`/reports/${id}/predmet`, body);
  }, KEYS.reports);

/** Foto upload (multipart; ciljani retry = pošalji SAMO neuspele sa njihovim `redni`). */
export interface UploadPhotosResult {
  total: number;
  uploaded: number;
  failed: number;
  failedRedni: number[];
}
export const useUploadPhotos = () =>
  useMontazaMutation<{ id: string; files: File[]; redni?: number[]; opisi?: string[] }, TxResponse<UploadPhotosResult>>(
    (v) => {
      const fd = new FormData();
      for (const f of v.files) fd.append('files', f, f.name || 'foto.jpg');
      if (v.redni?.length) fd.append('redni', v.redni.join(','));
      if (v.opisi?.length) fd.append('opisi', JSON.stringify(v.opisi));
      return apiUpload<TxResponse<UploadPhotosResult>>(`${BASE}/reports/${v.id}/photos`, fd);
    },
    KEYS.reports,
  );

export const useUploadReportPdf = () =>
  useMontazaMutation<{ id: string; blob: Blob }, TxResponse<{ pdfPath: string; pdfNaziv: string }>>((v) => {
    const fd = new FormData();
    fd.append('file', v.blob, `${v.id}.pdf`);
    return apiUpload<TxResponse<{ pdfPath: string; pdfNaziv: string }>>(`${BASE}/reports/${v.id}/pdf`, fd);
  }, KEYS.reports);

/** AI strukturiranje — imperativno (bez keša). Fotke b64 bez data: prefiksa. */
export function aiGenerate(vars: {
  tekst?: string;
  slike?: { media_type: string; data: string }[];
  dopune?: string[];
}): Promise<TxResponse<AiGenerateOut>> {
  return post<AiGenerateOut>('/reports/ai-generate', vars);
}

export const useSetAiModel = () =>
  useMontazaMutation<{ model: string }>((v) => put('/ai-model', { model: v.model }), KEYS.aiModel);
