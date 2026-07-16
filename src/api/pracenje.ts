'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

// ============================================================================
// Praćenje proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3). Data sloj:
// TanStack Query hooks nad NestJS `/v1/pracenje/*`. Većina čitanja su DEFINER/wrapper
// RPC-ovi koji vraćaju jsonb (portfolio/predmeti/podsklopovi/izvestaj/rn/operativni-plan)
// — tipizovano permisivno (poznata polja + index-potpis), verno 1.0 RPC izlazu.
// Šifarnici (odeljenja/radnici/akcione-tacke), prijave i plan-prioritet su raw redovi.
// Mutacije = jsonb RPC-ovi; scope/manage/prioritet odluka presuđuje sy15 kroz withUserRls.
// „Realtime" = polling na 30 s (paritet 1.0). Polling se radi u UI-ju (refetchInterval).
// ============================================================================

const BASE = '/v1/pracenje';

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

// ------------------------------------------------------------------ tipovi (permisivni; jsonb RPC izlaz)

export interface PortfolioItem {
  predmet_item_id?: number;
  broj_predmeta?: string;
  naziv_predmeta?: string;
  komitent?: string | null;
  status?: string | null;
  op_pct?: number | null;
  dani_do_roka?: number | null;
  count_kasni?: number | null;
  usko_grlo?: string | null;
  problemi?: string | null;
  bez_podataka?: boolean;
  sort_priority?: number | null;
  [k: string]: unknown;
}
export interface Portfolio {
  kpi?: Record<string, unknown>;
  items?: PortfolioItem[];
  generated_at?: string;
  lot_qty?: number;
  [k: string]: unknown;
}

export interface PredmetRow {
  predmet_item_id?: number;
  broj_predmeta?: string;
  naziv_predmeta?: string | null;
  komitent?: string | null;
  status?: string | null;
  rok_zavrsetka?: string | null;
  root_rn_id?: number | string | null;
  redni_broj?: number | string | null;
  [k: string]: unknown;
}

/** get_aktivni_predmeti vraća niz ILI { predmeti:[…] } — normalizuj. */
export function normalizePredmeti(data: unknown): PredmetRow[] {
  if (Array.isArray(data)) return data as PredmetRow[];
  if (data && typeof data === 'object' && Array.isArray((data as { predmeti?: unknown }).predmeti)) {
    return (data as { predmeti: PredmetRow[] }).predmeti;
  }
  return [];
}

export interface IzvestajRow {
  node_id?: string;
  rn_id?: string | null;
  rn_broj?: string | null;
  ident_broj?: string | null;
  naziv_pozicije?: string | null;
  naziv_dela?: string | null;
  level?: number;
  broj_crteza?: string | null;
  crtez_drawing_no?: string | null;
  has_crtez_file?: boolean;
  sklop_drawing_no?: string | null;
  broj_sklopnog_crteza?: string | null;
  has_skop_crtez_file?: boolean;
  materijal?: string | null;
  dimenzije?: string | null;
  lansirana_kolicina?: number | null;
  zavrsena_kolicina?: number | null;
  required_for_lot?: number | null;
  kompletirano_za_lot?: number | null;
  raspolozivo_za_montazu?: number | null;
  masinska_obrada_status?: string | null;
  povrsinska_zastita_status?: string | null;
  masinska_done_override?: boolean | null;
  povrsinska_done_override?: boolean | null;
  status_override?: string | null;
  has_parent_override?: boolean;
  parent_override_rn_id?: number | string | null;
  parent_node_id?: number | string | null;
  korisnicka_napomena?: string | null;
  sistemska_napomena?: string | null;
  datum_lansiranja_tp?: string | null;
  datum_izrade?: string | null;
  raspolozivo?: number | null;
  statusi?: PracenjeStatusi;
  operations?: PracenjeOperacija[];
  [k: string]: unknown;
}

/** Bitovi problema po redu (get_predmet_pracenje_izvestaj → r.statusi). */
export interface PracenjeStatusi {
  kasni?: boolean;
  nema_tp?: boolean;
  nema_crtez?: boolean;
  nema_zavrsnu_kontrolu?: boolean;
  nije_kompletirano?: boolean;
  nema_rn?: boolean;
  [k: string]: unknown;
}

/** Operacija reda (podtabela expand + matrični prikaz + izvozi). */
export interface PracenjeOperacija {
  redosled?: number | string | null;
  naziv?: string | null;
  masina?: string | null;
  opis_rada?: string | null;
  alat_pribor?: string | null;
  planned_qty?: number | null;
  completed_qty?: number | null;
  completed_at?: string | null;
  kontrola_status?: string | null;
  is_final_control?: boolean;
  [k: string]: unknown;
}

export interface IzvestajPredmet {
  broj_predmeta?: string | null;
  naziv_predmeta?: string | null;
  komitent?: string | null;
  rok_zavrsetka?: string | null;
  [k: string]: unknown;
}
export interface IzvestajRoot {
  node_id?: number | string | null;
  naziv?: string | null;
  [k: string]: unknown;
}
export interface IzvestajSummary {
  total_rows?: number | null;
  total_lansirano?: number | null;
  total_zavrseno?: number | null;
  [k: string]: unknown;
}
export interface IzvestajResult {
  rows?: IzvestajRow[];
  predmet?: IzvestajPredmet;
  root?: IzvestajRoot | null;
  root_rn?: number | string | null;
  summary?: IzvestajSummary;
  lot_qty?: number;
  generated_at?: string | null;
  [k: string]: unknown;
}
export function normalizeIzvestaj(data: unknown): IzvestajRow[] {
  if (Array.isArray(data)) return data as IzvestajRow[];
  if (data && typeof data === 'object' && Array.isArray((data as IzvestajResult).rows)) {
    return (data as IzvestajResult).rows!;
  }
  return [];
}
/** Pun izveštaj (rows + predmet/root/summary/generated_at) — za zaglavlje, footer i izvoze. */
export function normalizeIzvestajResult(data: unknown): IzvestajResult {
  if (Array.isArray(data)) return { rows: data as IzvestajRow[] };
  if (data && typeof data === 'object') return data as IzvestajResult;
  return { rows: [] };
}

/** Podsklopovi (stablo RN-ova predmeta) → ravna lista za Opseg select. */
export interface PodsklopNode {
  rn_id?: number | string | null;
  ident_broj?: string | null;
  naziv_dela?: string | null;
  [k: string]: unknown;
}
export function normalizePodsklopovi(data: unknown): PodsklopNode[] {
  if (Array.isArray(data)) return data as PodsklopNode[];
  if (data && typeof data === 'object') {
    const o = data as { podsklopovi?: unknown; nodes?: unknown; rows?: unknown };
    for (const key of ['podsklopovi', 'nodes', 'rows'] as const) {
      if (Array.isArray(o[key])) return o[key] as PodsklopNode[];
    }
  }
  return [];
}

export interface RnResult {
  source?: 'local' | 'bigtehn' | string;
  rn_id?: string | null;
  rn_broj?: string | null;
  naziv?: string | null;
  pozicije?: Array<Record<string, unknown>>;
  [k: string]: unknown;
}

export interface AktivnostRow {
  id?: string;
  naziv_aktivnosti?: string;
  odeljenje_id?: string;
  odeljenje_naziv?: string | null;
  odeljenje?: string | null;
  status?: string;
  prioritet?: string;
  rb?: number;
  opis?: string | null;
  broj_tp?: string | null;
  kolicina_text?: string | null;
  odgovoran_label?: string | null;
  odgovoran?: string | null;
  planirani_pocetak?: string | null;
  planirani_zavrsetak?: string | null;
  zavisi_od?: string | null;
  zavisi_od_text?: string | null;
  rizik_napomena?: string | null;
  rezerva_dani?: number | null;
  kasni?: boolean;
  [k: string]: unknown;
}

export interface Odeljenje {
  id: string;
  kod: string;
  naziv: string;
  boja: string | null;
  sort_order: number | null;
  aktivan: boolean;
  vodja_user_id: string | null;
  vodja_radnik_id: string | null;
}
export interface Radnik {
  id: string;
  employee_id: number | null;
  odeljenje_id: string | null;
  sifra_radnika: string | null;
  ime: string | null;
  puno_ime: string | null;
  email: string | null;
  aktivan: boolean;
}
export interface AkcionaTacka {
  id: string;
  naslov: string;
  opis: string | null;
  projekat_id: string | null;
  sastanak_id: string | null;
  effective_status: string;
  rok: string | null;
  rok_text: string | null;
  odgovoran_label: string | null;
  odgovoran_text: string | null;
}
export interface PlanPrioritet {
  ids: number[];
  max: number | null;
  prev: number[] | null;
}

export const PRACENJE_STATUS_LABELS: Record<string, string> = {
  nije_kompletirano: 'Nije kompletirano',
  nema_tp: 'Nema TP',
  nema_crtez: 'Nema crtež',
  nema_zavrsnu_kontrolu: 'Nema završnu kontrolu',
  kasni: 'Kasni',
  kompletirano: 'Kompletirano',
  u_radu: 'U radu',
  nije_zapoceto: 'Nije započeto',
};

export const AKTIVNOST_STATUS_LABELS: Record<string, string> = {
  nije_krenulo: 'Nije krenulo',
  u_toku: 'U toku',
  blokirano: 'Blokirano',
  zavrseno: 'Završeno',
};

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['pracenje'] as const,
  portfolio: ['pracenje', 'portfolio'] as const,
  predmeti: ['pracenje', 'predmeti'] as const,
  rn: (id: string) => ['pracenje', 'rn', id] as const,
  lookups: ['pracenje', 'lookups'] as const,
  planPrioritet: ['pracenje', 'plan-prioritet'] as const,
};

const POLL_MS = 30_000;

// ------------------------------------------------------------------ queries

export function usePortfolio(lotQty?: number) {
  return useQuery({
    queryKey: [...KEYS.portfolio, lotQty ?? null],
    refetchInterval: POLL_MS,
    queryFn: () => apiFetch<{ data: Portfolio | null }>(`${BASE}/portfolio${qs({ lotQty })}`),
  });
}

export function usePredmeti() {
  return useQuery({
    queryKey: KEYS.predmeti,
    refetchInterval: POLL_MS,
    queryFn: () => apiFetch<{ data: unknown }>(`${BASE}/predmeti`),
  });
}

export function usePodsklopovi(itemId: number | null) {
  return useQuery({
    queryKey: ['pracenje', 'podsklopovi', itemId],
    enabled: !!itemId,
    queryFn: () => apiFetch<{ data: unknown }>(`${BASE}/predmeti/${itemId}/podsklopovi`),
  });
}

export function usePredmetIzvestaj(itemId: number | null, rootRn?: string, lotQty?: number) {
  return useQuery({
    queryKey: ['pracenje', 'izvestaj', itemId, rootRn ?? null, lotQty ?? null],
    enabled: !!itemId,
    queryFn: () =>
      apiFetch<{ data: unknown }>(`${BASE}/predmeti/${itemId}/izvestaj${qs({ rootRn, lotQty })}`),
  });
}

export function useRn(rnId: string | null) {
  return useQuery({
    queryKey: rnId ? KEYS.rn(rnId) : ['pracenje', 'rn', 'none'],
    enabled: !!rnId,
    refetchInterval: rnId ? POLL_MS : false,
    queryFn: () => apiFetch<{ data: RnResult | null }>(`${BASE}/rn/${rnId}`),
  });
}

export function useOperativniPlan(rnId: string | null, projekat?: string) {
  return useQuery({
    queryKey: ['pracenje', 'operativni-plan', rnId, projekat ?? null],
    enabled: !!rnId,
    refetchInterval: rnId ? POLL_MS : false,
    queryFn: () =>
      apiFetch<{ data: unknown }>(`${BASE}/rn/${rnId}/operativni-plan${qs({ projekat })}`),
  });
}

export function useCanEditRn(rnId: string | null, projekat?: string) {
  return useQuery({
    queryKey: ['pracenje', 'can-edit', rnId, projekat ?? null],
    enabled: !!rnId,
    queryFn: () =>
      apiFetch<{ data: { canEdit: boolean } }>(`${BASE}/rn/${rnId}/can-edit${qs({ projekat })}`),
  });
}

export function useAktivnostIstorija(id: string | null) {
  return useQuery({
    queryKey: ['pracenje', 'istorija', id],
    enabled: !!id,
    queryFn: () =>
      apiFetch<{ data: { blokade: Array<Record<string, unknown>>; audit: Array<Record<string, unknown>> } }>(
        `${BASE}/aktivnosti/${id}/istorija`,
      ),
  });
}

export function useOdeljenja() {
  return useQuery({
    queryKey: [...KEYS.lookups, 'odeljenja'],
    queryFn: () => apiFetch<{ data: Odeljenje[] }>(`${BASE}/lookups/odeljenja`),
  });
}
export function useRadnici() {
  return useQuery({
    queryKey: [...KEYS.lookups, 'radnici'],
    queryFn: () => apiFetch<{ data: Radnik[] }>(`${BASE}/lookups/radnici`),
  });
}
export function useAkcioneTacke(projekat?: string) {
  return useQuery({
    queryKey: [...KEYS.lookups, 'akcione-tacke', projekat ?? null],
    queryFn: () => apiFetch<{ data: AkcionaTacka[] }>(`${BASE}/lookups/akcione-tacke${qs({ projekat })}`),
  });
}
export function usePlanPrioritet() {
  return useQuery({
    queryKey: KEYS.planPrioritet,
    queryFn: () => apiFetch<{ data: PlanPrioritet }>(`${BASE}/plan-prioritet`),
  });
}

/** Prijave rada: BigTehn (workOrder+op) ili lokalno (pozicija). */
export function usePrijave(params: { workOrder?: string; op?: string; machine?: string; pozicija?: string }) {
  const enabled = !!((params.workOrder && params.op) || params.pozicija);
  return useQuery({
    queryKey: ['pracenje', 'prijave', params],
    enabled,
    queryFn: () => apiFetch<{ data: unknown; meta?: { source?: string } }>(`${BASE}/prijave${qs({ ...params })}`),
  });
}

/** Pretraga delova (min 2 znaka) — otvara RN drill-down. */
export function useSearchDelovi(q: string) {
  return useQuery({
    queryKey: ['pracenje', 'search-delovi', q],
    enabled: q.trim().length >= 2,
    queryFn: () => apiFetch<{ data: Array<Record<string, unknown>> }>(`${BASE}/search-delovi${qs({ q })}`),
  });
}

/** RN resolve (broj/legacy/uuid → uuid) — imperativno (drill-down po broju). */
export function resolveRn(ref: string): Promise<{ data: { id: string } }> {
  return apiFetch<{ data: { id: string } }>(`${BASE}/rn/resolve${qs({ ref })}`);
}

export function fetchCrtezSignUrl(code: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/crtez/sign${qs({ code })}`);
}

// ------------------------------------------------------------------ mutations

function usePracenjeMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.all) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function put<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PUT', body: JSON.stringify(body) });
}

/* ── Aktivni predmeti — prioritet (admin) ── */
export const useShiftPrioritet = () =>
  usePracenjeMutation<{ itemId: number; direction: 'up' | 'down' }>(
    (v) => put(`/predmeti/${v.itemId}/prioritet`, { direction: v.direction }),
    KEYS.predmeti,
  );

/* ── Tabela praćenja — napomena / override (manage) ── */
export const useUpsertNapomena = () =>
  usePracenjeMutation<{ itemId: number; bigtehnRnId: string; note: string; rnId?: string }>((v) => {
    const { itemId, ...body } = v;
    return put(`/predmeti/${itemId}/napomena`, body);
  });

export const useUpsertOverride = () =>
  usePracenjeMutation<{
    itemId: number;
    bigtehnRnId: string;
    status?: string;
    masinska?: boolean;
    povrsinska?: boolean;
    rnId?: string;
  }>((v) => {
    const { itemId, ...body } = v;
    return put(`/predmeti/${itemId}/override`, body);
  });

export const useUpsertParentOverride = () =>
  usePracenjeMutation<{ itemId: number; bigtehnRnId: string; parentRnId?: string | null; clear?: boolean }>((v) => {
    const { itemId, ...body } = v;
    return put(`/predmeti/${itemId}/parent-override`, body);
  });

/* ── Operativni plan — aktivnosti (edit) ── */
export interface AktivnostInput {
  id?: string;
  radniNalogId?: string;
  projekatId?: string;
  odeljenjeId: string;
  nazivAktivnosti: string;
  planiraniPocetak?: string;
  planiraniZavrsetak?: string;
  odgovoranUserId?: string;
  odgovoranRadnikId?: string;
  status?: string;
  prioritet?: string;
  rb?: number;
  opis?: string;
  brojTp?: string;
  kolicinaText?: string;
  odgovoranLabel?: string;
  zavisiOdAktivnostId?: string;
  zavisiOdText?: string;
  statusMode?: string;
  rizikNapomena?: string;
  izvor?: string;
  izvorAkcioniPlanId?: string;
  izvorPozicijaId?: string;
  izvorTpOperacijaId?: string;
}
export const useUpsertAktivnost = () =>
  usePracenjeMutation<AktivnostInput, TxResponse<{ id: string | null }>>((v) => post('/aktivnosti', v));

export const useZatvoriAktivnost = () =>
  usePracenjeMutation<{ id: string; napomena?: string }>((v) => post(`/aktivnosti/${v.id}/zatvori`, { napomena: v.napomena }));
export const useBlokirajAktivnost = () =>
  usePracenjeMutation<{ id: string; razlog: string }>((v) => post(`/aktivnosti/${v.id}/blokiraj`, { razlog: v.razlog }));
export const useOdblokirajAktivnost = () =>
  usePracenjeMutation<{ id: string; napomena?: string }>((v) => post(`/aktivnosti/${v.id}/odblokiraj`, { napomena: v.napomena }));
export const usePromoteAkcionaTacka = () =>
  usePracenjeMutation<{ akcioniPlanId: string; odeljenjeId: string; rnId: string }>((v) => post('/aktivnosti/promote', v));

/* ── RN ensure (drill-down; DEFINER, svaki korisnik) ── */
export const useEnsureRn = () =>
  usePracenjeMutation<{ workOrderId: string }, TxResponse<{ id: string | null }>>((v) =>
    post('/rn/ensure-from-bigtehn', { workOrderId: v.workOrderId }),
  );

/* ── Export-log (server-side; presuda P4) ── */
export function logExport(dto: {
  tab: string;
  rnId?: string | null;
  rnBroj?: string;
  predmetItemId?: number;
  extra?: Record<string, unknown>;
}): Promise<TxResponse<{ logged: boolean }>> {
  return post<{ logged: boolean }>('/export-log', dto);
}
