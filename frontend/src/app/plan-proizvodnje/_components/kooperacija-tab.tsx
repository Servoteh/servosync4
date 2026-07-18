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
import { useRnFilter, RnFilterInput } from './rn-filter';
import { plannedSeconds, formatSecondsHm } from './shared';

/** Izvor kooperacije → labela statusa (paritet 1.0 statusLabel). */
function statusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'external': return 'Eksterno';
    case 'external_in_progress': return 'U kooperaciji';
    case 'external_done': return 'Vraćeno';
    default: return '—';
  }
}

/** Badge izvora AUTO/MANUAL/oba (paritet 1.0 sourceBadge). */
function SourceBadge({ source }: { source: string }) {
  if (source === 'auto') return <StatusBadge tone="info" label="AUTO" />;
  if (source === 'manual') return <StatusBadge tone="warn" label="MANUAL" />;
  if (source === 'auto+manual')
    return (
      <span className="inline-flex gap-1">
        <StatusBadge tone="info" label="AUTO" />
        <StatusBadge tone="warn" label="MANUAL" />
      </span>
    );
  return <span className="text-ink-disabled">—</span>;
}

/** Kooperacija: operacije u kooperaciji (ručno vraćanje) + auto grupe (admin CRUD bez DELETE). */
export function KooperacijaTab() {
  // RN filter (GAP-PM-04) — server param `q` na useCooperation (BE ILIKE) + LS po tabu (GAP-PM-21).
  const rn = useRnFilter('kooperacija');
  const coop = useCooperation(rn.applied);
  const groups = useCooperationGroups();
  const overlay = useUpsertOverlay();
  const patchGroup = usePatchCoopGroup();
  const can = useCan();
  const canEdit = can(PERMISSIONS.PLAN_PROIZVODNJE_EDIT);
  const [groupForm, setGroupForm] = useState(false);

  const ops = coop.data?.data ?? [];
  const autoCount = ops.filter((o) => o.cooperation_source === 'auto').length;
  const manualCount = ops.filter((o) => o.cooperation_source === 'manual').length;
  const bothCount = ops.filter((o) => o.cooperation_source === 'auto+manual').length;

  /** „Skini manual" — skida SAMO ručni flag (auto-kooperacija ostaje dok admin ne promeni lookup). */
  function skiniManual(o: OpRow) {
    overlay.mutate({ workOrderId: o.work_order_id, lineId: o.line_id, cooperationStatus: 'none' });
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <RnFilterInput value={rn.raw} onChange={rn.setRaw} />
          <span className="text-sm text-ink-secondary">
            {ops.length} operacija · auto {autoCount} · manual {manualCount}
            {bothCount ? ` · auto+manual ${bothCount}` : ''}
          </span>
        </div>
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">RN</th>
                <th className="px-3 py-1.5">Crtež</th>
                <th className="px-3 py-1.5">Operacija</th>
                <th className="px-3 py-1.5">RJ grupa</th>
                <th className="px-3 py-1.5">Izvor</th>
                <th className="px-3 py-1.5">Partner</th>
                <th className="px-3 py-1.5">Povratak</th>
                <th className="px-3 py-1.5 text-right">Plan</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {ops.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-ink-disabled">
                    {rn.active ? `Nema rezultata za filter „${rn.applied.trim()}".` : 'Nema operacija u kooperaciji.'}
                  </td>
                </tr>
              ) : (
                ops.map((o) => {
                  const source = o.cooperation_source || 'none';
                  const canClear = canEdit && (source === 'manual' || source === 'auto+manual');
                  return (
                    <tr key={`${o.work_order_id}:${o.line_id}`} className="border-b border-line-soft hover:bg-surface-2">
                      <td className="px-3 py-1.5 font-medium text-ink">{o.rn_ident_broj ?? '—'}</td>
                      <td className="px-3 py-1.5 text-xs text-ink-secondary">{o.broj_crteza ?? '—'}</td>
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-ink">{String(o.operacija ?? '—')}</div>
                        <div className="text-xs text-ink-disabled">{o.opis_rada ?? ''}</div>
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-ink">{o.rj_group_code ?? o.original_machine_code ?? '—'}</div>
                        <div className="text-xs text-ink-disabled">{o.rj_group_label ?? o.original_machine_name ?? ''}</div>
                      </td>
                      <td className="px-3 py-1.5"><SourceBadge source={source} /></td>
                      <td className="px-3 py-1.5">{o.cooperation_partner ?? '—'}</td>
                      <td className="tnums px-3 py-1.5 text-xs">{formatDate(o.cooperation_expected_return)}</td>
                      <td className="tnums px-3 py-1.5 text-right text-xs">{formatSecondsHm(plannedSeconds(o))}</td>
                      <td className="px-3 py-1.5 text-right">
                        {canClear ? (
                          <Button variant="ghost" className="h-8 px-2 text-xs" onClick={() => skiniManual(o)}>
                            <RotateCcw className="h-3.5 w-3.5" /> Skini manual
                          </Button>
                        ) : (
                          <span
                            className="text-xs text-ink-disabled"
                            title={source === 'auto' ? 'Auto-grupa se menja samo kroz lookup listu' : ''}
                          >
                            {statusLabel(o.cooperation_status)}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-ink-disabled">
          Auto redovi dolaze iz eksplicitne liste RJ grupa. „Skini manual" skida samo ručni flag;
          auto-kooperacija ostaje dok admin ne promeni lookup listu.
        </p>
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
