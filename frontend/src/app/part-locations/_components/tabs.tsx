'use client';

import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<K extends string> {
  key: K;
  label: string;
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
              'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-fg'
                : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
