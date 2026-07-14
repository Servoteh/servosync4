'use client';

import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { FileSpreadsheet } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { useAbsences, useDirectory, useGridMonths, type Absence, type KadrHoliday } from '@/api/kadrovska';
import { SummaryChips } from '../common';
import {
  ABS_STYLE,
  absLabel,
  absStyle,
  compareByName,
  daysInMonthKey,
  defaultMonthKey,
  normEmp,
  shiftMonthKey,
  todayYmd,
  workHourToAbsenceView,
  type AbsenceView,
  type EmpRow,
  type MonthDay,
} from './shared';

// ============================================================================
// Kalendar — mesečni prikaz zaposleni×dan (port 1.0 calendarTab.js). Izvor =
// grid work_hours (primaran) + legacy absences (dualizam); vikendi/praznici/
// danas markirani; 🎂/⚠ markeri; klik na ćeliju → detalj modal; Excel export.
// ============================================================================

const DAY_LETTERS = ['N', 'P', 'U', 'S', 'Č', 'P', 'S'];

/** Zajednički oblik za prikaz (legacy Absence i grid AbsenceView). */
interface CalAbs {
  employeeId: string;
  type: string;
  dateFrom: string;
  dateTo: string;
  daysCount: number | null;
  note: string | null;
}
function fromLegacy(a: Absence): CalAbs {
  return {
    employeeId: a.employeeId,
    type: a.type,
    dateFrom: (a.dateFrom || '').slice(0, 10),
    dateTo: (a.dateTo || '').slice(0, 10),
    daysCount: a.daysCount,
    note: a.note,
  };
}
function fromGrid(v: AbsenceView): CalAbs {
  return { employeeId: v.employeeId, type: v.type, dateFrom: v.dateFrom, dateTo: v.dateTo, daysCount: v.daysCount, note: v.note || null };
}
function inRange(ymd: string, from: string, to: string): boolean {
  return !!ymd && !!from && !!to && ymd >= from && ymd <= to;
}

const selectCls =
  'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

export function KalendarTab({ onNavigateGrid }: { onNavigateGrid?: (empName: string, yyyymm: string) => void }) {
  const [monthKey, setMonthKey] = useState(defaultMonthKey);
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [cell, setCell] = useState<{ empId: string; ymd: string } | null>(null);

  const [yy, mm] = monthKey.split('-').map((n) => parseInt(n, 10));
  const days = useMemo(() => daysInMonthKey(monthKey), [monthKey]);
  const today = todayYmd();

  const dirQ = useDirectory();
  const absQ = useAbsences();
  const grid = useGridMonths(useMemo(() => (yy && mm ? [{ year: yy, month: mm }] : []), [yy, mm]));

  const holidayByYmd = useMemo(() => {
    const m = new Map<string, KadrHoliday>();
    for (const h of grid.holidays) if (!h.isWorkday) m.set(String(h.holidayDate).slice(0, 10), h);
    return m;
  }, [grid.holidays]);

  const emps: EmpRow[] = useMemo(
    () =>
      (dirQ.data?.data ?? [])
        .map(normEmp)
        .filter((e) => {
          if (!e.isActive) return false;
          if (dept && e.department !== dept) return false;
          if (q) {
            const hay = [e.name, e.department, e.team].join(' ').toLowerCase();
            if (!hay.includes(q.trim().toLowerCase())) return false;
          }
          return true;
        })
        .sort(compareByName),
    [dirQ.data, dept, q],
  );

  const departments = useMemo(() => {
    const s = new Set<string>();
    for (const r of dirQ.data?.data ?? []) {
      const d = normEmp(r).department;
      if (d) s.add(d);
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'sr'));
  }, [dirQ.data]);

  // Map<empId, CalAbs[]> — grid (primaran) + legacy absences koji seku mesec
  const absByEmp = useMemo(() => {
    const mStart = days[0]?.ymd ?? '';
    const mEnd = days[days.length - 1]?.ymd ?? '';
    const byEmp = new Map<string, CalAbs[]>();
    const push = (a: CalAbs) => {
      if (!a.dateFrom || !a.dateTo || a.dateTo < mStart || a.dateFrom > mEnd) return;
      const l = byEmp.get(a.employeeId);
      if (l) l.push(a);
      else byEmp.set(a.employeeId, [a]);
    };
    for (const w of grid.rows) {
      const v = workHourToAbsenceView(w);
      if (v) push(fromGrid(v));
    }
    for (const a of absQ.data?.data ?? []) {
      if (a.archivedAt) continue;
      push(fromLegacy(a));
    }
    return byEmp;
  }, [grid.rows, absQ.data, days]);

  // Summary chips
  const chips = useMemo(() => {
    const absentToday = new Set<string>();
    let go = 0;
    let bo = 0;
    let other = 0;
    for (const emp of emps) {
      for (const a of absByEmp.get(emp.id) ?? []) {
        if (inRange(today, a.dateFrom, a.dateTo)) absentToday.add(emp.id);
        if (a.type === 'godisnji') go++;
        else if (a.type === 'bolovanje') bo++;
        else other++;
      }
    }
    return { onLeave: absentToday.size, go, bo, other, holidays: days.filter((d) => holidayByYmd.has(d.ymd)).length };
  }, [emps, absByEmp, days, holidayByYmd, today]);

  const loading = dirQ.isLoading || absQ.isLoading || grid.isLoading;

  function dayHeadCls(d: MonthDay): string {
    return cn(
      d.isWeekend && 'bg-surface-2 text-ink-disabled',
      holidayByYmd.has(d.ymd) && 'bg-status-info-bg text-status-info',
      d.ymd === today && 'shadow-[inset_0_-2px_0_var(--status-warn)]',
    );
  }

  function exportXlsx() {
    if (!emps.length) return;
    const aoa: (string | number)[][] = [];
    aoa.push([`Kalendar ${monthKey}`]);
    aoa.push([]);
    aoa.push(['Zaposleni', 'Odeljenje', ...days.map((d) => String(d.day))]);
    aoa.push(['', '', ...days.map((d) => DAY_LETTERS[d.dow])]);
    for (const emp of emps) {
      const list = absByEmp.get(emp.id) ?? [];
      const row: (string | number)[] = [emp.name, emp.department];
      for (const d of days) {
        const hit = list.find((a) => inRange(d.ymd, a.dateFrom, a.dateTo));
        if (hit) row.push(ABS_STYLE[hit.type]?.short ?? '?');
        else if (holidayByYmd.has(d.ymd)) row.push('PR');
        else row.push('');
      }
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 28 }, { wch: 20 }, ...days.map(() => ({ wch: 4 }))];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: days.length + 1 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Kalendar ${monthKey}`);
    XLSX.writeFile(wb, `Kalendar_${monthKey.replace('-', '')}.xlsx`);
  }

  return (
    <div className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Aktivni', value: emps.length, tone: 'accent' },
          { label: 'Danas na odsustvu', value: chips.onLeave, tone: chips.onLeave ? 'warn' : 'default' },
          { label: 'GO (mesec)', value: chips.go },
          { label: 'Bolovanja (mesec)', value: chips.bo, tone: chips.bo ? 'warn' : 'default' },
          { label: 'Ostala odsustva', value: chips.other },
          { label: 'Praznici', value: chips.holidays },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          Mesec
          <input
            type="month"
            className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
            value={monthKey}
            onChange={(e) => setMonthKey(e.target.value || defaultMonthKey())}
          />
        </label>
        <Button variant="ghost" className="h-9 px-2" title="Prethodni mesec" onClick={() => setMonthKey((k) => shiftMonthKey(k, -1))}>
          ‹
        </Button>
        <Button variant="ghost" className="h-9 px-2" title="Sledeći mesec" onClick={() => setMonthKey((k) => shiftMonthKey(k, +1))}>
          ›
        </Button>
        <select className={selectCls} value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="">Sva odeljenja</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga po imenu…" />
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" className="h-8" onClick={exportXlsx} disabled={!emps.length}>
            <FileSpreadsheet className="h-4 w-4" aria-hidden /> Excel
          </Button>
          <span className="text-sm text-ink-secondary">
            {emps.length} {emps.length === 1 ? 'zaposleni' : 'zaposlenih'}
          </span>
        </div>
      </div>

      {/* Legenda */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary" aria-label="Legenda">
        {(['godisnji', 'bolovanje', 'sluzbeno', 'placeno', 'neplaceno', 'slobodan'] as const).map((t) => (
          <span key={t} className="inline-flex items-center gap-1.5">
            <span className={cn('h-3 w-3 rounded-sm', ABS_STYLE[t].bar)} aria-hidden />
            {absLabel(t)}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm bg-status-info-bg ring-1 ring-status-info/40" aria-hidden />
          Državni praznik
        </span>
        <span>🎂 Rođendan</span>
        <span>⚠ Lekarski ističe (mesec)</span>
      </div>

      {loading ? (
        <p className="px-1 py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : !emps.length ? (
        <EmptyState title="Nema zaposlenih za izabrane filtere" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full border-collapse text-xs" aria-label="Kalendarski prikaz odsustava">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <th rowSpan={2} className="sticky left-0 z-10 min-w-44 border-r border-line bg-surface-2 px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Zaposleni
                </th>
                {days.map((d) => (
                  <th key={d.ymd} title={d.ymd} className={cn('min-w-6 px-0.5 py-1 text-center font-semibold text-ink-secondary', dayHeadCls(d))}>
                    {d.day}
                  </th>
                ))}
              </tr>
              <tr className="border-b border-line bg-surface-2">
                {days.map((d) => (
                  <th key={d.ymd} className={cn('px-0.5 pb-1 text-center font-normal text-ink-disabled', dayHeadCls(d))}>
                    {DAY_LETTERS[d.dow]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {emps.map((emp) => {
                const list = absByEmp.get(emp.id) ?? [];
                const badges = empMonthBadges(emp, monthKey);
                return (
                  <tr key={emp.id} className="border-b border-line-soft">
                    <td className="sticky left-0 z-10 border-r border-line bg-surface px-3 py-1">
                      <div className="flex items-center gap-1.5 font-medium text-ink">
                        <span className="truncate">{emp.name}</span>
                        {badges.map((b, i) => (
                          <span key={i} title={b.title} className="cursor-default">
                            {b.icon}
                          </span>
                        ))}
                      </div>
                      {emp.department && <div className="text-2xs text-ink-secondary">{emp.department}</div>}
                    </td>
                    {days.map((d) => {
                      const hit = list.find((a) => inRange(d.ymd, a.dateFrom, a.dateTo));
                      const hol = holidayByYmd.get(d.ymd);
                      const title = hit
                        ? `${absLabel(hit.type)}: ${formatDate(hit.dateFrom)} – ${formatDate(hit.dateTo)}${hit.note ? '\n' + hit.note : ''}`
                        : hol
                          ? hol.name || 'Državni praznik'
                          : d.ymd === today
                            ? 'Danas'
                            : undefined;
                      return (
                        <td
                          key={d.ymd}
                          title={title}
                          onClick={() => setCell({ empId: emp.id, ymd: d.ymd })}
                          className={cn(
                            'h-7 cursor-pointer border-r border-line-soft px-0.5 text-center align-middle',
                            d.isWeekend && 'bg-surface-2',
                            hol && 'bg-status-info-bg',
                            d.ymd === today && 'shadow-[inset_0_0_0_1px_var(--status-warn)]',
                            hit && absStyle(hit.type).badge,
                          )}
                        >
                          {hit ? <span className="text-2xs font-semibold">{absStyle(hit.type).short}</span> : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {cell && (
        <CellDetailDialog
          emp={emps.find((e) => e.id === cell.empId) ?? null}
          ymd={cell.ymd}
          absences={(absByEmp.get(cell.empId) ?? []).filter((a) => inRange(cell.ymd, a.dateFrom, a.dateTo))}
          holiday={holidayByYmd.get(cell.ymd) ?? null}
          onClose={() => setCell(null)}
          onNavigateGrid={onNavigateGrid}
        />
      )}
    </div>
  );
}

/** 🎂 rođendan / ⚠ lekarski ističe u prikazanom mesecu (polja mogu nedostajati — vidi normEmp TODO). */
function empMonthBadges(emp: EmpRow, monthKey: string): { icon: string; title: string }[] {
  const out: { icon: string; title: string }[] = [];
  const mm = monthKey.split('-')[1];
  if (emp.birthDate && emp.birthDate.slice(5, 7) === mm) {
    const day = parseInt(emp.birthDate.slice(8, 10), 10);
    out.push({ icon: '🎂', title: `Rođendan ${day}.${parseInt(mm, 10)}.` });
  }
  if (emp.medicalExamExpires && emp.medicalExamExpires.slice(0, 7) === monthKey) {
    out.push({ icon: '⚠', title: `Lekarski ističe ${formatDate(emp.medicalExamExpires)}` });
  }
  return out;
}

function CellDetailDialog({
  emp,
  ymd,
  absences,
  holiday,
  onClose,
  onNavigateGrid,
}: {
  emp: EmpRow | null;
  ymd: string;
  absences: CalAbs[];
  holiday: KadrHoliday | null;
  onClose: () => void;
  onNavigateGrid?: (empName: string, yyyymm: string) => void;
}) {
  const isToday = ymd === todayYmd();
  return (
    <Dialog
      open
      onClose={onClose}
      title={emp?.name || '—'}
      footer={
        <>
          {onNavigateGrid && (
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                onNavigateGrid(emp?.name || '', ymd.slice(0, 7));
              }}
            >
              ✎ Izmeni u gridu
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-secondary">
        {formatDate(ymd)}
        {isToday ? ' (danas)' : ''}
        {holiday ? ` · 🇷🇸 ${holiday.name || 'Državni praznik'}` : ''}
      </p>
      {absences.length === 0 ? (
        <p className="py-2 text-sm text-ink-secondary">Nema upisanog odsustva za ovaj dan.</p>
      ) : (
        <div className="space-y-2">
          {absences.map((a, i) => (
            <div key={i} className="rounded-control border border-line px-3 py-2">
              <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${absStyle(a.type).badge}`}>
                {absLabel(a.type)}
              </span>
              <span className="ml-2 text-sm text-ink">
                {formatDate(a.dateFrom)} – {formatDate(a.dateTo)}
                {a.daysCount ? ` (${a.daysCount}d)` : ''}
              </span>
              {a.note && <div className="mt-1 text-xs text-ink-secondary">{a.note}</div>}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
