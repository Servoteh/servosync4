'use client';

import { useState } from 'react';
import type { OpRow } from '@/api/plan-proizvodnje';
import { useMachines, useMachineOperations, useDeptOperations } from '@/api/plan-proizvodnje';
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
  const machines = useMachines();
  const [machine, setMachine] = useState<string>('');
  const [dept, setDept] = useState<string>('');

  const machineOps = useMachineOperations(machine || null);
  const deptOps = useDeptOperations(!machine && dept ? dept : null);

  const rows: OpRow[] = machine ? machineOps.data?.data.rows ?? [] : dept ? deptOps.data?.data ?? [] : [];
  const loading = machine ? machineOps.isLoading : dept ? deptOps.isLoading : false;

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
        <span className="text-sm text-ink-secondary">{rows.length} operacija</span>
      </div>

      {!machine && !dept ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          Izaberi mašinu ili odeljenje.
        </div>
      ) : loading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : (
        <OpsTable ops={rows} reorderable={!!machine} onReassign={onReassign} onTp={onTp} onSkice={onSkice} />
      )}
    </div>
  );
}
