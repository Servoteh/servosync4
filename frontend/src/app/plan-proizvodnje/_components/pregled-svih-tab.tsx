'use client';

import { useMemo, useState } from 'react';
import { useAllOperations, useMachines, type PpMachine } from '@/api/plan-proizvodnje';
import { cn } from '@/lib/cn';
import { filterOpsByRnOrDrawing } from './shared';
import { useRnFilter, RnFilterInput } from './rn-filter';
import { buildDeadlineMatrix, cellUrgency, type CellUrgency, type DayCol, type MatrixMachine } from './zauzetost-agg';
import { LS, lsGet, lsSet } from './pp-storage';

/**
 * Pregled svih (GAP-PM-14) — matrica mašina × 5 radnih dana. Kolone: Otvoreno, Kasni,
 * 5 radnih dana, „Kasnije" (future) i „Bez roka" (noDeadline) ODVOJENO; boje ćelija po
 * hitnosti (danas/≤3/4–7/>7) + legenda; 🔥 HITNO badge u ćeliji (urgentBuckets);
 * badge-ovi „N spremno/HITNO/CAM" po mašini; UKUPNO red; sort mašina po opterećenju
 * (totalOps DESC); toggle „Samo proceduralne". Klik na red/ćeliju → skok u „Po mašini".
 */

/** Boja ćelije po hitnosti — pozadina + tekst (tokeni). */
const CELL_BG: Record<Exclude<CellUrgency, ''>, string> = {
  today: 'bg-status-warn-bg text-status-warn',
  soon: 'bg-status-warn-bg/50 text-status-warn',
  warn: 'bg-status-info-bg text-status-info',
  ok: 'bg-status-success-bg/50 text-status-success',
};

const PILL = 'inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium';

type Row = MatrixMachine & { machineName: string; noProcedure: boolean };

export function PregledSvihTab({ onJumpToPoMasini }: { onJumpToPoMasini?: (machineCode: string) => void }) {
  const q = useAllOperations();
  const machines = useMachines();
  const rawOps = q.data?.data ?? [];

  const rn = useRnFilter('pregled');
  const [filter, setFilter] = useState<'all' | 'proc'>(() => (lsGet(LS.procFilter('pregled')) === 'proc' ? 'proc' : 'all'));

  const machinesMap = useMemo(() => {
    const m = new Map<string, PpMachine>();
    for (const x of machines.data?.data ?? []) m.set(x.rj_code, x);
    return m;
  }, [machines.data]);

  const ops = useMemo(() => filterOpsByRnOrDrawing(rawOps, rn.applied), [rawOps, rn.applied]);

  const { days, rows } = useMemo(() => {
    const matrix = buildDeadlineMatrix(ops, 5);
    let list: Row[] = matrix.machines.map((m) => {
      const meta = machinesMap.get(m.machineCode);
      return {
        ...m,
        machineName: (meta?.name as string) || (meta?.naziv as string) || '',
        noProcedure: meta?.no_procedure === true,
      };
    });
    if (filter === 'proc') list = list.filter((r) => r.noProcedure === false);
    // Sort po opterećenju (totalOps DESC), tie-break machineCode numerički ASC.
    list.sort((a, b) => {
      if (b.totalOps !== a.totalOps) return b.totalOps - a.totalOps;
      return String(a.machineCode).localeCompare(String(b.machineCode), 'sr', { numeric: true });
    });
    return { days: matrix.days, rows: list };
  }, [ops, machinesMap, filter]);

  const totals = useMemo(() => {
    const perDay: Record<string, number> = {};
    for (const d of days) perDay[d.date] = 0;
    let total = 0;
    let overdue = 0;
    let future = 0;
    let noDeadline = 0;
    for (const r of rows) {
      total += r.totalOps;
      overdue += r.buckets.overdue;
      future += r.buckets.future;
      noDeadline += r.buckets.noDeadline;
      for (const d of days) perDay[d.date] += r.buckets[d.date] || 0;
    }
    return { total, overdue, future, noDeadline, perDay };
  }, [rows, days]);

  function setProc(f: 'all' | 'proc') {
    setFilter(f);
    lsSet(LS.procFilter('pregled'), f);
  }

  const jump = (mc: string) => onJumpToPoMasini?.(mc);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Filter mašina">
          <FilterBtn active={filter === 'all'} onClick={() => setProc('all')}>Sve mašine</FilterBtn>
          <FilterBtn active={filter === 'proc'} onClick={() => setProc('proc')}>Samo proceduralne</FilterBtn>
        </div>
        <RnFilterInput value={rn.raw} onChange={rn.setRaw} />
        <span className="ml-auto text-sm text-ink-secondary">
          {rows.length} mašina · {days.length} dana
          {q.data?.meta?.truncated ? ` · skraćeno od ${q.data.meta.total}` : ''}
        </span>
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje matrice…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          {rn.active ? `Nema rezultata za filter „${rn.applied.trim()}".` : 'Nema otvorenih operacija.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-panel border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
                  <th className="px-3 py-1.5 text-left">Mašina</th>
                  <th className="px-3 py-1.5 text-right">Otvoreno</th>
                  <th className="px-3 py-1.5 text-right text-status-danger">Kasni</th>
                  {days.map((d) => (
                    <th key={d.date} className={cn('px-3 py-1.5 text-right', d.isToday && 'text-ink')}>{d.label}</th>
                  ))}
                  <th className="px-3 py-1.5 text-right">Kasnije</th>
                  <th className="px-3 py-1.5 text-right">Bez roka</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.machineCode} className="border-b border-line-soft hover:bg-surface-2">
                    <td className="cursor-pointer px-3 py-1.5" onClick={() => jump(r.machineCode)} title="Otvori „Po mašini”">
                      <div className="font-medium text-ink">{r.machineCode}</div>
                      {r.machineName ? <div className="text-2xs text-ink-secondary">{r.machineName}</div> : null}
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {r.readyOps > 0 ? <span className={cn(PILL, 'bg-status-success-bg text-status-success')}>{r.readyOps} spremno</span> : null}
                        {r.urgentOps > 0 ? <span className={cn(PILL, 'bg-status-danger-bg text-status-danger')}>{r.urgentOps} HITNO</span> : null}
                        {r.camReadyOps > 0 ? <span className={cn(PILL, 'bg-status-info-bg text-status-info')}>{r.camReadyOps} CAM</span> : null}
                      </div>
                    </td>
                    <td className="tnums px-3 py-1.5 text-right font-semibold text-ink">{r.totalOps}</td>
                    <MatrixCell n={r.buckets.overdue} urgent={r.urgentBuckets.overdue} bg="bg-status-danger-bg text-status-danger" onClick={() => jump(r.machineCode)} />
                    {days.map((d) => {
                      const n = r.buckets[d.date] || 0;
                      const u = cellUrgency(d, n);
                      return (
                        <MatrixCell
                          key={d.date}
                          n={n}
                          urgent={r.urgentBuckets[d.date] || 0}
                          bg={u ? CELL_BG[u] : ''}
                          onClick={() => jump(r.machineCode)}
                        />
                      );
                    })}
                    <MatrixCell n={r.buckets.future} urgent={r.urgentBuckets.future} bg="" onClick={() => jump(r.machineCode)} />
                    <MatrixCell n={r.buckets.noDeadline} urgent={r.urgentBuckets.noDeadline} bg="" muted onClick={() => jump(r.machineCode)} />
                  </tr>
                ))}
                {/* UKUPNO red */}
                <tr className="border-t-2 border-line bg-surface-2 font-semibold text-ink">
                  <td className="px-3 py-1.5">UKUPNO</td>
                  <td className="tnums px-3 py-1.5 text-right">{totals.total}</td>
                  <td className="tnums px-3 py-1.5 text-right">{totals.overdue || ''}</td>
                  {days.map((d) => (
                    <td key={d.date} className="tnums px-3 py-1.5 text-right">{totals.perDay[d.date] || ''}</td>
                  ))}
                  <td className="tnums px-3 py-1.5 text-right">{totals.future || ''}</td>
                  <td className="tnums px-3 py-1.5 text-right">{totals.noDeadline || ''}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Legenda boja + hint */}
          <div className="flex flex-wrap items-center gap-3 text-2xs text-ink-secondary">
            <LegendSwatch cls="bg-status-danger-bg" label="Kasni" />
            <LegendSwatch cls="bg-status-warn-bg" label="Danas" />
            <LegendSwatch cls="bg-status-warn-bg/50" label="≤3 dana" />
            <LegendSwatch cls="bg-status-info-bg" label="4–7 dana" />
            <LegendSwatch cls="bg-status-success-bg/50" label=">7 dana" />
            <span className="ml-auto text-ink-disabled">🔥 = HITNO u ćeliji · klikni red/ćeliju za „Po mašini".</span>
          </div>
        </>
      )}
    </div>
  );
}

function MatrixCell({
  n,
  urgent,
  bg,
  muted,
  onClick,
}: {
  n: number;
  urgent: number;
  bg: string;
  muted?: boolean;
  onClick?: () => void;
}) {
  return (
    <td
      onClick={n > 0 ? onClick : undefined}
      className={cn('px-3 py-1.5 text-right', bg, n > 0 && 'cursor-pointer', urgent > 0 && 'ring-1 ring-inset ring-status-danger/40')}
    >
      {n > 0 ? (
        <span className={cn('tnums', muted && 'text-ink-secondary')}>
          {n}
          {urgent > 0 ? <span title={`${urgent} HITNO`} className="ml-0.5">🔥</span> : null}
        </span>
      ) : (
        <span className="text-ink-disabled">·</span>
      )}
    </td>
  );
}

function LegendSwatch({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-block h-3 w-3 rounded-sm', cls)} />
      {label}
    </span>
  );
}

function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('h-8 px-3 text-xs transition-colors', active ? 'bg-accent text-accent-fg' : 'bg-surface text-ink-secondary hover:bg-surface-2')}
    >
      {children}
    </button>
  );
}
