'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  status: 'OPEN' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'CANCELLED';
  recipientType: 'EMPLOYEE' | 'DEPARTMENT' | 'EXTERNAL_COMPANY';
  recipientEmployeeId: string | null;
  recipientEmployeeName: string | null;
  recipientDepartment: string | null;
  recipientCompanyName: string | null;
  /** PIB eksterne firme-primaoca (kooperacija) — potpisnica „firma (PIB: …)" (R4-PAR-02). */
  recipientCompanyPib: string | null;
  recipientMachineCode: string | null;
  issuedAt: string;
  issuedToEmployeeName: string | null;
  expectedReturnDate: string | null;
  returnConfirmedAt: string | null;
  pdfStoragePath: string | null;
  napomena: string | null;
  /** Broj stavki (rev_document_lines) — kolona „Stavki" (RB-22) + CSV (RB-25). */
  lineCount: number;
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

export type ReversiDocumentDetail = ReversiDocument & {
  lines: ReversiDocumentLine[];
  /**
   * Odeljenje radnika-primaoca (samo u detail odgovoru, BE `findOneDocument`) — za
   * potpisnicu „(Radnik — …)" (R4-PAR-02, paritet 1.0 `fetchEmployeeDepartment`).
   */
  recipientEmployeeDepartment?: string | null;
};

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

/**
 * Red view-a `v_rev_warehouse_unified` (`allLocations=false`) / `v_rev_inventory_all_locations`
 * (`allLocations=true`, dodaje `qty_total`). Objedinjeno stanje magacina — paritet 1.0
 * `fetchUnifiedWarehouse`. Filteri (grupa/pretraga/klasa/nulta stanja/sve lokacije) i
 * status-boje računaju se KLIJENTSKI nad ovim redovima (RA-30/33, magacinTab.js:73-146).
 */
export interface WarehouseRow {
  grupa: string;
  item_id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  /** Izvedena klasa (subgroup label) — dinamičan select „Klasa" + CSV (RA-30/36). */
  klasa: string | null;
  unit: string | null;
  in_warehouse_qty: number | null;
  qty_on_hand: number | null;
  /** Suma po SVIM lokacijama — samo `allLocations=true` varijanta (RA-33 „Kod primaoca"). */
  qty_total?: number | null;
  location_code: string | null;
  location_label: string | null;
  status: string | null;
  serijski_broj: string | null;
  min_stock_qty: number | null;
  max_stock_qty: number | null;
  is_quantity: boolean | null;
  is_consumable: boolean | null;
  napomena: string | null;
  subgroup_label: string | null;
  group_label: string | null;
}

/**
 * Red obogaćenog ledgera `v_rev_stock_ledger_detail` — izveštaj potrošnje/pokreta
 * (RA-39/40/41, paritet 1.0 `fetchConsumptionReport`). `delta`/`balance_after` su
 * čisti JS brojevi (BE kastuje u float8).
 */
export interface ConsumptionRow {
  ledger_id: string;
  tool_id: string | null;
  oznaka: string | null;
  naziv: string | null;
  is_consumable: boolean | null;
  subgroup_label: string | null;
  group_label: string | null;
  delta: number;
  reason: string;
  balance_after: number;
  ref_doc_id: string | null;
  doc_number: string | null;
  recipient_type: string | null;
  recipient_employee_name: string | null;
  recipient_department: string | null;
  recipient_company_name: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ConsumptionReportParams {
  /** 'YYYY-MM-DD' — `created_at >=` (default = 1. tekućeg meseca). */
  from?: string;
  /** 'YYYY-MM-DD' — inkluzivno do 23:59:59 tog dana. */
  to?: string;
  /** ISSUE | WRITE_OFF | RECEIPT | RETURN | ADJUST | ALL. */
  reason?: string;
  /** Fetch-all u jednom pozivu (default 2000, max 5000); FE agregira + CSV. */
  limit?: number;
}

/**
 * Izveštaj potrošnje (RA-39/40/41) — `reversi.manage`-gejtovan (kao `/ledger`).
 * Imperativno (poziva se iz dijaloga na „Prikaži"), fetch-all u jednom pozivu.
 */
export function fetchConsumptionReport(
  params: ConsumptionReportParams,
): Promise<{ data: ConsumptionRow[] }> {
  return apiFetch<{ data: ConsumptionRow[] }>(
    `/v1/reversi/reports/consumption${qs({ ...params })}`,
  );
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
  /** CSV lista statusa (npr. `OPEN,PARTIALLY_RETURNED`); prednost nad `status` (RB-20). */
  statuses?: string;
  /** `true` → OPEN/PARTIALLY_RETURNED sa istekim rokom; prednost nad `statuses`/`status` (RB-20). */
  overdue?: boolean;
  docType?: string;
  /** ISO — `issued_at` gte (RB-19 mesec, UTC početak). */
  issuedFrom?: string;
  /** ISO — `issued_at` lte (RB-19 mesec, UTC kraj). */
  issuedTo?: string;
  q?: string;
  page?: number;
  pageSize?: number;
}

/** Kontekst-filteri koji ulaze u SVE KPI count-ove i cardinality (RB-16, paritet 1.0). */
export interface ReversiKpiContext {
  q?: string;
  docType?: string;
  issuedFrom?: string;
  issuedTo?: string;
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

function qs(params: Record<string, string | number | boolean | undefined>): string {
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

/** Broj RAZLIČITIH primalaca na aktivnim reversima — KPI „Primaoci (aktivno)" (RB-16). */
export interface RecipientCardinality {
  count: number;
  /** Uvek `false` u 2.0 (tačan COUNT(DISTINCT), nije uzorak kao 1.0). */
  truncated: boolean;
}

export function useReversiRecipientCardinality(ctx: ReversiKpiContext) {
  return useQuery({
    queryKey: [...KEYS.documents, 'recipient-cardinality', ctx],
    queryFn: () =>
      apiFetch<{ data: RecipientCardinality }>(
        `/v1/reversi/documents/recipient-cardinality${qs({ ...ctx })}`,
      ),
  });
}

export interface ReversiKpis {
  /** OPEN + PARTIALLY_RETURNED. */
  nAkt: number;
  /** overdue = aktivni sa istekim rokom. */
  nOver: number;
  /** RETURNED. */
  nRet: number;
  /** CANCELLED. */
  nCan: number;
  /** Broj različitih primalaca na aktivnim reversima. */
  nRecip: number;
  nRecipTrunc: boolean;
}

/**
 * 5 KPI kartica Zaduženja (RB-16, paritet 1.0 `renderZaduzenjaPanel` count blok):
 * 4 count-a iz `meta.pagination.total` (pageSize=1, prednost overdue > statuses >
 * status) + „Primaoci (aktivno)" iz `recipient-cardinality`. Kontekst-filteri
 * (mesec/tip/pretraga) ulaze u SVAKI count.
 */
export function useReversiKpis(ctx: ReversiKpiContext): ReversiKpis {
  const active = useReversiDocuments({
    ...ctx,
    statuses: 'OPEN,PARTIALLY_RETURNED',
    page: 1,
    pageSize: 1,
  });
  const returned = useReversiDocuments({ ...ctx, status: 'RETURNED', page: 1, pageSize: 1 });
  const cancelled = useReversiDocuments({ ...ctx, status: 'CANCELLED', page: 1, pageSize: 1 });
  const overdue = useReversiDocuments({ ...ctx, overdue: true, page: 1, pageSize: 1 });
  const recip = useReversiRecipientCardinality(ctx);
  return {
    nAkt: active.data?.meta.pagination.total ?? 0,
    nOver: overdue.data?.meta.pagination.total ?? 0,
    nRet: returned.data?.meta.pagination.total ?? 0,
    nCan: cancelled.data?.meta.pagination.total ?? 0,
    nRecip: recip.data?.data.count ?? 0,
    nRecipTrunc: recip.data?.data.truncated ?? false,
  };
}

/**
 * Fetch-all filtriranog skupa dokumenata za CSV izvoz (RB-25). Prolazi kroz strane
 * (BE cap 200/req) do `meta.total`; plafon 100 strana (≈20k) čuva od runaway petlje
 * na pogrešnom total-u. 1.0 je izvozio samo učitane redove — 2.0 izvozi ceo skup.
 */
export async function fetchAllReversiDocuments(
  params: ReversiDocumentsParams,
): Promise<ReversiDocument[]> {
  const pageSize = 200;
  const out: ReversiDocument[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const res = await apiFetch<{ data: ReversiDocument[]; meta: PageMeta }>(
      `/v1/reversi/documents${qs({ ...params, page, pageSize })}`,
    );
    out.push(...res.data);
    if (res.data.length === 0 || out.length >= res.meta.pagination.total) break;
  }
  return out;
}

/**
 * Imperativni fetch jednog dokumenta sa stavkama (van React Query cache-a) — za
 * per-red „Potpisnica PDF" akciju u tabeli Zaduženja (R4-PAR-03), gde nema montiran
 * `useReversiDocument`. Vraća `data` telo (uklj. `lines` + `recipientEmployeeDepartment`).
 */
export async function fetchReversiDocument(id: string): Promise<ReversiDocumentDetail> {
  const res = await apiFetch<{ data: ReversiDocumentDetail }>(`/v1/reversi/documents/${id}`);
  return res.data;
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
  subsubgroupId?: string | null;
  datumKupovine?: string | null;
  nabavnaVrednost?: string | number | null;
  garancijaDo?: string | null;
  garancijaNapomena?: string | null;
  imaPunjac?: boolean;
  punjacSerijski?: string | null;
  minStockQty?: number | null;
  maxStockQty?: number | null;
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

/** Red istorije zaliha `rev_tool_stock_ledger` (RA-20 — GET /reversi/ledger?toolId=). */
export interface ToolLedgerRow {
  id: string;
  toolId: string;
  delta: number;
  reason: string;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
}

/**
 * Istorija promene zaliha za količinski/potrošni artikal (RA-19/RA-20). Ruta je
 * `reversi.manage`-gejtovana (RLS `rev_tool_stock_ledger_select = rev_can_manage`),
 * pa se poziva tek kad je korisnik manage i kad je artikal količinski.
 */
export function useToolLedger(toolId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: [...KEYS.tools, 'ledger', toolId],
    enabled: !!toolId && enabled,
    queryFn: () =>
      apiFetch<{ data: ToolLedgerRow[]; meta: PageMeta }>(
        `/v1/reversi/ledger${qs({ toolId: toolId ?? undefined, pageSize: 200 })}`,
      ),
  });
}

// ---------------------------------------------- Alat i oprema (jedinice + stablo)
// R1 (RA-08/10/12/13/14/15/16/17/18/21/23): per-jedinica katalog ručnog alata/LZO.
// BE: GET /reversi/inventory-units (server-side status/klasifikacija/sort/paginacija,
// pageSize do 5000 za CSV) i GET /reversi/inventory-tree (grupe/podgrupe/podpodgrupe).

/** Primalac otvorenog reversa po jedinici (issuedHolder iz inventory-units). */
export interface IssuedHolder {
  docNumber: string;
  recipientType: string;
  recipientEmployeeName: string | null;
  recipientDepartment: string | null;
  recipientCompanyName: string | null;
}

/** Klasifikacija u redu jedinice (grupa = bez id; pod/podpod nose id). */
export interface UnitGroupRef {
  code: string;
  label: string;
}
export interface UnitSubRef {
  id: string;
  code: string;
  label: string;
}

/**
 * Red `GET /reversi/inventory-units` — puna rev_tools polja (camelCase) + razrešena
 * klasifikacija, trenutna lokacija i zaduženje. (Deklarisan je podskup polja koji
 * FE koristi; BE spreada ceo model pa dodatna polja postoje u payload-u.)
 */
export interface InventoryUnitRow {
  id: string;
  oznaka: string;
  naziv: string;
  barcode: string;
  serijskiBroj: string | null;
  datumKupovine: string | null;
  status: string;
  napomena: string | null;
  isQuantity: boolean;
  isConsumable: boolean;
  totalQty: number;
  minStockQty: number | null;
  maxStockQty: number | null;
  subgroupId: string | null;
  subsubgroupId: string | null;
  group: UnitGroupRef | null;
  subgroup: UnitSubRef | null;
  subsubgroup: UnitSubRef | null;
  currentLocationId: string | null;
  currentLocationCode: string | null;
  issuedHolder: IssuedHolder | null;
}

export interface InventoryUnitsParams {
  status?: string;
  q?: string;
  groupCode?: string;
  subgroupId?: string;
  subsubgroupId?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

function unitsUrl(params: InventoryUnitsParams): string {
  return `/v1/reversi/inventory-units${qs({ ...params })}`;
}

export function useInventoryUnits(
  params: InventoryUnitsParams,
  options?: { staleTime?: number },
) {
  return useQuery({
    queryKey: [...KEYS.tools, 'inventory-units', params],
    queryFn: () => apiFetch<{ data: InventoryUnitRow[]; meta: PageMeta }>(unitsUrl(params)),
    // Zadrži prethodnu stranu dok se sledeća učitava — paginacija bez treptaja.
    placeholderData: keepPreviousData,
    // Opc. staleTime — stat kartice (RA-10, uzorak do 2000 redova) ga postavljaju
    // duže da se skup ne re-fetchuje na svaki fokus/mount (R1-REV-03).
    ...(options?.staleTime != null ? { staleTime: options.staleTime } : {}),
  });
}

/** Fetch-all (do 5000) za CSV izvoz celog filtriranog skupa (RA-23) — imperativno. */
export function fetchInventoryUnits(
  params: InventoryUnitsParams,
): Promise<{ data: InventoryUnitRow[]; meta: PageMeta }> {
  return apiFetch<{ data: InventoryUnitRow[]; meta: PageMeta }>(unitsUrl(params));
}

/** Stablo klasifikacije (grupe → podgrupe → podpodgrupe) za kaskadne filtere. */
export interface InventoryGroup {
  id: string;
  code: string;
  label: string;
  appliesTo: string;
  displayOrder: number;
  icon: string | null;
  isSeeded: boolean;
  napomena: string | null;
}
export interface InventorySubgroup {
  id: string;
  groupId: string;
  code: string;
  label: string;
  displayOrder: number;
  isSeeded: boolean;
  napomena: string | null;
}
export interface InventorySubsubgroup {
  id: string;
  subgroupId: string;
  code: string;
  label: string;
  displayOrder: number;
  isSeeded: boolean;
  napomena: string | null;
}
export interface InventoryTree {
  groups: InventoryGroup[];
  subgroups: InventorySubgroup[];
  subsubgroups: InventorySubsubgroup[];
}

export function useInventoryTree() {
  return useQuery({
    queryKey: [...KEYS.tools, 'inventory-tree'],
    queryFn: () => apiFetch<{ data: InventoryTree }>('/v1/reversi/inventory-tree'),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Broj artikala po podgrupi/podpodgrupi (RA-25 brojači u stablu; RA-28 upozorenje
 * „X postaje nesvrstano"). `tools`+`cutting` su po `subgroupId`, `subsubs` po
 * `subsubgroupId`.
 */
export interface ClassificationUsage {
  tools: Record<string, number>;
  cutting: Record<string, number>;
  subsubs: Record<string, number>;
}

export function useInventoryClassificationUsage() {
  return useQuery({
    queryKey: [...KEYS.tools, 'classification-usage'],
    queryFn: () =>
      apiFetch<{ data: ClassificationUsage }>('/v1/reversi/inventory-classification-usage'),
    staleTime: 60 * 1000,
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

/**
 * Red view-a `v_rev_my_machines_cutting_tools` (rezni alat na mašinama prijavljenog
 * korisnika) — RB-27 3. izvor. Kolone su nullable jer 1.0 `cuttingCard` čita uz
 * fallback-e (`remaining_quantity ?? quantity`, opciono `klasa`/`issued_to_employee_name`).
 */
export interface MyMachineCuttingRow {
  line_id: string;
  recipient_machine_code: string | null;
  barcode: string | null;
  oznaka: string | null;
  naziv: string | null;
  klasa: string | null;
  quantity: string | number | null;
  remaining_quantity: string | number | null;
  returned_quantity: string | number | null;
  unit: string | null;
  issued_to_employee_name: string | null;
  issued_at: string | null;
  doc_number: string | null;
}

/** Rezni alat na MOJIM mašinama (RB-27 3. izvor — endpoint živ, FE ga do sada nije koristio). */
export function useMyMachinesCutting() {
  return useQuery({
    queryKey: [...KEYS.reports, 'my-machines-cutting'],
    queryFn: () =>
      apiFetch<{ data: MyMachineCuttingRow[] }>('/v1/reversi/reports/my-machines-cutting'),
  });
}

/**
 * Sve MOJE otvorene rezne linije (RB-27 4. izvor — rezni koji sam potpisao). Isti
 * endpoint kao Quick Return skener ali BEZ barkoda (user-scoped, sve otvorene linije).
 */
export function useMyCuttingOpenLines() {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'my-open-lines'],
    queryFn: () => fetchCuttingOpenLines(),
  });
}

/**
 * Objedinjeno stanje magacina (RA-29–36). `allLocations=true` prebacuje na
 * `v_rev_inventory_all_locations` (dodaje `qty_total` po svim lokacijama) — prekidač
 * „Sve lokacije" u traci filtera (RA-30). Ostali filteri su klijentski nad odgovorom.
 */
export function useWarehouse(allLocations = false) {
  return useQuery({
    queryKey: [...KEYS.reports, 'warehouse', allLocations],
    queryFn: () =>
      apiFetch<{ data: WarehouseRow[] }>(
        `/v1/reversi/reports/warehouse${qs({ allLocations: allLocations || undefined })}`,
      ),
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
  /**
   * RB-35 — BE vraća I NEAKTIVNE (FE ih sivi + badž „neaktivan"); pretraga matchuje
   * i `position`. Aktivni su prvi u odgovoru (ORDER BY is_active DESC).
   */
  is_active: boolean;
}

/** Picker radnika za Izdaj (BE /reversi/lookups/employees — uklj. neaktivne, bez PII). */
export function useEmployeeLookup(q: string) {
  return useQuery({
    queryKey: ['reversi', 'lookups', 'employees', q],
    queryFn: () =>
      apiFetch<{ data: EmployeeOption[] }>(`/v1/reversi/lookups/employees${qs({ q })}`),
  });
}

/** Aktivna lokacija (RB-45 — dropdown lokacije povraćaja; BE /reversi/lookups/locations). */
export interface ReversiLocation {
  id: string;
  location_code: string;
  name: string | null;
  location_type: string | null;
}

/**
 * Aktivne `loc_locations` za izbor lokacije povraćaja (RB-45). FE šalje izabrani
 * `id` kao `return_to_location_id` u `POST /return` (bez izbora → BE ALAT-MAG-01).
 * Dugi staleTime — lokacije se retko menjaju, a modal povraćaja se često otvara.
 */
export function useReversiLocations() {
  return useQuery({
    queryKey: ['reversi', 'lookups', 'locations'],
    queryFn: () => apiFetch<{ data: ReversiLocation[] }>('/v1/reversi/lookups/locations'),
    staleTime: 5 * 60 * 1000,
  });
}

/**
 * Otvorena ISSUED linija RUČNOG alata po barkodu — Quick Return HAND (RB-43/44).
 * NIJE user-scoped (nalazi otvoren revers BILO KOG primaoca — paritet 1.0
 * `fetchOpenHandLineByToolBarcode`); FIFO najstariji; `remainingQty = max(1, izdato−vraćeno)`.
 * `data:null` = nema otvorenog reversa za taj alat. Imperativno (on-demand po skenu).
 */
export interface OpenHandLine {
  lineId: string;
  documentId: string;
  docNumber: string;
  recipientLabel: string;
  issuedQty: number;
  returnedQty: number;
  remainingQty: number;
  tool: { id: string; oznaka: string; naziv: string; barcode: string; serijskiBroj: string | null };
}

export function fetchOpenHandLine(barcode: string): Promise<{ data: OpenHandLine | null }> {
  return apiFetch<{ data: OpenHandLine | null }>(
    `/v1/reversi/documents/open-hand-line${qs({ barcode })}`,
  );
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
  // RA-24 — klasifikacija + datum kupovine iz CSV-a (FE mapira subgroup_code→id iz
  // stabla pre slanja; 2.0 pilot ih je gubio pri uvozu).
  subgroupId?: string;
  subsubgroupId?: string;
  datumKupovine?: string;
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

/** Raspored izdatog reznog po mašinama (RC-10 expand reda) — BE `machineBreakdown`. */
export interface CuttingMachineBreakdown {
  machineCode: string;
  qty: number;
}

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
  /** Magacinski raspoloživo (SUM samo po lokacijama location_type='WAREHOUSE'). */
  inWarehouseQty: number;
  /** Izdato po mašinama (SUM v_rev_cts_machine_stock.outstanding_qty). */
  onMachinesQty: number;
  /** UKUPNO = inWarehouseQty + onMachinesQty (paritet 1.0 total_on_hand). */
  onHandQty: number;
  /** Izdato razloženo po mašini (RC-10 „Raspored po mašinama"), sortirano po šifri. */
  machineBreakdown: CuttingMachineBreakdown[];
}

/**
 * Ceo (nefiltrirani) katalog reznog za mapu/workbench/pickere i tab-brojače.
 * `pageSize=15000` je OBAVEZAN: R5 BE `listCuttingTools` bez `pageSize` pada na
 * podrazumevanih 50 (parsePagination default), pa bi mapa/workbench/izdavanje tiho
 * dobili samo prvih 50 šifri. Vraća do 15000 (BE `maxSize`) — dovoljno za realni
 * katalog reznog (prod je trenutno prazan; puni se domenskom odlukom o source-lokaciji).
 */
export function useCuttingTools(q: string) {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'catalog', q],
    queryFn: () =>
      apiFetch<{ data: CuttingTool[]; meta?: PageMeta }>(
        `/v1/reversi/cutting-tools${qs({ q, pageSize: 15000 })}`,
      ),
  });
}

/** Filteri Katalog pod-taba (RC-04 mašina, RC-05 status, RC-13/14 paginacija). */
export interface CuttingCatalogParams {
  q?: string;
  /** `active`|`scrapped`|`all`/prazno = svi (BE tretira „all"/nepoznato bez filtera). */
  status?: string;
  /** `machine_code` (rj_code) — BE filtrira `compatible_machine_codes` sadrži šifru. */
  machine?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Katalog reznog za Katalog pod-tab (RC-04/05/13/14): filter po mašini + statusu,
 * paginacija sa `meta.total` (za „Učitaj još" i „Ukupno šifri"). `status='all'` /
 * prazno → bez statusnog filtera (BE ga ignoriše). `keepPreviousData` da tabela ne
 * treperi pri „Učitaj još"/promeni filtera.
 */
export function useCuttingCatalog(params: CuttingCatalogParams) {
  const { q, status, machine, page, pageSize } = params;
  return useQuery({
    queryKey: [
      'reversi',
      'cutting',
      'catalog-list',
      q ?? '',
      status ?? '',
      machine ?? '',
      page ?? 1,
      pageSize ?? 0,
    ],
    placeholderData: keepPreviousData,
    queryFn: () =>
      apiFetch<{ data: CuttingTool[]; meta: PageMeta }>(
        `/v1/reversi/cutting-tools${qs({
          q,
          status: status && status !== 'all' ? status : undefined,
          machine,
          page,
          pageSize,
        })}`,
      ),
  });
}

/** Stanje jedne šifre po lokaciji (RC-25 detalj) — `GET /cutting-tools/:id` → `stock[]`. */
export interface CuttingStockLocation {
  location_id: string;
  location_code: string;
  name: string | null;
  location_type: string | null;
  on_hand_qty: number;
}

/** Detalj šifre reznog + stanje po lokacijama (RC-25). `stock` sortiran količinom opadajuće. */
export interface CuttingToolDetail {
  id: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  unit: string;
  status: string;
  minStockQty: number;
  compatibleMachineCodes: string[];
  napomena: string | null;
  stock: CuttingStockLocation[];
}

export function useCuttingToolDetail(id: string | null) {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'detail', id],
    enabled: !!id,
    queryFn: () =>
      apiFetch<{ data: CuttingToolDetail }>(`/v1/reversi/cutting-tools/${id}`),
  });
}

/** Otvorena ISSUED linija reznog alata prijavljenog korisnika (open-lines, FIFO). */
export interface CuttingOpenLine {
  lineId: string;
  documentId: string;
  docNumber: string;
  catalogId: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  issuedQty: number;
  returnedQty: number;
  remainingQty: number;
  unit: string;
  machineCode: string | null;
  issuedAt: string;
  expectedReturnDate: string | null;
  lineStatus: string;
  documentStatus: string;
}

/**
 * Otvorene ISSUED linije reznog alata prijavljenog korisnika za skenirani barkod
 * (FIFO po issuedAt ASC). Imperativno (kao lookupBarcode) — poziva se on-demand po
 * skenu/unosu u modalu povraćaja. `barcode` prazan → sve otvorene linije korisnika.
 */
export function fetchCuttingOpenLines(barcode?: string): Promise<{ data: CuttingOpenLine[] }> {
  return apiFetch<{ data: CuttingOpenLine[] }>(
    `/v1/reversi/cutting-tools/open-lines${qs({ barcode })}`,
  );
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

/**
 * Izmena šifre reznog alata (RA-34 „olovka" za CUTTING iz magacina) → PATCH
 * /reversi/cutting-tools/:id. Menjaju se naziv/jm/min. zaliha/mašine/status/napomena
 * (oznaka je nepromenljiva na BE). Paritet 1.0 `openAddCuttingToolModal({tool})`.
 */
export interface CuttingToolUpdate {
  naziv?: string;
  unit?: string;
  minStockQty?: number;
  compatibleMachineCodes?: string[];
  status?: string;
  napomena?: string | null;
}

export function useUpdateCuttingTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: CuttingToolUpdate }) =>
      apiFetch<{ data: unknown }>(`/v1/reversi/cutting-tools/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi'] }),
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

/**
 * Rezni alat po SVIM mašinama (bez filtera po šifri) — izvor za „Mapu (rezni)"
 * (RA-47/50, paritet 1.0 `fetchCuttingByMachine({})`). BE `cuttingByMachine` bez
 * `machineCode` vraća ceo `v_rev_cts_by_machine`.
 */
export function useCuttingByMachineAll() {
  return useQuery({
    queryKey: ['reversi', 'cutting', 'by-machine', 'all'],
    queryFn: () =>
      apiFetch<{ data: CuttingByMachineRow[] }>('/v1/reversi/reports/cutting-by-machine'),
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

/**
 * Povraćaj reznog u magacin (rev_confirm_cutting_return jsonb pass-through). Jedan
 * poziv = jedan dokument (grupiši stavke po documentId). return_to_location_id=null
 * → BE/DB fn koristi ALAT-MAG-01. Idempotency: STABILAN clientEventId PO DOKUMENTU
 * (isti na retry) — jer bi jedan ključ za više dokumenata (deljena akcija
 * "reversi.cutting-return") tiho vratio keširani rezultat prvog i preskočio ostale.
 */
export const useCuttingReturn = () =>
  useReversiTx<IssueVars>(
    () => '/v1/reversi/cutting-return',
    (v) => v,
  );

// ---------------------------------------------- R1 inventar CRUD (RB-46 / RB-11 / RA-25–28)
// Nova jedinica / izmena artikla + klasifikacija (podgrupa/podpodgrupa CRUD). Sve su
// manage-gejtovane na BE. Invalidiraju ceo `['reversi']` (jedinice + stablo + usage +
// magacin izvedeni iz istih tabela). SQLSTATE kanon je već mapiran na BE (42501→403,
// P0001/22023/23503→422, 23505/P2002→409, P2025→404) — FE samo prikaže poruku.

/** Nova jedinica ručnog alata (RB-46) → POST /reversi/tools. Vraća barcode za RB-47. */
export interface CreateToolInput {
  oznaka: string;
  naziv: string;
  subgroupId?: string | null;
  subsubgroupId?: string | null;
  serijskiBroj?: string | null;
  datumKupovine?: string | null;
  napomena?: string | null;
  isQuantity?: boolean;
  isConsumable?: boolean;
  totalQty?: number;
  minStockQty?: number | null;
  maxStockQty?: number | null;
  /**
   * Idempotency ključ — stabilan po otvaranju forme, isti kroz retry ISTOG
   * submita. Dupli klik / retry vraća PRVU kreiranu jedinicu umesto drugog
   * barkoda (BE createTool je runIdempotent). Vidi newClientEventId.
   */
  clientEventId?: string;
}

export interface CreateToolResult {
  id: string;
  oznaka: string;
  naziv: string;
  barcode: string;
  locItemRefId: string | null;
  placement: unknown;
}

export function useCreateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateToolInput) =>
      apiFetch<{ data: CreateToolResult }>('/v1/reversi/tools', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi'] }),
  });
}

/** Izmena artikla (RB-11) → PATCH /reversi/tools/:id. `null` briše polje (klasa/serijski/…). */
export interface UpdateToolInput {
  oznaka?: string;
  naziv?: string;
  subgroupId?: string | null;
  subsubgroupId?: string | null;
  serijskiBroj?: string | null;
  datumKupovine?: string | null;
  nabavnaVrednost?: number | null;
  garancijaDo?: string | null;
  garancijaNapomena?: string | null;
  imaPunjac?: boolean;
  punjacSerijski?: string | null;
  napomena?: string | null;
  minStockQty?: number | null;
  maxStockQty?: number | null;
}

export function useUpdateTool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateToolInput }) =>
      apiFetch<{ data: ReversiTool }>(`/v1/reversi/tools/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi'] }),
  });
}

export function useAddSubgroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupCode: string; label: string; napomena?: string }) =>
      apiFetch<{ data: InventorySubgroup }>('/v1/reversi/inventory-subgroups', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'tools'] }),
  });
}

export function useAddSubsubgroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { subgroupId: string; label: string; napomena?: string }) =>
      apiFetch<{ data: InventorySubsubgroup }>('/v1/reversi/inventory-subsubgroups', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'tools'] }),
  });
}

export type ClassificationKind = 'group' | 'subgroup' | 'subsubgroup';

export function useRenameClassification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, label }: { kind: ClassificationKind; id: string; label: string }) =>
      apiFetch<{ data: unknown }>(`/v1/reversi/inventory-classification/${kind}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ label }),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'tools'] }),
  });
}

export function useDeleteSubgroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { deleted: true } }>(`/v1/reversi/inventory-subgroups/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'tools'] }),
  });
}

export function useDeleteSubsubgroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ data: { deleted: true } }>(`/v1/reversi/inventory-subsubgroups/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['reversi', 'tools'] }),
  });
}

/**
 * Štampa barkod-nalepnica (RA-22 bulk / RB-47 pri dodavanju) — RAW TSPL2 na mrežni
 * TSC (BE `POST /reversi/labels/print` → TCP 9100). Imperativno (poziva se iz
 * print helpera). Baca `ApiError` na neuspeh (poziv ga hvata i pada na browser preview).
 */
export function printReversiLabel(
  tspl2: string,
  copies?: number,
): Promise<{ data: { ok: boolean; bytes: number; printer: string } }> {
  return apiFetch<{ data: { ok: boolean; bytes: number; printer: string } }>(
    '/v1/reversi/labels/print',
    { method: 'POST', body: JSON.stringify({ tspl2, copies }) },
  );
}
