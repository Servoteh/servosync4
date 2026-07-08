'use client';

import { ApiError } from '@/api/client';
import { PART_QUALITY, type WorkerRef } from '@/api/tech-processes';

/** Radnik iz WorkerRef — puno ime ili username, kao fallback šifra. */
export function workerLabel(w: WorkerRef | null, id: number): string {
  return w?.fullName || w?.username || `#${id}`;
}

const QUALITY_LABEL: Record<number, string> = {
  [PART_QUALITY.GOOD]: 'Dobar',
  [PART_QUALITY.REWORK]: 'Dorada',
  [PART_QUALITY.SCRAP]: 'Škart',
};

/** Vrste kvaliteta za `<select>` u formama (0=Dobar, 1=Dorada, 2=Škart, §3.4). */
export const QUALITY_OPTIONS: { value: number; label: string }[] = [
  { value: PART_QUALITY.GOOD, label: 'Dobar' },
  { value: PART_QUALITY.REWORK, label: 'Dorada' },
  { value: PART_QUALITY.SCRAP, label: 'Škart' },
];

/** Naziv vrste kvaliteta dela (0=Dobar,1=Dorada,2=Škart) — backend naziv ima prednost. */
export function qualityLabel(id: number, name?: string | null): string {
  return name || QUALITY_LABEL[id] || `#${id}`;
}

/** Poruka greške iz backend odgovora (ApiError nosi srpsku poruku servisa). */
export function errMsg(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

/** Traka sa porukom greške (isti izgled kao na work-orders/structures ekranima). */
export function ErrorText({ error }: { error: unknown }) {
  const msg = errMsg(error);
  if (!msg) return null;
  return (
    <p className="text-sm text-status-danger" role="alert">
      {msg}
    </p>
  );
}

export const errorBox =
  'rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger';
