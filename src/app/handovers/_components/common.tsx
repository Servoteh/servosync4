'use client';

import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { HANDOVER_STATUS, type StatusRef } from '@/api/handovers';
import { ApiError } from '@/api/client';
import type { Tone } from '@/components/ui-kit/status-badge';
import { cn } from '@/lib/cn';

// ─────────────────────────────────────────────────────────────── greške

/** Poruka greške iz backend odgovora (ApiError nosi srpsku poruku servisa). */
export function errMsg(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

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

// ─────────────────────────────────────────────────────────────── sitni kontrolisani elementi

export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-9 rounded-control border border-line bg-surface px-2.5 text-sm text-ink',
        'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cn(
        'min-h-20 w-full rounded-control border border-line bg-surface px-3 py-2 text-base text-ink',
        'placeholder:text-ink-disabled',
        'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    />
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── statusi

/**
 * Status primopredaje (`HANDOVER_STATUS`) — kanonska mapa, ISTI ton/labela kao
 * `WO_STATUS` na Radnim nalozima (backend: ista `handover_statuses` lookup
 * tabela, vrednosti 1:1 preslikane, vidi handovers.service.ts).
 */
const HANDOVER_STATUS_META: Record<number, { tone: Tone; label: string }> = {
  [HANDOVER_STATUS.PENDING]: { tone: 'neutral', label: 'U obradi' },
  [HANDOVER_STATUS.APPROVED]: { tone: 'success', label: 'Saglasan' },
  [HANDOVER_STATUS.REJECTED]: { tone: 'danger', label: 'Odbijeno' },
  [HANDOVER_STATUS.LAUNCHED]: { tone: 'info', label: 'Lansiran' },
};
export function handoverStatusMeta(statusId: number): { tone: Tone; label: string } {
  return HANDOVER_STATUS_META[statusId] ?? { tone: 'neutral', label: 'U obradi' };
}

export const HANDOVER_STATUS_OPTIONS: { id: number; label: string }[] = [
  { id: HANDOVER_STATUS.PENDING, label: 'U obradi' },
  { id: HANDOVER_STATUS.APPROVED, label: 'Saglasan' },
  { id: HANDOVER_STATUS.REJECTED, label: 'Odbijeno' },
  { id: HANDOVER_STATUS.LAUNCHED, label: 'Lansiran' },
];

/**
 * Status nacrta (`handover_draft_statuses`) — DESIGN_SYSTEM §7 ne pokriva ovaj
 * domen i seed nije potvrđen (backend komentar: "nepotvrđen seed"), zato ton
 * ide heuristikom po nazivu iz API-ja (isti obrazac kao `pdm-helpers.ts` →
 * `drawingStatusMeta`), ne po fiksnom id-u. Integrator: prebaciti u kanonsku
 * mapu (§7) čim se seed potvrdi sa Vasom.
 */
export function draftStatusMeta(status: StatusRef | null): { tone: Tone; label: string } {
  const label = status?.name ?? '—';
  const n = label.toLowerCase();
  let tone: Tone = 'neutral';
  if (/lansir/.test(n)) tone = 'success';
  else if (/odbij|storn/.test(n)) tone = 'danger';
  else if (/\bpredat\b/.test(n)) tone = 'info';
  else if (/primopredaj/.test(n)) tone = 'warn';
  return { tone, label };
}

export const DRAFT_TYPE_LABEL: Record<number, string> = {
  0: 'Glavni sklop',
  1: 'Pojedinačni sklop',
  2: 'Podsklopovi',
};
export function draftTypeLabel(draftType: number): string {
  return DRAFT_TYPE_LABEL[draftType] ?? `#${draftType}`;
}
