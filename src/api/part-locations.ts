'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

// ------------------------------------------------------------------ tipovi

/** Radni nalog (podskup) razrešen iz `work_order_id` — MODULE_SPEC_lokacije §5. */
export interface PartLocationWorkOrderRef {
  id: number;
  identNumber: string;
  partName: string | null;
  drawingNumber: string;
  projectId: number;
}

/** Predmet (podskup) razrešen iz `project_id`. */
export interface PartLocationProjectRef {
  id: number;
  projectNumber: string;
  projectName: string | null;
  customerId: number;
}

/** Pozicija/polica (Was: tPozicije) — matični šifarnik lokacija. */
export interface Position {
  id: number;
  positionCode: string;
  description: string | null;
}

/** Vrsta kvaliteta dela razrešena iz `quality_type_id` (0=Dobar,1=Dorada,2=Škart). */
export interface PartLocationQualityRef {
  id: number;
  name: string;
}

/**
 * Jedan zapis u ledger-u lokacija delova (Was: tLokacijeDelova). READ-ONLY —
 * model nema polje smera (postavljeno/uklonjeno), pa je `quantity` bruto unos,
 * ne stanje.
 */
export interface PartLocation {
  id: number;
  workOrderId: number;
  projectId: number;
  positionId: number;
  workerId: number;
  qualityTypeId: number;
  recordDate: string;
  quantity: number;
  createdAt: string | null;
  workOrder: PartLocationWorkOrderRef | null;
  project: PartLocationProjectRef | null;
  position: Position | null;
  worker: WorkerRef | null;
  qualityType: PartLocationQualityRef | null;
}

/** Zbir količine po poziciji — deo kartice RN. */
export interface PartLocationPositionTotal {
  positionId: number;
  position: Position | null;
  quantity: number;
}

/** Kartica lokacije dela za jedan RN: ledger istorija + zbirovi (GET /card/:workOrderId). */
export interface PartLocationCard {
  workOrderId: number;
  workOrder: PartLocationWorkOrderRef | null;
  records: PartLocation[];
  totalsByPosition: PartLocationPositionTotal[];
  totalQuantity: number;
}

export interface CreatePositionInput {
  positionCode: string;
  description?: string;
}

export type UpdatePositionInput = Partial<CreatePositionInput>;

// ------------------------------------------------------------------ Delovi na lokacijama (READ-ONLY)

export interface PartLocationsListParams {
  page?: number;
  q?: string;
  qualityTypeId?: number | '';
}

/** Paginirana lista zapisa lokacija delova (+ pretraga RN/predmet/pozicija, filter kvaliteta). */
export function usePartLocations(params: PartLocationsListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  if (params.qualityTypeId !== '' && params.qualityTypeId != null)
    qs.set('qualityTypeId', String(params.qualityTypeId));
  const query = qs.toString();
  return useQuery({
    queryKey: ['part-locations', params],
    queryFn: () =>
      apiFetch<Paginated<PartLocation>>(`/v1/part-locations${query ? `?${query}` : ''}`),
  });
}

/** Kartica lokacije dela za dati RN — ledger istorija + zbir po poziciji + ukupno. */
export function usePartLocationCard(workOrderId: number | null) {
  return useQuery({
    queryKey: ['part-locations', 'card', workOrderId],
    queryFn: () =>
      apiFetch<{ data: PartLocationCard; meta: { note: string } }>(
        `/v1/part-locations/card/${workOrderId}`,
      ),
    enabled: workOrderId != null,
  });
}

// ------------------------------------------------------------------ Pozicije/police (CRUD)

export interface PositionsListParams {
  page?: number;
  q?: string;
}

/** Paginirana lista pozicija/polica (+ pretraga po šifri/opisu). */
export function usePositions(params: PositionsListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['positions', params],
    queryFn: () => apiFetch<Paginated<Position>>(`/v1/positions${query ? `?${query}` : ''}`),
  });
}

function useInvalidatePositions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['positions'] });
}

/** Kreiranje nove pozicije/police. */
export function useCreatePosition() {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: (input: CreatePositionInput) =>
      apiFetch<{ data: Position }>('/v1/positions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Izmena postojeće pozicije/police. */
export function useUpdatePosition() {
  const invalidate = useInvalidatePositions();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: UpdatePositionInput }) =>
      apiFetch<{ data: Position }>(`/v1/positions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: invalidate,
  });
}
