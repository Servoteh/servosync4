'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useReassign, useBulkReassign, useMachines } from '@/api/plan-proizvodnje';

/** REASSIGN dialog (single/bulk) + force (traži razlog + dozvolu plan_proizvodnje.force). */
export function ReassignDialog({
  open,
  onClose,
  pairs,
}: {
  open: boolean;
  onClose: () => void;
  pairs: { workOrderId: string; lineId: string }[];
}) {
  const machines = useMachines();
  const single = useReassign();
  const bulk = useBulkReassign();
  const can = useCan();
  const canForce = can(PERMISSIONS.PLAN_PROIZVODNJE_FORCE);

  const [target, setTarget] = useState('');
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTarget('');
      setForce(false);
      setReason('');
      setErr(null);
    }
  }, [open]);

  const isBulk = pairs.length > 1;

  async function submit() {
    setErr(null);
    if (force && !reason.trim()) {
      setErr('Za prinudni reassign razlog je obavezan.');
      return;
    }
    const targetMachine = target.trim() || null;
    try {
      if (isBulk) {
        await bulk.mutateAsync({ pairs, targetMachine, force, reason: reason || undefined });
      } else {
        await single.mutateAsync({ ...pairs[0], targetMachine, force, reason: reason || undefined });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Reassign nije uspeo.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isBulk ? `Premesti ${pairs.length} operacija` : 'Premesti operaciju'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} loading={single.isPending || bulk.isPending}>Premesti</Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Ciljna mašina (prazno = vrati na originalnu)">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            <option value="">— vrati na originalnu —</option>
            {(machines.data?.data ?? []).map((m) => (
              <option key={m.rj_code} value={m.rj_code}>
                {m.rj_code}
                {m.naziv || m.name ? ` — ${m.naziv ?? m.name}` : ''}
              </option>
            ))}
          </select>
        </FormField>

        {canForce && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Prinudno (force) — zaobiđi uslove
          </label>
        )}
        {force && (
          <FormField label="Razlog (obavezan)" required>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        )}
        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}
