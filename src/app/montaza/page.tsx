'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/app/reversi/_components/tabs';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { PlanTab } from './_components/plan-tab';
import { GanttTab } from './_components/gantt-tab';
import { TotalGanttTab } from './_components/total-gantt-tab';

type ViewKey = 'plan' | 'gantt' | 'total' | 'izvestaji';

const VIEWS: { key: ViewKey; label: string }[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'gantt', label: 'Gantt' },
  { key: 'total', label: 'Ukupan Gant' },
  { key: 'izvestaji', label: 'Izveštaji' },
];

const VALID = new Set<ViewKey>(['plan', 'gantt', 'total', 'izvestaji']);

/**
 * Plan montaže — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md). Hub + 4 pogleda
 * (Plan / Gantt / Ukupan Gant / Izveštaji) sa deep-link-om `?view=`. Modul „Montaža"
 * je UNGATED u 1.0 → svaka aktivna rola ulazi; edit/izveštaji gate-ovi su per-akcija.
 *
 * Increment 1 (ovaj): foundation + shell + deep-link + Izveštaji (lista+detalj) i
 * Plan pregled (read stablo). Plan tabela / Gantt / Ukupan Gant / create-wizard = sledeći increment-i.
 */
export default function MontazaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<ViewKey>('plan');

  // Deep-link init iz URL-a (window da izbegnemo useSearchParams Suspense pod static export-om).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search).get('view');
    if (p && VALID.has(p as ViewKey)) setView(p as ViewKey);
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  function changeView(v: ViewKey) {
    setView(v);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('view', v);
      window.history.replaceState(null, '', url.toString());
    }
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  const tabs: TabItem<ViewKey>[] = VIEWS;

  return (
    <AppShell>
      <PageHeader title="Plan montaže" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={tabs} value={view} onChange={changeView} ariaLabel="Pogledi Plana montaže" />

        {view === 'plan' && <PlanTab />}
        {view === 'gantt' && <GanttTab />}
        {view === 'total' && <TotalGanttTab />}
        {view === 'izvestaji' && <IzvestajiTab />}
      </div>
    </AppShell>
  );
}
