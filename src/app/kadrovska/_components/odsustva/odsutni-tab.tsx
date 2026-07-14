'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { useAbsences, useDirectory, useGridMonths, monthsInRange } from '@/api/kadrovska';
import { SummaryChips } from '../common';
import {
  ABS_STYLE,
  absLabel,
  compareByName,
  dowYmd,
  isWeekendYmd,
  mondayOf,
  normEmp,
  todayYmd,
  workHourToAbsenceView,
  ymdAddDays,
  type EmpRow,
} from './shared';

// ============================================================================
// Odsutni — roster timeline „ko je odsutan" (port 1.0 odsutniTab.js). Zaposleni
// × dani sa obojenim trakama po tipu; izvor = absences (hvata i buduće odobrene
// GO) + grid work_hours (izvor istine) — dualizam kao Kalendar. Absences dani
// se filtriraju na radne dane (bez vikenda/praznika) da liče na grid. Read-only.
// ============================================================================

const DOW = ['ne', 'po', 'ut', 'sr', 'če', 'pe', 'su'];
const RANGES: Record<string, number> = { danas: 1, nedelja: 7, '14dana': 14 };

const selectCls =
  'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink focus-visible:outline-none focus-visible:border-accent';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

export function OdsutniTab() {
  const today = todayYmd();
  const [range, setRange] = useState<'danas' | 'nedelja' | '14dana'>('nedelja');
  const [winStart, setWinStart] = useState(() => mondayOf(todayYmd()));
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');

  const n = RANGES[range] ?? 7;
  const winEnd = ymdAddDays(winStart, n - 1);

  function defaultStart(r: string): string {
    return r === 'danas' ? todayYmd() : mondayOf(todayYmd());
  }

  const dirQ = useDirectory();
  const absQ = useAbsences();
  const grid = useGridMonths(useMemo(() => monthsInRange(winStart, winEnd), [winStart, winEnd]));

  const holSet = grid.holidaySet;

  const empsAll: EmpRow[] = useMemo(() => (dirQ.data?.data ?? []).map(normEmp), [dirQ.data]);
  const departments = useMemo(() => {
    const s = new Set<string>();
    for (const e of empsAll) if (e.department) s.add(e.department);
    return Array.from(s).sort((a, b) => a.localeCompare(b, 'sr'));
  }, [empsAll]);

  const inScope = useMemo(() => {
    const lq = q.trim().toLowerCase();
    return (e: EmpRow) => {
      if (!e.isActive) return false;
      if (dept && e.department !== dept) return false;
      if (lq) {
        const hay = [e.name, e.position, e.department].join(' ').toLowerCase();
        if (!hay.includes(lq)) return false;
      }
      return true;
    };
  }, [dept, q]);

  // Map<empId, Map<ymd, type>>: absences opsezi (samo radni dani) + grid override.
  const dayMap = useMemo(() => {
    const map = new Map<string, Map<string, string>>();
    const put = (empId: string, ymd: string, type: string) => {
      if (!empId || !type || ymd < winStart || ymd > winEnd) return;
      let m = map.get(empId);
      if (!m) {
        m = new Map();
        map.set(empId, m);
      }
      m.set(ymd, type);
    };
    for (const a of absQ.data?.data ?? []) {
      if (a.archivedAt) continue;
      const df = (a.dateFrom || '').slice(0, 10);
      const dt = (a.dateTo || '').slice(0, 10);
      if (!df || !dt || dt < winStart || df > winEnd) continue;
      let cur = df < winStart ? winStart : df;
      const end = dt > winEnd ? winEnd : dt;
      for (let g = 0; cur <= end && g < 400; g++) {
        if (!isWeekendYmd(cur) && !holSet.has(cur)) put(a.employeeId, cur, a.type);
        cur = ymdAddDays(cur, 1);
      }
    }
    for (const w of grid.rows) {
      const v = workHourToAbsenceView(w);
      if (v) put(v.employeeId, v.dateFrom, v.type); // grid = izvor istine (radni dani)
    }
    return map;
  }, [absQ.data, grid.rows, holSet, winStart, winEnd]);

  const days = useMemo(() => {
    const out: { ymd: string; day: number; letter: string; weekend: boolean; holiday: boolean; today: boolean }[] = [];
    let cur = winStart;
    for (let i = 0; i < n; i++) {
      const dow = dowYmd(cur);
      out.push({
        ymd: cur,
        day: parseInt(cur.slice(8, 10), 10),
        letter: DOW[dow],
        weekend: dow === 0 || dow === 6,
        holiday: holSet.has(cur),
        today: cur === today,
      });
      cur = ymdAddDays(cur, 1);
    }
    return out;
  }, [winStart, n, holSet, today]);

  const rows = useMemo(
    () =>
      empsAll
        .filter((e) => inScope(e) && (dayMap.get(e.id)?.size ?? 0) > 0)
        .sort(compareByName),
    [empsAll, inScope, dayMap],
  );

  // „Danas odsutni" — i kad je danas VAN prikazanog prozora (iz absences tabele).
  const todayCount = useMemo(() => {
    if (today >= winStart && today <= winEnd) {
      return rows.filter((e) => dayMap.get(e.id)?.has(today)).length;
    }
    const scoped = new Set(empsAll.filter(inScope).map((e) => e.id));
    const out = new Set<string>();
    for (const a of absQ.data?.data ?? []) {
      if (a.archivedAt) continue;
      const df = (a.dateFrom || '').slice(0, 10);
      const dt = (a.dateTo || '').slice(0, 10);
      if (df && dt && df <= today && dt >= today && scoped.has(a.employeeId)) out.add(a.employeeId);
    }
    return out.size;
  }, [rows, dayMap, empsAll, inScope, absQ.data, today, winStart, winEnd]);

  const presentTypes = useMemo(() => {
    const present = new Set<string>();
    for (const e of rows) dayMap.get(e.id)?.forEach((t) => present.add(t));
    const order = ['godisnji', 'bolovanje', 'sluzbeno', 'placeno', 'slava', 'slobodan', 'neplaceno', 'ostalo'];
    return order.filter((t) => present.has(t));
  }, [rows, dayMap]);

  const loading = dirQ.isLoading || absQ.isLoading || grid.isLoading;

  return (
    <div className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Danas odsutni', value: todayCount, tone: todayCount ? 'warn' : 'default' },
          { label: 'U periodu', value: rows.length, tone: rows.length ? 'accent' : 'default' },
          { label: 'Dana u prikazu', value: n },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1" role="group" aria-label="Period">
          {(
            [
              { key: 'danas', label: 'Danas' },
              { key: 'nedelja', label: 'Ova nedelja' },
              { key: '14dana', label: '14 dana' },
            ] as const
          ).map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => {
                setRange(o.key);
                setWinStart(defaultStart(o.key));
              }}
              className={cn(
                'rounded-control px-2.5 py-1 text-xs font-medium transition-colors',
                range === o.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" className="h-9 px-2" title="Prethodni period" onClick={() => setWinStart((s) => ymdAddDays(s, -n))}>
          ◀
        </Button>
        <Button variant="ghost" className="h-9 px-2" title="Na današnji period" onClick={() => setWinStart(defaultStart(range))}>
          Danas
        </Button>
        <Button variant="ghost" className="h-9 px-2" title="Sledeći period" onClick={() => setWinStart((s) => ymdAddDays(s, n))}>
          ▶
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
        <span className="ml-auto text-sm text-ink-secondary">
          {n === 1 ? formatDate(winStart) : `${formatDate(winStart)} – ${formatDate(winEnd)}`}
        </span>
      </div>

      {loading ? (
        <p className="px-1 py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : !rows.length ? (
        <EmptyState title="Niko nije odsutan 🎉" hint="U izabranom periodu nema evidentiranih odsustava." />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <th className="sticky left-0 z-10 min-w-52 border-r border-line bg-surface-2 px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  Zaposleni
                </th>
                {days.map((d) => (
                  <th
                    key={d.ymd}
                    title={formatDate(d.ymd)}
                    className={cn(
                      'min-w-9 px-1 py-1 text-center',
                      (d.weekend || d.holiday) && 'bg-surface-2 text-ink-disabled',
                      d.today && 'shadow-[inset_0_-2px_0_var(--accent)]',
                    )}
                  >
                    <div className="tnums text-xs font-semibold text-ink">{d.day}</div>
                    <div className="text-2xs font-normal text-ink-disabled">{d.letter}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => {
                const dm = dayMap.get(e.id)!;
                return (
                  <tr key={e.id} className="border-b border-line-soft">
                    <td className="sticky left-0 z-10 border-r border-line bg-surface px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent-subtle text-2xs font-semibold text-accent"
                        >
                          {initials(e.name)}
                        </span>
                        <span className="truncate font-medium text-ink">{e.name}</span>
                      </div>
                    </td>
                    {days.map((d, i) => {
                      const type = dm.get(d.ymd);
                      if (!type) {
                        return (
                          <td
                            key={d.ymd}
                            className={cn(
                              'h-9 px-0.5',
                              (d.weekend || d.holiday) && 'bg-surface-2',
                              d.today && 'shadow-[inset_0_0_0_1px_var(--accent)]',
                            )}
                          />
                        );
                      }
                      const prevSame = i > 0 && dm.get(days[i - 1].ymd) === type;
                      const nextSame = i < days.length - 1 && dm.get(days[i + 1].ymd) === type;
                      const st = ABS_STYLE[type] ?? ABS_STYLE.ostalo;
                      return (
                        <td
                          key={d.ymd}
                          title={`${absLabel(type)} · ${formatDate(d.ymd)}`}
                          className={cn('h-9 px-0 py-1.5', d.today && 'shadow-[inset_0_0_0_1px_var(--accent)]')}
                        >
                          <div
                            className={cn(
                              'h-4 w-full',
                              st.bar,
                              !prevSame && 'ml-0.5 w-[calc(100%-2px)] rounded-l-full',
                              !nextSame && 'mr-0.5 w-[calc(100%-2px)] rounded-r-full',
                              !prevSame && !nextSame && 'mx-0.5 w-[calc(100%-4px)]',
                            )}
                          />
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

      {presentTypes.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-secondary">
          <span className="font-medium">Legenda:</span>
          {presentTypes.map((t) => (
            <span key={t} className="inline-flex items-center gap-1.5">
              <span className={cn('h-3 w-3 rounded-sm', (ABS_STYLE[t] ?? ABS_STYLE.ostalo).bar)} aria-hidden />
              {absLabel(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
