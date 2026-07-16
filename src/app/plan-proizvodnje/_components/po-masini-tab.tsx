'use client';

import { useMemo, useState } from 'react';
import { RefreshCw, Lock } from 'lucide-react';
import type { OpRow } from '@/api/plan-proizvodnje';
import { useMachines, useMachineOperations, useDeptOperations } from '@/api/plan-proizvodnje';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { OpsTable } from './ops-table';
import { DEPARTMENTS } from './shared';

/** Po mašini: izbor mašine ILI odeljenja → red otvorenih operacija (drag reorder za mašinu). */
export function PoMasiniTab({
  onReassign,
  onTp,
  onSkice,
}: {
  onReassign: (o: OpRow) => void;
  onTp: (o: OpRow) => void;
  onSkice: (o: OpRow) => void;
}) {
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const machines = useMachines();
  const [machine, setMachine] = useState<string>('');
  const [dept, setDept] = useState<string>('');
  const [reworkOnly, setReworkOnly] = useState(false);

  const machineOps = useMachineOperations(machine || null);
  const deptOps = useDeptOperations(!machine && dept ? dept : null);

  const active = machine ? machineOps : dept ? deptOps : null;
  const rawRows: OpRow[] = machine ? machineOps.data?.data.rows ?? [] : dept ? deptOps.data?.data ?? [] : [];
  const loading = machine ? machineOps.isLoading : dept ? deptOps.isLoading : false;
  const isError = !!active?.isError;

  // Filter „Dorada/škart" (GAP-PM-05).
  const rows = useMemo(
    () => (reworkOnly ? rawRows.filter((o) => o.is_rework || o.is_scrap) : rawRows),
    [rawRows, reworkOnly],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={dept}
          onChange={(e) => {
            setDept(e.target.value);
            setMachine('');
          }}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">— odeljenje —</option>
          {DEPARTMENTS.map((d) => (
            <option key={d.slug} value={d.slug}>{d.label}</option>
          ))}
        </select>
        <select
          value={machine}
          onChange={(e) => {
            setMachine(e.target.value);
            setDept('');
          }}
          className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">— mašina —</option>
          {(machines.data?.data ?? []).map((m) => (
            <option key={m.rj_code} value={m.rj_code}>
              {m.rj_code}
              {m.naziv || m.name ? ` — ${m.naziv ?? m.name}` : ''}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={reworkOnly} onChange={(e) => setReworkOnly(e.target.checked)} /> Dorada/škart
        </label>
        <span className="text-sm text-ink-secondary">{rows.length} operacija</span>
        {(machine || dept) && (
          <button
            type="button"
            onClick={() => active?.refetch()}
            disabled={active?.isFetching}
            title="Osveži"
            className="ml-auto inline-flex h-8 items-center gap-1 rounded-control border border-line px-2 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            <RefreshCw className={active?.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /> Osveži
          </button>
        )}
        {!canEdit && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary" title="Nemate pravo izmene">
            <Lock className="h-3 w-3" /> Samo za pregled
          </span>
        )}
      </div>

      {!machine && !dept ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Izaberi mašinu ili odeljenje.
        </div>
      ) : isError ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-status-danger">
          Greška pri učitavanju.{' '}
          <button type="button" onClick={() => active?.refetch()} className="underline">Pokušaj ponovo</button>
        </div>
      ) : loading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : reworkOnly && rows.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Nema dorade/škarta.
        </div>
      ) : (
        <OpsTable ops={rows} machine={machine || null} reorderable={!!machine && !reworkOnly} onReassign={onReassign} onTp={onTp} onSkice={onSkice} />
      )}
    </div>
  );
}
