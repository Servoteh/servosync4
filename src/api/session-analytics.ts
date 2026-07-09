'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { Paginated, WorkerRef } from './tech-processes';

/**
 * Analitika vremenskih sesija (A-4) nad `v_work_sessions` / `work_time_entries`:
 *   - dnevnik (po danu)     GET /v1/tech-processes/sessions/daily
 *   - zbir vs normirano     GET /v1/tech-processes/sessions/summary
 *   - po satu               GET /v1/tech-processes/sessions/hourly
 *   - loše evidentirani     GET /v1/tech-processes/sessions/poorly-recorded
 * Vreme (utrošeno) broji SAMO native sesije; komadi/brojači uključuju legacy istoriju.
 */

const BASE = '/v1/tech-processes/sessions';

export interface SessionParams {
  from?: string;
  to?: string;
  workCenterCode?: string;
  workerId?: number;
  page?: number;
}

function qsOf(params: SessionParams): string {
  const qs = new URLSearchParams();
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  if (params.workCenterCode) qs.set('workCenterCode', params.workCenterCode);
  if (params.workerId != null) qs.set('workerId', String(params.workerId));
  if (params.page && params.page > 1) qs.set('page', String(params.page));
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export interface DailyRow {
  day: string;
  sessionCount: number;
  workerCount: number;
  pieces: number;
  elapsedSeconds: number;
  elapsedMinutes: number;
  openCount: number;
}
export interface RangeMeta {
  from: string;
  to: string;
  days?: number;
  hours?: number;
}

export function useSessionsDaily(params: SessionParams) {
  return useQuery({
    queryKey: ['sessions', 'daily', params],
    queryFn: () =>
      apiFetch<{ data: DailyRow[]; meta: RangeMeta }>(`${BASE}/daily${qsOf(params)}`),
  });
}

export interface SummaryRow {
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  workCenterName: string | null;
  made: number;
  sessionCount: number;
  actualMinutes: number;
  normMinutes: number;
  diffMinutes: number;
  hasNorm: boolean;
}

export function useSessionsSummary(params: SessionParams) {
  return useQuery({
    queryKey: ['sessions', 'summary', params],
    queryFn: () =>
      apiFetch<Paginated<SummaryRow>>(`${BASE}/summary${qsOf(params)}`),
  });
}

export interface HourlyRow {
  hourLocal: string;
  sessionCount: number;
  workerCount: number;
  pieces: number;
  seconds: number;
  minutes: number;
}

export function useSessionsHourly(params: SessionParams) {
  return useQuery({
    queryKey: ['sessions', 'hourly', params],
    queryFn: () =>
      apiFetch<{ data: HourlyRow[]; meta: RangeMeta }>(`${BASE}/hourly${qsOf(params)}`),
  });
}

export interface PoorlyRow {
  id: number;
  techProcessId: number;
  workerId: number;
  worker: WorkerRef | null;
  projectId: number;
  identNumber: string;
  variant: number;
  operationNumber: number;
  workCenterCode: string;
  workCenterName: string | null;
  startedAt: string;
  stoppedAt: string | null;
  pieceCount: number;
  autoClosed: boolean;
  /** 'bez_stopa' | 'negativno' | 'auto_zatvoreno' | 'preko_dana'. */
  reason: string;
}

export function useSessionsPoorlyRecorded(params: SessionParams) {
  return useQuery({
    queryKey: ['sessions', 'poorly-recorded', params],
    queryFn: () =>
      apiFetch<Paginated<PoorlyRow>>(`${BASE}/poorly-recorded${qsOf(params)}`),
  });
}
