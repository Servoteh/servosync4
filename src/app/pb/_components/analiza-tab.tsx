'use client';

import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useTasks, PB_STATUSI, type PbTask } from '@/api/projektni-biro';
import { TaskStatusBadge, PrioBadge, shortDate, workDaysBetween, ProgressBar } from './shared';

export function AnalizaTab({ onOpenTask }: { onOpenTask: (id: string | null) => void }) {
  const tasksQ = useTasks({ pageSize: 500 });
  const all = (tasksQ.data?.data ?? []).filter((t) => !t.deleted_at);

  const projects = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of all) {
      if (t.project_id) map.set(t.project_id, [t.project_code, t.project_name].filter(Boolean).join(' ') || 'Projekat');
    }
    return [...map.entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label, 'sr'));
  }, [all]);

  const [projectId, setProjectId] = useState('');
  const sel = projectId || projects[0]?.id || '';
  const rows = all.filter((t) => t.project_id === sel);

  const byEngineer = useMemo(() => {
    const map = new Map<string, { name: string; rows: PbTask[] }>();
    for (const t of rows) {
      const key = t.employee_id ?? '—';
      const name = t.employee_name ?? 'Bez inženjera';
      if (!map.has(key)) map.set(key, { name, rows: [] });
      map.get(key)!.rows.push(t);
    }
    return [...map.values()];
  }, [rows]);

  const problems = rows.filter((t) => t.problem && t.status !== 'Završeno');

  // timeline projekta
  const dates = rows.flatMap((t) => [t.datum_pocetka_plan, t.datum_zavrsetka_plan].filter(Boolean) as string[]);
  const minD = dates.length ? new Date(Math.min(...dates.map((d) => new Date(d).getTime()))) : null;
  const maxD = dates.length ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))) : null;
  const totalDays = minD && maxD ? Math.max(1, Math.round((maxD.getTime() - minD.getTime()) / 86400000)) : 0;
  const elapsed = minD ? Math.max(0, Math.round((Date.now() - minD.getTime()) / 86400000)) : 0;
  const elapsedPct = totalDays ? Math.min(100, Math.round((elapsed / totalDays) * 100)) : 0;

  if (tasksQ.isError) return <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />;
  if (projects.length === 0) return <EmptyState title="Nema projekata sa zadacima" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm text-ink-secondary">Analiza projekta</label>
        <select
          value={sel}
          onChange={(e) => setProjectId(e.target.value)}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {minD && maxD && Number.isFinite(minD.getTime()) && Number.isFinite(maxD.getTime()) && (
        <div className="rounded-panel border border-line bg-surface p-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Timeline projekta</h3>
          <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${elapsedPct}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-secondary">
            Projekat traje: {totalDays} dana ukupno · Proteklo: ~{elapsed} dana ({elapsedPct}%) · {shortDate(minD.toISOString())} →{' '}
            {shortDate(maxD.toISOString())}
          </p>
        </div>
      )}

      <div className="rounded-panel border border-line bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Inženjeri na projektu</h3>
        <div className="space-y-3">
          {byEngineer.map((g) => {
            const done = g.rows.filter((t) => t.status === 'Završeno').length;
            return (
              <div key={g.name}>
                <div className="text-sm font-medium text-ink">
                  {g.name} <span className="text-ink-secondary">· {g.rows.length} zadataka · {done} završeno</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {PB_STATUSI.map((s) => {
                    const n = g.rows.filter((t) => t.status === s).length;
                    return n ? (
                      <span key={s} className="text-xs">
                        <TaskStatusBadge status={s} /> <span className="tnums text-ink-secondary">{n}</span>
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-panel border border-line bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-ink">Zadaci projekta</h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {rows.map((t) => (
            <button
              key={t.id}
              onClick={() => onOpenTask(t.id)}
              className="rounded-control border border-line-soft bg-surface-2 p-3 text-left hover:border-accent/40"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="font-medium text-ink">{t.naziv}</span>
                <TaskStatusBadge status={t.status} />
              </div>
              <div className="mt-1 text-xs text-ink-secondary">
                {[t.employee_name, t.vrsta].filter(Boolean).join(' · ')} <PrioBadge prio={t.prioritet} />
              </div>
              <div className="mt-1 text-xs text-ink-secondary">
                {shortDate(t.datum_pocetka_plan)} → {shortDate(t.datum_zavrsetka_plan)} · {workDaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan) ?? '—'} rd
              </div>
              <div className="mt-1">
                <ProgressBar value={t.procenat_zavrsenosti} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {problems.length > 0 && (
        <div className="rounded-panel border border-status-warn/40 bg-status-warn-bg/40 p-4">
          <h3 className="mb-2 text-sm font-semibold text-status-warn">⚠ Aktivni problemi</h3>
          <ul className="space-y-2">
            {problems.map((t) => (
              <li key={t.id} className="text-sm">
                <span className="font-medium text-ink">{t.naziv}</span> — {t.employee_name ?? 'nedodeljen'} — <TaskStatusBadge status={t.status} />
                <p className="mt-0.5 whitespace-pre-wrap text-ink-secondary">{t.problem}</p>
                {t.datum_zavrsetka_plan && <p className="text-xs text-ink-disabled">Rok: {shortDate(t.datum_zavrsetka_plan)}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
