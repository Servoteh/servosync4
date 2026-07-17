'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { ApiError } from '@/api/client';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { useReassign, useBulkReassign, useMachines, type OpRow, type PpMachine } from '@/api/plan-proizvodnje';
import { machineGroupSlugForCode, machineGroupLabel } from './shared';

/**
 * REASSIGN dijalog (single/bulk) sa logikom grupa mašina na FE (GAP-PM-24):
 *  - prikaz izvorne grupe (mešane grupe → upozorenje + submit blokiran bez force-a),
 *  - kandidati FILTRIRANI na istu vrstu mašine (bez force) i bez originalnih kodova,
 *  - opcija „Naziv (kod) · Grupa",
 *  - force razlog min 3 karaktera (paritet 1.0 reassignDialog.js).
 * Force zahteva plan_proizvodnje.force dozvolu.
 */
export function ReassignDialog({
  open,
  onClose,
  rows,
}: {
  open: boolean;
  onClose: () => void;
  rows: OpRow[];
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

  const isBulk = rows.length > 1;
  const allMachines = machines.data?.data ?? [];

  // Izvorna grupa = grupa mašine na kojoj operacija trenutno JESTE
  // (assigned_machine_code override ili original_machine_code / effective).
  const sourceCode = (r: OpRow) =>
    (r.assigned_machine_code as string | null) ||
    (r.original_machine_code as string | null) ||
    r.effective_machine_code ||
    '';

  const { sourceGroup, mixedGroups } = useMemo(() => {
    const groups = new Set(rows.map((r) => machineGroupSlugForCode(sourceCode(r))));
    return {
      sourceGroup: groups.size === 1 ? [...groups][0] : null,
      mixedGroups: groups.size > 1,
    };
  }, [rows]);

  // Kandidati: bez originalnih kodova; bez force-a — samo ista grupa.
  const candidates = useMemo(() => {
    const originalCodes = new Set(rows.map((r) => r.original_machine_code as string | null).filter(Boolean));
    return (allMachines as PpMachine[]).filter((m) => {
      if (!m?.rj_code || originalCodes.has(m.rj_code)) return false;
      if (force) return true;
      return !!sourceGroup && machineGroupSlugForCode(m.rj_code) === sourceGroup;
    });
  }, [allMachines, rows, force, sourceGroup]);

  // Mešane grupe bez force-a → blokiraj submit (paritet 1.0).
  const blockedMixed = mixedGroups && !force;

  async function submit() {
    setErr(null);
    const targetMachine = target.trim() || null;
    if (!targetMachine) {
      setErr('Izaberi ciljnu mašinu.');
      return;
    }
    if (force && reason.trim().length < 3) {
      setErr('Razlog forsiranja je obavezan (min 3 karaktera).');
      return;
    }
    try {
      if (isBulk) {
        await bulk.mutateAsync({
          pairs: rows.map((r) => ({ workOrderId: r.work_order_id, lineId: r.line_id })),
          targetMachine,
          force,
          reason: reason || undefined,
        });
      } else {
        await single.mutateAsync({
          workOrderId: rows[0].work_order_id,
          lineId: rows[0].line_id,
          targetMachine,
          force,
          reason: reason || undefined,
        });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Premeštanje nije uspelo.');
    }
  }

  const title = isBulk
    ? `Premesti ${rows.length} operacija`
    : `Premesti RN ${rows[0]?.rn_ident_broj ?? '?'} / op. ${rows[0]?.operacija ?? '?'}`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button onClick={submit} disabled={blockedMixed} loading={single.isPending || bulk.isPending}>Premesti</Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">
          Izvorna grupa: <strong className="text-ink">{mixedGroups ? 'mešane grupe' : machineGroupLabel(sourceGroup ?? 'ostalo')}</strong>
        </p>

        {mixedGroups && (
          <div className="rounded-control border border-status-warn bg-status-warn-bg/40 px-3 py-2 text-xs text-status-warn">
            Izabrane operacije su iz različitih vrsta mašina. Standardni bulk je blokiran;
            {canForce ? ' force (uz razlog) zaobilazi ograničenje.' : ' force mogu samo admin/menadžment.'}
          </div>
        )}

        {canForce && (
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Forsiraj drugu vrstu mašine
          </label>
        )}

        <FormField label="Ciljna mašina">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink"
          >
            <option value="">— izaberi mašinu —</option>
            {candidates.map((m) => (
              <option key={m.rj_code} value={m.rj_code}>
                {(m.name as string) || (m.naziv as string) || '—'} ({m.rj_code}) · {machineGroupLabel(machineGroupSlugForCode(m.rj_code))}
              </option>
            ))}
          </select>
        </FormField>
        {!force && candidates.length === 0 && !mixedGroups && (
          <p className="text-xs text-ink-disabled">
            Nema drugih mašina iste vrste. Uključi force da premestiš u drugu grupu.
          </p>
        )}

        {force && (
          <FormField label="Razlog forsiranja (min 3 karaktera)" required>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Npr. mašina nije dostupna, posao kompatibilan…"
              className="w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
            />
          </FormField>
        )}

        {err && <p className="text-sm text-status-danger">{err}</p>}
      </div>
    </Dialog>
  );
}
