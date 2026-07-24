'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  FileText,
  GanttChartSquare,
  Layers,
  Table2,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell, WideMode } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/app/reversi/_components/tabs';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { PlanTab } from './_components/plan-tab';
import { GanttTab } from './_components/gantt-tab';
import { TotalGanttTab } from './_components/total-gantt-tab';
import { NeusaglasenostiTab } from './_components/neusaglasenosti-tab';

type ViewKey = 'hub' | 'plan' | 'gantt' | 'total' | 'izvestaji' | 'neusaglasenosti';

/** Pogledi modula — hub kartice + tab traka (redosled kao 1.0 view tabs). */
const VIEWS: { key: Exclude<ViewKey, 'hub'>; label: string; icon: LucideIcon; desc: string }[] = [
  { key: 'plan', label: 'Plan', icon: Table2, desc: 'Tabela faza po pozicijama — statusi, procenti, rokovi' },
  { key: 'gantt', label: 'Gantt', icon: GanttChartSquare, desc: 'Vremenska linija faza aktivnog projekta' },
  { key: 'total', label: 'Ukupan Gant', icon: Layers, desc: 'Svi projekti na jednoj vremenskoj osi' },
  { key: 'izvestaji', label: 'Izveštaji', icon: FileText, desc: 'AI servisni izveštaji montera — tekst i fotke u PDF' },
  {
    key: 'neusaglasenosti',
    label: 'Neusaglašenosti',
    icon: AlertTriangle,
    desc: 'Prijava i praćenje odstupanja na montaži (zahtev 004/26)',
  },
];

/** Samo konkretni pogledi su validni deep-linkovi; sve ostalo → hub. */
const VALID = new Set<ViewKey>(['plan', 'gantt', 'total', 'izvestaji', 'neusaglasenosti']);

/**
 * Plan montaže — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md). Hub landing + 4 pogleda
 * (Plan / Gantt / Ukupan Gant / Izveštaji) sa deep-link-om `?view=`. Paritet 1.0
 * planMontaze/index.js: bez ?view= parametra ulaz je HUB (izbor prikaza karticama);
 * ?view=plan|gantt|total|izvestaji vodi pravo u pogled. Modul „Montaža" je UNGATED
 * u 1.0 → svaka aktivna rola ulazi; edit/izveštaji gate-ovi su per-akcija.
 */
export default function MontazaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<ViewKey>('hub');
  // Deep-link ka konkretnoj neusaglašenosti (mejl menadžmentu: ?view=neusaglasenosti&id=N).
  const [initialNcId, setInitialNcId] = useState<number | null>(null);

  // Deep-link init iz URL-a (window da izbegnemo useSearchParams Suspense pod static export-om).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const p = params.get('view');
    if (p && VALID.has(p as ViewKey)) setView(p as ViewKey);
    const idRaw = params.get('id');
    const idNum = idRaw ? Number.parseInt(idRaw, 10) : NaN;
    if (Number.isInteger(idNum) && idNum > 0) setInitialNcId(idNum);
    // „Potroši" deep-link ?id= (obrazac ?tour=1): očisti iz URL-a da se detalj ne
    // otvara ponovo pri promeni pogleda / remount-u (auto-open je jednokratan).
    if (idRaw) {
      const url = new URL(window.location.href);
      url.searchParams.delete('id');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  function changeView(v: ViewKey) {
    setView(v);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      if (v === 'hub') url.searchParams.delete('view');
      else url.searchParams.set('view', v);
      window.history.replaceState(null, '', url.toString());
    }
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>
    );
  }

  // Tab traka (samo van huba): „Meni" vraća na hub — paritet 1.0 view tabs.
  const tabs: TabItem<ViewKey>[] = [{ key: 'hub', label: 'Meni' }, ...VIEWS];

  return (
    <AppShell>
      {/* Gantt pogledi su „široki": sidebar se auto-sklanja dok su aktivni (F1 shell);
          hub/plan/izveštaji zadržavaju normalan raspored. */}
      <WideMode active={view === 'gantt' || view === 'total'} />
      <PageHeader title="Plan montaže" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        {view === 'hub' ? (
          <div className="mx-auto w-full max-w-3xl">
            <h2 className="mb-4 text-sm font-medium text-ink-secondary">Izaberite prikaz</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {VIEWS.map((v) => {
                const Icon = v.icon;
                return (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => changeView(v.key)}
                    className="flex flex-col items-start gap-2 rounded-panel border border-line bg-surface p-4 text-left transition-colors hover:bg-surface-2"
                  >
                    <Icon className="h-7 w-7 text-accent" aria-hidden />
                    <span className="text-sm font-semibold text-ink">{v.label}</span>
                    <span className="text-xs text-ink-secondary">{v.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <Tabs tabs={tabs} value={view} onChange={changeView} ariaLabel="Pogledi Plana montaže" />

            {view === 'plan' && <PlanTab />}
            {view === 'gantt' && <GanttTab />}
            {view === 'total' && <TotalGanttTab />}
            {view === 'izvestaji' && <IzvestajiTab />}
            {view === 'neusaglasenosti' && <NeusaglasenostiTab initialOpenId={initialNcId} />}
          </>
        )}
      </div>
    </AppShell>
  );
}
