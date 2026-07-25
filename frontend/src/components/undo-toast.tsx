'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * UndoToast — poništivo brisanje (Batch B, soft-delete). Fiksna pilula dole-sredina
 * (idiom `lib/toast.ts`), sa porukom, odbrojavanjem preostalog prozora (30 s) i dugmetom
 * „Poništi". Kad prozor istekne (ili se pozove `onDismiss`), sam nestaje.
 *
 * Kontrolisan spolja: roditelj drži „šta je obrisano" i renderuje/uklanja toast. Da bi
 * svako novo brisanje krenulo svež tajmer, montiraj sa `key` po id-u obrisane stavke.
 */
interface UndoToastProps {
  /** Poruka (npr. „Stavka obrisana."). */
  message: string;
  /** Trajanje prozora za poništavanje u ms (default 30000 — usklađeno sa backend `UNDO_WINDOW_MS`). */
  durationMs?: number;
  /** Klik na „Poništi". */
  onUndo: () => void;
  /** Istekao prozor ili zatvaranje — roditelj uklanja toast. */
  onDismiss: () => void;
  /** „Poništi" u toku (spinner + disabled). */
  undoing?: boolean;
}

export function UndoToast({
  message,
  durationMs = 30_000,
  onUndo,
  onDismiss,
  undoing = false,
}: UndoToastProps) {
  const [remaining, setRemaining] = useState(() => Math.ceil(durationMs / 1000));
  // Ref da promena identiteta `onDismiss` (nova funkcija po renderu) NE restartuje tajmer.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const started = Date.now();
    setRemaining(Math.ceil(durationMs / 1000));
    const tick = window.setInterval(() => {
      const leftMs = Math.max(0, durationMs - (Date.now() - started));
      setRemaining(Math.ceil(leftMs / 1000));
      if (leftMs <= 0) {
        window.clearInterval(tick);
        dismissRef.current();
      }
    }, 250);
    return () => window.clearInterval(tick);
  }, [durationMs]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'fixed bottom-4 left-1/2 z-[9999] -translate-x-1/2',
        'flex items-center gap-3 rounded-panel border border-line bg-surface',
        'px-4 py-2.5 text-sm text-ink shadow-lg',
      )}
    >
      <span>{message}</span>
      <span className="tnums text-xs text-ink-secondary">{remaining} s</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={undoing}
        className={cn(
          'inline-flex items-center gap-1.5 font-semibold text-accent',
          'hover:underline disabled:opacity-50 disabled:pointer-events-none',
          'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]',
        )}
      >
        {undoing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
        Poništi
      </button>
    </div>
  );
}
