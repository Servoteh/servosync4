'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Bezbedan podskup radnika (backend nikad ne vraća lozinke). */
export interface WorkerRef {
  id: number;
  fullName: string | null;
  username: string;
}

export interface TechProcess {
  id: number;
  workerId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  identMark: string;
  pieceCount: number;
  enteredAt: string;
  finishedAt: string | null;
  isProcessFinished: boolean | null;
  workOrderId: number;
  signature: string | null;
  note: string | null;
  worker: WorkerRef | null;
}

export interface TechProcessDocument {
  id: number;
  fileLink: string;
  fileName: string;
}

export interface TechProcessDetail extends TechProcess {
  documents: TechProcessDocument[];
}

export interface Paginated<T> {
  data: T[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

interface TpListParams {
  page?: number;
  q?: string;
}

/** Paginirana lista tehnoloških postupaka (+ filter po ident broju). */
export function useTechProcesses(params: TpListParams) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('identNumber', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', params],
    queryFn: () =>
      apiFetch<Paginated<TechProcess>>(
        `/v1/tech-processes${query ? `?${query}` : ''}`,
      ),
  });
}

/** Jedan TP sa radnikom + dokumentacijom (učitava se pri otvaranju reda). */
export function useTechProcess(id: number | null) {
  return useQuery({
    queryKey: ['tech-processes', 'detail', id],
    queryFn: () => apiFetch<{ data: TechProcessDetail }>(`/v1/tech-processes/${id}`),
    enabled: id != null,
  });
}

/** Vrste kvaliteta delova (`part_quality_types`) — 0=dobar, 1=dorada, 2=škart. */
export const PART_QUALITY = { GOOD: 0, REWORK: 1, SCRAP: 2 } as const;

// ------------------------------------------------------------------ KARTICA TP (/card)

/** Operacija (radni centar) razrešena iz šifre — deo kartice / kritičnih. */
export interface OperationRef {
  workCenterCode: string;
  workCenterName: string;
  workUnitCode: string;
}

/** Jedan red kartice tehnološkog postupka (operacija postupka). */
export interface TechProcessCardRow {
  id: number;
  workerId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  identMark: string;
  pieceCount: number;
  enteredAt: string;
  finishedAt: string | null;
  isProcessFinished: boolean | null;
  qualityTypeId: number;
  note: string | null;
  documents: TechProcessDocument[];
  worker: WorkerRef | null;
  operation: OperationRef | null;
  qualityType: { id: number; name: string } | null;
}

/** „Kartica tehnološkog postupka": redovi + sume (komadi po kvalitetu, vreme). */
export interface TechProcessCard {
  projectId: number;
  identNumber: string;
  variant: number;
  operationCount: number;
  finishedCount: number;
  summary: {
    totalPieces: number;
    piecesByQuality: { good: number; rework: number; scrap: number };
    /** Izvedeno (entered→finished); null ako nijedna operacija nije završena. */
    totalElapsedMinutes: number | null;
  };
  rows: TechProcessCardRow[];
}

export interface CardKey {
  projectId: number;
  identNumber: string;
  variant: number;
}

/**
 * Kartica jednog postupka (trojka projectId + identNumber + variant).
 * Sume računa API (DESIGN_SYSTEM/spec — ne u UI). Učitava se pri expand-u reda.
 */
export function useTechProcessCard(key: CardKey | null) {
  return useQuery({
    queryKey: ['tech-processes', 'card', key],
    queryFn: () => {
      const qs = new URLSearchParams({
        projectId: String(key!.projectId),
        identNumber: key!.identNumber,
        variant: String(key!.variant),
      });
      return apiFetch<{ data: TechProcessCard }>(
        `/v1/tech-processes/card?${qs.toString()}`,
      );
    },
    enabled: key != null,
  });
}

// ------------------------------------------------------------------ KRITIČNI (/critical)

/** severity: 3=rok probijen (crveno) · 2=≤2 dana (narandžasto) · 1=≤7 dana (žuto). */
export type CriticalSeverity = 1 | 2 | 3;

export interface CriticalTechProcess {
  id: number;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  pieceCount: number;
  enteredAt: string;
  workerId: number;
  worker: WorkerRef | null;
  operation: OperationRef | null;
  productionDeadline: string;
  daysRemaining: number;
  severity: CriticalSeverity;
}

export interface CriticalResponse {
  data: CriticalTechProcess[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
    severityCounts: { yellow: number; orange: number; red: number };
    thresholds: { redWhenOverdue: boolean; orangeMaxDays: number; yellowMaxDays: number };
  };
}

/** Kritični postupci — nezavršeni čiji RN rok ističe (severity 1/2/3). */
export function useCriticalTechProcesses(params: { page?: number }) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'critical', params],
    queryFn: () =>
      apiFetch<CriticalResponse>(
        `/v1/tech-processes/critical${query ? `?${query}` : ''}`,
      ),
  });
}

// ------------------------------------------------------------- UČINAK RADNIKA (/worker-performance)

export interface WorkerPerformance {
  workerId: number;
  worker: WorkerRef | null;
  processCount: number;
  finishedCount: number;
  totalPieces: number;
  piecesByQuality: { good: number; rework: number; scrap: number };
  totalElapsedSeconds: number;
  totalElapsedMinutes: number;
}

export interface WorkerPerformanceResponse {
  data: WorkerPerformance[];
  meta: { from: string | null; to: string | null; workerCount: number };
}

/** Učinak po radniku u periodu (from/to po datumu evidentiranja). */
export function useWorkerPerformance(params: { from?: string; to?: string }) {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'worker-performance', params],
    queryFn: () =>
      apiFetch<WorkerPerformanceResponse>(
        `/v1/tech-processes/worker-performance${query ? `?${query}` : ''}`,
      ),
  });
}

// ------------------------------------------------------------------ GOTOVOST RN (/rn-progress)

export interface RnProgress {
  workOrderId: number;
  projectId: number;
  identNumber: string;
  variant: number;
  partName: string;
  drawingNumber: string;
  productionDeadline: string | null;
  handoverStatusId: number;
  handoverStatus: { id: number; name: string } | null;
  workerId: number;
  worker: WorkerRef | null;
  plannedPieces: number;
  madeGoodPieces: number;
  madeGoodSource: 'significant' | 'any';
  operationCount: number;
  finishedOperationCount: number;
  /** null kada planirano = 0 (nedefinisan procenat). */
  completionPercent: number | null;
  isCompleted: boolean;
}

/** Pregled gotovosti RN — planirano vs napravljeno (dobar komad) + procenat. */
export function useRnProgress(params: { page?: number; q?: string }) {
  const qs = new URLSearchParams();
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  if (params.q) qs.set('q', params.q);
  const query = qs.toString();
  return useQuery({
    queryKey: ['tech-processes', 'rn-progress', params],
    queryFn: () =>
      apiFetch<Paginated<RnProgress>>(
        `/v1/tech-processes/rn-progress${query ? `?${query}` : ''}`,
      ),
  });
}
