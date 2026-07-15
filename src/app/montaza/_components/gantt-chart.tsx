'use client';

// Plan montaže — deljeni Gantt (single + total). Port 1:1 iz 1.0 gantt.js/totalGantt.js/
// ganttDrag.js: dan-mreža sa mesečnim headerom, trake obojene lokacijom (mech/elec stil),
// drag cele trake + levi/desni handle (delta dana = round(dx/CELL_W)), today/vikend/kolona-
// selekcija (klik + Shift raspon). Snimanje ide preko onCommit (autosave u tabu).

import { memo, useCallback, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { STATUSES } from '@/lib/plan-montaze/constants';
import { GANTT_CELL_W, type MonthSpan } from '@/lib/plan-montaze/gantt';
import { parseDateLocal, dateToYMD, formatDmy } from '@/lib/plan-montaze/date';
import { calcRisk, locationColor } from '@/lib/plan-montaze/phase';
import type { PhaseVM } from '@/api/plan-montaze';

const LABEL_W = 248;

export type GanttRow =
  | { kind: 'group'; id: string; label: string; sub?: string; color?: string }
  | { kind: 'phase'; phase: PhaseVM };

interface GanttChartProps {
  days: Date[];
  months: MonthSpan[];
  rows: GanttRow[];
  editable: boolean;
  labelHeader: string;
  onCommit: (phaseId: string, start: string, end: string) => void;
}

type DragMode = 'move' | 'start' | 'end';
interface Preview {
  phaseId: string;
  start: string;
  end: string;
}

export function GanttChart({ days, months, rows, editable, labelHeader, onCommit }: GanttChartProps) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selDays, setSelDays] = useState<Set<number>>(() => new Set());
  const lastSel = useRef<number | null>(null);
  const drag = useRef<{
    phaseId: string;
    mode: DragMode;
    originX: number;
    startD: Date;
    endD: Date;
    changed: boolean;
    curStart: string;
    curEnd: string;
  } | null>(null);

  const todayMs = (() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  })();

  const onDayHeaderClick = useCallback((e: React.MouseEvent, idx: number) => {
    setSelDays((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastSel.current !== null) {
        const from = Math.min(lastSel.current, idx);
        const to = Math.max(lastSel.current, idx);
        for (let k = from; k <= to; k++) next.add(k);
      } else if (next.has(idx) && next.size === 1) {
        next.clear();
        lastSel.current = null;
      } else {
        if (!e.ctrlKey && !e.metaKey) next.clear();
        next.add(idx);
        lastSel.current = idx;
      }
      return next;
    });
  }, []);

  const onDragStart = useCallback(
    (e: React.PointerEvent, phase: PhaseVM, mode: DragMode) => {
      if (!editable) return;
      const sD = parseDateLocal(phase.startDate);
      const eD = parseDateLocal(phase.endDate);
      if (!sD || !eD) return; // faza mora imati start/end (paritet 1.0)
      e.preventDefault();
      drag.current = {
        phaseId: phase.id,
        mode,
        originX: e.clientX,
        startD: sD,
        endD: eD,
        changed: false,
        curStart: phase.startDate,
        curEnd: phase.endDate,
      };
      setPreview({ phaseId: phase.id, start: phase.startDate, end: phase.endDate });

      const onMove = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        const delta = Math.round((ev.clientX - d.originX) / GANTT_CELL_W);
        let newS = new Date(d.startD);
        let newE = new Date(d.endD);
        if (d.mode === 'move') {
          newS.setDate(d.startD.getDate() + delta);
          newE.setDate(d.endD.getDate() + delta);
        } else if (d.mode === 'start') {
          newS.setDate(d.startD.getDate() + delta);
          if (newS > d.endD) newS = new Date(d.endD);
        } else {
          newE.setDate(d.endD.getDate() + delta);
          if (newE < d.startD) newE = new Date(d.startD);
        }
        d.changed = delta !== 0;
        d.curStart = dateToYMD(newS)!;
        d.curEnd = dateToYMD(newE)!;
        setPreview({ phaseId: d.phaseId, start: d.curStart, end: d.curEnd });
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const d = drag.current;
        drag.current = null;
        setPreview(null);
        if (d?.changed) onCommit(d.phaseId, d.curStart, d.curEnd);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [editable, onCommit],
  );

  const colCount = days.length + 1;

  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="text-sm" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
        <thead>
          <tr>
            <th
              rowSpan={2}
              className="sticky left-0 z-20 border-b border-r border-line bg-surface-2 px-3 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary"
              style={{ width: LABEL_W, minWidth: LABEL_W }}
            >
              {labelHeader}
            </th>
            {months.map((m) => (
              <th
                key={m.key}
                colSpan={m.count}
                className="border-b border-r border-line bg-surface-2 px-1 text-center text-2xs font-semibold text-ink-secondary"
              >
                {m.label}
              </th>
            ))}
          </tr>
          <tr>
            {days.map((d, idx) => {
              const isT = d.getTime() === todayMs;
              const isW = d.getDay() === 0 || d.getDay() === 6;
              const isSel = selDays.has(idx);
              return (
                <th
                  key={idx}
                  onClick={(e) => onDayHeaderClick(e, idx)}
                  title={`${formatDmy(dateToYMD(d))} — klik za selekciju, Shift+klik za raspon`}
                  className={cn(
                    'cursor-pointer border-b border-r border-line-soft text-center text-2xs tabular-nums',
                    isW && 'bg-surface-2',
                    isSel && 'bg-accent-subtle',
                    isT && 'border-l-2 border-l-accent font-semibold text-accent',
                  )}
                  style={{ width: GANTT_CELL_W, minWidth: GANTT_CELL_W }}
                >
                  {d.getDate()}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.kind === 'group') {
              return (
                <tr key={row.id}>
                  <td
                    colSpan={colCount}
                    className="sticky left-0 z-10 border-b border-line px-3 py-1 text-xs font-semibold text-ink"
                    style={row.color ? { background: row.color, color: '#fff' } : { background: 'var(--surface-2)' }}
                  >
                    {row.label}
                    {row.sub && <span className="ml-2 font-normal opacity-80">{row.sub}</span>}
                  </td>
                </tr>
              );
            }
            const p = row.phase;
            const eff = preview && preview.phaseId === p.id ? preview : { start: p.startDate, end: p.endDate };
            return (
              <PhaseGanttRow
                key={p.id}
                phase={p}
                days={days}
                effStart={eff.start}
                effEnd={eff.end}
                editable={editable}
                selDays={selDays}
                todayMs={todayMs}
                onDragStart={onDragStart}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PhaseRowProps {
  phase: PhaseVM;
  days: Date[];
  effStart: string;
  effEnd: string;
  editable: boolean;
  selDays: Set<number>;
  todayMs: number;
  onDragStart: (e: React.PointerEvent, phase: PhaseVM, mode: DragMode) => void;
}

const PhaseGanttRow = memo(function PhaseGanttRow({
  phase,
  days,
  effStart,
  effEnd,
  editable,
  selDays,
  todayMs,
  onDragStart,
}: PhaseRowProps) {
  const sMs = parseDateLocal(effStart)?.getTime() ?? null;
  const eMs = parseDateLocal(effEnd)?.getTime() ?? null;
  const rk = calcRisk(phase);
  const color = locationColor(phase.location);
  const isElec = phase.phaseType === 'electrical';
  const eng = phase.responsibleEngineer ? phase.responsibleEngineer.split(' ').pop() : '';
  const ld = phase.montageLead ? phase.montageLead.split(' ').pop() : '';

  return (
    <tr className={cn('border-b border-line-soft', rk.level === 'high' && 'bg-status-danger-bg/15')}>
      <td
        className="sticky left-0 z-10 border-r border-line bg-surface px-2 py-1"
        style={{ width: LABEL_W, minWidth: LABEL_W, borderLeft: `3px solid ${color}` }}
      >
        <div className="truncate text-sm font-medium text-ink" title={phase.phaseName}>
          {phase.phaseName || '—'}
        </div>
        <div className="flex items-center gap-1 truncate text-2xs text-ink-secondary">
          <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
          {phase.location || '—'}
          {eng ? ` · ${eng}` : ''}
          {ld ? ` · ${ld}` : ''}
          {' · '}
          {STATUSES[phase.status] ?? ''} {phase.pct}%
        </div>
      </td>
      {days.map((d, idx) => {
        const dMs = d.getTime();
        const isT = dMs === todayMs;
        const isW = d.getDay() === 0 || d.getDay() === 6;
        const isSel = selDays.has(idx);
        const inB = sMs !== null && eMs !== null && dMs >= sMs && dMs <= eMs;
        const isS = sMs !== null && dMs === sMs;
        const isE = eMs !== null && dMs === eMs;
        return (
          <td
            key={idx}
            onPointerDown={inB && editable ? (e) => {
              const t = e.target as HTMLElement;
              if (t.dataset.handle) return; // handle ima svoj listener
              onDragStart(e, phase, 'move');
            } : undefined}
            className={cn(
              'relative border-r border-line-soft p-0',
              isW && !inB && 'bg-surface-2',
              isSel && !inB && 'bg-accent-subtle',
              isT && 'border-l-2 border-l-accent',
              inB && editable && 'cursor-grab',
            )}
            style={{
              width: GANTT_CELL_W,
              minWidth: GANTT_CELL_W,
              height: 34,
              ...(inB
                ? {
                    background: color,
                    borderTopLeftRadius: isS ? 6 : 0,
                    borderBottomLeftRadius: isS ? 6 : 0,
                    borderTopRightRadius: isE ? 6 : 0,
                    borderBottomRightRadius: isE ? 6 : 0,
                    ...(isElec ? { boxShadow: 'inset 0 2px 0 rgba(255,255,255,.55)' } : {}),
                  }
                : {}),
            }}
          >
            {inB && editable && isS && (
              <span
                data-handle="start"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onDragStart(e, phase, 'start');
                }}
                className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-black/25"
                title="Prevuci — promeni početak"
              />
            )}
            {inB && editable && isE && (
              <span
                data-handle="end"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onDragStart(e, phase, 'end');
                }}
                className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-black/25"
                title="Prevuci — promeni kraj"
              />
            )}
          </td>
        );
      })}
    </tr>
  );
});
