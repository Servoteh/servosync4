'use client';

// Ukupan Gant — svi projekti (increment 3). Paritet 1.0 totalGantt.js: filteri
// (lokacija/vođa/inženjer/datum od-do), per-WP checkbox lista, „prikaži završene" i
// „samo sa datumom" toggle, grupisani redovi (projekat → nalog → faze), drag/resize,
// raspon klampovan na 730 dana. Deli GanttChart (izgled + drag) sa single Gantom.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FileDown } from 'lucide-react';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useMontazaTree, toPhaseVM, type PhaseVM } from '@/api/plan-montaze';
import {
  DEFAULT_LOCATIONS,
  ENGINEERS_DEFAULT,
  VODJA_DEFAULT,
} from '@/lib/plan-montaze/constants';
import { applyBusinessRules } from '@/lib/plan-montaze/phase';
import { parseDateLocal, getToday } from '@/lib/plan-montaze/date';
import { buildDayRange, buildMonthsHeader } from '@/lib/plan-montaze/gantt';
import { generateGanttPdf } from '@/lib/plan-montaze/gantt-pdf';
import { usePhaseAutosave } from '@/lib/plan-montaze/autosave';
import { GanttChart, type GanttRow } from './gantt-chart';
import { SaveStatusPanel } from './save-status';

interface TgItem {
  phase: PhaseVM;
  projectId: string;
  projectCode: string;
  projectName: string;
  wpId: string;
  wpName: string;
  wpRn: string;
}

interface Filters {
  loc: string;
  lead: string;
  engineer: string;
  dateFrom: string;
  dateTo: string;
}
const EMPTY: Filters = { loc: '', lead: '', engineer: '', dateFrom: '', dateTo: '' };

function uniq(base: readonly string[], extra: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...base, ...extra]) {
    const s = (v ?? '').trim();
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function TotalGanttTab() {
  const tree = useMontazaTree();
  const canEdit = useCan()(PERMISSIONS.MONTAZA_EDIT);
  const save = usePhaseAutosave();

  const projects = useMemo(() => tree.data?.data ?? [], [tree.data]);
  const [items, setItems] = useState<TgItem[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [showFinished, setShowFinished] = useState(false);
  const [onlyWithDates, setOnlyWithDates] = useState(false);
  const [wpOff, setWpOff] = useState<Set<string>>(() => new Set());
  const seeded = useRef(false);

  // Seed jednom (bez reseed na pozadinski refetch — lokalno je izvor istine za drag/edit).
  useEffect(() => {
    if (seeded.current || !projects.length) return;
    const flat: TgItem[] = [];
    for (const p of projects) {
      for (const wp of p.workPackages) {
        for (const ph of wp.phases) {
          flat.push({
            phase: toPhaseVM(ph),
            projectId: p.id,
            projectCode: p.project_code || '',
            projectName: p.project_name || '',
            wpId: wp.id,
            wpName: wp.name || '',
            wpRn: wp.rnCode || '',
          });
        }
      }
    }
    setItems(flat);
    seeded.current = true;
  }, [projects]);

  const allWps = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; label: string }[] = [];
    for (const it of items) {
      if (seen.has(it.wpId)) continue;
      seen.add(it.wpId);
      out.push({ id: it.wpId, label: `${it.projectCode}/${it.wpName}` });
    }
    return out;
  }, [items]);

  const leads = useMemo(() => uniq(VODJA_DEFAULT, items.map((i) => i.phase.montageLead)), [items]);
  const engineers = useMemo(() => uniq(ENGINEERS_DEFAULT, items.map((i) => i.phase.responsibleEngineer)), [items]);
  const locations = useMemo(() => uniq(DEFAULT_LOCATIONS, items.map((i) => i.phase.location)), [items]);

  const filtered = useMemo(() => {
    const f = filters;
    const fromMs = f.dateFrom ? parseDateLocal(f.dateFrom)?.getTime() ?? null : null;
    const toMs = f.dateTo ? parseDateLocal(f.dateTo)?.getTime() ?? null : null;
    return items.filter((it) => {
      const ph = it.phase;
      if (wpOff.has(it.wpId)) return false;
      if (!showFinished && ph.status === 2) return false;
      if (onlyWithDates && (!ph.startDate || !ph.endDate)) return false;
      if (f.loc && ph.location !== f.loc) return false;
      if (f.lead && ph.montageLead !== f.lead) return false;
      if (f.engineer && ph.responsibleEngineer !== f.engineer) return false;
      if (fromMs !== null || toMs !== null) {
        if (!ph.startDate && !ph.endDate) return false;
        const s = parseDateLocal(ph.startDate)?.getTime() ?? null;
        const e = parseDateLocal(ph.endDate)?.getTime() ?? s;
        if (toMs !== null && s !== null && s > toMs) return false;
        if (fromMs !== null) {
          const cmp = e !== null ? e : s;
          if (cmp !== null && cmp < fromMs) return false;
        }
      }
      return true;
    });
  }, [items, filters, showFinished, onlyWithDates, wpOff]);

  const { days, months } = useMemo(() => {
    const today = getToday();
    let min: Date;
    let max: Date;
    if (filters.dateFrom) min = parseDateLocal(filters.dateFrom) || new Date(today);
    else {
      min = new Date(today);
      for (const it of filtered) {
        const d = parseDateLocal(it.phase.startDate);
        if (d && d < min) min = d;
      }
      min.setDate(min.getDate() - 3);
    }
    if (filters.dateTo) max = parseDateLocal(filters.dateTo) || new Date(today);
    else {
      max = new Date(today);
      max.setDate(max.getDate() + 60);
      for (const it of filtered) {
        const d = parseDateLocal(it.phase.endDate);
        if (d && d > max) max = d;
      }
      max.setDate(max.getDate() + 5);
    }
    min.setHours(0, 0, 0, 0);
    max.setHours(0, 0, 0, 0);
    if (Math.round((max.getTime() - min.getTime()) / 864e5) > 730) {
      max = new Date(min);
      max.setDate(min.getDate() + 730);
    }
    const d = buildDayRange(min, max);
    return { days: d, months: buildMonthsHeader(d) };
  }, [filtered, filters.dateFrom, filters.dateTo]);

  // Grupisanje projekat → nalog → faze (redosled stabla).
  const rows: GanttRow[] = useMemo(() => {
    const out: GanttRow[] = [];
    const projSeen = new Set<string>();
    const wpSeen = new Set<string>();
    for (const it of filtered) {
      if (!projSeen.has(it.projectId)) {
        projSeen.add(it.projectId);
        out.push({
          kind: 'group',
          id: `p-${it.projectId}`,
          label: `${it.projectCode ? it.projectCode + ' — ' : ''}${it.projectName}`,
        });
      }
      if (!wpSeen.has(it.wpId)) {
        wpSeen.add(it.wpId);
        out.push({
          kind: 'group',
          id: `w-${it.wpId}`,
          label: `↳ ${it.wpName}`,
          sub: it.wpRn,
        });
      }
      out.push({ kind: 'phase', phase: it.phase });
    }
    return out;
  }, [filtered]);

  const onCommit = useCallback(
    (id: string, start: string, end: string) => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.phase.id !== id) return it;
          const next = { ...it.phase, startDate: start, endDate: end };
          applyBusinessRules(next);
          save.saveNow(next);
          return { ...it, phase: next };
        }),
      );
    },
    [save],
  );

  if (tree.isLoading) return <div className="p-6 text-sm text-ink-secondary">Učitavanje…</div>;
  if (tree.isError) return <div className="p-6 text-sm text-status-danger">Greška pri učitavanju.</div>;
  if (!projects.length) return <EmptyState title="Nema projekata" />;

  const anyFilter = !!filters.loc || !!filters.lead || !!filters.engineer || !!filters.dateFrom || !!filters.dateTo || showFinished || onlyWithDates || wpOff.size > 0;

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line bg-surface p-2">
        <Field label="Lokacija">
          <select value={filters.loc} onChange={(e) => setFilters((f) => ({ ...f, loc: e.target.value }))} className={selCls}>
            <option value="">Sve</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Vođa">
          <select value={filters.lead} onChange={(e) => setFilters((f) => ({ ...f, lead: e.target.value }))} className={selCls}>
            <option value="">Svi</option>
            {leads.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Inženjer">
          <select value={filters.engineer} onChange={(e) => setFilters((f) => ({ ...f, engineer: e.target.value }))} className={selCls}>
            <option value="">Svi</option>
            {engineers.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </Field>
        <Field label="Datum od">
          <input type="date" value={filters.dateFrom} onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))} className={selCls} />
        </Field>
        <Field label="Datum do">
          <input type="date" value={filters.dateTo} onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))} className={selCls} />
        </Field>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} /> Prikaži završene
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={onlyWithDates} onChange={(e) => setOnlyWithDates(e.target.checked)} /> Samo sa datumom
        </label>
        {anyFilter && (
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY);
              setShowFinished(false);
              setOnlyWithDates(false);
              setWpOff(new Set());
            }}
            className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
          >
            Reset
          </button>
        )}
        {rows.length > 0 && (
          <button
            type="button"
            onClick={() => void generateGanttPdf('Ukupan Gant', days, rows)}
            title="Izvezi Ukupan Gant u PDF"
            className="flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-xs text-ink-secondary hover:bg-surface-2"
          >
            <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
          </button>
        )}
      </div>

      {/* Per-WP checkbox lista */}
      {allWps.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface px-2 py-1.5">
          <span className="text-xs font-medium text-ink-secondary">Pozicije:</span>
          {allWps.map((w) => (
            <label key={w.id} className="flex items-center gap-1 text-xs text-ink-secondary">
              <input
                type="checkbox"
                checked={!wpOff.has(w.id)}
                onChange={(e) =>
                  setWpOff((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.delete(w.id);
                    else next.add(w.id);
                    return next;
                  })
                }
              />
              {w.label}
            </label>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Nema faza po trenutnim filterima" />
      ) : (
        <GanttChart days={days} months={months} rows={rows} editable={canEdit} labelHeader="Projekat / Pozicija / Faza" onCommit={onCommit} />
      )}

      <SaveStatusPanel status={save.status} />
    </div>
  );
}

const selCls = 'h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-ink-secondary">
      {label}
      {children}
    </label>
  );
}
