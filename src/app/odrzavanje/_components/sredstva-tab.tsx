'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  useArchiveAsset,
  useAssetServicePlan,
  useCreateAssetServicePlan,
  useCreateFacility,
  useCreateItAsset,
  useDeleteAssetServicePlan,
  useFacilities,
  useFacility,
  useGenerateAssetServiceWos,
  useItAsset,
  useItAssets,
  type AssetCardDetail,
  type MaintMe,
  type ViewRow,
} from '@/api/odrzavanje';
import { f, Field, OpStatusBadge, tableEmpty } from './common';

type Kind = 'it' | 'facility';

/** Generička sekcija za IT opremu / Objekte (lista view-a + karton + servisni plan). */
export function SredstvaTab({ kind, me }: { kind: Kind; me: MaintMe | undefined }) {
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const itList = useItAssets();
  const facList = useFacilities();
  const list = kind === 'it' ? itList : facList;
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  const rows = useMemo(() => {
    let all = (list.data?.data ?? []).filter((r) => !f(r, 'archived_at'));
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      all = all.filter((r) => [f(r, 'asset_code'), f(r, 'name')].filter(Boolean).some((x) => String(x).toLowerCase().includes(t)));
    }
    return all;
  }, [list.data, q]);

  const cols: Column<ViewRow>[] = [
    { key: 'code', header: 'Oznaka', render: (r) => <span className="tnums font-medium">{f(r, 'asset_code') ?? '—'}</span> },
    { key: 'name', header: 'Naziv', render: (r) => f(r, 'name') ?? '—' },
    ...(kind === 'it'
      ? [{ key: 'host', header: 'Uređaj / hostname', render: (r: ViewRow) => <span className="text-ink-secondary">{f(r, 'device_type', 'hostname') ?? '—'}</span> }]
      : [{ key: 'ftype', header: 'Tip objekta', render: (r: ViewRow) => <span className="text-ink-secondary">{f(r, 'facility_type') ?? '—'}</span> }]),
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={f(r, 'status')} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv…" />
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> {kind === 'it' ? 'Nova IT oprema' : 'Novi objekat'}</Button></div>}
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => f(r, 'asset_id') ?? String(Math.random())}
        loading={list.isLoading}
        onRowActivate={(r) => setOpenId(f(r, 'asset_id'))}
        empty={tableEmpty(list.isError, kind === 'it' ? 'Nema IT opreme' : 'Nema objekata', 'Nema evidentiranih sredstava.')}
      />
      <SredstvoCard kind={kind} id={openId} canManage={canManage} onClose={() => setOpenId(null)} />
      {creating && <CreateSredstvoDialog kind={kind} onClose={() => setCreating(false)} />}
    </div>
  );
}

function SredstvoCard({ kind, id, canManage, onClose }: { kind: Kind; id: string | null; canManage: boolean; onClose: () => void }) {
  const itQ = useItAsset(kind === 'it' ? id : null);
  const facQ = useFacility(kind === 'facility' ? id : null);
  const q = kind === 'it' ? itQ : facQ;
  const d: AssetCardDetail | undefined = q.data?.data;
  const plans = useAssetServicePlan(id);
  const createPlan = useCreateAssetServicePlan();
  const delPlan = useDeleteAssetServicePlan();
  const gen = useGenerateAssetServiceWos();
  const archive = useArchiveAsset();
  const [pname, setPname] = useState('');
  const [months, setMonths] = useState('12');

  if (!id) return null;
  const det = (d?.details ?? {}) as ViewRow;
  const detailKeys = kind === 'it'
    ? [['Uređaj', 'device_type'], ['Hostname', 'hostname'], ['IP', 'ip_address'], ['OS', 'operating_system'], ['Licenca do', 'license_expires_at'], ['Garancija do', 'warranty_expires_at']]
    : [['Tip', 'facility_type'], ['Površina m²', 'floor_area_m2'], ['Zona', 'floor_or_zone'], ['Inspekcija do', 'inspection_due_at'], ['PP do', 'fire_safety_due_at'], ['Serviser', 'service_provider']];

  return (
    <Dialog open={!!id} onClose={onClose} title={d ? `${d.assetCode} · ${d.name}` : 'Karton sredstva'}>
      {q.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between"><OpStatusBadge status={d.status} />{d.archivedAt && <StatusBadge tone="neutral" label="Arhivirano" />}</div>
          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
            {detailKeys.map(([label, key]) => <Field key={key} label={label}>{f(det, key) ?? '—'}</Field>)}
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h4 className="text-sm font-semibold text-ink">Servisni plan ({(plans.data?.data ?? []).length})</h4>
              {canManage && <Button variant="secondary" disabled={gen.isPending} onClick={() => gen.mutate({ id })}>Generiši naloge</Button>}
            </div>
            {canManage && (
              <div className="mb-2 flex flex-wrap items-end gap-2">
                <Input value={pname} onChange={(e) => setPname(e.target.value)} placeholder="Naziv plana" className="flex-1" />
                <Input value={months} onChange={(e) => setMonths(e.target.value)} placeholder="Mes." className="w-20" inputMode="numeric" />
                <Button variant="secondary" disabled={!pname.trim() || createPlan.isPending} onClick={() => createPlan.mutate({ id, name: pname, intervalMonths: Number(months) || 12 }, { onSuccess: () => setPname('') })}><Plus className="h-4 w-4" aria-hidden /></Button>
              </div>
            )}
            {(plans.data?.data ?? []).map((p) => (
              <div key={p.planId} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
                <span className="text-ink">{p.name} <span className="text-ink-secondary">· {p.intervalMonths} mes</span></span>
                {canManage && <button onClick={() => delPlan.mutate({ id, planId: p.planId })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
              </div>
            ))}
          </div>

          {canManage && !d.archivedAt && (
            <Button variant="danger" onClick={() => { const reason = prompt('Razlog arhiviranja?'); if (reason) archive.mutate({ id, reason }); }}>Arhiviraj</Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

function CreateSredstvoDialog({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const [assetCode, setCode] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const createIt = useCreateItAsset();
  const createFac = useCreateFacility();
  const create = kind === 'it' ? createIt : createFac;

  function submit() {
    setErr(null);
    if (!assetCode.trim() || !name.trim()) return setErr('Oznaka i naziv su obavezni.');
    create.mutate({ assetCode: assetCode.trim(), name: name.trim() }, { onSuccess: onClose, onError: (e) => setErr((e as Error).message) });
  }

  return (
    <Dialog open onClose={onClose} title={kind === 'it' ? 'Nova IT oprema' : 'Novi objekat'} footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka" required><Input value={assetCode} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}
