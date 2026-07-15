'use client';

// Gantt — aktivan projekat (increment 3). Paritet 1.0 gantt.js: izbor projekta/WP,
// „prikaži završene" toggle, dan-mreža sa trakama faza + drag/resize (GanttChart),
// snimanje kroz debounce autosave. Deli izgled/drag sa Ukupnim Gantom.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown } from 'lucide-react';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { cn } from '@/lib/cn';
import { useMontazaTree, toPhaseVM, type PhaseVM } from '@/api/plan-montaze';
import { applyBusinessRules } from '@/lib/plan-montaze/phase';
import { buildDayRange, buildMonthsHeader, inferGanttBounds } from '@/lib/plan-montaze/gantt';
import { generateGanttPdf } from '@/lib/plan-montaze/gantt-pdf';
import { usePhaseAutosave } from '@/lib/plan-montaze/autosave';
import { GanttChart, type GanttRow } from './gantt-chart';
import { SaveStatusPanel } from './save-status';

export function GanttTab() {
  const tree = useMontazaTree();
  const canEdit = useCan()(PERMISSIONS.MONTAZA_EDIT);
  const save = usePhaseAutosave();

  const projects = useMemo(() => tree.data?.data ?? [], [tree.data]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [wpId, setWpId] = useState<string | null>(null);
  const [phases, setPhases] = useState<PhaseVM[]>([]);
  const [showFinished, setShowFinished] = useState(false);
  const seededWp = useRef<string | null>(null);

  useEffect(() => {
    if (!projects.length) return;
    if (!projectId || !projects.some((p) => p.id === projectId)) {
      const p0 = projects[0];
      setProjectId(p0.id);
      setWpId(p0.workPackages[0]?.id ?? null);
    }
  }, [projects, projectId]);

  const activeProject = projects.find((p) => p.id === projectId) ?? null;
  const activeWp = activeProject?.workPackages.find((w) => w.id === wpId) ?? null;

  useEffect(() => {
    if (!wpId) {
      setPhases([]);
      seededWp.current = null;
      return;
    }
    if (seededWp.current === wpId) return;
    const wp = projects.find((p) => p.id === projectId)?.workPackages.find((w) => w.id === wpId);
    if (!wp) return;
    setPhases(
      wp.phases
        .slice()
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map(toPhaseVM),
    );
    seededWp.current = wpId;
  }, [wpId, projectId, projects]);

  const onCommit = useCallback(
    (id: string, start: string, end: string) => {
      setPhases((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const next = { ...p, startDate: start, endDate: end };
          applyBusinessRules(next);
          save.saveNow(next);
          return next;
        }),
      );
    },
    [save],
  );

  const visible = useMemo(
    () => phases.filter((p) => showFinished || p.status !== 2),
    [phases, showFinished],
  );
  const { days, months } = useMemo(() => {
    const withDates = visible.filter((p) => p.startDate || p.endDate);
    const { min, max } = inferGanttBounds(withDates, (p) => p.startDate || null, (p) => p.endDate || null);
    const d = buildDayRange(min, max);
    return { days: d, months: buildMonthsHeader(d) };
  }, [visible]);

  const rows: GanttRow[] = useMemo(() => visible.map((p) => ({ kind: 'phase', phase: p })), [visible]);

  function switchWp(id: string) {
    save.flushAll();
    setWpId(id);
  }
  function switchProject(id: string) {
    save.flushAll();
    setProjectId(id);
    const p = projects.find((x) => x.id === id);
    setWpId(p?.workPackages[0]?.id ?? null);
  }

  if (tree.isLoading) return <div className="p-6 text-sm text-ink-secondary">Učitavanje…</div>;
  if (tree.isError) return <div className="p-6 text-sm text-status-danger">Greška pri učitavanju.</div>;
  if (!projects.length) return <EmptyState title="Nema projekata" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Projekat
          <select
            value={projectId ?? ''}
            onChange={(e) => switchProject(e.target.value)}
            className="h-9 min-w-64 rounded-control border border-line bg-surface px-2 text-sm text-ink"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.project_code ? `${p.project_code} · ` : ''}
                {p.project_name}
              </option>
            ))}
          </select>
        </label>
        {activeProject && activeProject.workPackages.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {activeProject.workPackages.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => switchWp(w.id)}
                className={cn(
                  'rounded-control px-2.5 py-1.5 text-xs',
                  w.id === wpId ? 'bg-accent font-medium text-accent-fg' : 'border border-line text-ink-secondary hover:bg-surface-2',
                )}
                title={w.name}
              >
                <span className="tnums">{w.rnCode || 'RN'}</span>
                {w.name ? ` · ${w.name}` : ''}
              </button>
            ))}
          </div>
        )}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} />
          Prikaži završene
        </label>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => void generateGanttPdf(`Gantt — ${activeProject?.project_name ?? ''}`.trim(), days, rows)}
            title="Izvezi Gantt u PDF"
            className="flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2"
          >
            <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
          </button>
        )}
      </div>

      <p className="text-xs text-ink-disabled">
        Prevuci traku za pomeranje · levi/desni kraj za promenu datuma · Shift+klik na dan za raspon.
      </p>

      {!activeWp ? (
        <EmptyState title="Nema pozicije (naloga montaže)" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nema faza za prikaz" hint={'Probajte „Prikaži završene" ili dodajte datume fazama u tabu Plan.'} />
      ) : (
        <GanttChart days={days} months={months} rows={rows} editable={canEdit} labelHeader="Faza" onCommit={onCommit} />
      )}

      <SaveStatusPanel status={save.status} />
    </div>
  );
}
