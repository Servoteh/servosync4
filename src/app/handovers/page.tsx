'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabKey } from './_components/tabs';
import { DraftsTab } from './_components/drafts-tab';
import { PendingTab } from './_components/pending-tab';
import { AllHandoversTab } from './_components/all-handovers-tab';

/**
 * Primopredaje (MODULE_SPEC_nacrti_primopredaje §8) — tri tab-a nad dva
 * pod-resursa iz backend/src/modules/handovers/:
 *   - Nacrti      → GET/POST/PATCH/DELETE /v1/handover-drafts (handover-drafts.controller.ts)
 *   - Na čekanju  → GET /v1/handovers/pending-approval + approve/reject/launch (handovers.controller.ts)
 *   - Sve primopredaje → GET /v1/handovers + isti workflow dugmad
 */
export default function HandoversPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('drafts');

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
      <PageHeader title="Primopredaje" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs value={tab} onChange={setTab} />

        {tab === 'drafts' && <DraftsTab />}
        {tab === 'pending' && <PendingTab />}
        {tab === 'all' && <AllHandoversTab />}
      </div>
    </AppShell>
  );
}
