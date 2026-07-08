'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated } from './tech-processes';

// ─────────────────────────────────────────────────────────────── tipovi

export interface DrawingStatusRef {
  id: number;
  name: string;
}

/** Red u listi crteža — GET /v1/pdm/drawings. */
export interface Drawing {
  id: number;
  drawingNumber: string;
  revision: string;
  catalogNumber: string;
  name: string;
  material: string | null;
  dimensions: string | null;
  weight: number | null;
  marking: string;
  isProcurement: boolean;
  pdmStatus: string;
  statusId: number;
  designedBy: string | null;
  designDate: string | null;
  approvedBy: string | null;
  approvedDate: string | null;
  fileName: string | null;
  projectName: string | null;
  workOrderRef: string | null;
  createdAt: string | null;
  status: DrawingStatusRef | null;
}

/** PDF metapodaci (bez binarnog sadržaja) — deo detalja crteža. */
export interface DrawingPdfMeta {
  fileName: string | null;
  uploadedAt: string;
  sizeKb: number | null;
  uploadedBy: string | null;
  hasBinary: boolean;
}

/** Red u logu XML uvoza — GET /v1/pdm/import-log. */
export interface ImportLogRow {
  id: number;
  fileName: string;
  filePath: string;
  importedAt: string;
  success: boolean;
  statusMessage: string | null;
  isCritical: boolean;
}

/** Pun detalj crteža — GET /v1/pdm/drawings/:id. */
export interface DrawingDetail extends Drawing {
  externalId: string;
  transactionDate: string | null;
  quantity: number;
  comment: string | null;
  whereUsed: string | null;
  signature: string | null;
  pdf: DrawingPdfMeta | null;
  /** Poslednji XML uvozi vezani za broj crteža (heuristika po imenu fajla). */
  importLog: ImportLogRow[];
  componentCount: number;
  whereUsedCount: number;
}

/** Sažetak crteža u BOM / where-used čvorovima. */
export interface DrawingSummary {
  id: number;
  drawingNumber: string;
  revision: string;
  catalogNumber: string;
  name: string;
  material: string | null;
  isProcurement: boolean;
  weight: number | null;
  pdmStatus: string;
}

/** Čvor rekurzivne sastavnice — `drawing` je null kad ciljni crtež ne postoji. */
export interface BomTreeNode {
  componentId: number;
  drawing: DrawingSummary | null;
  /** Količina po jednom komadu neposrednog nadređenog. */
  requiredQuantity: number;
  /** Količina po jednom komadu korenskog sklopa (pomnoženo kroz nivoe). */
  totalQuantity: number;
  depth: number;
  /** Ciklus u sastavnici — grana je presečena, `children` je prazan. */
  isCycle: boolean;
  children: BomTreeNode[];
}

export interface BomFlatRow {
  drawing: DrawingSummary | null;
  totalQuantity: number;
  occurrences: number;
  minDepth: number;
}

export interface BomResponse {
  data: {
    drawing: DrawingSummary;
    /** Ugnježdeno stablo (null ako je pozvan flat režim — mi ga uvek tražimo). */
    tree: BomTreeNode[] | null;
    flat: BomFlatRow[];
  };
  meta: {
    depth: number;
    expandAll: boolean;
    componentRows: number;
    cyclesDetected: number;
    truncated: boolean;
  };
}

export interface WhereUsedItem {
  drawing: DrawingSummary | null;
  totalQuantity: number;
  occurrences: number;
  depth: number;
  isDirect: boolean;
  isTopLevel: boolean;
}

export interface WhereUsedResponse {
  data: {
    drawing: DrawingSummary;
    usedIn: WhereUsedItem[];
  };
  meta: {
    recursive: boolean;
    depth: number;
    cyclesDetected: number;
    parentCount: number;
  };
}

export interface PdmLookups {
  statuses: DrawingStatusRef[];
  materials: string[];
  designers: string[];
}

// ─────────────────────────────────────────────────────────────── parametri

export interface DrawingListParams {
  page?: number;
  q?: string;
  revision?: string;
  material?: string;
  designedBy?: string;
}

export interface ImportLogParams {
  page?: number;
  /** '' = svi, 'true' = uspešni, 'false' = neuspešni. */
  success?: '' | 'true' | 'false';
  /** '' = svi, 'true' = samo kritični. */
  isCritical?: '' | 'true' | 'false';
}

// ─────────────────────────────────────────────────────────────── hook-ovi

/** Paginirana lista crteža (+ pretraga i filteri revizija/materijal/projektant). */
export function useDrawings(params: DrawingListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.revision) qs.set('revision', params.revision);
  if (params.material) qs.set('material', params.material);
  if (params.designedBy) qs.set('designedBy', params.designedBy);
  const query = qs.toString();
  return useQuery({
    queryKey: ['pdm', 'drawings', params],
    queryFn: () =>
      apiFetch<Paginated<Drawing>>(`/v1/pdm/drawings${query ? `?${query}` : ''}`),
  });
}

/** Pun detalj crteža sa PDF metapodacima + brojačima (učitava se pri expand-u reda). */
export function useDrawing(id: number | null) {
  return useQuery({
    queryKey: ['pdm', 'drawings', 'detail', id],
    queryFn: () => apiFetch<{ data: DrawingDetail }>(`/v1/pdm/drawings/${id}`),
    enabled: id != null,
  });
}

/**
 * Rekurzivna sastavnica (ugnježdeno stablo do dubine 20). Ne šaljemo `expandAll`
 * jer backend njime vraća SAMO flat listu — širenje/skupljanje čvorova je
 * čisto UI stvar nad već dobijenim stablom.
 */
export function useBom(id: number | null, enabled = true) {
  return useQuery({
    queryKey: ['pdm', 'bom', id],
    queryFn: () => apiFetch<BomResponse>(`/v1/pdm/drawings/${id}/bom`),
    enabled: enabled && id != null,
  });
}

/** Gde se koristi (obrnuta sastavnica): direktni ili tranzitivni nadređeni. */
export function useWhereUsed(
  id: number | null,
  opts: { recursive?: boolean; enabled?: boolean } = {},
) {
  const recursive = opts.recursive ?? false;
  return useQuery({
    queryKey: ['pdm', 'where-used', id, recursive],
    queryFn: () =>
      apiFetch<WhereUsedResponse>(
        `/v1/pdm/drawings/${id}/where-used${recursive ? '?recursive=true' : ''}`,
      ),
    enabled: (opts.enabled ?? true) && id != null,
  });
}

/** Paginirana istorija XML uvoza (+ filteri uspeh/kritičnost). */
export function useImportLog(params: ImportLogParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.success) qs.set('success', params.success);
  if (params.isCritical) qs.set('isCritical', params.isCritical);
  const query = qs.toString();
  return useQuery({
    queryKey: ['pdm', 'import-log', params],
    queryFn: () =>
      apiFetch<Paginated<ImportLogRow>>(`/v1/pdm/import-log${query ? `?${query}` : ''}`),
  });
}

/** Statusi + distinct materijali + projektanti za filtere (jedan poziv, keširan). */
export function usePdmLookups() {
  return useQuery({
    queryKey: ['pdm', 'lookups'],
    queryFn: () => apiFetch<{ data: PdmLookups }>('/v1/pdm/lookups'),
    staleTime: 5 * 60_000,
  });
}

/**
 * Adapter za `ComboBox`: materijali iz /lookups, filtrirani klijentski po unosu.
 * Vraća oblik koji ComboBox očekuje ({ data: { data }, isLoading }).
 */
export function useMaterialsLookup(q: string) {
  const base = usePdmLookups();
  const all = base.data?.data.materials ?? [];
  const term = q.trim().toLowerCase();
  const items = (term ? all.filter((m) => m.toLowerCase().includes(term)) : all).slice(0, 50);
  return { data: { data: items }, isLoading: base.isLoading };
}

/** Adapter za `ComboBox`: projektanti (designed_by) iz /lookups. */
export function useDesignersLookup(q: string) {
  const base = usePdmLookups();
  const all = base.data?.data.designers ?? [];
  const term = q.trim().toLowerCase();
  const items = (term ? all.filter((d) => d.toLowerCase().includes(term)) : all).slice(0, 50);
  return { data: { data: items }, isLoading: base.isLoading };
}
