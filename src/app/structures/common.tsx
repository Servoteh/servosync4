'use client';

import type { ReactNode, SelectHTMLAttributes } from 'react';
import { Check, Minus } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { ApiError } from '@/api/client';
import { cn } from '@/lib/cn';

/** Poruka greške iz backend odgovora (ApiError nosi srpsku poruku servisa). */
export function errMsg(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return undefined;
}

/** Traka sa porukom greške (isti izgled kao na work-orders ekranu). */
export function ErrorText({ error }: { error: unknown }) {
  const msg = errMsg(error);
  if (!msg) return null;
  return (
    <p className="text-sm text-status-danger" role="alert">
      {msg}
    </p>
  );
}

/** Checkmark ćelija za bool flag kolone (tabela operacija / vrsta poslova). */
export function FlagCell({ on }: { on: boolean | null | undefined }) {
  return on ? (
    <Check className="h-4 w-4 text-status-success" aria-label="Da" />
  ) : (
    <Minus className="h-3.5 w-3.5 text-ink-disabled" aria-label="Ne" />
  );
}

/** Checkbox sa labelom (token boje, accent iz tokena). */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-center gap-2 text-base text-ink',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded-control border border-line accent-accent"
      />
      {label}
    </label>
  );
}

/** Native <select> stilizovan tokenima (kao status filter na work-orders). */
export function NativeSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        'h-9 w-full rounded-control border border-line bg-surface px-2.5 text-base text-ink',
        'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)]',
        className,
      )}
    >
      {children}
    </select>
  );
}

/**
 * Dijalog za potvrdu akcije (umesto window.confirm) — kit Dialog + dva dugmeta.
 * Za destruktivne akcije `danger` boji potvrdno dugme u status-danger.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Potvrdi',
  cancelLabel = 'Otkaži',
  onConfirm,
  onCancel,
  loading,
  danger,
  error,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  danger?: boolean;
  error?: unknown;
}) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button
            onClick={onCancel}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            {cancelLabel}
          </button>
          <Button
            onClick={onConfirm}
            loading={loading}
            className={danger ? 'bg-status-danger text-white hover:bg-status-danger' : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">{message}</p>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}
