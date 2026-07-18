'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { cn } from '@/lib/cn';
import { WorkersTab } from './workers-tab';
import { WorkUnitsTab } from './work-units-tab';
import { OperationsTab } from './operations-tab';
import { WorkerTypesTab } from './worker-types-tab';
import { MachineAccessTab } from './machine-access-tab';

type TabKey = 'workers' | 'work-units' | 'operations' | 'worker-types' | 'machine-access';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'workers', label: 'Radnici' },
  { key: 'work-units', label: 'Radne jedinice' },
  { key: 'operations', label: 'Operacije' },
  { key: 'worker-types', label: 'Vrste poslova' },
  { key: 'machine-access', label: 'Radnici po mašinama' },
];

export default function StructuresPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('workers');

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
      <PageHeader title="Proizvodne strukture" />

      {/* Tabovi (DESIGN_SYSTEM.md §4 — master/detalj na istoj strani; bez dinamičkih ruta). */}
      <div className="shrink-0 border-b border-line bg-surface px-6">
        <div
          role="tablist"
          aria-label="Proizvodne strukture"
          className="-mb-px flex flex-wrap gap-1"
        >
          {TABS.map((t) => {
            const active = t.key === tab;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                className={cn(
                  'border-b-2 px-3 py-2.5 text-base font-medium transition-colors',
                  active
                    ? 'border-accent text-ink'
                    : 'border-transparent text-ink-secondary hover:text-ink',
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab === 'workers' && <WorkersTab />}
        {tab === 'work-units' && <WorkUnitsTab />}
        {tab === 'operations' && <OperationsTab />}
        {tab === 'worker-types' && <WorkerTypesTab />}
        {tab === 'machine-access' && <MachineAccessTab />}
      </div>
    </AppShell>
  );
}
