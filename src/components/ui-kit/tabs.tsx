'use client';

import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<K extends string> {
  key: K;
  label: string;
}

/** Segmentovani tab prekidač (DESIGN_SYSTEM §4/§8: ←/→ menjaju tab). Wrap na uske širine. */
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
    if (idx < 0) return;
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
      className="inline-flex flex-wrap gap-1 rounded-panel border border-line bg-surface p-1"
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
              active ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** KPI pločica (DESIGN_SYSTEM §4). Klikabilna → skok/filter. */
export function KpiTile({
  value,
  label,
  tone = 'ink',
  onClick,
  title,
  active,
}: {
  value: number | string;
  label: string;
  tone?: 'ink' | 'info' | 'warn' | 'danger' | 'success';
  onClick?: () => void;
  title?: string;
  active?: boolean;
}) {
  const toneCls =
    tone === 'danger'
      ? 'text-status-danger'
      : tone === 'warn'
        ? 'text-status-warn'
        : tone === 'info'
          ? 'text-status-info'
          : tone === 'success'
            ? 'text-status-success'
            : 'text-ink';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={!onClick}
      className={cn(
        'flex min-w-32 flex-col items-start rounded-panel border bg-surface px-4 py-3 text-left transition-colors enabled:hover:bg-surface-2 disabled:cursor-default',
        active ? 'border-accent' : 'border-line',
      )}
    >
      <span className={cn('tnums text-2xl font-semibold', toneCls)}>{value}</span>
      <span className="mt-0.5 text-xs text-ink-secondary">{label}</span>
    </button>
  );
}
