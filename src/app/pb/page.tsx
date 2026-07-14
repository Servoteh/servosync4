'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { useProjects, useEngineers } from '@/api/projektni-biro';
import { PlanTab, type PlanFilters } from './_components/plan-tab';
import { KanbanTab } from './_components/kanban-tab';
import { GanttTab } from './_components/gantt-tab';
import { IzvestajiTab } from './_components/izvestaji-tab';
import { AnalizaTab } from './_components/analiza-tab';
import { SavetiTab } from './_components/saveti-tab';
import { PodesavanjaTab } from './_components/podesavanja-tab';
import { TaskEditor } from './_components/task-editor';

type TabKey = 'plan' | 'kanban' | 'gantt' | 'izvestaji' | 'analiza' | 'saveti' | 'podesavanja';

/**
 * Projektni biro (1.0 „Projektovanje") — 3.0 TALAS D (MODULE_SPEC_pb_profil_podesavanja_30 §4).
 * 7 tabova: Plan / Kanban / Gantt / Izveštaji / Analiza / Saveti / Podešavanja (admin).
 * Chrome filteri (projekat/inženjer/pretraga) važe na Plan/Kanban/Gantt. Vidljivost = pb.read;
 * write afordanse gejtovane po pb.edit/progress/tips_write/admin. Task editor = modal (pun +
 * restriktovani inženjer mod). Row-odluku (1h/24h/self-scope) presuđuje sy15 RLS.
 */
export default function PbPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<TabKey>('plan');
  const [editor, setEditor] = useState<{ taskId: string | null; status?: string } | null>(null);
  const [projectId, setProjectId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [q, setQ] = useState('');

  const projectsQ = useProjects();
  const engineersQ = useEngineers();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid flex-1 place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const isAdmin = can(PERMISSIONS.PB_ADMIN);
  const tabs: TabItem<TabKey>[] = [
    { key: 'plan', label: 'Plan' },
    { key: 'kanban', label: 'Kanban' },
    { key: 'gantt', label: 'Gantt' },
    { key: 'izvestaji', label: 'Izveštaji' },
    { key: 'analiza', label: 'Analiza' },
    { key: 'saveti', label: 'Saveti' },
    ...(isAdmin ? [{ key: 'podesavanja' as const, label: 'Podešavanja' }] : []),
  ];

  const filters: PlanFilters = { projectId: projectId || undefined, employeeId: employeeId || undefined, q: q || undefined };
  const showChrome = tab === 'plan' || tab === 'kanban' || tab === 'gantt';
  const openTask = (taskId: string | null, status?: string) => setEditor({ taskId, status });

  const selCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';

  return (
    <AppShell>
      <PageHeader title="Projektni biro" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Projektni biro" />
          {showChrome && (
            <div className="flex flex-wrap items-center gap-2">
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={selCls} aria-label="Projekat">
                <option value="">Svi projekti</option>
                {(projectsQ.data?.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {[p.project_code, p.project_name].filter(Boolean).join(' ')}
                  </option>
                ))}
              </select>
              <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={selCls} aria-label="Inženjer">
                <option value="">Svi inženjeri</option>
                {(engineersQ.data?.data ?? []).map((en) => (
                  <option key={en.id} value={en.id}>
                    {en.full_name}
                  </option>
                ))}
              </select>
              <SearchBox value={q} onChange={setQ} placeholder="Pretraži zadatke…" />
            </div>
          )}
        </div>

        {tab === 'plan' && <PlanTab filters={filters} onOpenTask={openTask} />}
        {tab === 'kanban' && <KanbanTab filters={filters} onOpenTask={openTask} />}
        {tab === 'gantt' && <GanttTab filters={filters} onOpenTask={openTask} />}
        {tab === 'izvestaji' && <IzvestajiTab />}
        {tab === 'analiza' && <AnalizaTab onOpenTask={openTask} />}
        {tab === 'saveti' && <SavetiTab />}
        {tab === 'podesavanja' && isAdmin && <PodesavanjaTab />}
      </div>

      {editor && <TaskEditor taskId={editor.taskId} initialStatus={editor.status} onClose={() => setEditor(null)} />}
    </AppShell>
  );
}
