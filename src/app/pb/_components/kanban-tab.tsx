'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { useTasks, useBulkUpdateTasks, type PbTask } from '@/api/projektni-biro';
import { PrioBadge, ProgressBar } from './shared';
import type { PlanFilters } from './plan-tab';

// Kanban kolone (1.0 redosled): Nije počelo, U toku, Pregled, Blokirano, Završeno.
const COLUMNS = ['Nije počelo', 'U toku', 'Pregled', 'Blokirano', 'Završeno'] as const;
const COL_TONE: Record<string, string> = {
  'Nije počelo': 'border-t-status-neutral',
  'U toku': 'border-t-accent',
  Pregled: 'border-t-status-warn',
  Blokirano: 'border-t-status-danger',
  Završeno: 'border-t-status-success',
};

/** Brze akcije po statusu (1.0 quickActions), max 2. */
const QUICK: Record<string, { to: string; label: string }[]> = {
  'Nije počelo': [{ to: 'U toku', label: '→ U toku' }],
  'U toku': [
    { to: 'Pregled', label: '→ Pregled' },
    { to: 'Završeno', label: '→ Završeno' },
  ],
  Pregled: [
    { to: 'U toku', label: '→ U toku' },
    { to: 'Završeno', label: '→ Završeno' },
  ],
  Blokirano: [{ to: 'U toku', label: '→ U toku' }],
  Završeno: [{ to: 'U toku', label: '↩ Ponovo otvori' }],
};

export function KanbanTab({ filters, onOpenTask }: { filters: PlanFilters; onOpenTask: (id: string | null, status?: string) => void }) {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.PB_EDIT);
  const tasksQ = useTasks({ ...filters, pageSize: 500 });
  const bulkM = useBulkUpdateTasks();
  const [showAllDone, setShowAllDone] = useState(false);

  const byStatus = useMemo(() => {
    const map: Record<string, PbTask[]> = {};
    for (const c of COLUMNS) map[c] = [];
    for (const t of tasksQ.data?.data ?? []) {
      if (t.deleted_at) continue;
      (map[t.status] ?? (map[t.status] = [])).push(t);
    }
    return map;
  }, [tasksQ.data]);

  // „+10 dana done": u koloni Završeno prikaži samo zadatke završene u poslednjih 10 dana.
  const doneRecent = useMemo(() => {
    if (showAllDone) return byStatus['Završeno'];
    const cutoff = Date.now() - 10 * 86400000;
    return byStatus['Završeno'].filter((t) => {
      const d = t.datum_zavrsetka_real || t.datum_zavrsetka_plan;
      return d ? new Date(d).getTime() >= cutoff : true;
    });
  }, [byStatus, showAllDone]);
  const hiddenDone = byStatus['Završeno'].length - doneRecent.length;

  function quick(id: string, to: string) {
    bulkM.mutate({ ids: [id], status: to });
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
      {COLUMNS.map((col) => {
        const items = col === 'Završeno' ? doneRecent : byStatus[col];
        return (
          <div key={col} className={cn('rounded-panel border border-line border-t-2 bg-surface', COL_TONE[col])}>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm font-semibold text-ink">{col}</span>
              <div className="flex items-center gap-1">
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">{items.length}</span>
                {canEdit && (
                  <button onClick={() => onOpenTask(null, col)} className="rounded p-0.5 text-ink-secondary hover:bg-surface-2" aria-label="Dodaj karticu">
                    ＋
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-2 px-2 pb-2">
              {items.map((t) => (
                <div key={t.id} className="rounded-control border border-line-soft bg-surface-2 p-2">
                  <button onClick={() => onOpenTask(t.id)} className="block w-full text-left">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium text-ink">{t.naziv}</span>
                      <PrioBadge prio={t.prioritet} />
                    </div>
                    <div className="mt-1 text-xs text-ink-secondary">
                      {[t.project_code, t.vrsta].filter(Boolean).join(' · ') || '—'}
                    </div>
                    {t.problem && <div className="mt-0.5 text-xs text-status-warn">⚠ problem</div>}
                    <div className="mt-1 text-xs text-ink-secondary">{t.employee_name ?? '— nedodeljen —'}</div>
                    <div className="mt-1">
                      <ProgressBar value={t.procenat_zavrsenosti} />
                    </div>
                  </button>
                  {canEdit && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {(QUICK[col] ?? []).map((a) => (
                        <button
                          key={a.to}
                          onClick={() => quick(t.id, a.to)}
                          className="rounded border border-line bg-surface px-1.5 py-0.5 text-2xs text-ink-secondary hover:bg-surface-2"
                        >
                          {a.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {col === 'Završeno' && hiddenDone > 0 && !showAllDone && (
                <Button variant="ghost" onClick={() => setShowAllDone(true)} className="h-7 w-full text-xs">
                  Još {hiddenDone} starijih završenih…
                </Button>
              )}
              {items.length === 0 && <p className="px-1 py-4 text-center text-xs text-ink-disabled">—</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
