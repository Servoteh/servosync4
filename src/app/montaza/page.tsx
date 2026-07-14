'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { PERMISSIONS } from '@/lib/permissions';
import { useProjectsTree } from '@/api/plan-montaze';
import { PlanView } from './_components/plan-view';
import { GanttView } from './_components/gantt-view';
import { IzvestajiView } from './_components/izvestaji-view';

type ViewKey = 'plan' | 'gantt' | 'total' | 'izvestaji';

const VIEWS: TabItem<ViewKey>[] = [
  { key: 'plan', label: 'Plan' },
  { key: 'gantt', label: 'Gantt' },
  { key: 'total', label: 'Ukupan Gant' },
  { key: 'izvestaji', label: 'Izveštaji' },
];

/**
 * Plan montaže — 3.0 TALAS C (MODULE_SPEC_planovi_pracenje_30.md §4). Hub + 4 pogleda
 * (Plan/Gantt/Ukupan Gant/Izveštaji) sa deep-link `?view=`. Modul „Montaža" je UNGATED
 * u 1.0 → vidljivost = montaza.read; edit = montaza.edit (uklj. tim_lider, presuda C1).
 */
export default function MontazaPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [view, setView] = useState<ViewKey>('plan');
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Deep-link ?view= (+ popstate).
  useEffect(() => {
    const sync = () => {
      const v = new URLSearchParams(window.location.search).get('view') as ViewKey | null;
      if (v && VIEWS.some((t) => t.key === v)) setView(v);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  function changeView(v: ViewKey) {
    setView(v);
    window.history.replaceState(null, '', `/montaza?view=${v}`);
  }

  const projectsQ = useProjectsTree();
  const projects = projectsQ.data?.data ?? [];
  const canEdit = can(PERMISSIONS.MONTAZA_EDIT);
  const canManage = can(PERMISSIONS.MONTAZA_AI_ADMIN); // menadžment/admin za tuđe izveštaje

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const singleProject = projects.filter((p) => p.id === (selectedProject ?? projects[0]?.id));

  return (
    <AppShell>
      <PageHeader
        title="Plan montaže"
        count={view !== 'izvestaji' ? `${projects.length} projekata` : undefined}
        actions={<Tabs tabs={VIEWS} value={view} onChange={changeView} ariaLabel="Pogledi Plana montaže" />}
      />
      <main className="flex-1 overflow-auto p-6">
        {projectsQ.isError && view !== 'izvestaji' ? (
          <EmptyState title="Greška pri učitavanju" hint="Pokušaj ponovo za koji trenutak." />
        ) : view === 'plan' ? (
          <PlanView projects={projects} canEdit={canEdit} selectedId={selectedProject} onSelect={setSelectedProject} />
        ) : view === 'gantt' ? (
          <GanttView projects={singleProject} mode="single" />
        ) : view === 'total' ? (
          <GanttView projects={projects} mode="total" />
        ) : (
          <IzvestajiView canManage={canManage} />
        )}
      </main>
    </AppShell>
  );
}
