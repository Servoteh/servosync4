'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { useCreateVehicle, useVehicles, type MaintMe, type VehicleOverviewRow } from '@/api/odrzavanje';
import { f, OpStatusBadge, tableEmpty } from './common';
import { VoziloCardDialog } from './vozilo-card-dialog';

/** Vozila — lista (v_maint_vehicle_overview) + filter + karton + kreiranje. */
export function VozilaTab({ me }: { me: MaintMe | undefined }) {
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const vehicles = useVehicles();
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  const rows = useMemo(() => {
    let all = vehicles.data?.data ?? [];
    if (!showArchived) all = all.filter((v) => !v.archived_at);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      all = all.filter((v) => [v.asset_code, v.name, f(v, 'registration_plate', 'plate')].filter(Boolean).some((x) => String(x).toLowerCase().includes(t)));
    }
    return all;
  }, [vehicles.data, q, showArchived]);

  const cols: Column<VehicleOverviewRow>[] = [
    { key: 'code', header: 'Oznaka', render: (r) => <span className="tnums font-medium">{r.asset_code}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'plate', header: 'Tablice', render: (r) => <span className="tnums text-ink-secondary">{f(r, 'registration_plate', 'plate') ?? '—'}</span> },
    { key: 'km', header: 'Kilometraža', numeric: true, render: (r) => <span className="text-ink-secondary">{f(r, 'odometer_km') ?? '—'}</span> },
    { key: 'reg', header: 'Registracija do', render: (r) => <span className="text-ink-secondary">{f(r, 'registration_expires_at') ? String(f(r, 'registration_expires_at')).slice(0, 10) : '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, tablice…" />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Arhivirana
        </label>
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novo vozilo</Button></div>}
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.asset_id}
        loading={vehicles.isLoading}
        onRowActivate={(r) => setOpenId(r.asset_id)}
        empty={tableEmpty(vehicles.isError, 'Nema vozila', 'Nijedno vozilo ne odgovara pretrazi.')}
      />
      <VoziloCardDialog id={openId} me={me} onClose={() => setOpenId(null)} />
      {creating && <CreateVehicleDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateVehicleDialog({ onClose }: { onClose: () => void }) {
  const [assetCode, setCode] = useState('');
  const [name, setName] = useState('');
  const [plate, setPlate] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateVehicle();

  function submit() {
    setErr(null);
    if (!assetCode.trim() || !name.trim()) return setErr('Oznaka i naziv su obavezni.');
    create.mutate(
      { assetCode: assetCode.trim(), name: name.trim(), details: plate ? { registration_plate: plate } : undefined },
      { onSuccess: onClose, onError: (e) => setErr((e as Error).message) },
    );
  }

  return (
    <Dialog open onClose={onClose} title="Novo vozilo" footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka" required><Input value={assetCode} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Tablice"><Input value={plate} onChange={(e) => setPlate(e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}
