'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { TabNav } from './_components/tab-nav';
import { DrawingsTab } from './_components/drawings-tab';
import { ImportLogTab } from './_components/import-log-tab';

export default function PdmPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState('drawings');

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
      <PageHeader title="PDM / Crteži" />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-line bg-surface px-6">
          <TabNav
            active={tab}
            onChange={setTab}
            tabs={[
              { key: 'drawings', label: 'Crteži' },
              { key: 'import', label: 'Log uvoza' },
            ]}
          />
        </div>

        <div className="flex-1 overflow-auto p-6">
          {tab === 'drawings' ? <DrawingsTab /> : <ImportLogTab />}
        </div>
      </div>
    </AppShell>
  );
}
