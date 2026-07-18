'use client';

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

const SIZE_CLASS = {
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  // xl2 = namerno širi (896px) za guste tabele (Istorija zarada); ne preklapa deljeni `xl`.
  xl2: 'max-w-4xl',
  '2xl': 'max-w-6xl',
} as const;

/** Modalni dijalog (DESIGN_SYSTEM.md §4/§10). Esc zatvara; klik na pozadinu zatvara. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Širina modala: md (≈ obrazac), lg/xl/2xl (šire tabele/zarade). */
  size?: keyof typeof SIZE_CLASS;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className={`w-full ${SIZE_CLASS[size]} rounded-panel border border-line bg-surface shadow-xl`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-md font-semibold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
            aria-label="Zatvori"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>
        )}
      </div>
    </div>
  );
}
