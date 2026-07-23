'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

// ============================================================================
// Sastanci — 3.0 TALAS B (MODULE_SPEC_sastanci_ai_30.md §4). Data sloj: TanStack
// Query hooks nad NestJS `/v1/sastanci/*`. Podaci žive u sy15 (1.0) bazi; backend
// vraća DVA oblika:
//   • Prisma modeli (sastanci/ucesnici/aktivnosti/odluke/…) → camelCase polja,
//   • sy15 view-ovi (`v_akcioni_plan` / `v_pm_teme_pregled`) → snake_case kolone.
// Mutacije sa nus-efektima nose `clientEventId` (idempotency ključ — vidi
// newClientEventId; paritet reversi.ts). Row-nivo (organizator-trio/učesnik-scope/
// pm_teme vidljivost) presuđuje sy15 RLS na backendu — FE ga NE duplira.
// ============================================================================

// ------------------------------------------------------------------ helpers

/**
 * Idempotency ključ mutacije (backend runIdempotentRls): generiši JEDNOM po
 * korisničkoj akciji (klik) i prosledi u variables — retry ISTE akcije nosi ISTI
 * ključ. `crypto.randomUUID` postoji samo u secure context-u; van njega (LAN
 * http) pada na `getRandomValues` (RFC 4122 v4). Kopija reversi.ts obrasca.
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

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const BASE = '/v1/sastanci';

/** Odgovor mutacije: `{ data }` (+ `meta.idempotent` za idempotentne POST-ove). */
export interface TxResponse<T = unknown> {
  data: T;
  meta?: { idempotent?: boolean };
}

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// ------------------------------------------------------------------ tipovi

/** `sastanci` red (Prisma model Sastanak — camelCase). */
export interface Sastanak {
  id: string;
  tip: 'sedmicni' | 'projektni' | 'tematski' | 'dnevni' | string;
  naslov: string;
  datum: string;
  vreme: string | null;
  mesto: string | null;
  projekatId: string | null;
  vodioEmail: string | null;
  vodioLabel: string | null;
  zapisnicarEmail: string | null;
  zapisnicarLabel: string | null;
  status: 'planiran' | 'u_toku' | 'zavrsen' | 'zakljucan' | 'otkazan' | string;
  zakljucanAt: string | null;
  zakljucanByEmail: string | null;
  napomena: string | null;
  createdAt: string;
  createdByEmail: string | null;
  updatedAt: string;
  pozivnicePoslateAt: string | null;
}

/** Učesnik (bez `rsvpToken` — tajna magic-linka; backend ga izostavlja). */
export interface Ucesnik {
  sastanakId: string;
  email: string;
  label: string | null;
  prisutan: boolean;
  pozvan: boolean;
  napomena: string | null;
  pripremljen: boolean;
  priprema: string | null;
  rsvpStatus: 'dolazim' | 'ne_dolazim' | null;
  rsvpAt: string | null;
}

/** Tačka zapisnika (presek_aktivnosti). */
export interface Aktivnost {
  id: string;
  sastanakId: string;
  rb: number;
  redosled: number;
  naslov: string;
  podRn: string | null;
  sadrzajHtml: string | null;
  sadrzajText: string | null;
  odgovoranEmail: string | null;
  odgovoranLabel: string | null;
  odgovoranText: string | null;
  rok: string | null;
  rokText: string | null;
  status: string;
  napomena: string | null;
  createdAt: string;
  updatedAt: string;
  temaId: string | null;
}

/** Slika preseka (meta; bytes su u bucketu `sastanak-slike`). sizeBytes → Number. */
export interface Slika {
  id: string;
  sastanakId: string;
  aktivnostId: string | null;
  storagePath: string;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  caption: string | null;
  redosled: number;
  uploadedByEmail: string | null;
  uploadedAt: string;
}

export interface Odluka {
  id: string;
  sastanakId: string;
  rb: number | null;
  naslov: string;
  opis: string | null;
  odlucioEmail: string | null;
  odlucioLabel: string | null;
  odlukaDatum: string | null;
  uticaj: string | null;
  vezaTemaId: string | null;
  vezaAkcijaId: string | null;
  status: 'na_snazi' | 'opozvana' | string;
  createdAt: string;
  updatedAt: string;
}

export interface Arhiva {
  id: string;
  sastanakId: string;
  snapshot: Record<string, unknown>;
  zapisnikStoragePath: string | null;
  zapisnikSizeBytes: number | null;
  zapisnikGeneratedAt: string | null;
  arhiviraoEmail: string | null;
  arhiviraoLabel: string | null;
  arhiviranoAt: string;
}

/** Red view-a `v_akcioni_plan` (snake_case + effective_status/dana_do_roka). */
export interface AkcijaRow {
  id: string;
  sastanak_id: string | null;
  tema_id: string | null;
  projekat_id: string | null;
  rb: number | null;
  naslov: string;
  opis: string | null;
  odgovoran_email: string | null;
  odgovoran_label: string | null;
  odgovoran_text: string | null;
  rok: string | null;
  rok_text: string | null;
  status: string;
  prioritet: number;
  zatvoren_at: string | null;
  zatvoren_by_email: string | null;
  zatvoren_napomena: string | null;
  created_at: string;
  created_by_email: string | null;
  updated_at: string;
  effective_status: 'otvoren' | 'u_toku' | 'kasni' | 'zavrsen' | string;
  dana_do_roka: number | null;
  /** Denormalizovan projekat (S-P0 ugovor, camelCase): za RN grupisanje bez extra fetch-a. */
  projekatNaziv: string | null;
  projekatCode: string | null;
  /** BigTehn predmet projekta — ključ za ⭐ rang (usePredmetPrioritet). */
  bigtehnItemId: string | null;
}

/** Red view-a `v_pm_teme_pregled` (snake_case + visual_tag). */
export interface PmTemaRow {
  id: string;
  vrsta: string;
  oblast: string;
  naslov: string;
  opis: string | null;
  projekat_id: string | null;
  status: string;
  prioritet: number;
  sastanak_id: string | null;
  predlozio_email: string;
  predlozio_label: string | null;
  predlozio_at: string;
  resio_email: string | null;
  resio_label: string | null;
  resio_at: string | null;
  resio_napomena: string | null;
  created_at: string;
  updated_at: string;
  hitno: boolean;
  za_razmatranje: boolean;
  admin_rang: number | null;
  admin_rang_by_email: string | null;
  admin_rang_at: string | null;
  visual_tag: string | null;
}

/** PM tema (Prisma model — draft tok vraća camelCase). */
export interface PmTema {
  id: string;
  vrsta: string;
  oblast: string;
  naslov: string;
  opis: string | null;
  projekatId: string | null;
  status: string;
  prioritet: number;
  sastanakId: string | null;
  predlozioEmail: string;
  predlozioLabel: string | null;
  predlozioAt: string;
  hitno: boolean;
  zaRazmatranje: boolean;
  adminRang: number | null;
}

export interface TemplateUcesnik {
  templateId: string;
  email: string;
  label: string | null;
}

export interface Template {
  id: string;
  naziv: string;
  tip: string;
  mesto: string | null;
  vodioEmail: string | null;
  zapisnicarEmail: string | null;
  cadence: 'none' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | string;
  cadenceDow: number | null;
  cadenceDom: number | null;
  vreme: string | null;
  napomena: string | null;
  isActive: boolean;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}
export type TemplateDetail = Template & { ucesnici: TemplateUcesnik[] };

/**
 * Red liste šablona — `Template` + dve izvedene kolone koje računa BE (S5).
 * Nisu na `TemplateDetail` (GET /templates/:id ih ne vraća).
 */
export interface TemplateRow extends Template {
  /** Sledeći termin po ritmu (`nextOccurrence`, YYYY-MM-DD); null za neaktivan / `cadence='none'`. */
  sledeciTermin: string | null;
  /** Poslednji ODRŽAN termin serije (YYYY-MM-DD) — dok nema `template_id`, heuristika po naslovu. */
  poslednjiSastanak: string | null;
  poslednjiSastanakId: string | null;
}

export interface AkcijaIstorija {
  id: string;
  akcijaId: string;
  polje: string;
  staro: string | null;
  novo: string | null;
  izmenioEmail: string | null;
  izmenjenoAt: string;
}

export interface NotifLog {
  id: string;
  kind: string;
  channel: string;
  recipientEmail: string;
  recipientLabel: string | null;
  subject: string;
  relatedSastanakId: string | null;
  relatedAkcijaId: string | null;
  status: string;
  scheduledAt: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface Prefs {
  email: string;
  onNewAkcija: boolean;
  onChangeAkcija: boolean;
  onMeetingInvite: boolean;
  onMeetingLocked: boolean;
  onActionReminder: boolean;
  onMeetingReminder: boolean;
}

/** sast_weekly_status() JSON (snapshot 12.07). can_move iz `sast_weekly_movers`. */
export interface WeeklyStatus {
  week_monday: string;
  default_date: string;
  skipped: boolean;
  skip_reason: string | null;
  sastanak_id: string | null;
  sastanak_datum: string | null;
  sastanak_vreme: string | null;
  sastanak_status: string | null;
  can_move: boolean;
}

/** sast_dashboard_stats() JSON — KPI brojke (snake_case, snapshot 12.07). */
export interface DashboardStats {
  sastanc_upcoming: number;
  sastanc_u_toku: number;
  akcije_otvoreno: number;
  akcije_kasni: number;
  pm_teme_na_cekanju: number;
}

/** get_sastanci_user_directory() red (autocomplete učesnika). */
export interface DirectoryEntry {
  email: string;
  full_name: string;
  role: string;
}

export interface AiModelSetting {
  id: number;
  model: string;
  updated_at: string;
  updated_by: string | null;
}

/** Rezultat globalne pretrage (min 2 znaka). */
export interface SearchResult {
  akcije: {
    id: string;
    naslov: string;
    sastanak_id: string | null;
    projekat_id: string | null;
    effective_status: string;
    status: string;
    rok: string | null;
    rok_text: string | null;
  }[];
  sastanci: Pick<Sastanak, 'id' | 'naslov' | 'datum' | 'status' | 'tip'>[];
}

export type SastanakOverview = {
  ucesnici: number;
  prisutni: number;
  pripremljeni: number;
  aktivnosti: number;
  odluke: number;
  akcije: number;
  akcijeOtvorene: number;
};

export type SastanakFull = Sastanak & {
  ucesnici: Ucesnik[];
  aktivnosti: Aktivnost[];
  slike: Slika[];
  odluke: Odluka[];
  akcije: AkcijaRow[];
  arhiva: Arhiva | null;
  overview: SastanakOverview;
};

export interface SignedUrl {
  url: string;
  expiresIn: number;
}

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['sastanci'] as const,
  list: ['sastanci', 'list'] as const,
  detail: (id: string) => ['sastanci', 'detail', id] as const,
  akcije: ['sastanci', 'akcije'] as const,
  teme: ['sastanci', 'teme'] as const,
  templates: ['sastanci', 'templates'] as const,
  arhive: ['sastanci', 'arhive'] as const,
  weekly: ['sastanci', 'weekly'] as const,
  prefs: ['sastanci', 'prefs'] as const,
  dashboard: ['sastanci', 'dashboard'] as const,
  directory: ['sastanci', 'directory'] as const,
  notifications: ['sastanci', 'notifications'] as const,
  aiModel: ['sastanci', 'ai-model'] as const,
};

// ------------------------------------------------------------------ queries

export interface ListParams {
  tip?: string;
  status?: string;
  projekatId?: string;
  q?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export function useSastanci(params: ListParams) {
  return useQuery({
    queryKey: [...KEYS.list, params],
    queryFn: () => apiFetch<{ data: Sastanak[]; meta: PageMeta }>(`${BASE}${qs({ ...params })}`),
  });
}

export function useMyMeetings() {
  return useQuery({
    queryKey: [...KEYS.all, 'my'],
    queryFn: () => apiFetch<{ data: Sastanak[] }>(`${BASE}/my`),
  });
}

export function useNextWeekly() {
  return useQuery({
    queryKey: [...KEYS.all, 'next-weekly'],
    queryFn: () => apiFetch<{ data: Sastanak | null }>(`${BASE}/next-weekly`),
  });
}

/** Globalna pretraga (komandna paleta) — imperativno, min 2 znaka. */
export function searchSastanci(q: string): Promise<{ data: SearchResult }> {
  return apiFetch<{ data: SearchResult }>(`${BASE}/search${qs({ q })}`);
}

export function useDashboardStats() {
  return useQuery({
    queryKey: KEYS.dashboard,
    queryFn: () => apiFetch<{ data: DashboardStats | null }>(`${BASE}/dashboard-stats`),
  });
}

/** Direktorijum korisnika (autocomplete učesnika; DB traži has_edit_role → 403 za viewer). */
export function useUserDirectory(enabled = true) {
  return useQuery({
    queryKey: KEYS.directory,
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: DirectoryEntry[] }>(`${BASE}/user-directory`),
  });
}

export function useWeeklyStatus() {
  return useQuery({
    queryKey: KEYS.weekly,
    queryFn: () => apiFetch<{ data: WeeklyStatus | null }>(`${BASE}/weekly`),
  });
}

export function usePrefs() {
  return useQuery({
    queryKey: KEYS.prefs,
    queryFn: () => apiFetch<{ data: Prefs | null }>(`${BASE}/prefs`),
  });
}

export function useNotifications(sastanakId?: string) {
  return useQuery({
    queryKey: [...KEYS.notifications, sastanakId ?? null],
    queryFn: () => apiFetch<{ data: NotifLog[] }>(`${BASE}/notifications${qs({ sastanakId })}`),
  });
}

export function useAiModel() {
  return useQuery({
    queryKey: KEYS.aiModel,
    queryFn: () => apiFetch<{ data: AiModelSetting | null }>(`${BASE}/ai-model`),
  });
}

export interface AkcijeParams {
  sastanakId?: string;
  projekatId?: string;
  status?: string;
  odgovoranEmail?: string;
}

export function useAkcije(params: AkcijeParams = {}) {
  return useQuery({
    queryKey: [...KEYS.akcije, params],
    queryFn: () => apiFetch<{ data: AkcijaRow[] }>(`${BASE}/akcije${qs({ ...params })}`),
  });
}

export interface WeeklyDiff {
  novo: number;
  zavrsenoOveNedelje: number;
  kasni: number;
  aktivnih: number;
}

export function useAkcijeWeeklyDiff(params: { since?: string; projekatId?: string } = {}) {
  return useQuery({
    queryKey: [...KEYS.akcije, 'weekly-diff', params],
    queryFn: () => apiFetch<{ data: WeeklyDiff }>(`${BASE}/akcije/weekly-diff${qs({ ...params })}`),
  });
}

/**
 * „Od prošlog sastanka" za detalj/PDF — sidro = PRETHODNI ZAKLJUČANI sastanak
 * (1.0 loadPrethodniZakljucanPre paritet). `data: null` = nema prethodnog →
 * red se uopšte ne prikazuje (ni u headeru ni u PDF-u).
 */
export interface SastanakWeeklyDiff {
  since: string;
  novo: number;
  zavrsenoOveNedelje: number;
  kasni: number;
  aktivnih: number;
  /**
   * Identitet prethodnog ZAKLJUČANOG sastanka (S1) — za dugme „Prethodni zapisnik".
   * Aditivno; polja su opciona jer se FE mora ponašati graciozno i dok ih BE još
   * ne vraća (dugme se tada prosto ne prikazuje). `null` = nema prethodnog.
   */
  prethodniSastanakId?: string | null;
  prethodniNaslov?: string | null;
  prethodniDatum?: string | null;
}

export function useSastanakWeeklyDiff(id: string | null) {
  return useQuery({
    queryKey: id
      ? [...KEYS.detail(id), 'weekly-diff']
      : ['sastanci', 'detail', 'none', 'weekly-diff'],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: SastanakWeeklyDiff | null }>(`${BASE}/${id}/weekly-diff`),
  });
}

/**
 * ⭐ Top prioritet predmeta (Podešavanja → Predmeti) — uređena lista bigtehn_item_id
 * (1.0 pullPredmetPlanPrioritetIds paritet); index u listi = rang.
 */
export function usePredmetPrioritet() {
  return useQuery({
    queryKey: [...KEYS.all, 'predmet-prioritet'],
    queryFn: () => apiFetch<{ data: string[] }>(`${BASE}/predmet-prioritet`),
  });
}

export function useAkcijaIstorija(akcijaId: string | null) {
  return useQuery({
    queryKey: [...KEYS.akcije, 'istorija', akcijaId],
    enabled: !!akcijaId,
    queryFn: () => apiFetch<{ data: AkcijaIstorija[] }>(`${BASE}/akcije/${akcijaId}/istorija`),
  });
}

export interface TemeParams {
  status?: string;
  excludeStatuses?: string;
  projekatId?: string;
  sastanakId?: string;
  oblast?: string;
  predlozioEmail?: string;
  hitnoOnly?: boolean;
  razmatranjeOnly?: boolean;
}

export function useTeme(params: TemeParams = {}) {
  return useQuery({
    queryKey: [...KEYS.teme, params],
    queryFn: () => apiFetch<{ data: PmTemaRow[] }>(`${BASE}/teme${qs({ ...params })}`),
  });
}

/** Red liste projekata/RN za picker akcije (S5): `code — naziv`. */
export interface SastanciProjekat {
  id: string;
  code: string | null;
  naziv: string | null;
}

/**
 * Pretraga aktivnih projekata/RN za AkcijaModal picker (S5). BE `GET /sastanci/
 * projekti?q=` (ILIKE po code/naziv, limit 20). Query je `enabled` tek na ≥1 znak
 * kucanog upita — bez upita picker ne šalje ništa (obrazac DirectoryPicker/debounce).
 */
export function useSastanciProjekti(q: string) {
  const t = q.trim();
  return useQuery({
    queryKey: [...KEYS.all, 'projekti', t],
    enabled: t.length >= 1,
    queryFn: () => apiFetch<{ data: SastanciProjekat[] }>(`${BASE}/projekti${qs({ q: t })}`),
  });
}

export function useDraftTeme(projektId: string | null) {
  return useQuery({
    queryKey: [...KEYS.teme, 'draft', projektId],
    enabled: !!projektId,
    queryFn: () => apiFetch<{ data: PmTema[] }>(`${BASE}/teme/draft${qs({ projektId: projektId ?? '' })}`),
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: KEYS.templates,
    queryFn: () => apiFetch<{ data: TemplateRow[] }>(`${BASE}/templates`),
  });
}

export function useTemplate(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.templates, id],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: TemplateDetail }>(`${BASE}/templates/${id}`),
  });
}

export function useArhive() {
  return useQuery({
    queryKey: KEYS.arhive,
    queryFn: () => apiFetch<{ data: Arhiva[] }>(`${BASE}/arhive`),
  });
}

/** Ključ arhiva liste — exportovan za NE-pretplaćeno čitanje keša
 *  (`qc.getQueryData`) iz detalja: odgovor nosi pune snapshot jsonb-ove pa se
 *  van arhiva taba ne sme držati aktivan query (refetch na svaku mutaciju). */
export const arhiveQueryKey = KEYS.arhive;

/** Query key full-detalja — exportovan da imperativni fetchQuery (arhiva štampa
 *  iz živih podataka kad je 2.0 lock snapshot okrnjen) deli keš sa useSastanakFull. */
export function sastanakFullQueryKey(id: string) {
  return [...KEYS.detail(id), 'full'] as const;
}

/** Imperativni fetch punog detalja (za queryClient.fetchQuery van hook-a). */
export function fetchSastanakFull(id: string): Promise<{ data: SastanakFull }> {
  return apiFetch<{ data: SastanakFull }>(`${BASE}/${id}/full`);
}

export function useSastanakFull(id: string | null) {
  return useQuery({
    queryKey: id ? sastanakFullQueryKey(id) : ['sastanci', 'detail', 'none', 'full'],
    enabled: !!id,
    queryFn: () => fetchSastanakFull(id as string),
  });
}

/** Potpisan URL PDF-a zapisnika (GET; mgmt∨učesnik u backendu). */
export function fetchArhivaPdfUrl(sastanakId: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/${sastanakId}/arhiva/pdf`);
}

/** Potpisan URL slike preseka. */
export function fetchSlikaUrl(slikaId: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/slike/${slikaId}/sign`);
}

// ------------------------------------------------------------------ mutations
// Sve invalidiraju širok ['sastanci'] ključ (paritet reversi obrasca). JSON telo
// preko apiFetch; multipart (slika/pdf) preko apiUpload.

function useSastanciMutation<V, R = unknown>(
  fn: (v: V) => Promise<R>,
  invalidate: readonly unknown[] = KEYS.all,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
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

/* ── Sastanak CRUD ── */

export interface CreateSastanakVars {
  clientEventId: string;
  tip?: string;
  naslov: string;
  datum: string;
  vreme?: string;
  mesto?: string;
  projekatId?: string;
  vodioEmail?: string;
  vodioLabel?: string;
  zapisnicarEmail?: string;
  zapisnicarLabel?: string;
  status?: string;
  napomena?: string;
  /**
   * Zahtev 005/26 — pozivanje učesnika iz „prve forme". Umetanje reda auto-šalje
   * 'meeting_invite' mejl (tema/termin/mesto) svakom učesniku (sy15 trigger).
   * Prazno/izostavljeno = sastanak bez poziva.
   */
  ucesnici?: { email: string; label?: string; pozvan?: boolean; prisutan?: boolean }[];
}
export const useCreateSastanak = () =>
  useSastanciMutation<CreateSastanakVars, TxResponse<Sastanak>>((v) => post<Sastanak>('', v));

export interface UpdateSastanakVars {
  id: string;
  patch: Partial<Omit<CreateSastanakVars, 'clientEventId' | 'naslov' | 'datum'>> & {
    naslov?: string;
    datum?: string;
  };
}
export const useUpdateSastanak = () =>
  useSastanciMutation<UpdateSastanakVars, TxResponse<Sastanak>>((v) => patch<Sastanak>(`/${v.id}`, v.patch));

export const useDeleteSastanak = () =>
  useSastanciMutation<{ id: string }>((v) => del(`/${v.id}`));

/** Zaključaj (RPC sast_zakljucaj_sastanak; pdfStoragePath upisan PRE meeting_locked). */
export const useLockSastanak = () =>
  useSastanciMutation<{ id: string; clientEventId: string; pdfStoragePath?: string }>((v) =>
    post(`/${v.id}/lock`, { clientEventId: v.clientEventId, pdfStoragePath: v.pdfStoragePath }),
  );

/**
 * Otkaži sastanak + obavesti pozvane učesnike (RPC sastanci_cancel_sastanak →
 * 'meeting_cancel' mejl svakom `pozvan=true`). Idempotentno (clientEventId) —
 * dupli klik ne šalje mejlove dvaput. Ključevi odgovora su snake_case jer je to
 * sirov jsonb iz sy15 RPC-a (isto kao weekly-status). `ok:false` NIJE greška:
 * `reason='locked'` (zaključan) / `'already_cancelled'` (već otkazan).
 */
export interface CancelResult {
  ok: boolean;
  reason?: 'locked' | 'already_cancelled';
  sastanak_id: string;
  otkazan_at?: string;
  /** Broj učesnika kojima je mejl stavljen u red za slanje. */
  obavesteno?: number;
}
export const useCancelSastanak = () =>
  useSastanciMutation<{ id: string; clientEventId: string }, TxResponse<CancelResult>>((v) =>
    post<CancelResult>(`/${v.id}/cancel`, { clientEventId: v.clientEventId }),
  );

export const useReopenSastanak = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/reopen`));

export const useSendInvites = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/invites`));

export const useRemindUnprepared = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/remind-unprepared`));

export const useResendLocked = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/resend-locked`));

/**
 * Prenos sa poslednjeg sastanka u novi (1.0 prenesiUNoviSastanak paritet):
 * kopira učesnike + premesta otvorene/u_toku akcije. Idempotentno (clientEventId).
 * `fromSastanakId` je OPCION — bez njega BE sam bira izvor (poslednji istog tipa
 * strogo pre datuma, server-side). `source: null` u odgovoru = nije bilo
 * prethodnog sastanka, ništa preneto.
 */
export interface PrenosResult {
  ucesnici: number;
  akcije: number;
  source: { id: string; naslov: string } | null;
}
export const usePrenos = () =>
  useSastanciMutation<
    { id: string; fromSastanakId?: string; clientEventId: string },
    TxResponse<PrenosResult>
  >((v) =>
    post<PrenosResult>(`/${v.id}/prenos`, {
      fromSastanakId: v.fromSastanakId,
      clientEventId: v.clientEventId,
    }),
  );

export const useSetMyRsvp = () =>
  useSastanciMutation<{ id: string; status?: 'dolazim' | 'ne_dolazim' | null }>((v) =>
    post(`/${v.id}/rsvp`, { status: v.status ?? null }),
  );

export const useMarkPrisutni = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/mark-prisutni`));

/* ── Učesnici ── */

export interface UcesnikInput {
  email: string;
  label?: string;
  prisutan?: boolean;
  pozvan?: boolean;
  napomena?: string;
}
export const useBulkUcesnici = () =>
  useSastanciMutation<{ id: string; clientEventId: string; ucesnici: UcesnikInput[] }>((v) =>
    put(`/${v.id}/ucesnici`, { clientEventId: v.clientEventId, ucesnici: v.ucesnici }),
  );

export const useAddUcesnik = () =>
  useSastanciMutation<{ id: string; email: string; label?: string }>((v) =>
    post(`/${v.id}/ucesnici`, { email: v.email, label: v.label }),
  );

/**
 * Izmena polja učesnika (Pozvan/Prisutan/Pripremljen + tekst pripreme).
 *
 * S7: kontrolisani checkbox-i u pripremi (`checked={u.prisutan}`) inače „ne
 * reaguju" — prosti invalidate-on-success ostavlja checkbox nepomeren dok
 * mutacija + refetch `full` ne prođu (sekunda+ na sporoj vezi). Zato optimistički
 * update: `onMutate` odmah patch-uje učesnika (po email-u) u kešu punog detalja,
 * `onError` vrati snapshot, `onSettled` invalidira (server ostaje izvor istine).
 * Potpis hooka je nepromenjen — pozivaoci i dalje rade `.mutate({ id, email, patch })`.
 */
const UCESNIK_MUT_KEY = ['sastanci', 'ucesnik-patch'] as const;

export const useUpdateUcesnik = () => {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    {
      id: string;
      email: string;
      patch: { pozvan?: boolean; prisutan?: boolean; pripremljen?: boolean; priprema?: string };
    },
    { key: readonly unknown[]; prev: { data: SastanakFull } | undefined }
  >({
    mutationKey: UCESNIK_MUT_KEY,
    mutationFn: (v) => patch(`/${v.id}/ucesnici/${encodeURIComponent(v.email)}`, v.patch),
    onMutate: async (v) => {
      const key = sastanakFullQueryKey(v.id);
      // Otkaži tekuće refetch-ove da ne pregaze optimistički upis.
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ data: SastanakFull }>(key);
      if (prev) {
        qc.setQueryData<{ data: SastanakFull }>(key, {
          ...prev,
          data: {
            ...prev.data,
            ucesnici: prev.data.ucesnici.map((u) =>
              u.email === v.email ? { ...u, ...v.patch } : u,
            ),
          },
        });
      }
      return { key, prev };
    },
    onError: (_e, _v, ctx) => {
      // Rollback na snapshot pre optimističkog upisa.
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () => {
      // Preklopljene mutacije (brzo štrikliranje niz listu učesnika): invalidate
      // tek kad se poslednja slegne — inače refetch pokrenut od ranije mutacije
      // pregazi optimistički upis onih još u letu (vidljiv revert checkbox-a).
      if (qc.isMutating({ mutationKey: UCESNIK_MUT_KEY }) <= 1) {
        void qc.invalidateQueries({ queryKey: KEYS.all });
      }
    },
  });
};

export const useRemoveUcesnik = () =>
  useSastanciMutation<{ id: string; email: string }>((v) =>
    del(`/${v.id}/ucesnici/${encodeURIComponent(v.email)}`),
  );

/* ── Tačke zapisnika (presek_aktivnosti) ── */

export interface AktivnostInput {
  naslov?: string;
  podRn?: string;
  sadrzajHtml?: string;
  sadrzajText?: string;
  odgovoranEmail?: string;
  odgovoranLabel?: string;
  odgovoranText?: string;
  rok?: string;
  rokText?: string;
  status?: string;
  napomena?: string;
  temaId?: string;
}
export const useCreateAktivnost = () =>
  useSastanciMutation<{ id: string; clientEventId: string } & AktivnostInput>((v) => {
    const { id, ...body } = v;
    return post(`/${id}/aktivnosti`, body);
  });

export const useUpdateAktivnost = () =>
  useSastanciMutation<{ aktId: string; patch: AktivnostInput }>((v) =>
    patch(`/aktivnosti/${v.aktId}`, v.patch),
  );

export const useDeleteAktivnost = () =>
  useSastanciMutation<{ aktId: string }>((v) => del(`/aktivnosti/${v.aktId}`));

export const useReorderAktivnosti = () =>
  useSastanciMutation<{ id: string; ids: string[] }>((v) =>
    post(`/${v.id}/aktivnosti/reorder`, { ids: v.ids }),
  );

export const useSeedFromTeme = () =>
  useSastanciMutation<{ id: string }>((v) => post(`/${v.id}/aktivnosti/seed-from-teme`));

/* ── Odluke ── */

export interface OdlukaInput {
  naslov?: string;
  rb?: number;
  opis?: string;
  odlucioEmail?: string;
  odlucioLabel?: string;
  odlukaDatum?: string;
  uticaj?: string;
  vezaTemaId?: string;
  vezaAkcijaId?: string;
  status?: 'na_snazi' | 'opozvana';
}
export const useCreateOdluka = () =>
  useSastanciMutation<{ id: string; clientEventId: string; naslov: string } & OdlukaInput>((v) => {
    const { id, ...body } = v;
    return post(`/${id}/odluke`, body);
  });

export const useUpdateOdluka = () =>
  useSastanciMutation<{ id: string; odlId: string; patch: OdlukaInput }>((v) =>
    patch(`/${v.id}/odluke/${v.odlId}`, v.patch),
  );

export const useDeleteOdluka = () =>
  useSastanciMutation<{ id: string; odlId: string }>((v) => del(`/${v.id}/odluke/${v.odlId}`));

/* ── Akcioni plan ── */

export interface AkcijaInput {
  naslov: string;
  sastanakId?: string;
  temaId?: string;
  projekatId?: string;
  rb?: number;
  opis?: string;
  odgovoranEmail?: string;
  odgovoranLabel?: string;
  odgovoranText?: string;
  rok?: string;
  rokText?: string;
  status?: string;
  prioritet?: number;
}
// NAPOMENA: akcija-mutacije invalidiraju ŠIROK ['sastanci'] ključ (KEYS.all) —
// akcije se prikazuju i u detalju sastanka (`useSastanakFull` = ['sastanci','detail',
// id,'full']) i na mobilnom; usko invalidiranje samo ['sastanci','akcije'] ostavljalo
// je detalj bajat (mobilni highlight statusa se nije pomerao — review nalaz #5).
export const useCreateAkcija = () =>
  useSastanciMutation<{ clientEventId: string } & AkcijaInput>((v) => post('/akcije', v));

export interface AkcijaPatch {
  naslov?: string;
  sastanakId?: string;
  /** `null` briše vezu sa projektom/RN (S5) — akcija pada u „Bez RN / projekta". */
  projekatId?: string | null;
  rb?: number;
  opis?: string;
  odgovoranEmail?: string;
  odgovoranLabel?: string;
  odgovoranText?: string;
  rok?: string;
  rokText?: string;
  status?: string;
  prioritet?: number;
  zatvorenNapomena?: string;
}
export const usePatchAkcija = () =>
  useSastanciMutation<{ id: string; patch: AkcijaPatch }>((v) => patch(`/akcije/${v.id}`, v.patch));

export const useDeleteAkcija = () =>
  useSastanciMutation<{ id: string }>((v) => del(`/akcije/${v.id}`));

export const useBulkStatusAkcije = () =>
  useSastanciMutation<{ ids: string[]; status: string }>((v) =>
    post('/akcije/bulk-status', { ids: v.ids, status: v.status }),
  );

/* ── PM teme ── */

export interface TemaInput {
  naslov: string;
  vrsta?: string;
  oblast?: string;
  opis?: string;
  projekatId?: string;
  sastanakId?: string;
  status?: string;
  prioritet?: number;
  hitno?: boolean;
  zaRazmatranje?: boolean;
}
export const useCreateTema = () =>
  useSastanciMutation<{ clientEventId: string } & TemaInput>((v) => post('/teme', v), KEYS.teme);

export const useUpdateTema = () =>
  useSastanciMutation<{ id: string; patch: Partial<TemaInput> & { resioNapomena?: string } }>(
    (v) => patch(`/teme/${v.id}`, v.patch),
    KEYS.teme,
  );

export const useDeleteTema = () =>
  useSastanciMutation<{ id: string }>((v) => del(`/teme/${v.id}`), KEYS.teme);

export const useReorderRang = () =>
  useSastanciMutation<{ items: { id: string; rang?: number | null }[] }>(
    (v) => post('/teme/reorder-rang', { items: v.items }),
    KEYS.teme,
  );

export interface DraftTemaVars {
  clientEventId: string;
  projektId: string;
  naslov: string;
  vrsta?: string;
  oblast?: string;
  opis?: string;
  prioritet?: number;
  hitno?: boolean;
  predlozioLabel?: string;
}
export const useCreateDraftTema = () =>
  useSastanciMutation<DraftTemaVars>((v) => post('/teme/draft', v), KEYS.teme);

export const useSetTemaHitno = () =>
  useSastanciMutation<{ id: string; hitno: boolean }>(
    (v) => post(`/teme/${v.id}/hitno`, { hitno: v.hitno }),
    KEYS.teme,
  );

export const useSetTemaRazmatranje = () =>
  useSastanciMutation<{ id: string; zaRazmatranje: boolean }>(
    (v) => post(`/teme/${v.id}/za-razmatranje`, { zaRazmatranje: v.zaRazmatranje }),
    KEYS.teme,
  );

export const useSetTemaAdminRang = () =>
  useSastanciMutation<{ id: string; rang?: number | null }>(
    (v) => post(`/teme/${v.id}/admin-rang`, { rang: v.rang ?? null }),
    KEYS.teme,
  );

export const useDodeliTemu = () =>
  useSastanciMutation<{ id: string; sastanakId: string }>(
    (v) => post(`/teme/${v.id}/dodeli`, { sastanakId: v.sastanakId }),
    KEYS.teme,
  );

export const useDraftReview = () =>
  useSastanciMutation<{ id: string; odluka: string; napomena?: string }>(
    (v) => post(`/teme/${v.id}/draft-review`, { odluka: v.odluka, napomena: v.napomena }),
    KEYS.teme,
  );

export const useDraftUvedi = () =>
  useSastanciMutation<{ id: string; sastanakId: string }>(
    (v) => post(`/teme/${v.id}/uvedi`, { sastanakId: v.sastanakId }),
    KEYS.teme,
  );

/* ── Šabloni ── */

export interface TemplateInput {
  naziv: string;
  tip?: string;
  mesto?: string;
  vodioEmail?: string;
  zapisnicarEmail?: string;
  cadence?: string;
  cadenceDow?: number;
  cadenceDom?: number;
  vreme?: string;
  napomena?: string;
  isActive?: boolean;
  ucesnici?: { email: string; label?: string }[];
}
export const useCreateTemplate = () =>
  useSastanciMutation<{ clientEventId: string } & TemplateInput>(
    (v) => post('/templates', v),
    KEYS.templates,
  );

export const useUpdateTemplate = () =>
  useSastanciMutation<{ id: string; patch: Partial<TemplateInput> }>(
    (v) => patch(`/templates/${v.id}`, v.patch),
    KEYS.templates,
  );

export const useDeleteTemplate = () =>
  useSastanciMutation<{ id: string }>((v) => del(`/templates/${v.id}`), KEYS.templates);

/** Instanciraj šablon (nextOccurrence u BE) → kreira sastanak (BE vraća samo id+datum). */
export const useInstantiateTemplate = () =>
  useSastanciMutation<{ id: string; clientEventId: string }, TxResponse<{ id: string; datum: string }>>(
    (v) => post<{ id: string; datum: string }>(`/templates/${v.id}/instantiate`, { clientEventId: v.clientEventId }),
  );

/* ── Slike (multipart upload / meta patch / delete) ── */

export const useUploadSlika = () =>
  useSastanciMutation<{ id: string; file: File | Blob; aktivnostId?: string; caption?: string }>(
    (v) => {
      const fd = new FormData();
      fd.append('file', v.file, v.file instanceof File ? v.file.name : 'slika.jpg');
      if (v.aktivnostId) fd.append('aktivnostId', v.aktivnostId);
      if (v.caption) fd.append('caption', v.caption);
      return apiUpload<TxResponse<Slika>>(`${BASE}/${v.id}/slike`, fd);
    },
  );

export const useUpdateSlika = () =>
  useSastanciMutation<{ slikaId: string; caption?: string; redosled?: number }>((v) =>
    patch(`/slike/${v.slikaId}`, { caption: v.caption, redosled: v.redosled }),
  );

export const useDeleteSlika = () =>
  useSastanciMutation<{ slikaId: string }>((v) => del(`/slike/${v.slikaId}`));

/* ── Arhiva PDF (multipart upload; path paritet {id}/{ts}_zapisnik.pdf u BE) ── */

export const useUploadArhivaPdf = () =>
  useSastanciMutation<
    // requireArhiva: regen tok na ZAKLJUČANOM — arhiva red MORA biti pogođen
    // (BE: 0 redova = 403 umesto tihog 200 sa starim PDF-om). Lock tok NE šalje
    // (red nastaje tek u lock RPC-u pa je 0 tamo legitimno).
    { id: string; blob: Blob; clientEventId?: string; requireArhiva?: boolean },
    TxResponse<{ storagePath: string; arhivaUpdated: boolean }>
  >(
    (v) => {
      const fd = new FormData();
      fd.append('file', v.blob, `${v.id}_zapisnik.pdf`);
      if (v.clientEventId) fd.append('clientEventId', v.clientEventId);
      if (v.requireArhiva) fd.append('requireArhiva', 'true');
      return apiUpload<TxResponse<{ storagePath: string; arhivaUpdated: boolean }>>(`${BASE}/${v.id}/arhiva/pdf`, fd);
    },
  );

/* ── Sedmični (weekly_move gate = DB tabela; FE samo prosleđuje) ── */

export const useWeeklyPomeri = () =>
  useSastanciMutation<{ datum: string; vreme?: string }>(
    (v) => post('/weekly/pomeri', v),
    KEYS.all,
  );

export const useWeeklyOdlozi = () =>
  useSastanciMutation<{ weekMonday?: string; reason?: string }>((v) => post('/weekly/odlozi', v));

export const useWeeklyVrati = () =>
  useSastanciMutation<{ weekMonday?: string }>((v) => post('/weekly/vrati', v));

/* ── Prefs / AI model ── */

export const useUpdatePrefs = () =>
  useSastanciMutation<Partial<Omit<Prefs, 'email'>>>((v) => patch('/prefs', v), KEYS.prefs);

export const useSetAiModel = () =>
  useSastanciMutation<{ model: string }>((v) => put('/ai-model', { model: v.model }), KEYS.aiModel);

/* ── AI rezime zapisnika (Sažmi) — model iz sastanci_ai_settings ── */

export interface AiSummaryResult {
  summary: string;
  model: string;
  usage?: unknown;
}
export function aiSummary(id: string, sastanak: Record<string, unknown>): Promise<{ data: AiSummaryResult }> {
  return apiFetch<{ data: AiSummaryResult }>(`${BASE}/${id}/ai-summary`, {
    method: 'POST',
    body: JSON.stringify({ sastanak }),
  });
}
