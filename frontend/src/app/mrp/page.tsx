'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { cn } from '@/lib/cn';
import { DemandsTab } from './_components/demands-tab';
import { StockTab } from './_components/stock-tab';

// ------------------------------------------------------------------ tabovi (segmented control)
// Kopirano iz tech-processes/page.tsx (DESIGN_SYSTEM §10 — Tabs još nije u kitu).

type TabKey = 'demands' | 'stock';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'demands', label: 'Potrebe' },
  { key: 'stock', label: 'Zalihe' },
];

function Tabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
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
      aria-label="Prikaz MRP / nabavke"
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

// ================================================================== STRANICA

export default function MrpPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('demands');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader title="MRP / Nabavka" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs value={tab} onChange={setTab} />

        {tab === 'demands' && <DemandsTab />}
        {tab === 'stock' && <StockTab />}
      </div>
    </AppShell>
  );
}
