'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useMachines,
  useMachineOperations,
  useUpsertOverlay,
  type OpRow,
} from '@/api/plan-proizvodnje';
import { StatusPill, nextStatus, progressLabel } from '../../plan-proizvodnje/_components/shared';

/** Mobilni Plan proizvodnje (/m/proizvodnja) — operater bira mašinu → red operacija + status/SPREMNO. */
export default function MobileProizvodnjaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [machine, setMachine] = useState('');
  const machines = useMachines();
  const ops = useMachineOperations(machine || null);
  const overlay = useUpsertOverlay();
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return <main className="grid min-h-screen place-items-center text-sm text-ink-secondary">Učitavanje…</main>;
  }

  const rows = ops.data?.data.rows ?? [];

  function cycle(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, localStatus: nextStatus(o.local_status) });
  }
  function toggleReady(o: OpRow) {
    if (!canEdit) return;
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, readyOverride: !o.ready_override });
  }

  return (
    <main className="min-h-screen bg-app p-3">
      <h1 className="mb-3 text-md font-semibold text-ink">Proizvodnja</h1>
      <select
        value={machine}
        onChange={(e) => setMachine(e.target.value)}
        className="mb-3 h-10 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
      >
        <option value="">— izaberi mašinu —</option>
        {(machines.data?.data ?? []).map((m) => (
          <option key={m.rj_code} value={m.rj_code}>
            {m.rj_code}
            {m.naziv || m.name ? ` — ${m.naziv ?? m.name}` : ''}
          </option>
        ))}
      </select>

      {!machine ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Izaberi mašinu.</p>
      ) : ops.isLoading ? (
        <p className="py-8 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-disabled">Nema otvorenih operacija.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((o) => (
            <div key={`${o.work_order_id}:${o.line_id}`} className="rounded-panel border border-line bg-surface p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink">{o.broj_crteza ?? '—'}</span>
                <StatusPill status={o.local_status} onClick={() => cycle(o)} disabled={!canEdit} />
              </div>
              <div className="mt-0.5 text-xs text-ink-secondary">
                {o.naziv_dela ?? ''} · RN {o.rn_ident_broj ?? '—'} · op {String(o.operacija ?? '')}
              </div>
              <div className="mt-1 flex items-center gap-3 text-xs text-ink-disabled">
                <span>Kom {progressLabel(o)}</span>
                <span>Rok {formatDate(o.rok_izrade)}</span>
                {canEdit && (
                  <label className="ml-auto flex items-center gap-1.5 text-ink">
                    <input type="checkbox" checked={!!o.ready_override} onChange={() => toggleReady(o)} /> SPREMNO
                  </label>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
