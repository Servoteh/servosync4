'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, apiUpload } from './client';

/** Tip razrešenog barkoda (BE /reversi/lookups/barcode — paritet 1.0 resolveReversiBarcode). */
export type BarcodeKind = 'HAND' | 'CUTTING' | 'EMPLOYEE' | 'UNKNOWN';

export interface BarcodeResult {
  kind: BarcodeKind;
  barcode: string;
  record: ReversiTool | { id: string; full_name: string; department: string | null } | Record<string, unknown> | null;
}

/**
 * Imperativno razrešavanje skeniranog/otkucanog barkoda (poziva se iz skener
 * overlay-a i HID-wedge polja, ne kao useQuery jer je on-demand po skenu).
 */
export function lookupBarcode(code: string): Promise<{ data: BarcodeResult }> {
  return apiFetch<{ data: BarcodeResult }>(`/v1/reversi/lookups/barcode?code=${encodeURIComponent(code)}`);
}

// ------------------------------------------------------------------ tipovi
// Reversi — 3.0 PILOT (2.0 backend docs/design/MODULE_SPEC_reversi.md §4).
// Podaci žive u sy15 (1.0) bazi; backend vraća DVE vrste oblika:
//  • Prisma modeli (documents/tools/…) → camelCase polja,
//  • sy15 view-ovi (reports/*) → snake_case kolone view-a (paritet 1.0, mereno 10.07).

export interface ReversiDocument {
  id: string;
  docNumber: string;
  docType: 'TOOL' | 'COOPERATION_GOODS' | 'CUTTING_TOOL';
  status: 'OPEN' | 'PARTIALLY_RETURNED' | 'RETURNED';
  recipientType: 'EMPLOYEE' | 'DEPARTMENT' | 'EXTERNAL_COMPANY';
  recipientEmployeeId: string | null;
  recipientEmployeeName: string | null;
  recipientDepartment: string | null;
  recipientCompanyName: string | null;
  recipientMachineCode: string | null;
  issuedAt: string;
  issuedToEmployeeName: string | null;
  expectedReturnDate: string | null;
  returnConfirmedAt: string | null;
  pdfStoragePath: string | null;
  napomena: string | null;
}

export interface ReversiTool {
  id: string;
  oznaka: string;
  naziv: string;
  serijskiBroj: string | null;
  barcode: string;
  status: 'active' | 'scrapped' | 'lost';
  isQuantity: boolean;
  isConsumable: boolean;
  totalQty: number;
  subgroupId: string | null;
  napomena: string | null;
}

export interface ReversiDocumentLine {
  id: string;
  documentId: string;
  sortOrder: number;
  lineType: 'TOOL' | 'PRODUCTION_PART';
  toolId: string | null;
  drawingNo: string | null;
  partName: string | null;
  quantity: string | number;
  returnedQuantity: string | number;
  unit: string;
  lineStatus: 'ISSUED' | 'RETURNED' | 'CONSUMED';
  napomena: string | null;
  tool: ReversiTool | null;
}

export type ReversiDocumentDetail = ReversiDocument & { lines: ReversiDocumentLine[] };

/** Red view-a `v_rev_my_issued_tools` (snake_case — kolone izmerene na sy15 10.07). */
export interface MyIssuedRow {
  document_id: string;
  doc_number: string;
  issued_at: string;
  expected_return_date: string | null;
  document_status: string;
  oznaka: string;
  naziv: string;
  serijski_broj: string | null;
  quantity: string | number;
  unit: string;
  pribor: string | null;
  line_status: string;
  subgroup_label: string | null;
  group_label: string | null;
}

/** Red view-a `v_rev_my_consumed`. */
export interface MyConsumedRow {
  ledger_id: string;
  tool_id: string;
  oznaka: string;
  naziv: string;
  subgroup_label: string | null;
  group_label: string | null;
  quantity: number;
  consumed_at: string;
  doc_number: string | null;
  note: string | null;
}

/** Red view-a `v_rev_warehouse_unified` (objedinjeno stanje magacina). */
export interface WarehouseRow {
  grupa: string;
  item_id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  unit: string | null;
  in_warehouse_qty: number | null;
  qty_on_hand: number | null;
  location_code: string | null;
  status: string | null;
  serijski_broj: string | null;
  min_stock_qty: number | null;
  is_quantity: boolean | null;
  is_consumable: boolean | null;
  subgroup_label: string | null;
  group_label: string | null;
}

/** Red view-a `v_rev_otpisani_alat`. */
export interface ScrappedRow {
  id: string;
  oznaka: string;
  naziv: string;
  barcode: string | null;
  serijski_broj: string | null;
  status: string;
  otpis_datum: string | null;
  otpis_razlog: string | null;
  subgroup_label: string | null;
  group_label: string | null;
  ukupan_servis_trosak: number | null;
  broj_servisa: number | null;
}

export interface PageMeta {
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface ReversiDocumentsParams {
  status?: string;
  docType?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ReversiToolsParams {
  status?: string;
  subgroupId?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

// ------------------------------------------------------------------ helpers

/**
 * Idempotency ključ mutacije (backend `rev_api_idempotency`): generiši JEDNOM
 * po korisničkoj akciji (klik) i prosledi u variables — retry ISTE akcije nosi
 * ISTI ključ (backend vraća sačuvan rezultat umesto duplog izvršenja).
 *
 * `crypto.randomUUID` postoji SAMO u secure context-u (https / localhost); na
 * LAN pristupu (`http://192.168.x.x:3000`) ga nema, pa pada nazad na
 * `getRandomValues` (dostupan i van secure context-a) — RFC 4122 v4.
 */
export function newClientEventId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; // verzija 4
  b[8] = (b[8] & 0x3f) | 0x80; // varijanta 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const KEYS = {
  documents: ['reversi', 'documents'] as const,
  tools: ['reversi', 'tools'] as const,
  reports: ['reversi', 'reports'] as const,
};

// ------------------------------------------------------------------ queries

export function useReversiDocuments(params: ReversiDocumentsParams) {
  return useQuery({
    queryKey: [...KEYS.documents, params],
    queryFn: () =>
      apiFetch<{ data: ReversiDocument[]; meta: PageMeta }>(
        `/v1/reversi/documents${qs({ ...params })}`,
      ),
  });
}

export function useReversiDocument(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.documents, 'detail', id],
    enabled: !!id,
    queryFn: () =>
      apiFetch<{ data: ReversiDocumentDetail }>(`/v1/reversi/documents/${id}`),
  });
}

export function useReversiTools(params: ReversiToolsParams) {
  return useQuery({
    queryKey: [...KEYS.tools, params],
    queryFn: () =>
      apiFetch<{ data: ReversiTool[]; meta: PageMeta }>(`/v1/reversi/tools${qs({ ...params })}`),
  });
}

export interface ToolBattery {
  id: string;
  serijskiBroj: string | null;
  kapacitet: string | null;
  datumNabavke: string | null;
  status: string;
  napomena: string | null;
}

export interface ToolService {
  id: string;
  datum: string;
  tip: string;
  opis: string | null;
  izvrsilac: string | null;
  trosak: string | number | null;
  status: string;
  napomena: string | null;
}

export type ReversiToolDetail = ReversiTool & {
  datumKupovine?: string | null;
  nabavnaVrednost?: string | number | null;
  otpisDatum?: string | null;
  otpisRazlog?: string | null;
  batteries: ToolBattery[];
  services: ToolService[];
};

/** Kartica alata: osnovno + baterije + servisi (GET /reversi/tools/:id). */
export function useReversiTool(id: string | null) {
  return useQuery({
    queryKey: [...KEYS.tools, 'detail', id],
    enabled: !!id,
    queryFn: () => apiFetch<{ data: ReversiToolDetail }>(`/v1/reversi/tools/${id}`),
  });
}

export function useMyIssuedTools() {
  return useQuery({
    queryKey: [...KEYS.reports, 'my-issued'],
    queryFn: () => apiFetch<{ data: MyIssuedRow[] }>('/v1/reversi/reports/my-issued'),
  });
}

export function useMyConsumed() {
  return useQuery({
    queryKey: [...KEYS.reports, 'my-consumed'],
    queryFn: () => apiFetch<{ data: MyConsumedRow[] }>('/v1/reversi/reports/my-consumed'),
  });
}

export function useWarehouse() {
  return useQuery({
    queryKey: [...KEYS.reports, 'warehouse'],
    queryFn: () => apiFetch<{ data: WarehouseRow[] }>('/v1/reversi/reports/warehouse'),
  });
}

export function useScrapped() {
  return useQuery({
    queryKey: [...KEYS.reports, 'scrapped'],
    queryFn: () => apiFetch<{ data: ScrappedRow[] }>('/v1/reversi/reports/scrapped'),
  });
}

export interface EmployeeOption {
  id: string;
  full_name: string;
  department: string | null;
  position: string | null;
}

/** Picker radnika za Izdaj (BE /reversi/lookups/employees — aktivni, bez PII). */
export function useEmployeeLookup(q: string) {
  return useQuery({
    queryKey: ['reversi', 'lookups', 'employees', q],
    queryFn: () =>
      apiFetch<{ data: EmployeeOption[] }>(`/v1/reversi/lookups/employees${qs({ q })}`),
  });
}

// TODO(reversi): „Moj tim" pogled (TL/šef vidi zaduženja svog tima) — spec §6/§8,
// permisija reversi.team_read (get_team_issued_tools kroz GUC). Odloženo dok BE
// endpoint /reversi/reports/team-issued ne postoji; ranije stanje je bio mrtav hook.

// ------------------------------------------------------------------ mutations
// Sve nose obavezan clientEventId (vidi newClientEventId). Odgovor:
// { data: <rezultat DB fn>, meta: { idempotent: boolean } }.

interface TxResult {
  data: unknown;
  meta: { idempotent: boolean };
}

function useReversiTx<V extends { clientEventId: string }>(
  path: (v: V) => string,
  body: (v: V) => object,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: V) =>
      apiFetch<TxResult>(path(v), { method: 'POST', body: JSON.stringify(body(v)) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reversi'] });
    },
  });
}

export interface IssueVars {
  clientEventId: string;
  /** jsonb payload — ista struktura koju 1.0 `issueDialog` gradi (DB fn validira). */
  payload: Record<string, unknown>;
}

export const useReversiIssue = () =>
  useReversiTx<IssueVars>(
    () => '/v1/reversi/issue',
    (v) => v,
  );

export const useReversiReturn = () =>
  useReversiTx<IssueVars>(
    () => '/v1/reversi/return',
    (v) => v,
  );

export interface WriteOffVars {
  clientEventId: string;
  toolId: string;
  razlog?: string;
  datum?: string;
  status?: 'scrapped' | 'lost';
}

export const useWriteOffTool = () =>
  useReversiTx<WriteOffVars>(
    (v) => `/v1/reversi/tools/${v.toolId}/write-off`,
    ({ clientEventId, razlog, datum, status }) => ({ clientEventId, razlog, datum, status }),
  );

export interface RestoreVars {
  clientEventId: string;
  toolId: string;
}

export const useRestoreTool = () =>
  useReversiTx<RestoreVars>(
    (v) => `/v1/reversi/tools/${v.toolId}/restore`,
    ({ clientEventId }) => ({ clientEventId }),
  );

export interface StockDeltaVars {
  clientEventId: string;
  toolId: string;
  delta: number;
  reason: string;
  note?: string;
}

export const useStockDelta = () =>
  useReversiTx<StockDeltaVars>(
    (v) => `/v1/reversi/tools/${v.toolId}/stock-delta`,
    ({ clientEventId, delta, reason, note }) => ({ clientEventId, delta, reason, note }),
  );

/** Upload potpisnice (multipart) na BE (bucket reversal-pdf). */
export function useUploadSignaturePdf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId, blob }: { docId: string; blob: Blob }) => {
      const fd = new FormData();
      fd.append('file', blob, `${docId}.pdf`);
      return apiUpload<{ data: { path: string } }>(
        `/v1/reversi/documents/${docId}/signature-pdf`,
        fd,
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'documents'] }),
  });
}

/** Potpisan URL za preuzimanje potpisnice (GET). */
export function fetchSignaturePdfUrl(docId: string): Promise<{ data: { url: string; expiresIn: number } }> {
  return apiFetch(`/v1/reversi/documents/${docId}/signature-pdf`);
}

export interface BulkToolRow {
  oznaka: string;
  naziv: string;
  serijskiBroj?: string;
  isQuantity?: boolean;
  isConsumable?: boolean;
  totalQty?: number;
  napomena?: string;
}

export interface BulkImportResult {
  created: number;
  skipped: number;
  total: number;
  errors: { oznaka: string; error: string }[];
}

/** Bulk-import inventara ručnog alata (redovi parsirani iz XLSX/CSV na klijentu). */
export function useBulkImportTools() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rows: BulkToolRow[]) =>
      apiFetch<{ data: BulkImportResult }>('/v1/reversi/bulk-import/tools', {
        method: 'POST',
        body: JSON.stringify({ rows }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi'] }),
  });
}

/** Red view-a `v_rev_machines` (nad maint_machines — Reversi kontekst mašina). */
export interface MachineRow {
  machine_code: string;
  name: string;
  type: string | null;
  manufacturer: string | null;
  model: string | null;
  location: string | null;
  tracked: boolean | null;
  archived_at: string | null;
}

/** Red view-a `v_rev_cts_by_machine` (rezni alat po mašini). */
export interface CuttingByMachineRow {
  machine_code: string;
  machine_name: string | null;
  catalog_id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  unit: string | null;
  remaining_qty: number | null;
  last_issued_at: string | null;
  last_issued_to_name: string | null;
  subgroup_label: string | null;
  group_label: string | null;
}

export function useReversiMachines() {
  return useQuery({
    queryKey: [...KEYS.reports, 'machines'],
    queryFn: () => apiFetch<{ data: MachineRow[] }>('/v1/reversi/reports/machines'),
  });
}

// ------------------------------------------------------------------ rezni alat

export interface CuttingTool {
  id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  unit: string;
  status: string;
  minStockQty: number;
  compatibleMachineCodes: string[];
  napomena: string | null;
  onHandQty: number;
}

export function useCuttingTools(q: string) {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'catalog', q],
    queryFn: () => apiFetch<{ data: CuttingTool[] }>(`/v1/reversi/cutting-tools${qs({ q })}`),
  });
}

export interface CuttingToolCreate {
  oznaka: string;
  naziv: string;
  unit?: string;
  minStockQty?: number;
  compatibleMachineCodes?: string[];
  napomena?: string;
}

export function useCreateCuttingTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CuttingToolCreate) =>
      apiFetch<{ data: { id: string } }>('/v1/reversi/cutting-tools', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'cutting'] }),
  });
}

export interface MachineHead {
  id: string;
  machineCode: string;
  oznaka: string;
  naziv: string;
  tip: string | null;
  serijskiBroj: string | null;
  status: string;
  napomena: string | null;
}

export function useMachineHeads(machineCode: string | null) {
  return useQuery({
    queryKey: ['reversi', 'machine-heads', machineCode],
    enabled: !!machineCode,
    queryFn: () => apiFetch<{ data: MachineHead[] }>(`/v1/reversi/machines/${machineCode}/heads`),
  });
}

export function useCuttingByMachine(machineCode: string | null) {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'by-machine', machineCode],
    enabled: !!machineCode,
    queryFn: () =>
      apiFetch<{ data: CuttingByMachineRow[] }>(`/v1/reversi/reports/cutting-by-machine${qs({ machineCode: machineCode ?? '' })}`),
  });
}

/** Seed/dopuna stanja reznog po lokaciji (rev_cutting_tool_seed_stock). */
export interface SeedStockVars {
  clientEventId: string;
  catalogId: string;
  /** Opciono — bez lokacije BE koristi podrazumevani magacin (ALAT-MAG-01). */
  locationId?: string;
  qty: number;
}
export const useSeedCuttingStock = () =>
  useReversiTx<SeedStockVars>(
    (v) => `/v1/reversi/cutting-tools/${v.catalogId}/seed-stock`,
    ({ clientEventId, locationId, qty }) =>
      locationId ? { clientEventId, locationId, qty } : { clientEventId, qty },
  );

/** Izdavanje reznog na mašinu (rev_issue_cutting_reversal jsonb pass-through). */
export const useCuttingIssue = () =>
  useReversiTx<IssueVars>(
    () => '/v1/reversi/cutting-issue',
    (v) => v,
  );
