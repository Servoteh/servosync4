'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

// ============================================================================
// Lokacije delova (fizičke lokacije `loc_*`) — 3.0 TALAS A seoba iz 1.0.
// Backend: docs/design/MODULE_SPEC_lokacije_30.md §3 (endpointi /api/v1/locations/*).
// Podaci žive u sy15 (1.0) bazi; backend vraća DVE vrste oblika:
//   • Prisma modeli (locations/placements/movements) → camelCase polja,
//   • sy15 RPC izveštaji (report/predmet/sync) → snake_case JSON iz DB funkcija.
// ⚠️ NE mešati sa 2.0-native `part-locations` (QBigTehn ledger) — drugi modul.
// ============================================================================

// ------------------------------------------------------------------ enumi (paritet Prisma sy15.prisma)

export type LocTypeEnum =
  | 'WAREHOUSE' | 'RACK' | 'SHELF' | 'BIN' | 'PROJECT' | 'PRODUCTION'
  | 'ASSEMBLY' | 'SERVICE' | 'FIELD' | 'TRANSIT' | 'OFFICE' | 'TEMP'
  | 'SCRAPPED' | 'OTHER' | 'MACHINE' | 'CAGE';

export type LocPlacementStatus = 'ACTIVE' | 'IN_TRANSIT' | 'PENDING_CONFIRMATION' | 'UNKNOWN';

export type LocMovementType =
  | 'INITIAL_PLACEMENT' | 'TRANSFER' | 'ASSIGN_TO_PROJECT' | 'RETURN_FROM_PROJECT'
  | 'SEND_TO_SERVICE' | 'RETURN_FROM_SERVICE' | 'SEND_TO_FIELD' | 'RETURN_FROM_FIELD'
  | 'SCRAP' | 'CORRECTION' | 'INVENTORY_ADJUSTMENT' | 'REVERSAL_ISSUE' | 'REVERSAL_RETURN';

/**
 * Tipovi pokreta ponuđeni u „Brzo premeštanje" (paritet 1.0 `MOVEMENT_TYPES` —
 * 11 vrednosti; REVERSAL_* su rezervisani za Reversi tok i nisu ručno birani).
 * TRANSFER je prvi jer je najčešći; INITIAL_PLACEMENT je poseban tok (nove stavke).
 */
export const MOVEMENT_TYPES: LocMovementType[] = [
  'TRANSFER', 'INITIAL_PLACEMENT', 'ASSIGN_TO_PROJECT', 'RETURN_FROM_PROJECT',
  'SEND_TO_SERVICE', 'RETURN_FROM_SERVICE', 'SEND_TO_FIELD', 'RETURN_FROM_FIELD',
  'SCRAP', 'CORRECTION', 'INVENTORY_ADJUSTMENT',
];

/**
 * Čitljive labele tipova pokreta — TERMINOLOGIJA PARITET 1.0 (index.js
 * `MOVEMENT_TYPE_LABELS`): „Prvo zaduženje" (ne „Početni smeštaj"), „Povrat…"
 * (ne „Povraćaj…"), „Korekcija / neraspoređeno", „Inventar". Granularni tipovi
 * (ASSIGN/SEND/…) koje 1.0 ne razlaže dobijaju opisne srpske labele u istom duhu.
 */
export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  INITIAL_PLACEMENT: 'Prvo zaduženje',
  TRANSFER: 'Premeštanje',
  ASSIGN_TO_PROJECT: 'Dodela projektu',
  RETURN_FROM_PROJECT: 'Povrat sa projekta',
  SEND_TO_SERVICE: 'Slanje na servis',
  RETURN_FROM_SERVICE: 'Povrat sa servisa',
  SEND_TO_FIELD: 'Slanje na teren',
  RETURN_FROM_FIELD: 'Povrat sa terena',
  SCRAP: 'Otpis',
  CORRECTION: 'Korekcija / neraspoređeno',
  INVENTORY_ADJUSTMENT: 'Inventar',
  REVERSAL_ISSUE: 'Reversi izdavanje',
  REVERSAL_RETURN: 'Reversi povrat',
};

/** Tip lokacije → čitljiva labela (paritet 1.0 lokacijeTypes). */
export const LOC_TYPE_LABEL: Record<string, string> = {
  WAREHOUSE: 'Magacin', RACK: 'Regal', SHELF: 'Polica', BIN: 'KES',
  PROJECT: 'Projekat', PRODUCTION: 'Proizvodnja', ASSEMBLY: 'Montaža',
  SERVICE: 'Servis', FIELD: 'Teren', TRANSIT: 'Tranzit', OFFICE: 'Kancelarija',
  TEMP: 'Privremeno', SCRAPPED: 'Otpisano', OTHER: 'Ostalo',
  MACHINE: 'Mašina', CAGE: 'Kavez',
};

/** kind → tipovi (paritet backend KIND_TO_TYPES). Za formu Nova/Izmena lokacije. */
export const HALL_TYPES: LocTypeEnum[] = ['WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP'];
export const SHELF_TYPES: LocTypeEnum[] = ['SHELF', 'RACK', 'BIN'];

// ------------------------------------------------------------------ tipovi zapisa (Prisma camelCase)

export interface LocLocation {
  id: string;
  locationCode: string;
  name: string;
  locationType: LocTypeEnum;
  parentId: string | null;
  pathCached: string;
  depth: number;
  isActive: boolean;
  capacityNote: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

export interface LocPlacement {
  id: string;
  itemRefTable: string;
  itemRefId: string;
  locationId: string;
  placementStatus: LocPlacementStatus;
  lastMovementId: string | null;
  placedAt: string;
  placedBy: string | null;
  notes: string | null;
  updatedAt: string;
  quantity: string | number;
  orderNo: string;
  drawingNo: string;
}

export interface LocMovement {
  id: string;
  itemRefTable: string;
  itemRefId: string;
  fromLocationId: string | null;
  toLocationId: string | null;
  movementType: LocMovementType;
  movementReason: string | null;
  note: string | null;
  movedAt: string;
  movedBy: string;
  /**
   * Prikazno ime izvršioca (BE dopuna, grana fix/locations-energetika): `user_roles`
   * full_name/email po `movedBy` uid-u; `null` ako nerazrešiv. `movedBy` (UUID) OSTAJE
   * kao zero-loss fallback. Dok BE grane nisu spojene, polje je `undefined` na runtime-u
   * (UI defanzivno pada na skraćeni `movedBy`). Vidi `userDisplay()` u common.tsx.
   */
  movedByName?: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  correctionOfMovementId: string | null;
  syncStatus: string;
  createdAt: string;
  quantity: string | number;
  orderNo: string;
  drawingNo: string;
  source: string;
  clientEventUuid: string | null;
}

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** Red izveštaja `loc_report_parts_by_locations` (snake_case JSON iz RPC-a; polja opciona). */
export interface ReportRow {
  item_ref_table?: string;
  item_ref_id?: string;
  order_no?: string;
  drawing_no?: string;
  wo_broj_crteza?: string;
  project_code?: string;
  project_name?: string;
  customer_name?: string;
  naziv_dela?: string;
  materijal?: string;
  dimenzija_materijala?: string;
  rok_izrade?: string;
  tezina_obr?: number | string;
  qty_on_location?: number | string;
  qty_total_for_bucket?: number | string;
  komada_rn?: number | string;
  placement_status?: string;
  work_order_id?: number | string;
  location_code?: string;
  location_name?: string;
  hall_code?: string;
  hall_name?: string;
  // Dodatna polja iz RPC-a `loc_report_parts_by_locations` (koristi CSV izvoz,
  // paritet 1.0 `buildReportCsvRow` / REPORT_CSV_HEADERS — nisu u ekranu, ali su
  // deo punog reda). Sva opciona; RPC ih uvek emituje za bigtehn_rn redove.
  revizija?: string;
  status_rn?: boolean;
  location_kind?: string;
  location_path?: string;
  shelf_note?: string;
  last_moved_at?: string;
  updated_at?: string;
  // `placement_id` = jedinstven ključ reda (RPC emituje pl.id) → stabilan rowKey.
  // `location_id` = fizička lokacija reda → loc-index fallback za halu ugnježdenih
  // mašina (RPC vraća hall_code=NULL kad je hala 2+ nivoa iznad). Vidi report-tab.
  placement_id?: string;
  location_id?: string;
  [key: string]: unknown;
}

export interface ReportResult {
  total: number;
  rows: ReportRow[];
}

/** Red `loc_tps_for_predmet` (snake_case JSON iz RPC-a). */
export interface PredmetTpRow {
  work_order_id?: number | string;
  wo_ident_broj?: string;
  tp_no?: string;
  wo_broj_crteza?: string;
  naziv_dela?: string;
  komada_rn?: number | string;
  qty_total_placed?: number | string;
  qty_on_location?: number | string;
  location_type?: string;
  location_code?: string;
  location_name?: string;
  materijal?: string;
  dimenzija_materijala?: string;
  has_pdf?: boolean;
  status?: string;
  // Puna polja RPC-a `loc_tps_for_predmet` — nisu u ekranu, ali ulaze u
  // Štampa/PDF/CSV izvoz punog spiska (paritet 1.0 predmetTab buildCsvText).
  location_path?: string;
  placement_status?: string;
  status_rn?: boolean;
  revizija?: string;
  rok_izrade?: string;
  tezina_obr?: number | string;
  [key: string]: unknown;
}

export interface PredmetTpsResult {
  total: number;
  rows: PredmetTpRow[];
}

// ------------------------------------------------------------------ barkod (BE server-side resolve)

/** Tip razrešenog barkoda (BE /locations/lookups/barcode — paritet barcodeParse+shelfBarcode). */
export type LocBarcodeKind = 'ITEM' | 'SHELF' | 'UNKNOWN';

export interface LocBarcodeItemResult {
  kind: 'ITEM';
  parsed: { orderNo: string; itemRefId: string; drawingNo: string; format: string; raw: string };
  records: LocPlacement[];
}

export interface LocBarcodeShelfResult {
  kind: 'SHELF';
  parsed: { format: string; raw: string };
  record?: LocLocation | null;
  presetHallFilterId?: string | null;
  message?: string;
}

export interface LocBarcodeUnknownResult {
  kind: 'UNKNOWN';
  parsed: null;
  records: [];
}

export type LocBarcodeResult =
  | LocBarcodeItemResult
  | LocBarcodeShelfResult
  | LocBarcodeUnknownResult;

/**
 * Imperativno razrešavanje skeniranog/otkucanog barkoda (poziva se iz skenera i
 * HID polja, ne kao useQuery — on-demand po skenu). BE parsira RNZ/short/compact
 * (stavka) i LP:/„HALA - POLICA"/šifra police (destinacija).
 */
export function lookupLocBarcode(code: string): Promise<{ data: LocBarcodeResult }> {
  return apiFetch<{ data: LocBarcodeResult }>(
    `/v1/locations/lookups/barcode?code=${encodeURIComponent(code)}`,
  );
}

/** Da li je broj naloga u aktivnom projekt/montaža predmetu (loc_order_no_in_active_proj_mont). */
export function validateOrderNo(orderNo: string): Promise<{ data: boolean | null }> {
  return apiFetch<{ data: boolean | null }>(
    `/v1/locations/lookups/validate-order?orderNo=${encodeURIComponent(orderNo)}`,
  );
}

// ------------------------------------------------------------------ helpers

/**
 * Idempotency ključ pokreta (`client_event_uuid`, DB fn NATIVNA idempotencija):
 * generiši JEDNOM po korisničkoj akciji i prosledi u variables — retry ISTE akcije
 * nosi ISTI ključ (backend na replay vraća `{ok, idempotent:true}`). `crypto.randomUUID`
 * postoji samo u secure context-u → fallback na `getRandomValues` (RFC 4122 v4).
 */
export function newClientEventUuid(): string {
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

export const KEYS = {
  root: ['lokacije'] as const,
  locations: ['lokacije', 'locations'] as const,
  placements: ['lokacije', 'placements'] as const,
  movements: ['lokacije', 'movements'] as const,
  report: ['lokacije', 'report'] as const,
  predmet: ['lokacije', 'predmet'] as const,
  audit: ['lokacije', 'audit'] as const,
  sync: ['lokacije', 'sync'] as const,
};

// ------------------------------------------------------------------ query params

export interface LocationsParams {
  active?: 'true' | 'all' | 'false';
  q?: string;
  kind?: 'hall' | 'shelf' | 'cage' | 'machine';
  type?: string;
  parentId?: string;
  page?: number;
  pageSize?: number;
}

export interface PlacementsParams {
  search?: string;
  locationId?: string;
  orderNo?: string;
  itemRefId?: string;
  itemRefTable?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface MovementsParams {
  search?: string;
  userId?: string;
  locationId?: string;
  movementType?: string;
  orderNo?: string;
  itemRefId?: string;
  itemRefTable?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface ReportParams {
  drawingNo?: string;
  orderNo?: string;
  tpNo?: string;
  projectSearch?: string;
  locationId?: string;
  locationQ?: string;
  hallId?: string;
  locationKind?: 'shelf' | 'cage';
  nazivDela?: string;
  sort?: string;
  desc?: boolean;
  page?: number;
  pageSize?: number;
}

export interface PredmetTpsParams {
  onlyOpen?: boolean;
  includeAssembled?: boolean;
  tpNo?: string;
  drawingNo?: string;
  locationFilter?: 'all' | 'with' | 'without';
  workOrderId?: string;
  page?: number;
  pageSize?: number;
}

// ------------------------------------------------------------------ queries (read)

export function useLocations(params: LocationsParams, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.locations, params],
    enabled,
    queryFn: () =>
      apiFetch<{ data: LocLocation[]; meta: PageMeta }>(`/v1/locations${qs({ ...params })}`),
  });
}

/**
 * SVE lokacije (za indeks razrešavanja from/to labela, shelf↔hall hijerarhiju i
 * select-e). Backend klampuje pageSize na 1000, a živih lokacija je ~1561 — pa
 * ovaj hook prolazi kroz stranice dok se ne pokupe svi redovi (cap 20 strana).
 */
export function useAllLocations(active: 'true' | 'all' | 'false' = 'all') {
  return useQuery({
    queryKey: [...KEYS.locations, 'all', active],
    staleTime: 60_000,
    queryFn: async () => {
      const pageSize = 1000;
      const out: LocLocation[] = [];
      for (let page = 1; page <= 20; page++) {
        const res = await apiFetch<{ data: LocLocation[]; meta: PageMeta }>(
          `/v1/locations${qs({ active, page, pageSize })}`,
        );
        out.push(...res.data);
        if (out.length >= res.meta.pagination.total || res.data.length < pageSize) break;
      }
      return out;
    },
  });
}

export function useLocation(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.locations, 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: LocLocation }>(`/v1/locations/${id}`),
  });
}

export function usePlacements(params: PlacementsParams, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.placements, params],
    enabled,
    queryFn: () =>
      apiFetch<{ data: LocPlacement[]; meta: PageMeta }>(
        `/v1/locations/placements${qs({ ...params })}`,
      ),
  });
}

export function useMovements(params: MovementsParams, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.movements, params],
    enabled,
    queryFn: () =>
      apiFetch<{ data: LocMovement[]; meta: PageMeta }>(
        `/v1/locations/movements${qs({ ...params })}`,
      ),
  });
}

/** Jedan izvršilac pokreta za „Korisnik" filter (id = moved_by UUID; name = razrešeno ime). */
export interface LocMover {
  id: string;
  name?: string | null;
}

/**
 * PUNA lista movera za „Korisnik" filter (paritet 1.0 `loadHistoryUsers`): BE ruta
 * `GET /v1/locations/movements/movers` → DISTINCT moved_by (+ razrešeno ime) preko
 * SVIH pokreta, bez page-clamp-a. Nova ruta grane fix/locations-energetika; `retry:false`
 * jer dok grane nisu spojene vraća 404 — pozivalac tada defanzivno pada na distinct iz
 * učitane strane (staro ponašanje) da filter ostane funkcionalan (zero-loss).
 */
export function useMovementMovers(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.movements, 'movers'],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: () => apiFetch<{ data: LocMover[] }>('/v1/locations/movements/movers'),
  });
}

export function useReportByLocation(params: ReportParams, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.report, params],
    enabled,
    queryFn: () =>
      apiFetch<{ data: ReportResult }>(`/v1/locations/reports/by-location${qs({ ...params })}`),
  });
}

/** Red autosugestije naziva dela (loc_report_suggest_naziv_dela — niz OBJEKATA). */
export interface ReportSuggestion {
  naziv_dela: string;
  broj_crteza?: string;
  placement_count?: number;
  [key: string]: unknown;
}

/** Autosugestija naziva dela za report filter (loc_report_suggest_naziv_dela). */
export function useReportSuggest(q: string) {
  return useQuery({
    queryKey: [...KEYS.report, 'suggest', q],
    enabled: q.trim().length >= 2,
    queryFn: () =>
      apiFetch<{ data: ReportSuggestion[] }>(
        `/v1/locations/reports/suggest-naziv-dela${qs({ q })}`,
      ),
  });
}

export function usePredmetTps(itemId: string | null, params: PredmetTpsParams) {
  return useQuery({
    queryKey: [...KEYS.predmet, itemId, params],
    enabled: !!itemId,
    queryFn: () =>
      apiFetch<{ data: PredmetTpsResult; meta: { opStatus: unknown } }>(
        `/v1/locations/predmet/${itemId}/tps${qs({ ...params })}`,
      ),
  });
}

/**
 * Radni nalog predmeta iz nove rute `GET /v1/locations/predmet/:itemId/work-orders`
 * (grana fix/locations-energetika) — SVI RN po predmetu, JEDAN red po nalogu (bez
 * placement-expandovanja i bez MES-active filtera). Batch TP štampa gubi 77% RN kad
 * se hrani iz `loc_tps_for_predmet` (MES-active); ovo je zamena za tu putanju. Polja
 * camelCase (BE model). Opciona jer PIN može evoluirati; UI ih čita defanzivno.
 */
export interface LocWorkOrder {
  workOrderId: number | string;
  identBroj?: string;
  crtez?: string;
  nazivDela?: string;
  komada?: number | string;
  materijal?: string;
  dimenzijaMaterijala?: string;
  statusRn?: boolean;
  tipOperacije?: string;
  [key: string]: unknown;
}

export interface PredmetWorkOrdersParams {
  onlyOpen?: boolean;
}

/**
 * SVI radni nalozi predmeta za batch-štampu (paritet 1.0 `searchBigtehnWorkOrdersForItem`
 * bez `is_mes_active`). `retry:false` — dok BE ruta nije spojena vraća 404, pa pozivalac
 * (BatchTpLabels) defanzivno pada na `usePredmetTps` (MES-active), deduplikovan po
 * work_order_id, da bar nema duplih redova/ključeva. Predmet-tab NE dira ovaj hook.
 */
export function usePredmetWorkOrders(itemId: string | null, params: PredmetWorkOrdersParams = {}) {
  return useQuery({
    queryKey: [...KEYS.predmet, itemId, 'work-orders', params],
    enabled: !!itemId,
    retry: false,
    queryFn: () =>
      apiFetch<{ data: LocWorkOrder[] }>(
        `/v1/locations/predmet/${itemId}/work-orders${qs({ ...params })}`,
      ),
  });
}

/**
 * Red istorije definicija master lokacija (RPC `loc_locations_audit` — kolone iz
 * `sql/migrations/add_loc_locations_audit.sql`). `actor_name` je BE dopuna (grana
 * fix/locations-energetika): actor_uid → ime, fallback actor_email → `null`.
 * Dok BE grane nisu spojene, `actor_name` je `undefined` (UI pada na email/UUID).
 */
export interface DefinitionAuditRow {
  id?: number | string;
  record_id?: string | null;
  action?: string | null;
  actor_email?: string | null;
  actor_uid?: string | null;
  actor_name?: string | null;
  changed_at?: string | null;
  old_data?: Record<string, unknown> | null;
  new_data?: Record<string, unknown> | null;
  diff_keys?: string[] | null;
  [key: string]: unknown;
}

/** Istorija definisanja/izmena master lokacija (manage; loc_locations_audit). */
export function useDefinitionsAudit(limit = 100, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.audit, limit],
    enabled,
    queryFn: () =>
      apiFetch<{ data: DefinitionAuditRow[] }>(
        `/v1/locations/definitions-audit${qs({ limit })}`,
      ),
  });
}

/**
 * Početna KPI — rolling brojači premeštanja u poslednja 24h / 7 dana
 * (BE ruta `GET /v1/locations/summary` → `{ data: { movements24h, movements7d } }`;
 * grana fix/locations-energetika). `retry:false` jer dok BE grane nisu spojene ruta
 * vraća 404 — pozivalac tada defanzivno pada na „ukupno" brojače (zero-loss prikaz).
 */
export interface LocationsSummary {
  movements24h: number;
  movements7d: number;
}

export function useLocationsSummary(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.root, 'summary'],
    enabled,
    retry: false,
    staleTime: 30_000,
    queryFn: () => apiFetch<{ data: LocationsSummary }>('/v1/locations/summary'),
  });
}

/**
 * ⭐ redosled predmeta iz Praćenja (Podešavanja predmeta) — paritet 1.0
 * `ensurePrioritetHydrated` / `getPrioritetIds`. Vraća skup `predmet_item_id`
 * koje treba istaći/sortirati prve u picker-u „Pregled predmeta". `retry:false`
 * + tih fallback na `[]` (403 za role bez `pracenje.read`, mrežni pad) da picker
 * ostane upotrebljiv — prioritet je kozmetički (samo redosled).
 */
export function usePredmetPrioritetIds(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.root, 'predmet-prioritet'],
    enabled,
    retry: false,
    staleTime: 60_000,
    queryFn: async (): Promise<number[]> => {
      try {
        const r = await apiFetch<{ data: { ids?: number[] } }>('/v1/pracenje/plan-prioritet');
        const ids = r.data?.ids;
        return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
      } catch {
        return [];
      }
    },
  });
}

// ------------------------------------------------------------------ fetch-all (imperativni izvoz)
// Paritet 1.0 `fetchAllLocReportPartsByLocations` / `fetchAllMovements` /
// `fetchAllPlacements` (services/lokacije.js): povuci CEO filtrirani skup kroz
// petlju po stranama (BE klampuje pageSize na 500 za sva tri endpointa), uz
// progres i tvrdi safety cap. NISU useQuery — zovu se na klik „Export CSV".

/** Napredak povlačenja (za dugme „CSV… loaded/total"). */
export interface FetchAllProgress {
  loaded: number;
  total: number | null;
}

export interface FetchAllOpts {
  onProgress?: (p: FetchAllProgress) => void;
  signal?: AbortSignal;
  /** Override veličine strane (default = BE max 500). */
  pageSize?: number;
}

export interface FetchAllResult<T> {
  rows: T[];
  total: number | null;
  truncated: boolean;
}

/** Tvrdi limit da neko slučajno ne obori browser (paritet 1.0 HARD_CAP). */
const FETCH_ALL_HARD_CAP = 50_000;
/** BE klampuje pageSize na 500 (report/movements/placements) — koristi maks. */
const FETCH_ALL_PAGE_SIZE = 500;

function clampPageSize(v: number | undefined): number {
  return Math.max(1, Math.min(Number(v) || FETCH_ALL_PAGE_SIZE, 500));
}

/**
 * SVE redove izveštaja „Pregled po lokacijama" (loc_report_parts_by_locations)
 * koji odgovaraju `params` (bez page/pageSize — ovde se postavljaju po strani).
 * RPC vraća `{ total, rows }`; petljamo dok ne pokupimo `total` (ili cap).
 */
export async function fetchAllReportByLocation(
  params: ReportParams,
  opts: FetchAllOpts = {},
): Promise<FetchAllResult<ReportRow>> {
  const size = clampPageSize(opts.pageSize);
  const rows: ReportRow[] = [];
  let total: number | null = null;
  let truncated = false;

  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await apiFetch<{ data: ReportResult }>(
      `/v1/locations/reports/by-location${qs({ ...params, page, pageSize: size })}`,
    );
    const chunk = res.data?.rows ?? [];
    if (typeof res.data?.total === 'number') total = res.data.total;
    if (chunk.length === 0) break;
    rows.push(...chunk);
    opts.onProgress?.({ loaded: rows.length, total });
    if (chunk.length < size) break;
    if (total != null && rows.length >= total) break;
    if (rows.length >= FETCH_ALL_HARD_CAP) {
      truncated = true;
      break;
    }
  }

  return { rows, total, truncated };
}

/** SVE redove istorije premeštanja (movements) koji odgovaraju `params`. */
export async function fetchAllMovements(
  params: MovementsParams,
  opts: FetchAllOpts = {},
): Promise<FetchAllResult<LocMovement>> {
  const size = clampPageSize(opts.pageSize);
  const rows: LocMovement[] = [];
  let total: number | null = null;
  let truncated = false;

  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await apiFetch<{ data: LocMovement[]; meta: PageMeta }>(
      `/v1/locations/movements${qs({ ...params, page, pageSize: size })}`,
    );
    const chunk = res.data ?? [];
    if (typeof res.meta?.pagination?.total === 'number') total = res.meta.pagination.total;
    if (chunk.length === 0) break;
    rows.push(...chunk);
    opts.onProgress?.({ loaded: rows.length, total });
    if (chunk.length < size) break;
    if (total != null && rows.length >= total) break;
    if (rows.length >= FETCH_ALL_HARD_CAP) {
      truncated = true;
      break;
    }
  }

  return { rows, total, truncated };
}

/**
 * SVE redove „Pregled predmeta" (loc_tps_for_predmet) za jedan predmet koji
 * odgovaraju `params` — paritet 1.0 `fetchAllFiltered` (predmetTab.js:919): povuci
 * ceo filtrirani skup kroz petlju po stranama za Štampa/PDF/CSV izvoz. BE klampuje
 * pageSize (koristi 1000 kao 1.0 PAGE). NIJE useQuery — zove se na klik izvoza.
 */
export async function fetchAllPredmetTps(
  itemId: string,
  params: Omit<PredmetTpsParams, 'page' | 'pageSize' | 'workOrderId'>,
  opts: FetchAllOpts = {},
): Promise<FetchAllResult<PredmetTpRow>> {
  const size = Math.max(1, Math.min(Number(opts.pageSize) || 1000, 1000));
  const rows: PredmetTpRow[] = [];
  let total: number | null = null;
  let truncated = false;

  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await apiFetch<{ data: PredmetTpsResult }>(
      `/v1/locations/predmet/${itemId}/tps${qs({ ...params, page, pageSize: size })}`,
    );
    const chunk = res.data?.rows ?? [];
    if (typeof res.data?.total === 'number') total = res.data.total;
    if (chunk.length === 0) break;
    rows.push(...chunk);
    opts.onProgress?.({ loaded: rows.length, total });
    if (chunk.length < size) break;
    if (total != null && rows.length >= total) break;
    if (rows.length >= FETCH_ALL_HARD_CAP) {
      truncated = true;
      break;
    }
  }

  return { rows, total, truncated };
}

/** SVE placements (Stavke) koji odgovaraju `params` (za CSV izvoz Stavki). */
export async function fetchAllPlacements(
  params: PlacementsParams,
  opts: FetchAllOpts = {},
): Promise<FetchAllResult<LocPlacement>> {
  const size = clampPageSize(opts.pageSize);
  const rows: LocPlacement[] = [];
  let total: number | null = null;
  let truncated = false;

  for (let page = 1; ; page++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await apiFetch<{ data: LocPlacement[]; meta: PageMeta }>(
      `/v1/locations/placements${qs({ ...params, page, pageSize: size })}`,
    );
    const chunk = res.data ?? [];
    if (typeof res.meta?.pagination?.total === 'number') total = res.meta.pagination.total;
    if (chunk.length === 0) break;
    rows.push(...chunk);
    opts.onProgress?.({ loaded: rows.length, total });
    if (chunk.length < size) break;
    if (total != null && rows.length >= total) break;
    if (rows.length >= FETCH_ALL_HARD_CAP) {
      truncated = true;
      break;
    }
  }

  return { rows, total, truncated };
}

// ---- Sync (admin) ----

/**
 * BigTehn ingest worker sample (1 red iz `loc_bigtehn_ingest_state.last_run_summary.samples`) —
 * paritet 1.0 renderIngestSamplesHtml (index.js:2341). Sva polja opciona (worker ih puni po akciji).
 */
export interface IngestSample {
  signal_id?: number | string | null;
  ident?: string | null;
  predmet?: string | null;
  tp?: string | null;
  op?: string | null;
  machine?: string | null;
  from_loc?: string | null;
  from_type?: string | null;
  transfer_qty?: number | string | null;
  rn_total?: number | string | null;
  action?: string | null;
  armed_executed?: boolean;
  armed_error?: string | null;
  parser_fallback?: boolean;
  started_at?: string | null;
}

/** by_action histogram (1.0 renderByActionPillsHtml) — brojači po klasi prijave. */
export type IngestByAction = Record<string, number>;

/** Sažetak poslednjeg run-a ingest worker-a (`state.last_run_summary`). */
export interface IngestSummary {
  by_action?: IngestByAction;
  samples?: IngestSample[];
  processed_total?: number | string | null;
}

/**
 * Stanje BigTehn ingest worker-a — 2.0 `sync/status` vraća ovo pod `data.ingest`
 * (mirror 1.0 `loc_bigtehn_ingest_state`). Polja opciona; `armed`/`is_armed` oba
 * priznata (postojeći FE gard). `ok:false` + `error` = DB stanje nedostupno.
 */
export interface IngestState {
  ok?: boolean;
  error?: string;
  armed?: boolean;
  is_armed?: boolean;
  last_run_at?: string | null;
  watermark?: number | string | null;
  last_run_summary?: IngestSummary;
}

/**
 * Heartbeat ingest worker-a — 2.0 `sync/status` vraća pod `data.heartbeat`
 * (paritet 1.0 `statusRes.heartbeat`, index.js:2231). `is_alive` = pulsirao < 10 min.
 * NE meša se sa `data.health` (worker-health summary, vidi `SyncHealth`).
 */
export interface IngestHeartbeat {
  is_alive?: boolean;
  age_seconds?: number | null;
}

/**
 * Zdravlje sync worker-a (DEAD_LETTER + per-worker heartbeat) — 2.0 `sync/status`
 * vraća pod `data.health` (paritet 1.0 `fetchLocSyncHealthSummary` /
 * `loc_sync_health_summary`, index.js:1521). Hrani worker-health baner u
 * pocetna-tab (`syncWorkerAlerts`). RAZLIČITO od ingest heartbeat-a (`data.heartbeat`).
 */
export interface SyncHealth {
  dead_letter_count?: number;
  workers?: { worker_id?: string; last_seen?: string | null; age_seconds?: number; is_alive?: boolean }[];
}

/** 1 red outbound queue-a (MSSQL write-back) — paritet 1.0 fetchSyncOutboundEvents. */
export interface SyncOutboundRow {
  status?: string | null;
  source_record_id?: string | null;
  created_at?: string | null;
  last_error?: string | null;
}

export interface SyncStatus {
  /** Stanje ingest worker-a (mirror `loc_bigtehn_ingest_state`). */
  ingest: IngestState;
  /** Zdravlje sync worker-a (DEAD_LETTER + per-worker heartbeat) — hrani worker-health baner. */
  health: SyncHealth;
  /** Ingest heartbeat (`is_alive`, `age_seconds`) — paritet 1.0 `statusRes.heartbeat`. */
  heartbeat: IngestHeartbeat;
  bridge: { sync_job: string; last_finished: string | null; status: string | null }[];
}

export function useSyncStatus(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.sync, 'status'],
    enabled,
    refetchInterval: 30_000,
    queryFn: () => apiFetch<{ data: SyncStatus }>('/v1/locations/sync/status'),
  });
}

/**
 * Zdravlje sinhronizacije za SVE korisnike modula (ne samo admina) — nova BE ruta
 * `GET /v1/locations/sync/health`. Za razliku od `sync/status` (LOKACIJE_ADMIN,
 * pun detalj), ovo je read-only sažetak dostupan baseline read ulogama: koji
 * BigTehn keš je zastareo (pragovi 1.0 index.js:255-292 — RN/linije/TP 6h,
 * predmeti 36h, crteži 7d, izračunato server-side) + da li sync worker radi
 * (heartbeat >10min / DEAD_LETTER, 1.0 index.js:214-246). Hrani banere L-06/L-07
 * za magacionera/cnc koji ranije NISU videli upozorenje (gejtovano za admina).
 *
 * `retry:false` + tih fallback: dok BE ruta nije spojena vraća 404, pozivalac tada
 * ne prikazuje bAner (zero-loss — admin i dalje vidi detaljni prikaz iz sync/status).
 */
export interface SyncHealthSummary {
  /** Po kategoriji keša: da li je zastareo (server primenio 1.0 pragove). */
  cacheStale: {
    rn: boolean;
    linije: boolean;
    tp: boolean;
    predmeti: boolean;
    crtezi: boolean;
  };
  /** false = neki worker bez heartbeat-a >10min ILI ima DEAD_LETTER stavki. */
  workerHealthy: boolean;
}

export function useSyncHealth(enabled = true) {
  return useQuery({
    queryKey: [...KEYS.sync, 'health'],
    enabled,
    retry: false,
    refetchInterval: 60_000,
    staleTime: 30_000,
    queryFn: () => apiFetch<{ data: SyncHealthSummary }>('/v1/locations/sync/health'),
  });
}

export function useSyncOutbound(limit = 80, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.sync, 'outbound', limit],
    enabled,
    queryFn: () =>
      apiFetch<{ data: SyncOutboundRow[] }>(
        `/v1/locations/sync/outbound${qs({ limit })}`,
      ),
  });
}

// ------------------------------------------------------------------ mutations
// Envelope odgovor DB fn: { data: {ok, ...}, meta?: {idempotent} }.

interface EnvelopeResult {
  data: Record<string, unknown>;
  meta?: { idempotent?: boolean };
}

/**
 * Pokret (SVE tipove) — POST /locations/movements → loc_create_movement(jsonb).
 * `clientEventUuid` je OBAVEZAN idempotency ključ (generiši newClientEventUuid()
 * JEDNOM po formi). `payload` je 1:1 sa 1.0 (camelCase; BE mapira u snake_case).
 */
export interface MovementVars {
  clientEventUuid: string;
  itemRefTable: string;
  itemRefId: string;
  movementType: LocMovementType;
  orderNo?: string;
  drawingNo?: string;
  quantity?: number;
  toLocationId?: string;
  fromLocationId?: string;
  movementReason?: string;
  note?: string;
  movedAt?: string;
}

/**
 * Plain POST pokreta (bez React Query) — koristi ga i `useCreateMovement` hook i
 * offline-queue flusher (lib/offlineQueue.ts), koji radi van React tree-a.
 * Idempotencija ide preko `clientEventUuid` (partial UNIQUE indeks; retry istog
 * UUID-a vraća {idempotent:true} bez dupliranja).
 */
export function postMovement(v: MovementVars): Promise<EnvelopeResult> {
  return apiFetch<EnvelopeResult>('/v1/locations/movements', {
    method: 'POST',
    body: JSON.stringify(v),
  });
}

export function useCreateMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: MovementVars) => postMovement(v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.root }),
  });
}

export interface CageMoveVars {
  cageId: string;
  newHallId: string;
  reason?: string;
}

export function useMoveCage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: CageMoveVars) =>
      apiFetch<{ data: Record<string, unknown> }>('/v1/locations/cage-move', {
        method: 'POST',
        body: JSON.stringify(v),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.locations }),
  });
}

export interface CreateLocationVars {
  locationCode: string;
  name: string;
  locationType: LocTypeEnum;
  parentId?: string;
  capacityNote?: string;
  notes?: string;
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: CreateLocationVars) =>
      apiFetch<{ data: LocLocation }>('/v1/locations', {
        method: 'POST',
        body: JSON.stringify(v),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.locations }),
  });
}

export interface UpdateLocationVars {
  id: string;
  name?: string;
  locationType?: LocTypeEnum;
  parentId?: string | null;
  isActive?: boolean;
  capacityNote?: string | null;
  notes?: string | null;
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateLocationVars) =>
      apiFetch<{ data: LocLocation }>(`/v1/locations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.locations }),
  });
}

// ---- Sync mutacije (admin) ----

export function useSyncArm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (armed: boolean) =>
      apiFetch<{ data: Record<string, unknown> }>('/v1/locations/sync/arm', {
        method: 'POST',
        body: JSON.stringify({ armed }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.sync }),
  });
}

export function useSyncRunNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<{ data: Record<string, unknown> }>('/v1/locations/sync/run-now', {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEYS.sync }),
  });
}

// ---- Štampa nalepnica (labels) — front gradi TSPL2, BE prosleđuje RAW ----

/** POST /locations/labels/print — RAW TSPL2 (police + TP), reuse 2.0 TSPL2 transporta. */
export function usePrintLocLabel() {
  return useMutation({
    mutationFn: (body: { tspl2: string; copies?: number }) =>
      apiFetch<{ data: { ok: boolean } }>('/v1/locations/labels/print', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ============================================================================
// REVERSI ↔ LOKACIJE integracija (spec §5 #17 + #18) — status i mehanizam
// ----------------------------------------------------------------------------
// #17 Initial placement iz 2.0: kada Reversi kreira/seed-uje alat, početni smeštaj
//     ide kao pokret tipa INITIAL_PLACEMENT u loc ledger. FE mehanizam POSTOJI —
//     `useCreateMovement({ movementType: 'INITIAL_PLACEMENT', itemRefTable: 'rev_tools',
//     itemRefId: <toolId>, toLocationId, quantity })`; „Brzo premeštanje" ekran ga
//     nudi za ručni tok. Automatsku emisiju na kreiranje alata radi BACKEND
//     (rev_cutting_tool_seed_stock već upisuje placement) — nije FE odgovornost.
//
// #18 REZNI FIX (izvorna lokacija = MACHINE, ne magacin): BACKEND-first. Trenutno
//     `reversi.service.cuttingIssue` postavlja `source_location_id` na magacin
//     ALAT-MAG-01. Da izvor bude MAŠINA, stok reznog mora biti SEED-ovan na MACHINE
//     loc lokaciju (inače dekrement padne na lokaciju sa 0 → SQLSTATE 23514 i lomi
//     RADNI tok izdavanja). Payload je pass-through, pa FE MOŽE poslati
//     `source_location_id` čim se odluči mapiranje mašina→MACHINE loc — ali FE-only
//     izmena bi slomila živi tok. Nenad je ovo označio kao otvorenu domensku odluku
//     („source-location, katalog prazan"). → R4 cross-team, posle BE seed-a na mašine.
// ============================================================================
