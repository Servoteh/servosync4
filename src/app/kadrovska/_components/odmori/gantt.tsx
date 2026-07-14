'use client';

import { useState } from 'react';
import { formatDate } from '@/lib/format';
import type { VacationRequest } from '@/api/kadrovska';
import type { BalanceRow } from './types';
import { deptColor, daysInYear, dayOfYearZero, clampYmd, todayIso, MONTH_NAMES } from './helpers';

// Gantt prikaz GO po odeljenjima (1.0 vacationTab.renderGantt). Segmenti se
// izvode iz zahteva (pending=željeni / approved-budući=odobren / approved-prošli=
// iskorišćeno) — jedini izvor perioda dostupan bez teškog grid fetch-a.

type BarKind = 'pending' | 'approved' | 'used' | 'over';
interface Seg { from: string; to: string; days: number; kind: BarKind; label: string }

const BAR_STYLE: Record<BarKind, string> = {
  pending: 'repeating-linear-gradient(45deg,#E8A83855,#E8A83855 4px,#E8A83833 4px,#E8A83833 8px)',
  approved: '#4F86C6',
  used: '#6BBF5A',
  over: '#C6534F',
};

function segsForEmp(vac: VacationRequest[], isOver: boolean): Seg[] {
  const today = todayIso();
  const out: Seg[] = [];
  for (const r of vac) {
    if (!r.dateFrom || !r.dateTo) continue;
    const from = r.dateFrom.slice(0, 10);
    const to = r.dateTo.slice(0, 10);
    if (r.status === 'pending') {
      out.push({ from, to, days: r.daysCount, kind: 'pending', label: 'Željeni GO (čeka odobrenje)' });
    } else if (r.status === 'approved') {
      if (to >= today) out.push({ from, to, days: r.daysCount, kind: 'approved', label: 'Odobren GO' });
      else out.push({ from, to, days: r.daysCount, kind: isOver ? 'over' : 'used', label: 'Iskorišćeno GO' });
    }
  }
  return out;
}

export function VacationGantt({ rows, vac, year }: { rows: BalanceRow[]; vac: VacationRequest[]; year: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const totalDays = daysInYear(year);
  const today = todayIso();
  const isCurrentYear = today.startsWith(String(year));
  const todayPct = (dayOfYearZero(today, year) / totalDays) * 100;

  const vacByEmp = new Map<string, VacationRequest[]>();
  for (const r of vac) {
    if (!vacByEmp.has(r.employeeId)) vacByEmp.set(r.employeeId, []);
    vacByEmp.get(r.employeeId)!.push(r);
  }

  const deptMap = new Map<string, BalanceRow[]>();
  for (const r of rows) {
    const dept = r.emp.department || '(bez odeljenja)';
    if (!deptMap.has(dept)) deptMap.set(dept, []);
    deptMap.get(dept)!.push(r);
  }
  const depts = [...deptMap.keys()].sort((a, b) => a.localeCompare(b, 'sr'));

  function toggle(d: string) {
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d); else n.add(d);
      return n;
    });
  }

  function barEl(seg: Seg, empName: string, key: number) {
    const cFrom = clampYmd(seg.from, year);
    const cTo = clampYmd(seg.to, year);
    const startDoy = dayOfYearZero(cFrom, year);
    const endDoy = dayOfYearZero(cTo, year);
    const left = (startDoy / totalDays) * 100;
    const width = Math.max(0.4, ((endDoy - startDoy + 1) / totalDays) * 100);
    const tip = `${seg.label}: ${formatDate(seg.from)} → ${formatDate(seg.to)} (${seg.days} d.) · ${empName}`;
    return (
      <div
        key={key}
        title={tip}
        className="absolute top-1 h-3 rounded-sm"
        style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%`, background: BAR_STYLE[seg.kind] }}
      />
    );
  }

  const monthHeader = MONTH_NAMES.map((name, i) => {
    const start = `${year}-${String(i + 1).padStart(2, '0')}-01`;
    const endDate = new Date(Date.UTC(year, i + 1, 0)).toISOString().slice(0, 10);
    const startDoy = dayOfYearZero(start, year);
    const endDoy = dayOfYearZero(endDate, year);
    const left = (startDoy / totalDays) * 100;
    const width = ((endDoy - startDoy + 1) / totalDays) * 100;
    return (
      <div key={i} className="absolute top-0 text-center text-[0.6rem] text-ink-secondary" style={{ left: `${left.toFixed(3)}%`, width: `${width.toFixed(3)}%` }}>
        {name}
      </div>
    );
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-xs text-ink-secondary">
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm" style={{ background: BAR_STYLE.pending }} />Željeni (na čekanju)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm" style={{ background: BAR_STYLE.approved }} />Odobren</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm" style={{ background: BAR_STYLE.used }} />Iskorišćeno</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-3 w-5 rounded-sm" style={{ background: BAR_STYLE.over }} />Prekoračenje</span>
        {isCurrentYear && <span className="flex items-center gap-1.5"><span className="inline-block h-3.5 w-0.5 bg-accent" />Danas</span>}
      </div>

      <div className="space-y-2">
        {depts.map((dept) => {
          const dRows = deptMap.get(dept)!;
          const isCollapsed = collapsed.has(dept);
          const col = deptColor(dept === '(bez odeljenja)' ? '' : dept);
          return (
            <div key={dept} className="rounded-panel border border-line bg-surface">
              <button
                type="button"
                onClick={() => toggle(dept)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium text-ink hover:bg-surface-2"
              >
                <span className="text-ink-secondary">{isCollapsed ? '▶' : '▼'}</span>
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: col }} />
                <span>{dept}</span>
                <span className="ml-auto text-xs text-ink-secondary">{dRows.length} zap.</span>
              </button>
              {!isCollapsed && (
                <div className="px-3 pb-3">
                  <div className="relative mb-1 ml-[180px] h-4 border-b border-line-soft">
                    {monthHeader}
                    {isCurrentYear && <div className="absolute top-0 h-4 w-px bg-accent" style={{ left: `${todayPct.toFixed(3)}%` }} />}
                  </div>
                  {dRows.map((r) => {
                    const isOver = r.daysRemaining < 0;
                    const segs = segsForEmp(vacByEmp.get(r.emp.id) || [], isOver);
                    const remCls = r.daysRemainingAccrued < 0 ? 'text-status-danger' : r.daysRemainingAccrued < 3 ? 'text-status-warn' : 'text-ink-secondary';
                    return (
                      <div key={r.emp.id} className="flex items-center gap-2 border-b border-line-soft py-1 last:border-0">
                        <div className="flex w-[172px] shrink-0 items-center gap-1.5 pr-2">
                          <span className="truncate text-xs text-ink">{r.emp.name}</span>
                          <span className={`ml-auto tnums text-[0.65rem] font-semibold ${remCls}`} title="Preostalo (zarađeno do danas)">{r.daysRemainingAccrued}d</span>
                        </div>
                        <div className="relative h-5 flex-1">
                          {segs.map((s, i) => barEl(s, r.emp.name, i))}
                          {isCurrentYear && <div className="absolute top-0 h-5 w-px bg-accent/60" style={{ left: `${todayPct.toFixed(3)}%` }} />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
