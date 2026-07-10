'use client';

import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

// Kopirano iz src/app/tech-processes/page.tsx (zadatak: "Tabovi: kopiraj Tabs iz
// tech-processes/page.tsx") — segmentovana pilula-navigacija, ista kao tamo.

export type TabKey = 'drafts' | 'pending' | 'approved' | 'all';

export const TABS: { key: TabKey; label: string }[] = [
  { key: 'drafts', label: 'Nacrti' },
  { key: 'pending', label: 'Na čekanju' },
  { key: 'approved', label: 'Odobrene' },
  { key: 'all', label: 'Sve primopredaje' },
];

export function Tabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const idx = TABS.findIndex((t) => t.key === value);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChange(TABS[(idx + 1) % TABS.length].key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChange(TABS[(idx - 1 + TABS.length) % TABS.length].key);
    }
  }
  return (
    <div
      role="tablist"
      aria-label="Prikaz primopredaja"
      onKeyDown={onKeyDown}
      className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1"
    >
      {TABS.map((t) => {
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
