'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from './_components/tabs';
import { PartsTab } from './_components/parts-tab';
import { PositionsTab } from './_components/positions-tab';

type TabKey = 'parts' | 'positions';

const TABS: TabItem<TabKey>[] = [
  { key: 'parts', label: 'Delovi na lokacijama' },
  { key: 'positions', label: 'Pozicije/police' },
];

export default function PartLocationsPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('parts');

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
      <PageHeader title="Lokacije delova" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Lokacije delova" />

        {tab === 'parts' && <PartsTab />}
        {tab === 'positions' && <PositionsTab />}
      </div>
    </AppShell>
  );
}
