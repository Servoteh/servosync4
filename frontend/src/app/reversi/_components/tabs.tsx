'use client';

import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<K extends string> {
  key: K;
  label: string;
  /** Živi brojač (RA-04) — prikazan kao badge uz labelu; `undefined`/`null` = sakriven. */
  count?: number | null;
}

/**
 * Segmentovani tab prekidač — kopija `Tabs` iz tech-processes/page.tsx
 * (DESIGN_SYSTEM.md §4/§8: ←/→ menjaju tab, aktivan tab = akcentna pozadina).
 */
export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
}: {
  tabs: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  ariaLabel: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = tabs.findIndex((t) => t.key === value);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(tabs[(idx + 1) % tabs.length].key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(tabs[(idx - 1 + tabs.length) % tabs.length].key);
    }
  }
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1"
    >
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-fg'
                : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
            )}
          >
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  'tnums rounded-full px-1.5 py-0.5 text-2xs font-semibold',
                  active ? 'bg-accent-fg/20 text-accent-fg' : 'bg-surface-2 text-ink-secondary',
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
