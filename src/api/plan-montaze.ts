'use client';

// Plan montaže + izveštaji montera — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3).
// Podaci žive u sy15 (1.0) bazi; BE vraća DVA oblika (paritet Reversi):
//   • Prisma modeli (tree WP/faze, report detalj+fotke) → camelCase,
//   • raw SQL (pb_list_projects, lista izveštaja, lookupi) → snake_case kolone.
// Komponente NIKAD ne zovu apiFetch direktno — samo ovi TanStack Query hook-ovi (CLAUDE.md §8).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ------------------------------------------------------------------ helpers

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/**
 * Klijentski UUID = idempotency ključ (izveštaji POST, doktrina A4). `crypto.randomUUID`
 * postoji SAMO u secure context-u (https/localhost); na LAN http padamo na getRandomValues.
 * (Isti mehanizam kao api/reversi.ts newClientEventId.)
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

const KEYS = {
  tree: ['montaza', 'tree'] as const,
  reports: ['montaza', 'reports'] as const,
  aiModel: ['montaza', 'ai-model'] as const,
  lookups: ['montaza', 'lookups'] as const,
};

// ------------------------------------------------------------------ tipovi (read)

/** Faza (Prisma model → camelCase; `checks`/`linkedDrawings` su Json u bazi). */
export interface MontazaPhase {
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
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Nalog montaže (work package). */
export interface MontazaWorkPackage {
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
  phases: MontazaPhase[];
}

/** Projekat (pb_list_projects → snake_case) + ugnježdeni WP/faze. */
export interface MontazaProjectNode {
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
  workPackages: MontazaWorkPackage[];
}

/** Red liste izveštaja (raw SQL → snake_case). */
export interface IzvestajRow {
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

/** Foto izveštaja (Prisma → camelCase). */
export interface IzvestajFoto {
  id: string;
  izvestajId: string;
  redniBroj: number;
  storagePath: string;
  opis: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

/** Detalj izveštaja (Prisma → camelCase) + fotke. */
export interface IzvestajDetail {
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
  fotke: IzvestajFoto[];
}

export interface AiModelRow {
  id: number;
  model: string;
  updated_at: string;
  updated_by: string | null;
}

/** Red predmet lookup-a (bigtehn_items_cache + kratki naziv komitenta). */
export interface PredmetOption {
  id: number;
  broj_predmeta: string | null;
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

/** Exists-check crteža. */
export interface DrawingExists {
  drawing_no: string;
  exists: boolean;
  storage_path: string | null;
  file_name: string | null;
}

export interface ReportsParams {
  status?: string;
  q?: string;
  limit?: number;
}

/** ⭐ plan-prioritet payload (GET /v1/pracenje/plan-prioritet). */
export interface PlanPrioritet {
  ids: number[];
  max: number;
  prev: number[];
}

// ------------------------------------------------------------------ ⭐ redosled projekata

/**
 * ⭐ redosled predmeta iz Praćenja (Podešavanja predmeta). Na grešku (403 za role
 * bez pracenje.read, mrežni pad…) vraća [] → sort pada na project_code fallback.
 */
async function fetchPlanPrioritetIds(): Promise<number[]> {
  try {
    const r = await apiFetch<{ data: PlanPrioritet }>('/v1/pracenje/plan-prioritet');
    const ids = r.data?.ids;
    return Array.isArray(ids)
      ? ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [];
  } catch {
    return [];
  }
}

/**
 * Paritet 1.0 `sortProjectsForPredmetPrioritet` (services/projects.js →
 * predmetPrioritet.sortByPredmetPrioritet): projekti čiji je `predmet_item_id`
 * u ⭐ listi idu PRVI, u redosledu te liste; ostali (i ceo skup kad je lista
 * prazna) po `project_code` localeCompare('sr'). Sort je stabilan → jednaki
 * kodovi zadržavaju originalni red. Ne mutira ulaz.
 */
export function sortProjectsByPrioritet<
  T extends { predmet_item_id: number | null; project_code: string | null },
>(projects: T[], ids: number[]): T[] {
  const list = Array.isArray(projects) ? [...projects] : [];
  if (list.length <= 1) return list;
  const byCode = (a: T, b: T) =>
    String(a.project_code ?? '').localeCompare(String(b.project_code ?? ''), 'sr');
  if (!ids.length) return list.sort(byCode);
  const rank = (p: T): number => {
    const id = Number(p.predmet_item_id);
    return Number.isFinite(id) && id > 0 ? ids.indexOf(id) : -1;
  };
  return list.sort((a, b) => {
    const ia = rank(a);
    const ib = rank(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return byCode(a, b);
  });
}

// ------------------------------------------------------------------ queries

/**
 * Celo stablo projekat→WP→faze (pb_list_projects ⋈ aktivacija; jedan poziv, bez N+1).
 * Projekti stižu VEĆ sortirani po ⭐ plan-prioritetu (paritet 1.0) — svi potrošači
 * (Plan / Gantt / Ukupan Gant) dobijaju isti redosled bez sopstvenog sorta.
 */
export function useMontazaTree() {
  return useQuery({
    queryKey: KEYS.tree,
    queryFn: async () => {
      const [treeRes, prioIds] = await Promise.all([
        apiFetch<{ data: MontazaProjectNode[] }>('/v1/montaza/projects?include=tree'),
        fetchPlanPrioritetIds(),
      ]);
      return { ...treeRes, data: sortProjectsByPrioritet(treeRes.data ?? [], prioIds) };
    },
  });
}

/** Lista izveštaja montera (filter status + q pretraga po 6 polja). */
export function useMontazaReports(params: ReportsParams) {
  return useQuery({
    queryKey: [...KEYS.reports, params],
    queryFn: () => apiFetch<{ data: IzvestajRow[] }>(`/v1/montaza/reports${qs({ ...params })}`),
  });
}

/** Detalj izveštaja + fotke (meta). */
export function useMontazaReport(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.reports, 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: IzvestajDetail }>(`/v1/montaza/reports/${id}`),
  });
}

/** Model za AI strukturiranje izveštaja (singleton). */
export function useMontazaAiModel() {
  return useQuery({
    queryKey: KEYS.aiModel,
    queryFn: () => apiFetch<{ data: AiModelRow | null }>('/v1/montaza/ai-model'),
  });
}

/** Pretraga predmeta (Poveži predmet picker). onlyActive default false (paritet 1.0). */
export function useMontazaPredmetLookup(q: string, onlyActive = false) {
  return useQuery({
    queryKey: [...KEYS.lookups, 'predmeti', q, onlyActive],
    enabled: q.trim().length >= 2,
    queryFn: () =>
      apiFetch<{ data: PredmetOption[] }>(
        `/v1/montaza/lookups/predmeti${qs({ q, onlyActive: onlyActive ? '1' : undefined })}`,
      ),
  });
}

// Imperativni GET-ovi (on-demand: signed URL-ovi + exists-check).

/** Presigned URL fotke (po foto id-ju). */
export function fetchPhotoSignedUrl(photoId: string): Promise<{ data: { url: string; expiresIn?: number } }> {
  return apiFetch(`/v1/montaza/reports/photo/${photoId}/sign`);
}

/** Presigned URL PDF-a izveštaja. */
export function fetchReportPdfUrl(id: string): Promise<{ data: { url: string; expiresIn?: number } }> {
  return apiFetch(`/v1/montaza/reports/${id}/pdf`);
}

/** Exists-check + putanje za listu brojeva crteža (zarezom razdvojeni). */
export function fetchDrawingsExists(codes: string[]): Promise<{ data: DrawingExists[] }> {
  return apiFetch(`/v1/montaza/lookups/drawings${qs({ codes: codes.join(',') })}`);
}

/** Presigned URL PDF-a crteža iz bigtehn keša (gate can_read_production_drawings). */
export function fetchDrawingSignedUrl(code: string): Promise<{ data: { url: string; expiresIn?: number } }> {
  return apiFetch(`/v1/montaza/lookups/drawings/sign${qs({ code })}`);
}

// ------------------------------------------------------------------ kompatibilnost
// Spoljni potrošači montaza predmet-lookup-a (kadrovska grid picker/teren, lokacije
// štampa) i idempotency ključa (plan-proizvodnje) uvoze ove nazive iz @/api/plan-montaze.
// Zadržavamo ih kao aliase na kanonske (PredmetOption / newClientEventId) da objedinjavanje
// montaže ne polomi te module.

/**
 * Predmet-lookup red za spoljne potrošače (kadrovska/lokacije). Oblik identičan ranijem
 * montaža `PredmetLookup` — `broj_predmeta` je non-null (predmet uvek ima broj), za razliku
 * od internog PredmetOption. Zadržava kompatibilnost sa modulima pisanim protiv tog tipa.
 */
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

/** Alias idempotency ključa — koristi ga plan-proizvodnje (reassign clientEventId). */
export const newClientId = newClientEventId;

/**
 * Predmet-lookup bez enabled-guarda (paritet ranijeg montaža pickera; fira i za prazan/kratak
 * upit → recent 50). Kadrovska grid/teren + lokacije štampa zavise od ovog ponašanja.
 */
export function usePredmetiLookup(q: string, onlyActive = false) {
  return useQuery({
    queryKey: [...KEYS.lookups, 'predmeti-compat', q, onlyActive],
    queryFn: () =>
      apiFetch<{ data: PredmetLookup[] }>(
        `/v1/montaza/lookups/predmeti${qs({ q, onlyActive: onlyActive ? '1' : undefined })}`,
      ),
  });
}

// ------------------------------------------------------------------ mutacije: PM CRUD
// Upsert-po-id (paritet 1.0 buildXPayload); row-odluka has_edit_role presuđuje sy15 (403).

export interface UpsertProjectVars {
  id?: string;
  projectCode: string;
  projectName: string;
  projectm?: string;
  projectDeadline?: string | null;
  pmEmail?: string;
  leadpmEmail?: string;
  status?: string;
}
export interface UpdateProjectVars extends Partial<Omit<UpsertProjectVars, 'id'>> {
  id: string;
}

export interface UpsertWorkPackageVars {
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
export interface UpdateWorkPackageVars extends Partial<Omit<UpsertWorkPackageVars, 'id' | 'projectId'>> {
  id: string;
}

export interface PhaseFields {
  phaseName?: string;
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
  phaseType?: 'mechanical' | 'electrical';
  description?: string;
  linkedDrawings?: string[];
  actualStartDate?: string | null;
  actualEndDate?: string | null;
}
export interface UpsertPhaseVars extends PhaseFields {
  id?: string;
  projectId: string;
  workPackageId: string;
  phaseName: string;
}
export interface UpdatePhaseVars extends PhaseFields {
  id: string;
}

function useMontazaMutation<V, R = { data: unknown }>(
  fn: (v: V) => Promise<R>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['montaza'] }),
  });
}

export const useUpsertProject = () =>
  useMontazaMutation((v: UpsertProjectVars) =>
    apiFetch<{ data: MontazaProjectNode }>('/v1/montaza/projects', {
      method: 'POST',
      body: JSON.stringify(v),
    }),
  );

export const useUpdateProject = () =>
  useMontazaMutation(({ id, ...body }: UpdateProjectVars) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );

export const useDeleteProject = () =>
  useMontazaMutation((id: string) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/projects/${id}`, { method: 'DELETE' }),
  );

export const useUpsertWorkPackage = () =>
  useMontazaMutation((v: UpsertWorkPackageVars) =>
    apiFetch<{ data: MontazaWorkPackage }>('/v1/montaza/work-packages', {
      method: 'POST',
      body: JSON.stringify(v),
    }),
  );

export const useUpdateWorkPackage = () =>
  useMontazaMutation(({ id, ...body }: UpdateWorkPackageVars) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/work-packages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );

export const useDeleteWorkPackage = () =>
  useMontazaMutation((id: string) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/work-packages/${id}`, { method: 'DELETE' }),
  );

export const useUpsertPhase = () =>
  useMontazaMutation((v: UpsertPhaseVars) =>
    apiFetch<{ data: MontazaPhase }>('/v1/montaza/phases', {
      method: 'POST',
      body: JSON.stringify(v),
    }),
  );

export const useUpdatePhase = () =>
  useMontazaMutation(({ id, ...body }: UpdatePhaseVars) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/phases/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );

export const useDeletePhase = () =>
  useMontazaMutation((id: string) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/phases/${id}`, { method: 'DELETE' }),
  );

// ------------------------------------------------------------------ mutacije: izveštaji

/** jsonb payload izveštaja (paritet 1.0 sacuvajIzvestaj); `id` = klijentski UUID (idempotencija). */
export interface CreateReportVars {
  id: string;
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

/** Kreiranje izveštaja — idempotentno preko `id`. Odgovor: {data, meta:{idempotent}}. */
export const useCreateReport = () =>
  useMontazaMutation((v: CreateReportVars) =>
    apiFetch<{ data: unknown; meta: { idempotent: boolean } }>('/v1/montaza/reports', {
      method: 'POST',
      body: JSON.stringify(v),
    }),
  );

export interface LinkPredmetVars {
  id: string;
  predmetItemId?: number | null;
  predmetBroj?: string;
  nazivProjekta?: string;
  klijent?: string;
}

/** Poveži/odveži predmet (prazan payload = odveži). */
export const useLinkPredmet = () =>
  useMontazaMutation(({ id, ...body }: LinkPredmetVars) =>
    apiFetch<{ data: { id: string } }>(`/v1/montaza/reports/${id}/predmet`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  );

/** Strukturisan AI izlaz (BE normalizeMontazaOut; datum=DD.MM.YYYY, vreme=HH:MM). */
export interface MontazaAiOut {
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
  fotodokumentacija: { redni_broj: number; opis: string }[];
  predmet_item_id: number | null;
  nedostajuci_podaci: string[];
}

/** AI strukturiranje slobodnog teksta + fotki (port edge). Fotke: base64 bez data: prefiksa. */
export interface AiGenerateVars {
  tekst?: string;
  slike?: { media_type: string; data: string }[];
  dopune?: string[];
}
export const useAiGenerate = () =>
  useMutation({
    mutationFn: (v: AiGenerateVars) =>
      apiFetch<{ data: MontazaAiOut; meta?: { model?: string } }>('/v1/montaza/reports/ai-generate', {
        method: 'POST',
        body: JSON.stringify(v),
      }),
  });

/** Postavi AI model (admin). */
export const useSetMontazaAiModel = () =>
  useMontazaMutation((model: string) =>
    apiFetch<{ data: AiModelRow }>('/v1/montaza/ai-model', {
      method: 'PUT',
      body: JSON.stringify({ model }),
    }),
  );

/** Upload fotki izveštaja (multipart). `redni` = CSV rednih brojeva za ciljani retry. */
export function useUploadReportPhotos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      files,
      redni,
      opisi,
    }: {
      id: string;
      files: File[];
      redni?: string;
      opisi?: string[];
    }) => {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      if (redni) fd.append('redni', redni);
      if (opisi) fd.append('opisi', JSON.stringify(opisi));
      return apiUpload<{ data: unknown }>(`/v1/montaza/reports/${id}/photos`, fd);
    },
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: [...KEYS.reports, 'detail', v.id] }),
  });
}

/** Upload PDF-a izveštaja (multipart, generisan na FE). */
export function useUploadReportPdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blob, fileName }: { id: string; blob: Blob; fileName?: string }) => {
      const fd = new FormData();
      fd.append('file', blob, fileName ?? `${id}.pdf`);
      return apiUpload<{ data: { path: string } }>(`/v1/montaza/reports/${id}/pdf`, fd);
    },
    onSuccess: (_r, v) => void qc.invalidateQueries({ queryKey: [...KEYS.reports, 'detail', v.id] }),
  });
}

// ------------------------------------------------------------------ normalizacija

/**
 * Sirova faza (Prisma read) → radni oblik za UI/pravila: `checks` = tačno 8 bool,
 * `linkedDrawings` = string[], datumi = kanonsko 'YYYY-MM-DD', nullovi → '' / 0.
 * (phase.ts pravila očekuju ovaj normalizovan oblik.)
 */
export interface PhaseVM {
  id: string;
  projectId: string;
  workPackageId: string;
  phaseName: string;
  location: string;
  startDate: string;
  endDate: string;
  responsibleEngineer: string;
  montageLead: string;
  status: number;
  pct: number;
  checks: boolean[];
  blocker: string;
  note: string;
  sortOrder: number;
  phaseType: 'mechanical' | 'electrical';
  description: string;
  linkedDrawings: string[];
  actualStartDate: string;
  actualEndDate: string;
}

function ymd(v: string | null): string {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export function toPhaseVM(p: MontazaPhase): PhaseVM {
  const checks = Array.isArray(p.checks) ? p.checks.slice(0, 8) : [];
  while (checks.length < 8) checks.push(false);
  return {
    id: p.id,
    projectId: p.projectId,
    workPackageId: p.workPackageId,
    phaseName: p.phaseName ?? '',
    location: p.location ?? '',
    startDate: ymd(p.startDate),
    endDate: ymd(p.endDate),
    responsibleEngineer: p.responsibleEngineer ?? '',
    montageLead: p.montageLead ?? '',
    status: p.status ?? 0,
    pct: p.pct ?? 0,
    checks: checks.map(Boolean),
    blocker: p.blocker ?? '',
    note: p.note ?? '',
    sortOrder: p.sortOrder ?? 0,
    phaseType: p.phaseType === 'electrical' ? 'electrical' : 'mechanical',
    description: p.description ?? '',
    linkedDrawings: Array.isArray(p.linkedDrawings) ? p.linkedDrawings : [],
    actualStartDate: ymd(p.actualStartDate),
    actualEndDate: ymd(p.actualEndDate),
  };
}
