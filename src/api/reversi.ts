'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

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
 */
export const newClientEventId = (): string => crypto.randomUUID();

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

export function useWarehouse(allLocations = false) {
  return useQuery({
    queryKey: [...KEYS.reports, 'warehouse', allLocations],
    queryFn: () =>
      apiFetch<{ data: WarehouseRow[] }>(
        `/v1/reversi/reports/warehouse${allLocations ? '?allLocations=true' : ''}`,
      ),
  });
}

export function useScrapped(enabled: boolean) {
  return useQuery({
    queryKey: [...KEYS.reports, 'scrapped'],
    enabled,
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

export function useTeamIssued(enabled: boolean) {
  return useQuery({
    queryKey: [...KEYS.reports, 'team-issued'],
    enabled,
    queryFn: () =>
      apiFetch<{ data: Record<string, unknown>[] }>('/v1/reversi/reports/team-issued'),
  });
}

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
