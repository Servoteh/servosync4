'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useWhereUsed, type WhereUsedItem } from '@/api/pdm';
import { formatNumber } from '@/lib/format';

export function WhereUsed({ drawingId }: { drawingId: number }) {
  const [recursive, setRecursive] = useState(false);
  const q = useWhereUsed(drawingId, { recursive });
  const usedIn = q.data?.data.usedIn ?? [];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
        <div className="inline-flex overflow-hidden rounded-control border border-line">
          <ToggleBtn active={!recursive} onClick={() => setRecursive(false)}>
            Direktni
          </ToggleBtn>
          <ToggleBtn active={recursive} onClick={() => setRecursive(true)}>
            Svi nivoi
          </ToggleBtn>
        </div>
        {q.data && (
          <span className="tnums">{formatNumber(q.data.meta.parentCount)} nadređenih</span>
        )}
      </div>

      {q.isLoading ? (
        <span className="text-sm text-ink-disabled">Učitavanje…</span>
      ) : q.error ? (
        <span className="text-sm text-status-danger">Greška pri učitavanju.</span>
      ) : usedIn.length === 0 ? (
        <span className="text-sm text-ink-disabled">
          Nijedan sklop ne koristi ovaj crtež.
        </span>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <div className="min-w-[32rem]">
            {usedIn.map((it, i) => (
              <WhereUsedRow key={`${it.drawing?.id ?? 'x'}-${i}`} item={it} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WhereUsedRow({ item }: { item: WhereUsedItem }) {
  const d = item.drawing;
  return (
    <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5 text-sm last:border-0">
      <span className={cn('tnums shrink-0 font-medium', d ? 'text-ink' : 'text-status-danger')}>
        {d ? d.drawingNumber : '(ne postoji)'}
      </span>
      {d?.revision && (
        <span className="tnums shrink-0 text-2xs text-ink-disabled">rev {d.revision}</span>
      )}
      <span className="truncate text-ink-secondary">{d?.name ?? 'crtež ne postoji'}</span>

      {item.isDirect ? (
        <StatusBadge tone="info" label="direktno" />
      ) : (
        <StatusBadge tone="neutral" label={`nivo ${item.depth}`} />
      )}
      {item.isTopLevel && <StatusBadge tone="success" label="vrh" />}

      <span className="ml-auto shrink-0 tnums text-ink">
        {formatNumber(item.totalQuantity)} kom
      </span>
      {item.occurrences > 1 && (
        <span className="shrink-0 tnums text-xs text-ink-disabled">×{item.occurrences}</span>
      )}
    </div>
  );
}

function ToggleBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'px-2.5 py-1 font-medium transition-colors',
        active ? 'bg-accent-subtle text-accent' : 'text-ink-secondary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}
