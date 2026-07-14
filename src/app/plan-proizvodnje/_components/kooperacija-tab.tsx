'use client';

import { useState } from 'react';
import { Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Can } from '@/lib/can';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useCooperation,
  useCooperationGroups,
  useCreateCoopGroup,
  usePatchCoopGroup,
  useUpsertOverlay,
  type OpRow,
} from '@/api/plan-proizvodnje';

/** Kooperacija: operacije u kooperaciji (ručno vraćanje) + auto grupe (admin CRUD bez DELETE). */
export function KooperacijaTab() {
  const coop = useCooperation();
  const groups = useCooperationGroups();
  const overlay = useUpsertOverlay();
  const patchGroup = usePatchCoopGroup();
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const [groupForm, setGroupForm] = useState(false);

  const ops = coop.data?.data ?? [];

  function vrati(o: OpRow) {
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, cooperationStatus: 'none' });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="text-sm text-ink-secondary">{ops.length} operacija u kooperaciji</div>
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Crtež / deo</th>
                <th className="px-3 py-1.5">RN</th>
                <th className="px-3 py-1.5">Partner</th>
                <th className="px-3 py-1.5">Povratak</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-ink-disabled">Nema operacija u kooperaciji.</td>
                </tr>
              ) : (
                ops.map((o) => (
                  <tr key={`${o.work_order_id}:${o.line_id}`} className="border-b border-line-soft hover:bg-surface-2">
                    <td className="px-3 py-1.5">
                      <div className="font-medium text-ink">{o.broj_crteza ?? '—'}</div>
                      <div className="text-xs text-ink-disabled">{o.naziv_dela ?? ''}</div>
                    </td>
                    <td className="px-3 py-1.5 text-xs">{o.rn_ident_broj ?? '—'}</td>
                    <td className="px-3 py-1.5">{o.cooperation_partner ?? '—'}</td>
                    <td className="tnums px-3 py-1.5 text-xs">{formatDate(o.cooperation_expected_return)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {canEdit && (
                        <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => vrati(o)}>
                          <RotateCcw className="h-3.5 w-3.5" /> Vrati
                        </Button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Auto grupe (admin) */}
      <div className="space-y-2 rounded-panel border border-line bg-surface p-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Auto grupe (RJ)</h3>
          <Can permission={PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN}>
            <Button variant="ghost" className="ml-auto h-8 px-2 text-xs" onClick={() => setGroupForm(true)}>
              <Plus className="h-3.5 w-3.5" /> Nova
            </Button>
          </Can>
        </div>
        {(groups.data?.data ?? []).length === 0 ? (
          <p className="text-xs text-ink-disabled">Nema definisanih grupa.</p>
        ) : (
          <ul className="space-y-1">
            {(groups.data?.data ?? []).map((g) => (
              <li key={g.rj_group_code} className="flex items-center gap-2 rounded-control border border-line px-2 py-1.5 text-sm">
                <span className="font-medium text-ink">{g.rj_group_code}</span>
                <span className="truncate text-xs text-ink-secondary">{g.group_label}</span>
                {g.removed_at ? (
                  <StatusBadge tone="neutral" label="Uklonjeno" />
                ) : (
                  <StatusBadge tone="success" label="Aktivno" />
                )}
                <Can permission={PERMISSIONS.PLAN_PROIZVODNJE_KOOP_ADMIN}>
                  <button
                    onClick={() => patchGroup.mutate({ code: g.rj_group_code, removed: !g.removed_at })}
                    className="ml-auto text-2xs text-accent hover:underline"
                  >
                    {g.removed_at ? 'Vrati' : 'Ukloni'}
                  </button>
                </Can>
              </li>
            ))}
          </ul>
        )}
      </div>

      {groupForm && <GroupForm onClose={() => setGroupForm(false)} />}
    </div>
  );
}

function GroupForm({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [notes, setNotes] = useState('');
  const create = useCreateCoopGroup();

  return (
    <Dialog
      open
      onClose={onClose}
      title="Nova auto-koop grupa"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button
            loading={create.isPending}
            disabled={!code.trim() || !label.trim()}
            onClick={async () => {
              await create.mutateAsync({ rjGroupCode: code.trim(), groupLabel: label.trim(), notes: notes || undefined });
              onClose();
            }}
          >
            Sačuvaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="RJ kod grupe" required>
          <Input value={code} onChange={(e) => setCode(e.target.value)} />
        </FormField>
        <FormField label="Naziv" required>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </FormField>
        <FormField label="Napomena">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
