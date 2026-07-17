'use client';

import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useAssetServicePlan,
  useCreateAssetServicePlan,
  useDeleteAssetServicePlan,
  useGenerateAssetServiceWos,
  useUpdateAssetServicePlan,
  type ViewRow,
  type WoPriority,
} from '@/api/odrzavanje';
import { f, fnum, isoToDateInput, WO_PRIORITY_LABEL } from './common';

const DUE: Record<string, { tone: Tone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  due_soon: { tone: 'warn', label: 'Uskoro' },
  overdue: { tone: 'danger', label: 'Kasni' },
  inactive: { tone: 'neutral', label: 'Pauziran' },
};
const PRIORITY_KEYS: WoPriority[] = ['p1_zastoj', 'p2_smetnja', 'p3_manje', 'p4_planirano'];

function nextDueText(at: string | null): string {
  if (!at) return '—';
  const d = String(at).slice(0, 10);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(`${d}T00:00:00`);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  const hint = days < 0 ? ` (kasni ${-days}d)` : days === 0 ? ' (danas)' : days <= 30 ? ` (za ${days}d)` : '';
  return `${formatDate(at)}${hint}`;
}

/**
 * Servisni plan IT opreme / objekta (H14 — paritet 1.0 maintAssetServicePlanPanel.js).
 * Čita `v_maint_asset_service_plan_due` (BE due kolone, P0): status badge, sledeći rok,
 * poslednji put, WO-link, brojači kasni/uskoro. Pun CRUD (name/prioritet/interval/last-done/
 * active/notes) + „Generiši WO". `onWoOpen` = klik na WO-link otvara detalj (karton prosleđuje).
 */
export function AssetServicePlanPanel({
  assetId,
  canManage,
  onWoOpen,
}: {
  assetId: string;
  canManage: boolean;
  onWoOpen?: (woId: string) => void;
}) {
  const plans = useAssetServicePlan(assetId);
  const del = useDeleteAssetServicePlan();
  const gen = useGenerateAssetServiceWos();
  const [formOpen, setFormOpen] = useState(false);
  const [editRow, setEditRow] = useState<ViewRow | null>(null);
  const rows = (plans.data?.data ?? []) as unknown as ViewRow[];
  const overdueN = rows.filter((r) => f(r, 'due_status') === 'overdue').length;
  const dueSoonN = rows.filter((r) => f(r, 'due_status') === 'due_soon').length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Plan održavanja</h3>
          <p className="text-xs text-ink-secondary">
            {rows.length} {rows.length === 1 ? 'stavka' : 'stavki'}
            {overdueN > 0 && <span className="text-status-danger"> · {overdueN} kasni</span>}
            {dueSoonN > 0 && <span className="text-status-warn"> · {dueSoonN} uskoro</span>}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="secondary" disabled={gen.isPending} onClick={() => gen.mutate({ id: assetId }, { onSuccess: (res) => { const n = (res as { data?: { created?: number } }).data?.created; toast(n ? `Kreirano ${n} WO iz plana` : 'Nema novih WO-ova za generisanje'); } })}>↻ Generiši WO</Button>
            <Button onClick={() => { setEditRow(null); setFormOpen(true); }}><Plus className="h-4 w-4" aria-hidden /> Dodaj plan stavku</Button>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema plan stavki. Dodaj prvu da sistem automatski kreira naloge kad servis dospe.</p>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Stavka</th><th className="p-2">Interval</th><th className="p-2">Poslednji put</th><th className="p-2">Sledeći put</th><th className="p-2">Status</th><th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const due = DUE[f(r, 'due_status') ?? ''] ?? { tone: 'neutral' as Tone, label: f(r, 'due_status') ?? '—' };
                const openWoId = f(r, 'open_wo_id');
                return (
                  <tr key={f(r, 'plan_id') ?? Math.random()} className={`border-b border-line-soft ${f(r, 'active') === 'false' ? 'opacity-55' : ''}`}>
                    <td className="p-2 font-medium text-ink">{f(r, 'name')}</td>
                    <td className="p-2 text-ink-secondary">{fnum(r, 'interval_months') ?? '—'} mes</td>
                    <td className="p-2 text-ink-secondary">{f(r, 'last_done_at') ? formatDate(String(f(r, 'last_done_at'))) : '—'}</td>
                    <td className="p-2 text-ink-secondary">{nextDueText(f(r, 'next_due_at'))}</td>
                    <td className="p-2"><StatusBadge tone={due.tone} label={due.label} /></td>
                    <td className="p-2 text-right">
                      <div className="flex justify-end gap-1.5">
                        {f(r, 'has_open_wo') === 'true' && openWoId && (onWoOpen
                          ? <button onClick={() => onWoOpen(String(openWoId))} className="text-accent hover:underline">WO ↗</button>
                          : <StatusBadge tone="info" label="WO otvoren" />)}
                        {canManage && <button title="Izmeni" onClick={() => { setEditRow(r); setFormOpen(true); }} className="text-ink-disabled hover:text-ink"><Pencil className="h-3.5 w-3.5" aria-hidden /></button>}
                        {canManage && <button title="Obriši" onClick={() => { if (confirm(`Obrisati plan stavku „${f(r, 'name')}"?`)) del.mutate({ id: assetId, planId: String(f(r, 'plan_id')) }, { onSuccess: () => toast('Obrisano') }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && <PlanForm assetId={assetId} row={editRow} onClose={() => setFormOpen(false)} />}
    </div>
  );
}

function PlanForm({ assetId, row, onClose }: { assetId: string; row: ViewRow | null; onClose: () => void }) {
  const create = useCreateAssetServicePlan();
  const update = useUpdateAssetServicePlan();
  const isEdit = !!row;
  const [name, setName] = useState(row ? String(f(row, 'name') ?? '') : '');
  const [priority, setPriority] = useState<string>(row ? String(f(row, 'priority') ?? 'p4_planirano') : 'p4_planirano');
  const [months, setMonths] = useState(row ? String(fnum(row, 'interval_months') ?? '') : '');
  const [lastAt, setLastAt] = useState(row ? isoToDateInput(f(row, 'last_done_at')) : '');
  const [active, setActive] = useState(row ? f(row, 'active') !== 'false' : true);
  const [notes, setNotes] = useState(row ? String(f(row, 'notes') ?? '') : '');
  const [err, setErr] = useState<string | null>(null);
  const selCls = 'h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink';

  function submit() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    const m = Number(months);
    if (!Number.isFinite(m) || m <= 0) return setErr('Interval u mesecima mora biti pozitivan broj.');
    const common = {
      name: name.trim(),
      intervalMonths: Math.round(m),
      lastDoneAt: lastAt || undefined,
      priority: priority as WoPriority,
      notes: notes.trim() || undefined,
      active,
    };
    if (isEdit) update.mutate({ id: assetId, planId: String(f(row!, 'plan_id')), patch: common }, { onSuccess: () => { toast('Sačuvano'); onClose(); }, onError: (e) => setErr((e as Error).message) });
    else create.mutate({ id: assetId, ...common }, { onSuccess: () => { toast('Plan stavka dodata'); onClose(); }, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title={isEdit ? 'Izmeni plan stavku' : 'Nova plan stavka'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button loading={create.isPending || update.isPending} onClick={submit}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="npr. Preventivni pregled, Backup provera" /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Prioritet"><select value={priority} onChange={(e) => setPriority(e.target.value)} className={selCls}>{PRIORITY_KEYS.map((k) => <option key={k} value={k}>{WO_PRIORITY_LABEL[k]}</option>)}</select></FormField>
          <FormField label="Interval — meseci" required><Input value={months} onChange={(e) => setMonths(e.target.value)} inputMode="numeric" placeholder="npr. 12" /></FormField>
          <FormField label="Poslednji put — datum"><Input type="date" value={lastAt} onChange={(e) => setLastAt(e.target.value)} /></FormField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktivno (uključeno u auto-generisanje WO)</label>
        <FormField label="Napomene"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></FormField>
      </div>
    </Dialog>
  );
}
