'use client';

// Mobilni Plan montaže (/m/montaza) — namenska mobilna ruta (1.0 hub deep-link paritet).
// Reuse punih tabova (PlanTab/IzvestajiTab) bez desktop sidebar-a; PlanTab je već responsive
// (kartice < lg) pa na telefonu daje PUN edit (ne read-only). Vidljivost = montaza.read.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { PlanTab } from '../../montaza/_components/plan-tab';
import { IzvestajiTab } from '../../montaza/_components/izvestaji-tab';

type Tab = 'plan' | 'izvestaji';
const TABS: TabItem<Tab>[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'izvestaji', label: 'Izveštaji' },
];

export default function MobileMontazaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('plan');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  return (
    <main className="min-h-screen bg-app p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h1 className="text-md font-semibold text-ink">Plan montaže</h1>
        <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Montaža" />
      </div>
      {tab === 'plan' ? <PlanTab /> : <IzvestajiTab />}
    </main>
  );
}
