'use client';

import { cn } from '@/lib/cn';

export interface TabItem {
  key: string;
  label: string;
}

/**
 * Lokalna pilula-navigacija tabova (podvučen aktivni tab, akcentna boja).
 *
 * NAPOMENA: DESIGN_SYSTEM §10 predviđa kit komponentu `Tabs`, ali ona još nije
 * u `src/components/ui-kit/`. Zbog ograničenja zadatka (pišem samo u svoj modul)
 * ovo je privremena lokalna verzija — integrator: promovisati u kit + /dev/ui.
 */
export function TabNav({
  tabs,
  active,
  onChange,
  size = 'md',
}: {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
  size?: 'md' | 'sm';
}) {
  return (
    <div className="flex items-center gap-1 border-b border-line" role="tablist">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(t.key)}
            className={cn(
              '-mb-px border-b-2 font-medium transition-colors focus-visible:outline-none',
              size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm',
              isActive
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-secondary hover:text-ink',
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
