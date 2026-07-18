'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export interface SyncEntityResult {
  rowsUpserted?: number;
  rowsSkipped?: number;
  error?: string;
}

export interface SyncLog {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  entityScope: string | null;
  rowsFetched: number;
  rowsUpserted: number;
  rowsSkipped: number;
  errorMessage: string | null;
  metadata: Record<string, SyncEntityResult> | null;
}

/** Recent sync runs (newest first). */
export function useSyncLogs() {
  return useQuery({
    queryKey: ['sync', 'log'],
    queryFn: () => apiFetch<SyncLog[]>('/sync/log'),
  });
}

/** Trigger a full on-demand sync; refreshes the log list on completion. */
export function useRunSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SyncLog>('/sync/run', { method: 'POST', body: '{}' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sync', 'log'] }),
  });
}
