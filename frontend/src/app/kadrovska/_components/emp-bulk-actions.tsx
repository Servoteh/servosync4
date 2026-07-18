'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import {
  newClientEventId,
  useDeactivateEmployee,
  useUpdateEmployee,
  type EmployeeSafe,
} from '@/api/kadrovska';
import { sv } from './common';
import { empDisplayName } from './emp-shared';

// ⚙ Bulk akcije nad selektovanim zaposlenima — Deaktiviraj / Aktiviraj
// (port 1.0 openEmpBulkActionsModal + applyEmpBulkAction). Petlja nad
// postojećim endpointima: deactivate = POST /:id/deactivate, aktiviranje =
// PATCH is_active (paritet BE ugovora).

type BulkAct = 'deactivate' | 'activate';

export function EmpBulkActionsDialog({
  items,
  onClose,
  onDone,
}: {
  items: EmployeeSafe[];
  onClose: () => void;
  /** Zove se posle obrade — poruka za toast + čišćenje selekcije. */
  onDone: (msg: string) => void;
}) {
  const deactivateMut = useDeactivateEmployee();
  const updateMut = useUpdateEmployee();

  const activeCnt = items.filter((e) => e.is_active).length;
  const inactiveCnt = items.length - activeCnt;

  const [act, setAct] = useState<BulkAct>(activeCnt > 0 ? 'deactivate' : 'activate');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namesPreview = items.slice(0, 5).map((e) => empDisplayName(e) || '—').join(', ');
  const more = items.length > 5 ? ` … i još ${items.length - 5}` : '';

  const target = act === 'deactivate' ? items.filter((e) => e.is_active) : items.filter((e) => !e.is_active);

  async function apply() {
    if (!target.length) {
      setError('Nema redova za ovu akciju.');
      return;
    }
    setBusy(true);
    setError(null);
    let ok = 0;
    let fail = 0;
    for (const e of target) {
      try {
        if (act === 'deactivate') {
          await deactivateMut.mutateAsync({ id: e.id, clientEventId: newClientEventId() });
        } else {
          await updateMut.mutateAsync({
            id: e.id,
            patch: { is_active: true },
            expectedUpdatedAt: sv(e, 'updated_at') || undefined,
          });
        }
        ok++;
      } catch {
        fail++;
      }
    }
    setBusy(false);
    onDone(
      fail === 0
        ? `✅ ${act === 'deactivate' ? 'Deaktivirano' : 'Aktivirano'} ${ok}`
        : `⚠ Promenjeno ${ok}, neuspešno ${fail}`,
    );
    onClose();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`⚙ Bulk akcija — ${items.length} zaposlen(ih)`}
      footer={
        confirming ? (
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Nazad</Button>
            <Button variant={act === 'deactivate' ? 'danger' : 'primary'} onClick={() => void apply()} loading={busy}>
              {act === 'deactivate' ? `Deaktiviraj ${target.length}` : `Aktiviraj ${target.length}`}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>Otkaži</Button>
            <Button onClick={() => (target.length ? setConfirming(true) : setError('Nema redova za ovu akciju.'))}>
              Primeni
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">{namesPreview}{more}</p>
        {error && <p className="text-sm text-status-danger" role="alert">{error}</p>}

        {confirming ? (
          <p className="text-sm text-ink">
            {act === 'deactivate' ? 'Deaktivirati' : 'Aktivirati'} <strong>{target.length}</strong> zaposlen(ih)?
            Istorija se ne briše; akcija je reverzibilna.
          </p>
        ) : (
          <fieldset className="space-y-2 rounded-panel border border-line p-4">
            <legend className="px-1 text-sm font-semibold text-ink">Izaberi akciju</legend>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name="empBulkAct"
                checked={act === 'deactivate'}
                disabled={activeCnt === 0}
                onChange={() => setAct('deactivate')}
              />
              <span>
                Deaktiviraj selektovane (preporučeno; istorija se čuva)
                <span className="text-ink-secondary">
                  {activeCnt === 0 ? ' — niko nije aktivan' : ` (${activeCnt} aktivnih)`}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="radio"
                name="empBulkAct"
                checked={act === 'activate'}
                disabled={inactiveCnt === 0}
                onChange={() => setAct('activate')}
              />
              <span>
                Aktiviraj selektovane (vrati u aktivne)
                <span className="text-ink-secondary">
                  {inactiveCnt === 0 ? ' — svi su već aktivni' : ` (${inactiveCnt} neaktivnih)`}
                </span>
              </span>
            </label>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}
