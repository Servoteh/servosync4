'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatNumber } from '@/lib/format';

/** Server-side paginacija (prev/next) — DESIGN_SYSTEM.md §5. */
export function Pager({
  page,
  totalPages,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn =
    'rounded-control border border-line bg-surface p-1.5 text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex items-center justify-end gap-3 text-sm text-ink-secondary">
      <span className="tnums">
        Strana {formatNumber(page)} od {formatNumber(totalPages)}
      </span>
      <div className="flex gap-1">
        <button onClick={onPrev} disabled={page <= 1} className={btn} aria-label="Prethodna strana">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          onClick={onNext}
          disabled={page >= totalPages}
          className={btn}
          aria-label="Sledeća strana"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
