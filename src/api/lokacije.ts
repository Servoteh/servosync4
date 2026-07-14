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

export const MOVEMENT_TYPE_LABEL: Record<string, string> = {
  INITIAL_PLACEMENT: 'Početni smeštaj',
  TRANSFER: 'Premeštanje',
  ASSIGN_TO_PROJECT: 'Dodela projektu',
  RETURN_FROM_PROJECT: 'Povraćaj sa projekta',
  SEND_TO_SERVICE: 'Slanje na servis',
  RETURN_FROM_SERVICE: 'Povraćaj sa servisa',
  SEND_TO_FIELD: 'Slanje na teren',
  RETURN_FROM_FIELD: 'Povraćaj sa terena',
  SCRAP: 'Otpis',
  CORRECTION: 'Korekcija',
  INVENTORY_ADJUSTMENT: 'Inventarska korekcija',
  REVERSAL_ISSUE: 'Reversi izdavanje',
  REVERSAL_RETURN: 'Reversi povraćaj',
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

const KEYS = {
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

/** Istorija definisanja/izmena master lokacija (manage; loc_locations_audit). */
export function useDefinitionsAudit(limit = 100, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.audit, limit],
    enabled,
    queryFn: () =>
      apiFetch<{ data: Record<string, unknown>[] }>(
        `/v1/locations/definitions-audit${qs({ limit })}`,
      ),
  });
}

// ---- Sync (admin) ----

export interface SyncStatus {
  ingest: unknown;
  health: unknown;
  heartbeat: Record<string, unknown>[];
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

export function useSyncOutbound(limit = 80, enabled = true) {
  return useQuery({
    queryKey: [...KEYS.sync, 'outbound', limit],
    enabled,
    queryFn: () =>
      apiFetch<{ data: Record<string, unknown>[] }>(
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

export function useCreateMovement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: MovementVars) =>
      apiFetch<EnvelopeResult>('/v1/locations/movements', {
        method: 'POST',
        body: JSON.stringify(v),
      }),
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
