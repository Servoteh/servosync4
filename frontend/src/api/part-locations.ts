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
 * Jedan zapis u ledger-u lokacija delova (Was: tLokacijeDelova). LEDGER SA
 * PREDZNAKOM (MODULE_SPEC_lokacije §3.1): postavljanje (unos / cilj prenosa) =
 * +quantity, uklanjanje (trebovanje / izvor prenosa) = −quantity. Neto stanje
 * dela na poziciji = SUM(quantity). Zapisi su append-only (korekcija = kontra-zapis).
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

/** Neto stanje po poziciji (SUM quantity sa predznakom) — deo kartice RN. */
export interface PartLocationPositionTotal {
  positionId: number;
  position: Position | null;
  quantity: number;
}

/** Kartica lokacije dela za jedan RN: ledger istorija + NETO stanje (GET /card/:workOrderId). */
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

/** Kartica lokacije dela za dati RN — ledger istorija + NETO stanje po poziciji + ukupno. */
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

// ------------------------------------------------------------------ Ledger mutacije (unos / prenos / trebovanje)

/** Unos lokacije — placement (+quantity), §3.1/§3.7. `projectId` izvodi backend iz RN-a. */
export interface CreatePartLocationInput {
  workOrderId: number;
  positionId: number;
  qualityTypeId: number;
  /** Izvršilac (radnik) — FK `workers`; do auth veze uzima se radnik RN-a. */
  workerId: number;
  quantity: number;
}

/** Prenos dela sa police na policu — par (−qty izvor / +qty cilj) u transakciji, §3.2. */
export interface TransferPartLocationInput {
  workOrderId: number;
  fromPositionId: number;
  toPositionId: number;
  qualityTypeId: number;
  quantity: number;
}

/** Trebovanje/uklanjanje dela sa police — removal (−quantity), §3.2. */
export interface RequisitionPartLocationInput {
  workOrderId: number;
  positionId: number;
  qualityTypeId: number;
  quantity: number;
}

/** Invalidacija svih upita lokacija (lista + kartice dele prefiks `['part-locations']`). */
function useInvalidatePartLocations() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['part-locations'] });
}

/** Unos lokacije (POST /part-locations) — placement +qty. */
export function useCreatePartLocation() {
  const invalidate = useInvalidatePartLocations();
  return useMutation({
    mutationFn: (input: CreatePartLocationInput) =>
      apiFetch<{ data: PartLocation; meta: { note: string } }>('/v1/part-locations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Prenos dela između pozicija (POST /part-locations/transfer) — −qty izvor / +qty cilj. */
export function useTransferPartLocation() {
  const invalidate = useInvalidatePartLocations();
  return useMutation({
    mutationFn: (input: TransferPartLocationInput) =>
      apiFetch<{
        data: { from: PartLocation; to: PartLocation };
        meta: { note: string; fromBalanceAfter: number; toBalanceAfter: number };
      }>('/v1/part-locations/transfer', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

/** Trebovanje dela sa pozicije (POST /part-locations/requisition) — removal −qty. */
export function useRequisitionPartLocation() {
  const invalidate = useInvalidatePartLocations();
  return useMutation({
    mutationFn: (input: RequisitionPartLocationInput) =>
      apiFetch<{ data: PartLocation; meta: { note: string; balanceAfter: number } }>(
        '/v1/part-locations/requisition',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      ),
    onSuccess: invalidate,
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
