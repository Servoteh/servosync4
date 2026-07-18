'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/**
 * MRP / Nabavka — SAMO UVID (MODULE_SPEC_mrp.md, BACKEND_RULES §11.3).
 * Backend kontroler (`backend/src/modules/mrp/`) izlaže samo GET rute — BOM
 * eksplozija i planiranje (mutacije) su blokirani dok se ne potvrdi dizajn
 * BOM/MRP logike. Ovaj fajl zato ima samo query hook-ove, bez mutacija.
 */

export interface ProjectRef {
  id: number;
  projectNumber: string;
  projectName: string | null;
  customerId: number;
}

export interface DrawingRef {
  id: number;
  drawingNumber: string;
  name: string | null;
  catalogNumber: string | null;
  revision: string;
}

export interface ItemRef {
  id: number;
  catalogNumber: string | null;
  name: string | null;
  unit: string | null;
}

/**
 * `mrp_demand_items.supplier_id` nema posebnu Supplier tabelu — rešava se preko
 * Customer-a (BigBit drži komitente i dobavljače u istom ID prostoru). Vidi
 * napomenu u `mrp.service.ts` — integrator: potvrditi sa domenom ako zatreba.
 */
export interface SupplierRef {
  id: number;
  name: string;
  city: string | null;
}

interface MrpDemandBase {
  id: number;
  projectId: number;
  rootDrawingId: number | null;
  workerId: number | null;
  /** Izvor potrebe: 1 = automatski (BOM eksplozija), 2 = ručno. */
  source: number;
  /** Tip eksplozije: 1 = top-level, 2 = puna (BOM). */
  explosionType: number | null;
  /** Raw šifra statusa (legacy `MRP_Potrebe.Status`) — nema kanonsku mapu dok se
   *  planiranje ne dizajnira (§11.3); "obrađena" se zna pouzdano samo preko `planId`. */
  status: number;
  demandDate: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  plannedQuantity: number;
  planId: number | null;
  project: ProjectRef | null;
  rootDrawing: DrawingRef | null;
  worker: WorkerRef | null;
}

export interface MrpDemand extends MrpDemandBase {
  itemsCount: number;
}

export interface MrpDemandItem {
  id: number;
  demandId: number;
  sourceDrawingId: number | null;
  procurementDrawingId: number | null;
  itemId: number | null;
  itemCatalogNumber: string;
  itemName: string;
  itemUnit: string;
  /** Raw šifra izvora stavke — nedovoljno dokumentovano da se prevede u tekst. */
  itemSource: number;
  requiredQuantity: number;
  demandDate: string;
  leadTimeDays: number | null;
  procurementDate: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  supplierId: number | null;
  /** Raw `StatusStavke` (workflow šifra stavke) — pokrivenost se prikazuje preko
   *  `freeStock` vs `requiredQuantity` (dokumentovana formula), ne preko ovog polja. */
  itemStatus: number;
  reservedQuantity: number;
  toProcureQuantity: number;
  sourceDrawing: DrawingRef | null;
  procurementDrawing: DrawingRef | null;
  item: ItemRef | null;
  supplier: SupplierRef | null;
  /** SlobodneZalihe = Zalihe − Rezervisano (MODULE_SPEC_mrp §3.1); null ako nema snapshot. */
  freeStock: number | null;
}

export interface MrpDemandDetail extends MrpDemandBase {
  items: MrpDemandItem[];
}

export interface MrpStockRow {
  itemId: number;
  inStock: number;
  reserved: number;
  name: string | null;
  catalogNumber: string | null;
  unit: string | null;
  updatedAt: string | null;
  /** SlobodneZalihe = Zalihe − Rezervisano. */
  freeStock: number;
  item: ItemRef | null;
}

export interface MrpDemandListParams {
  page?: number;
  /** Pretraga po napomeni. */
  q?: string;
  projectId?: number | '';
  from?: string;
  to?: string;
}

export interface MrpStockListParams {
  page?: number;
  /** Pretraga: katalog broj / naziv artikla. */
  q?: string;
}

/** Paginirana lista MRP potreba (+ pretraga po napomeni, predmetu, datumu). */
export function useMrpDemands(params: MrpDemandListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.projectId !== '' && params.projectId != null)
    qs.set('projectId', String(params.projectId));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['mrp-demands', params],
    queryFn: () => apiFetch<Paginated<MrpDemand>>(`/v1/mrp/demands${query ? `?${query}` : ''}`),
  });
}

/** Jedna MRP potreba sa stavkama (rešene FK + slobodne zalihe po stavci). */
export function useMrpDemand(id: number | null) {
  return useQuery({
    queryKey: ['mrp-demands', 'detail', id],
    queryFn: () => apiFetch<{ data: MrpDemandDetail }>(`/v1/mrp/demands/${id}`),
    enabled: id != null,
  });
}

/** Snapshot zaliha (`mrp_item_stock`, BigBit overlay) + pretraga po artiklu. */
export function useMrpStock(params: MrpStockListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['mrp-stock', params],
    queryFn: () => apiFetch<Paginated<MrpStockRow>>(`/v1/mrp/stock${query ? `?${query}` : ''}`),
  });
}
