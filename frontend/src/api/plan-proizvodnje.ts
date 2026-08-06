'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';
import { newClientId } from './plan-montaze';
import { toast } from '@/lib/toast';

// ============================================================================
// Plan proizvodnje — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §3). Data sloj:
// TanStack Query hooks nad NestJS `/v1/plan-proizvodnje/*`. READ = view lanac
// `v_production_operations_effective` (bigtehn keš + overlay + spremnost). Mutacije:
// overlay merge-upsert, urgency set/clear (DELETE nikad), reassign single/bulk (JEDAN
// clientEventId), auto-koop grupe (admin), skice + signed URL. BigInt id-jevi stižu kao
// STRINGOVI (jsonSafe). Row/force odluka presuđuje sy15 kroz withUserRls.
// ============================================================================

const BASE = '/v1/plan-proizvodnje';

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

/** Mašina (bigtehn_machines_cache SELECT *). rj_code je stabilan; ostalo tolerantno. */
export interface PpMachine {
  rj_code: string;
  naziv?: string | null;
  name?: string | null;
  [k: string]: unknown;
}

/**
 * Red operacije iz `v_production_operations_effective`. Poznate kolone tipizovane;
 * ostatak view-a dostupan preko index-potpisa (defensivno renderovanje).
 */
export interface OpRow {
  line_id: string;
  work_order_id: string;
  effective_machine_code: string | null;
  assigned_machine_code: string | null;
  broj_crteza: string | null;
  naziv_dela: string | null;
  rn_ident_broj: string | null;
  operacija: number | string | null;
  opis_rada: string | null;
  tpz_min: number | null;
  tk_min: number | null;
  komada_total: number | null;
  komada_done: number | null;
  real_seconds: number | null;
  rok_izrade: string | null;
  prioritet_bigtehn: number | null;
  is_non_machining: boolean | null;
  local_status: string | null;
  shift_note: string | null;
  shift_sort_order: number | null;
  cam_ready: boolean | null;
  ready_override: boolean | null;
  is_ready_for_machine: boolean | null;
  is_urgent: boolean | null;
  auto_sort_bucket: number | null;
  cooperation_status: string | null;
  cooperation_partner: string | null;
  cooperation_expected_return: string | null;
  // ── Kooperacija — izvor/RJ grupa (view v_production_operations_effective / coop endpoint).
  cooperation_source?: string | null; // 'auto' | 'manual' | 'auto+manual' | 'none'
  rj_group_code?: string | null;
  rj_group_label?: string | null;
  original_machine_name?: string | null;
  urgency_reason?: string | null;
  // ── Kolone koje BE agent PARALELNO dodaje u /operations/all SELECT (machine/dept nose ih preko SELECT *).
  //    Sve opciono (?:) da tsc/next build prođu nezavisno dok BE još nije živ.
  original_machine_code?: string | null;
  customer_short?: string | null;
  customer_name?: string | null;
  customer_id?: number | string | null;
  is_rework?: boolean | null;
  is_scrap?: boolean | null;
  rework_pieces?: number | null;
  scrap_pieces?: number | null;
  has_bigtehn_drawing?: boolean | null;
  drawings_count?: number | null;
  is_ready_manual?: boolean | null;
  ready_override_by?: string | null;
  ready_override_at?: string | null;
  previous_operation_operacija?: number | string | null;
  previous_operation_status?: string | null;
  previous_operation_machine_code?: string | null;
  is_cooperation_effective?: boolean | null;
  // ── TP modal header/log polja (tech-procedure response — header/operations/logs):
  materijal?: string | null;
  dimenzija_materijala?: string | null;
  rn_napomena?: string | null;
  rn_zavrsen?: boolean | null;
  rn_zakljucano?: boolean | null;
  is_done_in_bigtehn?: boolean | null;
  last_finished_at?: string | null;
  [k: string]: unknown;
}

/** Jedan red prijave rada (tech-procedure `logs[]` iz bigtehn_tech_routing_cache). */
export interface TechLog {
  operacija: number | string | null;
  started_at?: string | null;
  finished_at?: string | null;
  machine_code?: string | null;
  worker_id?: number | string | null;
  potpis?: string | null;
  komada?: number | null;
  prn_timer_seconds?: number | null;
  is_completed?: boolean | null;
  napomena?: string | null;
  [k: string]: unknown;
}

export interface MachineOpsResult {
  rows: OpRow[];
  has_more: boolean;
  next_work_order_offset: number;
}

export interface CoopGroup {
  rj_group_code: string;
  group_label: string;
  notes: string | null;
  added_at: string | null;
  added_by: string | null;
  removed_at: string | null;
  removed_by: string | null;
}

export interface PpDrawing {
  id: string;
  workOrderId: string;
  lineId: string;
  storagePath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  uploadedAt: string;
  uploadedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

export interface TechProcedure {
  operations: OpRow[];
  logs: TechLog[];
  header: OpRow | null;
}

/** Overlay (Prisma PpOverlay — camelCase; BigInt-i kao string). */
export interface PpOverlay {
  id: string;
  workOrderId: string;
  lineId: string;
  localStatus: string;
  shiftNote: string | null;
  shiftSortOrder: number | null;
  assignedMachineCode: string | null;
  camReady: boolean;
  readyOverride: boolean;
  cooperationStatus: string;
  cooperationPartner: string | null;
  cooperationExpectedReturn: string | null;
  [k: string]: unknown;
}

/**
 * Red gant feed-a (`/gantt`, zahtev 046/26). Auto-podaci stavke (pozicija/količina/crtež/
 * RN/faza obrade/mašina) + planirani termini + spremnost/završenost. `planned_start_at`
 * je NULL dok stavka nije stavljena na plan („Dodaj na plan") — tada nema bara na osi.
 */
export interface GanttRow {
  line_id: string;
  work_order_id: string;
  operacija: number | string | null;
  opis_rada: string | null;
  effective_machine_code: string | null;
  original_machine_code: string | null;
  original_machine_name: string | null;
  /** Iz ručnog šifrarnika hala; null = grupa „Bez hale". */
  hall: string | null;
  rn_ident_broj: string | null;
  broj_crteza: string | null;
  /**
   * 079/26 — postoji li PDF crteža u PDM kešu (`bigtehn_drawings`). Opciona (`?:`) da
   * FE preživi stariji BE odgovor bez kolone (CF frontend deploy je nezavisan od BE);
   * `undefined` se tumači kao „možda ima" (link se nudi, promašaj javlja toast), a
   * `false` kao „nema" (broj crteža ostaje običan tekst) — isti obrazac kao TP modal.
   */
  has_bigtehn_drawing?: boolean | null;
  naziv_dela: string | null;
  materijal: string | null;
  komada_total: number | null;
  /** Zbir SVIH kvaliteta („koliko je otkucano"). */
  komada_done: number | null;
  // ── 069/26: gotovost se sudi po DOBRIM komadima, pa gant mora i da ih pokaže.
  //    Opciona (`?:`) da FE preživi stariji BE odgovor bez ovih kolona (CF deploy je nezavisan).
  /** Samo DOBRI komadi (bez dorade i škarta) — brojač po kom se sudi gotovost. */
  komada_done_good?: number | null;
  scrap_pieces?: number | null;
  rework_pieces?: number | null;
  /** Ima škarta, a dobrih komada još nema dovoljno → oznaka „ŠKART" umesto kvačice. */
  scrap_outstanding?: boolean | null;
  rok_izrade: string | null;
  tpz_min: number | null;
  tk_min: number | null;
  /** COALESCE(override, TPZ + TK × komada) u minutima. */
  effective_duration_minutes: number | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  planned_duration_minutes: number | null;
  /** Tri-state override: null = auto iz kucanja operatera. */
  planned_done: boolean | null;
  planned_done_at: string | null;
  planned_done_by: string | null;
  /**
   * Gotovost pozicije: `COALESCE(planned_done, AUTO)` gde je AUTO = 069/26 pravilo
   * (DOBRIH komada ≥ plan; zastavica kioska samo kad količina nije merljiva). Čitaju je
   * checkbox „Završeno" i boja bara. Kanon: `IS_COMPLETED_EFFECTIVE` na backendu,
   * ogledalo `autoDone()` ispod.
   */
  is_completed_effective: boolean | null;
  predecessor_work_order_id: string | null;
  predecessor_line: string | null;
  is_ready_for_machine: boolean | null;
  is_ready_manual: boolean | null;
  // ── Pečat ručnog override-a spremnosti (046/26 Paket B — dijalog prikazuje ko/kada).
  //    Opciona (`?:`) da FE preživi i stariji BE odgovor bez ovih kolona.
  ready_override_at?: string | null;
  ready_override_by?: string | null;
  previous_operation_status: string | null;
  previous_operation_operacija: number | string | null;
  previous_operation_machine_code: string | null;
  local_status: string | null;
  shift_sort_order: number | null;
  shift_note: string | null;
  is_urgent: boolean | null;
  urgency_reason: string | null;
  is_non_machining: boolean | null;
  customer_short: string | null;
  customer_name: string | null;
  is_done_in_bigtehn: boolean | null;
  // ── Picker status polja (046/26-A4, `scope=sve` pretraga) — opciona (`?:`) da FE
  //    preživi i stariji BE odgovor bez ovih kolona (CF frontend deploy je nezavisan).
  rn_zavrsen?: boolean | null;
  is_cooperation_effective?: boolean | null;
  overlay_archived_at?: string | null;
  /** RN prošao završnu kontrolu (M6) — scope=sve skida EFF_FILTER pa FE mora razlog. */
  plan_rn_final_control_done?: boolean | null;
  // ── Kolona „Sklop" (046/26-C2) — efektivni DIREKTNI roditelj po 053 strukturi
  //    praćenja (override → auto sastavnica). Opciona (`?:`) da FE preživi stariji BE.
  /** work_orders.id roditelja ili NEGATIVAN id virtuelnog sklopa; null = bez sklopa. */
  sklop_node_id?: number | string | null;
  /** Naziv sklopa: part_name roditeljskog RN-a / naziv virtuelnog sklopa. */
  sklop_naziv?: string | null;
  /** Ident broj roditeljskog RN-a (null za virtuelni sklop). */
  sklop_rn_ident?: string | null;
  [k: string]: unknown;
}

/** Red šifrarnika hala — SVE mašine iz `operations`, `hall` null kad dodela ne postoji. */
export interface MachineHallRow {
  machine_code: string;
  machine_name: string | null;
  hall: string | null;
  sort_order: number | null;
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Deljeni ključ otvorene operacije. */
export function opKey(o: { work_order_id: string; line_id: string }): string {
  return `${o.work_order_id}:${o.line_id}`;
}

/**
 * 069/26 — FE OGLEDALO automatske gotovosti. BE kanon je `IS_COMPLETED_EFFECTIVE`
 * (`plan-proizvodnje-read.service.ts`): broje se SAMO DOBRI komadi, a zastavica sa
 * kioska (`is_done_in_bigtehn`) vredi jedino kad količina nije merljiva — prazan/nula
 * plan ili operacija bez procesa (opšti nalozi, gde se komadi i ne kucaju).
 *
 * Služi ISKLJUČIVO optimističkom prikazu: kad planer skine svoj ručni override
 * („Završeno" nazad na auto = `planned_done: null`), red mora odmah da pokaže ono što
 * će BE vratiti. Bez toga kvačica trepne u pogrešno stanje do sledećeg mrežnog kruga.
 *
 * ⚠️ Promeni li se BE pravilo, MORA i ovde. Dve grane iste formule su već jednom
 * proizvele isti bug dvaput (numeracija RN-a, 030/26) — zato je ovo jedini FE račun
 * gotovosti; `gant-utils` ga samo re-eksportuje (isti obrazac kao `rowKey = opKey`).
 */
export function autoDone(row: GanttRow): boolean {
  const plan = row.komada_total;
  if (plan != null && plan > 0 && row.is_non_machining !== true) {
    return (row.komada_done_good ?? 0) >= plan;
  }
  return row.is_done_in_bigtehn === true;
}

/**
 * 069/26 (Strahinja) — „umesto štiklirano da je gotovo, da piše škart": pozicija ima
 * škarta, a DOBRIH komada još nema dovoljno. Oznaka nestaje SAMA čim se škart
 * nadoknadi ili planer ručno presudi da je gotovo. BE ogledalo: `scrap_outstanding`.
 */
export function scrapOutstanding(row: GanttRow, done: boolean): boolean {
  return (row.scrap_pieces ?? 0) > 0 && !done;
}

/**
 * Nosi li red oznaku „ŠKART" — BE kolona kad je ima, inače isti FE račun (stariji BE
 * odgovor nema kolonu; tada `scrap_pieces` fali pa oznaka izostane, što je siguran smer).
 */
export function scrapBadge(row: GanttRow): boolean {
  return row.scrap_outstanding ?? scrapOutstanding(row, row.is_completed_effective === true);
}

/** Objašnjenje oznake škarta (tooltip): koliko je bačeno i koliko dobrih fali do plana. */
export function scrapText(row: GanttRow): string {
  const fali = Math.max(0, (row.komada_total ?? 0) - (row.komada_done_good ?? 0));
  return `Škart ${row.scrap_pieces ?? 0} kom — nedostaje ${fali} dobrih do plana`;
}

export const PP_STATUS_LABELS: Record<string, string> = {
  waiting: 'Čeka',
  in_progress: 'U radu',
  blocked: 'Blokirano',
  completed: 'Završeno',
};

// ------------------------------------------------------------------ query keys

const KEYS = {
  all: ['pp'] as const,
  machines: ['pp', 'machines'] as const,
  operations: ['pp', 'operations'] as const,
  cooperation: ['pp', 'cooperation'] as const,
  coopGroups: ['pp', 'coop-groups'] as const,
  drawings: ['pp', 'drawings'] as const,
  audit: ['pp', 'audit'] as const,
  gantt: ['pp', 'gantt'] as const,
  halls: ['pp', 'halls'] as const,
};

// ------------------------------------------------------------------ queries

export function useMachines() {
  return useQuery({
    queryKey: KEYS.machines,
    queryFn: () => apiFetch<{ data: PpMachine[] }>(`${BASE}/machines`),
  });
}

/** Red operacija po mašini (RPC paginacija) — vraća { rows, has_more, next_… }. */
export function useMachineOperations(machine: string | null, offset = 0, limit = 100, q = '') {
  const term = q.trim();
  return useQuery({
    queryKey: [...KEYS.operations, 'machine', machine, offset, limit, term],
    enabled: !!machine,
    queryFn: () =>
      apiFetch<{ data: MachineOpsResult }>(
        `${BASE}/operations${qs({ machine: machine ?? '', offset, limit, q: term || undefined })}`,
      ),
  });
}

/** Broj RN-a po strani za „Još RN" paginaciju (paritet 1.0 PLAN_PP_MACHINE_WO_PAGE). */
export const MACHINE_WO_PAGE = 100;

/**
 * Red operacija po mašini SA akumulacijom stranica (GAP-PM-02 „Još RN"). Prva strana
 * kroz TanStack Query (keš = KEYS.operations 'machine' machine — deli ga optimistički
 * reorder/patch sloj). `loadMore()` dovlači sledećih do 100 RN i MERGE-uje ih u isti keš
 * (append + re-sort BE-a je već primenjen po strani, pa je append dovoljan uz stabilan
 * BE redosled prioriteta). Vraća { rows, hasMore, loadMore, loadingMore, ...query }.
 */
export function useMachineOperationsAccum(machine: string | null, q = '') {
  const qc = useQueryClient();
  const [loadingMore, setLoadingMore] = useState(false);
  // 040/26: crtež/RN filter je sad SERVER-side (u ključu + URL-u), pa „Još RN" paginacija
  // radi i nad filtriranim skupom (crtež iza prvih 100 RN). Prazan term = ceo red mašine.
  const term = q.trim();
  const key = [...KEYS.operations, 'machine', machine, 0, MACHINE_WO_PAGE, term] as const;

  const query = useQuery({
    queryKey: key,
    enabled: !!machine,
    queryFn: () =>
      apiFetch<{ data: MachineOpsResult }>(
        `${BASE}/operations${qs({ machine: machine ?? '', offset: 0, limit: MACHINE_WO_PAGE, q: term || undefined })}`,
      ),
  });

  const result = query.data?.data;
  const rows = result?.rows ?? [];
  const hasMore = !!result?.has_more;

  const loadMore = useCallback(async () => {
    if (!machine || !result?.has_more || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await apiFetch<{ data: MachineOpsResult }>(
        `${BASE}/operations${qs({ machine, offset: result.next_work_order_offset, limit: MACHINE_WO_PAGE, q: term || undefined })}`,
      );
      const cur = qc.getQueryData<{ data: MachineOpsResult }>(key);
      const curRows = cur?.data.rows ?? rows;
      const seen = new Set(curRows.map((o) => `${o.work_order_id}:${o.line_id}`));
      const merged = [...curRows, ...next.data.rows.filter((o) => !seen.has(`${o.work_order_id}:${o.line_id}`))];
      qc.setQueryData(key, {
        data: { rows: merged, has_more: next.data.has_more, next_work_order_offset: next.data.next_work_order_offset },
      });
    } finally {
      setLoadingMore(false);
    }
  }, [machine, result, rows, loadingMore, qc, key, term]);

  return { rows, hasMore, loadMore, loadingMore, isLoading: query.isLoading, isError: query.isError, isFetching: query.isFetching, refetch: query.refetch };
}

/** Red operacija po odeljenju (view rows). */
export function useDeptOperations(dept: string | null) {
  return useQuery({
    queryKey: [...KEYS.operations, 'dept', dept],
    enabled: !!dept,
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/operations${qs({ dept: dept ?? '' })}`),
  });
}

/** Sve otvorene operacije (agregat) + meta { total, truncated, limit }. */
export function useAllOperations(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.operations, 'all'],
    enabled,
    queryFn: () =>
      apiFetch<{ data: OpRow[]; meta: { total: number; truncated: boolean; limit: number } }>(
        `${BASE}/operations/all`,
      ),
  });
}

export function useOperationsSearch(q: string) {
  return useQuery({
    queryKey: [...KEYS.operations, 'search', q],
    enabled: q.trim().length >= 2,
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/operations/search${qs({ q })}`),
  });
}

/* ── Gant (046/26) ── */

/** Gant feed (otvorene operacije + sve već isplanirane stavke). `hall='-'` = „Bez hale". */
export function useGantt(
  filters: { hall?: string; machine?: string; q?: string; sort?: 'termin' | 'rucni' } = {},
) {
  const term = (filters.q ?? '').trim();
  // 070/26: `sort` je DEO KLJUČA — feed se seče na BE strani (`LIMIT`) po BE poretku, pa
  // svaki režim mora imati svoj keš (deljen keš bi crtao rez napravljen u drugom režimu).
  // `termin` je podrazumevano i NE šalje parametar — stari URL, stari (današnji) odgovor.
  const sort = filters.sort === 'rucni' ? 'rucni' : 'termin';
  return useQuery({
    queryKey: [...KEYS.gantt, filters.hall ?? '', filters.machine ?? '', term, sort],
    queryFn: () =>
      apiFetch<{ data: GanttRow[]; meta: { limit: number; truncated: boolean } }>(
        `${BASE}/gantt${qs({
          hall: filters.hall,
          machine: filters.machine,
          q: term || undefined,
          sort: sort === 'rucni' ? 'rucni' : undefined,
        })}`,
      ),
  });
}

/**
 * Server-side pretraga za picker „Dodaj na plan" (046/26-A4). Gant feed je trunciran na
 * 5000 redova (prod: 16.394 kandidata) i sužen aktivnim filterima taba, pa je klijentska
 * pretraga tiho promašivala otvorene operacije. `scope=sve` traži po CELOJ bazi i vraća
 * i završene/zatvorene/kooperaciju — picker ih prikazuje sa razlogom umesto da ih krije.
 * Ključ počinje sa KEYS.gantt da optimistički patch `useGanttOverlay` pogodi i ovaj keš.
 */
export function useGanttSearchAll(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: [...KEYS.gantt, 'sve', term],
    enabled: term.length >= 2,
    queryFn: () =>
      apiFetch<{ data: GanttRow[]; meta: { limit: number; truncated: boolean } }>(
        `${BASE}/gantt${qs({ q: term, scope: 'sve' })}`,
      ),
  });
}

/** Šifrarnik hala — sve mašine + dodeljena hala (null = nije dodeljena). */
export function useMachineHalls() {
  return useQuery({
    queryKey: KEYS.halls,
    queryFn: () => apiFetch<{ data: MachineHallRow[] }>(`${BASE}/halls`),
  });
}

export function useCooperation(q = '') {
  return useQuery({
    queryKey: [...KEYS.cooperation, q],
    queryFn: () => apiFetch<{ data: OpRow[] }>(`${BASE}/cooperation${qs({ q })}`),
  });
}

export function useCooperationGroups() {
  return useQuery({
    queryKey: KEYS.coopGroups,
    queryFn: () => apiFetch<{ data: CoopGroup[] }>(`${BASE}/cooperation/groups`),
  });
}

export function useReassignAudit(enabled = true) {
  return useQuery({
    queryKey: KEYS.audit,
    enabled,
    retry: false,
    queryFn: () => apiFetch<{ data: Array<Record<string, unknown>> }>(`${BASE}/reassign/audit`),
  });
}

export function useDrawings(workOrder: string | null, line: string | null) {
  return useQuery({
    queryKey: [...KEYS.drawings, workOrder, line],
    enabled: !!workOrder && !!line,
    queryFn: () => apiFetch<{ data: PpDrawing[] }>(`${BASE}/drawings${qs({ workOrder: workOrder!, line: line! })}`),
  });
}

export function useTechProcedure(workOrderId: string | null) {
  return useQuery({
    queryKey: ['pp', 'tech-procedure', workOrderId],
    enabled: !!workOrderId,
    queryFn: () => apiFetch<{ data: TechProcedure }>(`${BASE}/tech-procedure/${workOrderId}`),
  });
}

export function fetchDrawingSignUrl(id: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/drawings/${id}/sign`);
}
export function fetchBigtehnDrawingSignUrl(code: string): Promise<{ data: SignedUrl }> {
  return apiFetch<{ data: SignedUrl }>(`${BASE}/drawings/bigtehn/sign${qs({ code })}`);
}

// ------------------------------------------------------------------ mutations

function usePpMutation<V, R = unknown>(fn: (v: V) => Promise<R>, invalidate: readonly unknown[] = KEYS.operations) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimistički obrazac (GAP-PM-20): onMutate patch keširanih OpRow[] + rollback na
// grešku (toast ⚠) + toast ✓ na uspeh. Namena — inline akcije u OpsTable (status,
// hitno, pin, CAM, spremnost, napomena, kooperacija, redosled).
// ─────────────────────────────────────────────────────────────────────────────

/** Ključ otvorene operacije za poređenje u optimističkom patch-u. */
type OpId = { workOrderId: string; lineId: string };

/** Prođi kroz sve keširane operations-liste ({rows}|OpRow[]|search) i patch-uj redove. */
function patchCachedOps(qc: QueryClient, match: (o: OpRow) => boolean, apply: (o: OpRow) => OpRow): void {
  const caches = qc.getQueriesData<unknown>({ queryKey: KEYS.operations });
  for (const [key, data] of caches) {
    if (!data || typeof data !== 'object') continue;
    const d = data as { data?: unknown };
    const payload = d.data;
    if (Array.isArray(payload)) {
      qc.setQueryData(key, { ...d, data: (payload as OpRow[]).map((o) => (match(o) ? apply(o) : o)) });
    } else if (payload && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)) {
      const inner = payload as { rows: OpRow[] };
      qc.setQueryData(key, { ...d, data: { ...inner, rows: inner.rows.map((o) => (match(o) ? apply(o) : o)) } });
    }
  }
}

/**
 * Optimistička mutacija sa lokalnim patch-om OpRow-a. `optimistic(v)` vraća delimičan
 * patch koji se primenjuje na red čiji su work_order_id/line_id u `ids(v)`.
 */
function useOptimisticOpMutation<V, R = unknown>(
  fn: (v: V) => Promise<R>,
  ids: (v: V) => OpId,
  optimistic: (v: V) => Partial<OpRow>,
  msgs?: { ok?: string; err?: string },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (v: V) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      const id = ids(v);
      const patch = optimistic(v);
      patchCachedOps(
        qc,
        (o) => o.work_order_id === id.workOrderId && o.line_id === id.lineId,
        (o) => ({ ...o, ...patch }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast(`⚠ ${msgs?.err ?? 'Nije sačuvano — osvežavam.'}`);
    },
    onSuccess: () => {
      if (msgs?.ok) toast(`✓ ${msgs.ok}`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.operations }),
  });
}

function post<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}
function put<T = unknown>(path: string, body?: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
}
function patch<T = unknown>(path: string, body: object): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });
}
function del<T = unknown>(path: string): Promise<TxResponse<T>> {
  return apiFetch<TxResponse<T>>(`${BASE}${path}`, { method: 'DELETE' });
}

/* ── Overlay (merge patch) ── */

export interface OverlayPatch {
  workOrderId: string;
  lineId: string;
  localStatus?: string;
  shiftNote?: string | null;
  shiftSortOrder?: number | null;
  assignedMachineCode?: string | null;
  camReady?: boolean;
  readyOverride?: boolean;
  cooperationStatus?: string;
  cooperationPartner?: string | null;
  cooperationExpectedReturn?: string | null;
  // ── Gant (046/26). undefined = ne diraj, null = obriši.
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  plannedDurationMinutes?: number | null;
  plannedDone?: boolean | null;
  predecessorWorkOrderId?: string | null;
  predecessorLine?: string | null;
}
export const useUpsertOverlay = () =>
  usePpMutation<OverlayPatch, TxResponse<PpOverlay>>((v) => post<PpOverlay>('/overlays', v));

/**
 * Optimistički overlay upsert za inline akcije u tabeli (GAP-PM-20). Patch mapira
 * camelCase overlay polja na snake_case view kolone da lokalni prikaz odmah reaguje.
 */
export const useOptimisticOverlay = (msgs?: { ok?: string; err?: string }) =>
  useOptimisticOpMutation<OverlayPatch, TxResponse<PpOverlay>>(
    (v) => post<PpOverlay>('/overlays', v),
    (v) => ({ workOrderId: v.workOrderId, lineId: v.lineId }),
    (v) => {
      const p: Partial<OpRow> = {};
      if (v.localStatus !== undefined) p.local_status = v.localStatus;
      if (v.shiftNote !== undefined) p.shift_note = v.shiftNote;
      if (v.shiftSortOrder !== undefined) p.shift_sort_order = v.shiftSortOrder;
      if (v.assignedMachineCode !== undefined) p.assigned_machine_code = v.assignedMachineCode;
      if (v.camReady !== undefined) p.cam_ready = v.camReady;
      if (v.readyOverride !== undefined) p.ready_override = v.readyOverride;
      if (v.cooperationStatus !== undefined) p.cooperation_status = v.cooperationStatus;
      if (v.cooperationPartner !== undefined) p.cooperation_partner = v.cooperationPartner;
      if (v.cooperationExpectedReturn !== undefined) p.cooperation_expected_return = v.cooperationExpectedReturn;
      return p;
    },
    msgs,
  );

/**
 * Overlay upsert IZ GANTA (046/26) — optimistički patch keširanih `GanttRow[]` lista
 * (drag bara/resize/popover mora da odgovori odmah, mreža stiže posle). Rollback + ⚠ toast
 * na grešku; `onSettled` invalidira gant (i „operations", jer mašina/spremnost mogu da se
 * promene iz istog popovera).
 */
export const useGanttOverlay = (msgs?: {
  ok?: string;
  /** Funkcija dobija grešku i sme da vrati konkretan razlog (npr. prevod BE 422 koda). */
  err?: string | ((e: unknown) => string | null | undefined);
}) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: OverlayPatch) => post<PpOverlay>('/overlays', v),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.gantt });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.gantt }).map(([k, d]) => [k, d] as const);
      const p: Partial<GanttRow> = {};
      if (v.plannedStartAt !== undefined) p.planned_start_at = v.plannedStartAt;
      if (v.plannedEndAt !== undefined) p.planned_end_at = v.plannedEndAt;
      if (v.plannedDurationMinutes !== undefined) p.planned_duration_minutes = v.plannedDurationMinutes;
      if (v.plannedDone !== undefined) p.planned_done = v.plannedDone;
      if (v.assignedMachineCode !== undefined) p.effective_machine_code = v.assignedMachineCode;
      if (v.readyOverride !== undefined) p.is_ready_manual = v.readyOverride;
      if (v.shiftNote !== undefined) p.shift_note = v.shiftNote;
      if (v.predecessorWorkOrderId !== undefined) p.predecessor_work_order_id = v.predecessorWorkOrderId;
      if (v.predecessorLine !== undefined) p.predecessor_line = v.predecessorLine;
      for (const [key, data] of qc.getQueriesData<unknown>({ queryKey: KEYS.gantt })) {
        const d = data as { data?: GanttRow[] } | undefined;
        if (!d || !Array.isArray(d.data)) continue;
        qc.setQueryData(key, {
          ...d,
          data: d.data.map((r) => {
            if (!(r.work_order_id === v.workOrderId && r.line_id === v.lineId)) return r;
            const next = { ...r, ...p };
            // `is_completed_effective` je BE izvedeno polje (COALESCE(planned_done,
            // AUTO)) koje čitaju i checkbox „Završeno" i boja bara — bez ovog koraka
            // klik izgleda mrtvo dok ne prođe mrežni krug. AUTO grana je 069/26
            // pravilo (dobri komadi ≥ plan), pa mora kroz `autoDone` — ne kroz sirovu
            // zastavicu kioska, inače skidanje override-a nakratko pokaže tuđu istinu.
            if (v.plannedDone !== undefined) {
              const done = v.plannedDone ?? autoDone(r);
              next.is_completed_effective = done;
              // Oznaka „ŠKART" je izvedena iz iste gotovosti — mora da prati u istom
              // koraku, da bar ne ostane sa ✓ i oznakom istovremeno.
              next.scrap_outstanding = scrapOutstanding(r, done);
            }
            // `is_ready_for_machine` je takođe BE izvedeno (override OR prethodne
            // operacije završene) — bedž spremnosti i boja bara moraju da reaguju odmah.
            // Izračunata grana = FE ogledalo `is_ready_rb`: 'none' | 'completed'.
            if (v.readyOverride !== undefined) {
              next.is_ready_for_machine =
                v.readyOverride ||
                r.previous_operation_status === 'none' ||
                r.previous_operation_status === 'completed';
            }
            return next;
          }),
        });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      const razlog = typeof msgs?.err === 'function' ? msgs.err(e) : msgs?.err;
      toast(`⚠ ${razlog || 'Nije sačuvano — osvežavam.'}`);
    },
    onSuccess: () => {
      if (msgs?.ok) toast(`✓ ${msgs.ok}`);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEYS.gantt });
      void qc.invalidateQueries({ queryKey: KEYS.operations });
    },
  });
};

/**
 * Promena mašine IZ GANTA (046/26). Ide kroz postojeći `/reassign` (a NE direktno na
 * `assignedMachineCode`) da bi ostao na snazi guard grupe mašina + audit; prelaz u drugu
 * grupu i dalje traži force iz taba „Po mašini" (422 `machine_group_mismatch`).
 */
export const useGanttReassign = () =>
  usePpMutation<ReassignVars>((v) => post('/reassign', { clientEventId: newClientId(), ...v }), KEYS.all);

/* ── Šifrarnik hala (046/26) ── */

export const useUpsertMachineHall = () =>
  usePpMutation<{ machineCode: string; hall: string; sortOrder?: number | null; note?: string | null }>(
    (v) => {
      const { machineCode, ...body } = v;
      return put(`/halls/${encodeURIComponent(machineCode)}`, body);
    },
    // Hala menja GRUPISANJE ganta, ne samo šifarnik → invalidiraj ceo `pp` prostor.
    KEYS.all,
  );

export const useDeleteMachineHall = () =>
  usePpMutation<{ machineCode: string }>(
    (v) => del(`/halls/${encodeURIComponent(v.machineCode)}`),
    KEYS.all,
  );

export const useReorderOverlays = () =>
  usePpMutation<{ items: { workOrderId: string; lineId: string }[] }>((v) => post('/overlays/reorder', { items: v.items }));

/**
 * Optimistički reorder (drag-drop / „Idi na poziciju N"). Patch-uje red MAŠINE u kešu
 * na novi redosled (rows), a na grešku vraća prethodno stanje + toast (GAP-PM-09/20).
 */
export const useOptimisticReorder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { machine: string | null; orderedRows: OpRow[] }) =>
      post('/overlays/reorder', { items: v.orderedRows.map((x) => ({ workOrderId: x.work_order_id, lineId: x.line_id })) }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      const caches = qc.getQueriesData<unknown>({ queryKey: [...KEYS.operations, 'machine', v.machine] });
      for (const [key, data] of caches) {
        if (!data || typeof data !== 'object') continue;
        const d = data as { data?: { rows?: OpRow[] } };
        if (d.data && Array.isArray(d.data.rows)) {
          qc.setQueryData(key, { ...d, data: { ...d.data, rows: v.orderedRows } });
        }
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast('⚠ Redosled nije sačuvan — osvežavam.');
      // GREŠKA → rollback (gore) + refetch SVEGA (paritet 1.0 refreshOperationsForMachine
      // na neuspeh, poMasiniTab.js:1973-1976). Ovde SME invalidacija mašinskog keša.
      void qc.invalidateQueries({ queryKey: KEYS.operations });
    },
    onSuccess: (_r, v) => {
      toast('✓ Redosled sačuvan');
      // USPEH → NE invalidiraj akumulirani mašinski keš ([..'machine', machine, offset, limit]).
      // 1.0 renumeriše in-place bez refetch-a (poMasiniTab.js:1978), a refetch bi obrisao
      // „Još RN" stranice (loadMore merge u isti ključ) — optimistički patch je već upisao
      // tačan redosled. Ostali potrošači (dept/all/search) se i dalje invalidiraju (zadržana
      // postojeća semantika), hirurški isključena SAMO mašinska accum grana ove mašine.
      void qc.invalidateQueries({
        queryKey: KEYS.operations,
        predicate: (query) => {
          const k = query.queryKey as unknown[];
          // k = ['pp','operations','machine', <machine>, <offset>, <limit>] → preskoči tekuću mašinu.
          const isThisMachine = k[2] === 'machine' && k[3] === (v.machine ?? null);
          return !isThisMachine;
        },
      });
    },
  });
};

/**
 * Optimistički reorder redova GANTA (zahtev 070/26) — ISTI endpoint i ISTI ključ upisa
 * kao „Po mašini": `/overlays/reorder` upisuje `shift_sort_order` = 1..n redom kojim
 * stignu stavke. Razlika je samo keš koji se pipa: gant čita `KEYS.gantt`, pa se
 * optimistički upisuju NOVE vrednosti `shift_sort_order` u redove (poredak se iz njih
 * izvodi u `groupRows`/`compareRows`, pa se prikaz pomeri odmah, bez čekanja mreže).
 *
 * `orderedRows` je PUN red mašine (i stavke van plana), ne samo vidljivi isečak — inače
 * bi renumeracija 1..n nad podskupom pomerila stavke koje planer u gantu ne vidi, a koje
 * „Po mašini" prikazuje (isti `shift_sort_order`, dva prikaza).
 *
 * Greška → rollback na zatečeno stanje + ⚠ toast; `onSettled` osvežava i gant i
 * „Po mašini" (jedan podatak, dva potrošača).
 */
export const useGanttReorder = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { orderedRows: GanttRow[] }) =>
      post('/overlays/reorder', {
        items: v.orderedRows.map((x) => ({ workOrderId: x.work_order_id, lineId: x.line_id })),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.gantt });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.gantt }).map(([k, d]) => [k, d] as const);
      const order = new Map(v.orderedRows.map((r, i) => [opKey(r), i + 1]));
      for (const [key, data] of qc.getQueriesData<unknown>({ queryKey: KEYS.gantt })) {
        const d = data as { data?: GanttRow[] } | undefined;
        if (!d || !Array.isArray(d.data)) continue;
        qc.setQueryData(key, {
          ...d,
          data: d.data.map((r) => {
            const n = order.get(opKey(r));
            return n === undefined ? r : { ...r, shift_sort_order: n };
          }),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast('⚠ Redosled nije sačuvan — osvežavam.');
    },
    onSuccess: () => toast('✓ Redosled sačuvan'),
    onSettled: (_d, err) => {
      void qc.invalidateQueries({ queryKey: KEYS.gantt });
      // „Po mašini" čita ISTI `shift_sort_order`, pa mora da se osveži — ali NE i njegov
      // akumulirani mašinski keš (`['pp','operations','machine',…]`), u koji „Još RN"
      // stranice merge-uju u isti ključ; `useReorderOps` ga namerno štedi (v. gore) i
      // refetch bi obrisao dovučene stranice. Na GREŠKU se invalidira sve — tada je
      // zatečeno stanje ionako sumnjivo (isti izbor kao `useReorderOps.onError`).
      void qc.invalidateQueries({
        queryKey: KEYS.operations,
        predicate: (query) => (err ? true : (query.queryKey as unknown[])[2] !== 'machine'),
      });
    },
  });
};

/* ── Kaskadno pomeranje lanca (075/26 — F2 iz 046/26) ── */

/** Jedna stavka plana kaskade (pomerena). */
export interface ShiftChainStavka {
  work_order_id: string;
  line_id: string;
  dubina: number;
  rn_ident_broj: string | null;
  operacija: number | string | null;
  broj_crteza: string | null;
  machine: string | null;
  planned_start_at: string | null;
  planned_end_at: string | null;
  /** Pregled (`dryRun`) — NOVI termini; pri upisu su `null` (novo stanje je gore). */
  new_start: string | null;
  new_end: string | null;
}

/** Jedna preskočena stavka (u lancu je, ali se NE upisuje). */
export interface ShiftChainPreskoceno {
  work_order_id: string;
  line_id: string;
  dubina: number;
  rn_ident_broj: string | null;
  operacija: number | string | null;
  broj_crteza: string | null;
  machine: string | null;
  razlog_kod: 'zavrseno' | 'bez_termina' | 'arhivirano' | 'orfan';
  razlog: string;
}

export interface ShiftChainPlan {
  sidro: {
    work_order_id: string;
    line_id: string;
    rn_ident_broj: string | null;
    operacija: number | string | null;
    machine: string | null;
  } | null;
  delta_dana: number;
  zahvat: number;
  dubina_max: number;
  /** Otisak STANJA lanca — vraća se serveru kao `expectedHash` iz dijaloga / „Poništi". */
  hash: string;
  /** Otisak POSLE upisa — sidro za dugme „Poništi". `null` u pregledu. */
  hash_after: string | null;
  needs_confirm: boolean;
  totals: { pomereno: number; preskoceno: number; preskoceno_zavrsenih: number };
  stavke: ShiftChainStavka[];
  preskoceno: ShiftChainPreskoceno[];
  ciklus: { putanja: string[]; ivica: string } | null;
}

export interface ShiftChainVars {
  workOrderId: string;
  lineId: string;
  deltaDays: number;
  /** 🔴 Kuje ga POZIVALAC, ne hook — v. dole. */
  clientEventId: string;
  expectedHash?: string;
  /** Optimistički pregled: opKey → novi termini. NE šalje se na server. */
  optimistic?: Map<string, { start: string; end: string | null }>;
}

/**
 * PREGLED kaskade — obična funkcija, NE mutacija: ne dira keš i ne troši idempotency
 * ključ. Server vraća isti oblik plana kao upis, samo sa `new_start`/`new_end`.
 */
export const ganttShiftChainPreview = (v: {
  workOrderId: string;
  lineId: string;
  deltaDays: number;
}) =>
  apiFetch<TxResponse<ShiftChainPlan>>(`${BASE}/overlays/shift-chain`, {
    method: 'POST',
    body: JSON.stringify({ ...v, dryRun: true }),
  });

/**
 * Kaskadno pomeranje lanca (075/26). Obrazac je `useGanttReorder` (batch telo + mapa
 * nad SVIM redovima keša + rollback), a NE `useGanttOverlay`: taj pravi jedan konstantan
 * `Partial<GanttRow>` i primenjuje ga na jedan red, a lancu treba N RAZLIČITIH vrednosti.
 *
 * 🔴 `clientEventId` se kuje NA MESTU POZIVA i putuje kroz `variables`. NIKAD unutar
 * `mutationFn`: React Query na retry ponovo zove `mutationFn` sa ISTIM varijablama, pa
 * ključ mora da živi u varijablama — inače bi retry napravio DRUGI pomak (delta nije
 * idempotentna: dva puta primenjeno je 10 dana umesto 5).
 *
 * `onSuccess` ušiva keš po `data.stavke` iz ODGOVORA (ne po optimističkom pregledu) —
 * tako se pomeraju i redovi koje FE nikad nije video kao vezu (van iscrtanih 300).
 *
 * Toast se NE diže ovde: samo tab zna koliko je pomerenih redova zaista iscrtano, pa
 * poruku diže on kroz per-poziv `onSuccess`.
 */
export const useGanttShiftChain = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ShiftChainVars) =>
      post<ShiftChainPlan>('/overlays/shift-chain', {
        workOrderId: v.workOrderId,
        lineId: v.lineId,
        deltaDays: v.deltaDays,
        clientEventId: v.clientEventId,
        ...(v.expectedHash ? { expectedHash: v.expectedHash } : {}),
      }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.gantt });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.gantt }).map(([k, d]) => [k, d] as const);
      const opt = v.optimistic;
      if (opt) {
        for (const [key, data] of qc.getQueriesData<unknown>({ queryKey: KEYS.gantt })) {
          const d = data as { data?: GanttRow[] } | undefined;
          if (!d || !Array.isArray(d.data)) continue;
          qc.setQueryData(key, {
            ...d,
            data: d.data.map((r) => {
              const x = opt.get(opKey(r));
              return x ? { ...r, planned_start_at: x.start, planned_end_at: x.end } : r;
            }),
          });
        }
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast(`⚠ ${ganttChainErrorMessage(e) ?? 'Lanac nije pomeren — osvežavam.'}`);
    },
    onSuccess: (r) => {
      const m = new Map(r.data.stavke.map((x) => [opKey(x), x]));
      for (const [key, data] of qc.getQueriesData<unknown>({ queryKey: KEYS.gantt })) {
        const d = data as { data?: GanttRow[] } | undefined;
        if (!d || !Array.isArray(d.data)) continue;
        qc.setQueryData(key, {
          ...d,
          data: d.data.map((row) => {
            const x = m.get(opKey(row));
            return x
              ? { ...row, planned_start_at: x.planned_start_at, planned_end_at: x.planned_end_at }
              : row;
          }),
        });
      }
    },
    // JEDNA invalidacija. `KEYS.operations` se NAMERNO ne invalidira (za razliku od
    // `useGanttOverlay`): kaskada ne dira ni mašinu, ni spremnost, ni `shift_sort_order`,
    // a „Po mašini" termine i ne prikazuje. Feed ide do 5.000 redova — ušteda je stvarna.
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.gantt }),
  });
};

/**
 * Prevod BE koda kaskade u srpski razlog. Namerno je DUPLIKAT mape iz
 * `gant-utils.ts`: api sloj ne sme da uvozi iz `app/` (obrnut smer zavisnosti), a hook
 * mora da ume da javi razlog i kad ga pozivalac ne obradi. Tab i dijalog koriste
 * `overlayErrorMessage` iz `gant-utils`.
 */
function ganttChainErrorMessage(e: unknown): string | undefined {
  const msg = String((e as Error)?.message ?? '');
  const mapa: Record<string, string> = {
    predecessor_cycle: 'Veze prave petlju — pozicija bi zavisila sama od sebe preko lanca.',
    cascade_too_large: 'Lanac je predugačak za jedan upis — javi da se podigne granica.',
    chain_changed: 'Plan se u međuvremenu promenio — osveži gant i pomeri ponovo.',
    anchor_without_terms: 'Pozicija nema planiran termin.',
    overlay_not_found: 'Pozicija nije na planu.',
    delta_zero: 'Nema pomaka.',
  };
  for (const [code, razlog] of Object.entries(mapa)) if (msg.includes(code)) return razlog;
  return undefined;
}

/* ── Urgency ── */

export const useSetUrgent = () =>
  usePpMutation<{ workOrderId: string; reason?: string }>((v) =>
    put(`/urgency/${v.workOrderId}`, { reason: v.reason }),
  );
export const useClearUrgent = () =>
  usePpMutation<{ workOrderId: string }>((v) => del(`/urgency/${v.workOrderId}`));

/** Optimistički HITNO toggle (urgency je po RN-u, pa patch-ujemo sve redove istog work_order_id). */
export const useOptimisticUrgent = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workOrderId: string; urgent: boolean; reason?: string }) =>
      v.urgent ? put(`/urgency/${v.workOrderId}`, { reason: v.reason }) : del(`/urgency/${v.workOrderId}`),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEYS.operations });
      const prev = qc.getQueriesData<unknown>({ queryKey: KEYS.operations }).map(([k, d]) => [k, d] as const);
      patchCachedOps(
        qc,
        (o) => o.work_order_id === v.workOrderId,
        (o) => ({ ...o, is_urgent: v.urgent, urgency_reason: v.urgent ? v.reason ?? o.urgency_reason ?? null : null }),
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      const c = ctx as { prev?: (readonly [readonly unknown[], unknown])[] } | undefined;
      if (c?.prev) for (const [k, d] of c.prev) qc.setQueryData(k as readonly unknown[], d);
      toast('⚠ HITNO nije sačuvano — osvežavam.');
    },
    onSuccess: (_r, v) => toast(v.urgent ? '✓ Označeno HITNO' : '✓ HITNO skinuto'),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEYS.operations }),
  });
};

/* ── Reassign (single/bulk; clientEventId obavezan za idempotenciju) ── */

export interface ReassignVars {
  workOrderId: string;
  lineId: string;
  targetMachine?: string | null;
  force?: boolean;
  reason?: string;
  clientEventId?: string;
}
export const useReassign = () =>
  usePpMutation<ReassignVars>((v) => post('/reassign', { clientEventId: newClientId(), ...v }));

export interface BulkReassignVars {
  pairs: { workOrderId: string; lineId: string }[];
  targetMachine?: string | null;
  force?: boolean;
  reason?: string;
  clientEventId?: string;
}
export const useBulkReassign = () =>
  usePpMutation<BulkReassignVars>((v) => post('/reassign/bulk', { clientEventId: newClientId(), ...v }));

/* ── Kooperacija — auto grupe (admin) ── */

export const useCreateCoopGroup = () =>
  usePpMutation<{ rjGroupCode: string; groupLabel: string; notes?: string }>(
    (v) => post('/cooperation/groups', v),
    KEYS.coopGroups,
  );
export const usePatchCoopGroup = () =>
  usePpMutation<{ code: string; groupLabel?: string; notes?: string; removed?: boolean }>(
    (v) => {
      const { code, ...body } = v;
      return patch(`/cooperation/groups/${encodeURIComponent(code)}`, body);
    },
    KEYS.coopGroups,
  );

/* ── Skice ── */

export const useUploadDrawing = () =>
  usePpMutation<{ workOrder: string; line: string; file: File }, TxResponse<PpDrawing>>((v) => {
    const fd = new FormData();
    fd.append('workOrder', v.workOrder);
    fd.append('line', v.line);
    fd.append('file', v.file, v.file.name);
    return apiUpload<TxResponse<PpDrawing>>(`${BASE}/drawings`, fd);
  }, KEYS.drawings);

export const useDeleteDrawing = () =>
  usePpMutation<{ id: string }>((v) => del(`/drawings/${v.id}`), KEYS.drawings);
