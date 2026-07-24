'use client';

// Mobilni Plan montaže (/m/montaza) — namenska mobilna ruta (1.0 hub deep-link paritet).
// Reuse punih tabova (PlanTab/IzvestajiTab) bez desktop sidebar-a; PlanTab je već responsive
// (kartice < lg) pa na telefonu daje PUN edit (ne read-only). Vidljivost = montaza.read.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { PlanTab } from '../../montaza/_components/plan-tab';
import { IzvestajiTab } from '../../montaza/_components/izvestaji-tab';
import { PrijavaNeusaglasenostiDialog } from '../../montaza/_components/prijava-neusaglasenosti-dialog';

type Tab = 'plan' | 'izvestaji';
const TABS: TabItem<Tab>[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'izvestaji', label: 'Izveštaji' },
];

export default function MobileMontazaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('plan');
  const [prijavaOpen, setPrijavaOpen] = useState(false);
  const canReport = can(PERMISSIONS.MONTAZA_NEUSAGLASENOSTI_WRITE);

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

      {/* Kartica „Prijavi neusaglašenost" (zahtev 004/26) — kamera na telefonu je primarni tok. */}
      {canReport && (
        <button
          type="button"
          onClick={() => setPrijavaOpen(true)}
          className="mb-3 flex w-full items-center gap-3 rounded-panel border border-line bg-surface p-3 text-left active:bg-surface-2"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-control bg-status-warn-bg text-status-warn">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">Prijavi neusaglašenost</span>
            <span className="block text-xs text-ink-secondary">
              Odstupanje na montaži — slikaj i pošalji odmah
            </span>
          </span>
        </button>
      )}

      {tab === 'plan' ? <PlanTab /> : <IzvestajiTab />}

      {prijavaOpen && (
        <PrijavaNeusaglasenostiDialog onClose={() => setPrijavaOpen(false)} />
      )}
    </main>
  );
}
