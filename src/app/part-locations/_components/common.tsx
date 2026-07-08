'use client';

import { Info } from 'lucide-react';
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

/**
 * Napomena „uskoro" za premeštanje/trebovanje delova između lokacija — van obima
 * ovog talasa (ledger-write, MODULE_SPEC_lokacije §7.1/§11). Ista tipografija kao
 * `EmptyState` (title `text-base text-ink-secondary` / hint `text-sm text-ink-disabled`),
 * ali kao kompaktna traka jer tabela iznad/ispod nije prazna.
 */
export function ComingSoonNote({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-panel border border-line-soft bg-surface-2/60 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
      <div>
        <p className="text-base text-ink-secondary">{title}</p>
        <p className="text-sm text-ink-disabled">{hint}</p>
      </div>
    </div>
  );
}
