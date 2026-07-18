'use client';

import { useMemo, useState } from 'react';
import { useAllOperations, useMachines, type PpMachine } from '@/api/plan-proizvodnje';
import { cn } from '@/lib/cn';
import { filterOpsByRnOrDrawing, formatSecondsHm } from './shared';
import { useRnFilter, RnFilterInput } from './rn-filter';
import { summarizeByMachine, type MachineSummary } from './zauzetost-agg';
import { LS, lsGet, lsSet, lsGetSort, lsSetSort, type SortState } from './pp-storage';

/**
 * Zauzetost mašina (GAP-PM-13) — 11 sortabilnih kolona (Mašina, Otvoreno, Crteža,
 * Spremno/HITNO/CAM pill, Hitno rok-breakdown Kasni/Danas/≤3d, Planirano, Realizovano,
 * Premešteno, Ne-mašinske), UKUPNO red, klik-sort sa LS persist-om, toggle „Samo
 * proceduralne". Klik na red → skok u „Po mašini". Klijentska agregacija nad
 * /operations/all (DOSLOVNI port 1.0 summarizeByMachine + zauzetostTab.js).
 */

type Row = MachineSummary & { machineName: string; noProcedure: boolean };

interface Col {
  key: string;
  label: string;
  align: 'left' | 'right';
  accessor: (r: Row) => number | string;
  title?: string;
}

const COLUMNS: Col[] = [
  { key: 'machineCode', label: 'Mašina', align: 'left', accessor: (r) => r.machineCode },
  { key: 'totalOps', label: 'Otvoreno', align: 'right', accessor: (r) => r.totalOps },
  { key: 'drawingsCount', label: 'Crteža', align: 'right', accessor: (r) => r.drawingsCount },
  { key: 'readyOps', label: 'Spremno', align: 'right', accessor: (r) => r.readyOps, title: 'Spremno za obradu' },
  { key: 'urgentOps', label: 'HITNO', align: 'right', accessor: (r) => r.urgentOps, title: 'Ručno označeno HITNO' },
  { key: 'camReadyOps', label: 'CAM', align: 'right', accessor: (r) => r.camReadyOps, title: 'CAM spremno' },
  { key: 'hot', label: 'Hitno rok', align: 'right', accessor: (r) => r.overdueOps + r.todayOps, title: 'Kasni / danas / ≤3 dana' },
  { key: 'plannedSec', label: 'Planirano', align: 'right', accessor: (r) => r.plannedSec },
  { key: 'realSec', label: 'Realizovano', align: 'right', accessor: (r) => r.realSec },
  { key: 'reassignedInOps', label: 'Premešteno', align: 'right', accessor: (r) => r.reassignedInOps, title: 'Operacije prebačene sa originalne mašine' },
  { key: 'nonMachiningOps', label: 'Ne-mašinske', align: 'right', accessor: (r) => r.nonMachiningOps, title: 'Kontrole, kooperacija, ručne operacije…' },
];

const PILL = 'inline-flex items-center justify-center rounded-full px-1.5 py-0.5 text-2xs font-medium tnums';

export function ZauzetostTab({ onJumpToPoMasini }: { onJumpToPoMasini?: (machineCode: string) => void }) {
  const q = useAllOperations();
  const machines = useMachines();
  const rawOps = q.data?.data ?? [];

  const rn = useRnFilter('zauzetost');
  const [filter, setFilter] = useState<'all' | 'proc'>(() => (lsGet(LS.procFilter('zauzetost')) === 'proc' ? 'proc' : 'all'));
  const [sort, setSort] = useState<SortState>(() => lsGetSort({ key: 'totalOps', dir: 'desc' }));

  const machinesMap = useMemo(() => {
    const m = new Map<string, PpMachine>();
    for (const x of machines.data?.data ?? []) m.set(x.rj_code, x);
    return m;
  }, [machines.data]);

  const ops = useMemo(() => filterOpsByRnOrDrawing(rawOps, rn.applied), [rawOps, rn.applied]);

  const rows = useMemo<Row[]>(() => {
    let data: Row[] = summarizeByMachine(ops).map((s) => {
      const meta = machinesMap.get(s.machineCode);
      return {
        ...s,
        machineName: (meta?.name as string) || (meta?.naziv as string) || '',
        noProcedure: meta?.no_procedure === true,
      };
    });
    if (filter === 'proc') data = data.filter((r) => r.noProcedure === false);
    return data;
  }, [ops, machinesMap, filter]);

  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key);
    if (!col) return rows;
    const factor = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = col.accessor(a);
      const vb = col.accessor(b);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * factor;
      return String(va || '').localeCompare(String(vb || ''), 'sr', { numeric: true }) * factor;
    });
  }, [rows, sort]);

  const totals = useMemo(() => {
    const t = { totalOps: 0, drawingsCount: 0, camReadyOps: 0, hot: 0, plannedSec: 0, realSec: 0, reassignedInOps: 0, nonMachiningOps: 0 };
    for (const r of rows) {
      t.totalOps += r.totalOps;
      t.drawingsCount += r.drawingsCount;
      t.camReadyOps += r.camReadyOps;
      t.hot += r.overdueOps + r.todayOps;
      t.plannedSec += r.plannedSec;
      t.realSec += r.realSec;
      t.reassignedInOps += r.reassignedInOps;
      t.nonMachiningOps += r.nonMachiningOps;
    }
    return t;
  }, [rows]);

  function clickSort(key: string) {
    setSort((prev) => {
      const next: SortState =
        prev.key === key
          ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'machineCode' ? 'asc' : 'desc' };
      lsSetSort(next);
      return next;
    });
  }
  function setProc(f: 'all' | 'proc') {
    setFilter(f);
    lsSet(LS.procFilter('zauzetost'), f);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Filter mašina">
          <FilterBtn active={filter === 'all'} onClick={() => setProc('all')}>Sve mašine</FilterBtn>
          <FilterBtn active={filter === 'proc'} onClick={() => setProc('proc')}>Samo proceduralne</FilterBtn>
        </div>
        <RnFilterInput value={rn.raw} onChange={rn.setRaw} />
        <span className="ml-auto text-sm text-ink-secondary">
          {rows.length} mašina · {totals.totalOps} ops · {formatSecondsHm(totals.plannedSec)} plan
          {q.data?.meta?.truncated ? ` · skraćeno od ${q.data.meta.total}` : ''}
        </span>
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje zauzetosti…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          {rn.active
            ? `Nema rezultata za filter „${rn.applied.trim()}".`
            : 'Nema otvorenih operacija. Sve mašine su bez aktivnih naloga ili Bridge još nije popunio keš.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-2xs uppercase tracking-wider text-ink-secondary">
                {COLUMNS.map((c) => {
                  const isActive = c.key === sort.key;
                  return (
                    <th
                      key={c.key}
                      onClick={() => clickSort(c.key)}
                      title={c.title}
                      aria-sort={isActive ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={cn(
                        'cursor-pointer select-none px-3 py-1.5 hover:text-ink',
                        c.align === 'right' ? 'text-right' : 'text-left',
                        isActive && 'text-ink',
                      )}
                    >
                      {c.label}
                      {isActive ? <span className="ml-1">{sort.dir === 'asc' ? '▲' : '▼'}</span> : null}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.machineCode}
                  onClick={() => onJumpToPoMasini?.(r.machineCode)}
                  className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                  title="Otvori u tabu „Po mašini”"
                >
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-ink">{r.machineCode}</div>
                    {r.machineName ? <div className="text-2xs text-ink-secondary">{r.machineName}</div> : null}
                  </td>
                  <td className="tnums px-3 py-1.5 text-right font-semibold text-ink">{r.totalOps}</td>
                  <td className="tnums px-3 py-1.5 text-right">{r.drawingsCount}</td>
                  <td className="px-3 py-1.5 text-right">
                    {r.readyOps > 0 ? <span className={cn(PILL, 'bg-status-success-bg text-status-success')}>{r.readyOps}</span> : <span className="text-ink-disabled">–</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.urgentOps > 0 ? <span className={cn(PILL, 'bg-status-danger-bg text-status-danger')}>{r.urgentOps}</span> : <span className="text-ink-disabled">–</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.camReadyOps > 0 ? <span className={cn(PILL, 'bg-status-info-bg text-status-info')}>{r.camReadyOps}</span> : <span className="text-ink-disabled">–</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <HotBreakdown overdue={r.overdueOps} today={r.todayOps} soon={r.soonOps} />
                  </td>
                  <td className="tnums px-3 py-1.5 text-right">{formatSecondsHm(r.plannedSec)}</td>
                  <td className="tnums px-3 py-1.5 text-right text-ink-secondary">{formatSecondsHm(r.realSec)}</td>
                  <td className="px-3 py-1.5 text-right">
                    {r.reassignedInOps > 0 ? <span className={cn(PILL, 'bg-status-warn-bg text-status-warn')}>{r.reassignedInOps}</span> : <span className="text-ink-disabled">–</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    {r.nonMachiningOps > 0 ? <span className={cn(PILL, 'bg-surface-2 text-ink-secondary')}>{r.nonMachiningOps}</span> : <span className="text-ink-disabled">–</span>}
                  </td>
                </tr>
              ))}
              {/* UKUPNO red */}
              <tr className="border-t-2 border-line bg-surface-2 font-semibold text-ink">
                <td className="px-3 py-1.5">UKUPNO</td>
                <td className="tnums px-3 py-1.5 text-right">{totals.totalOps}</td>
                <td className="tnums px-3 py-1.5 text-right">{totals.drawingsCount}</td>
                <td className="px-3 py-1.5" />
                <td className="px-3 py-1.5" />
                <td className="tnums px-3 py-1.5 text-right">{totals.camReadyOps || ''}</td>
                <td className="tnums px-3 py-1.5 text-right">{totals.hot || ''}</td>
                <td className="tnums px-3 py-1.5 text-right">{formatSecondsHm(totals.plannedSec)}</td>
                <td className="tnums px-3 py-1.5 text-right">{formatSecondsHm(totals.realSec)}</td>
                <td className="tnums px-3 py-1.5 text-right">{totals.reassignedInOps || ''}</td>
                <td className="tnums px-3 py-1.5 text-right">{totals.nonMachiningOps || ''}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && onJumpToPoMasini ? (
        <p className="text-2xs text-ink-disabled">Klikni na red da otvoriš mašinu u tabu „Po mašini".</p>
      ) : null}
    </div>
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

/** Rok-breakdown: crveno Kasni / narandžasto Danas / žuto ≤3d (paritet 1.0 „Hitno" kolona). */
function HotBreakdown({ overdue, today, soon }: { overdue: number; today: number; soon: number }) {
  if (!overdue && !today && !soon) return <span className="text-ink-disabled">–</span>;
  return (
    <span className="inline-flex gap-1">
      {overdue > 0 ? <span className={cn(PILL, 'bg-status-danger-bg text-status-danger')} title="Kasni">{overdue}</span> : null}
      {today > 0 ? <span className={cn(PILL, 'bg-status-warn-bg text-status-warn')} title="Rok danas">{today}</span> : null}
      {soon > 0 ? <span className={cn(PILL, 'bg-status-warn-bg/60 text-status-warn')} title="Rok ≤3 dana">{soon}</span> : null}
    </span>
  );
}
