'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/**
 * Zakazani poslovi — data sloj nad `/api/v1/scheduler/*`.
 *
 * ZAŠTO POSTOJI: poslovi (noćni uvoz iz BigBita, watchdog, podsetnici, istek rezervacija…)
 * rade po rasporedu, ali do 05.08.2026. se iz aplikacije NISU mogli ni videti ni pokrenuti —
 * ruta na serveru je postojala, ekran nije. Kad bi uvoz zapeo, jedini izlaz je bio čekati
 * sledeću noć. Ekran „Sinhronizacije" ih sada prikazuje i nudi „Pokreni sada".
 *
 * Tipovi su 1:1 sa `backend/src/modules/scheduler/scheduler.controller.ts` (`GET jobs`).
 */

const BASE = '/v1/scheduler';

/** Raspored posla — oblik iz `scheduler.types.ts`. */
export interface JobSchedule {
  kind: string;
  /** `daily` → „03:45"; `interval` → minuti; ostalo zavisi od vrste. */
  at?: string;
  everyMinutes?: number;
  weekday?: number;
}

/** Jedno izvršenje posla (`scheduled_job_runs`). */
export interface JobRun {
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  attempts: number;
  summary: string | null;
  error: string | null;
}

export interface ScheduledJob {
  key: string;
  description: string;
  schedule: JobSchedule;
  /** Poslednja 3 izvršenja, najnovije prvo. */
  lastRuns: JobRun[];
}

export interface SchedulerState {
  /** Opšti pogon — kad je `false`, nijedan posao ne ide po rasporedu. */
  enabled: boolean;
  jobs: ScheduledJob[];
}

const KEYS = {
  all: ['scheduler'] as const,
  jobs: ['scheduler', 'jobs'] as const,
};

/**
 * Spisak poslova sa istorijom. Osvežava se sam dok je ekran otvoren — pokrenut posao
 * traje i po nekoliko minuta, a korisnik gleda baš to.
 */
export function useSchedulerJobs(enabled = true) {
  return useQuery({
    queryKey: KEYS.jobs,
    queryFn: () => apiFetch<{ data: SchedulerState }>(`${BASE}/jobs`),
    enabled,
    refetchInterval: 15_000,
  });
}

/** Rezultat ručnog pokretanja (`POST jobs/:key/run-now`). */
export interface RunNowResult {
  key: string;
  status?: string;
  summary?: string;
  error?: string;
  [k: string]: unknown;
}

/**
 * „Pokreni sada". Posao se izvršava SINHRONO na serveru, pa poziv ume da traje —
 * noćni uvoz iz BigBita je reda veličine dva minuta. Po završetku se spisak osvežava
 * da se odmah vidi ishod u istoriji.
 */
export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      apiFetch<{ data: RunNowResult }>(`${BASE}/jobs/${encodeURIComponent(key)}/run-now`, {
        method: 'POST',
        body: '{}',
      }),
    onSettled: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  });
}

/**
 * Poslovi koji se tiču dovlačenja podataka iz BigBita — ono što na ovom ekranu jedino
 * i treba. Ostali zakazani poslovi (podsetnici, čišćenja) idu u sporedni deo ekrana.
 */
export function jeBigbitPosao(key: string): boolean {
  return key.startsWith('bigbit');
}
