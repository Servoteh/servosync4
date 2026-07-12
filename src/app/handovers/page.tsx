'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabKey } from './_components/tabs';
import { PendingTab } from './_components/pending-tab';
import { ApprovedTab } from './_components/approved-tab';
import { AllHandoversTab } from './_components/all-handovers-tab';

/**
 * Primopredaje (MODULE_SPEC_nacrti_primopredaje §8) — tok odobravanja
 * (tehnolozi, ODLUKE #33) nad backend/src/modules/handovers/:
 *   - Na čekanju  → GET /v1/handovers/pending-approval + approve/reject (handovers.controller.ts)
 *   - Odobrene    → GET /v1/handovers?statusId=1 + prepare-work-order/launch/return-to-pending
 *   - Sve primopredaje → GET /v1/handovers + isti workflow dugmad
 * Nacrti (handover-drafts, radni prostor projektanata) su na zasebnoj ruti /nacrti.
 */
export default function HandoversPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('pending');

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

        {tab === 'pending' && <PendingTab />}
        {tab === 'approved' && <ApprovedTab />}
        {tab === 'all' && <AllHandoversTab />}
      </div>
    </AppShell>
  );
}
