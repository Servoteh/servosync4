'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import {
  useCreateDriver,
  useDriver,
  useDrivers,
  type DriverRow,
  type MaintMe,
} from '@/api/odrzavanje';
import { deadlineTone, f, Field, tableEmpty } from './common';

/** Vozači — lista (v_maint_drivers_overview) + karton (PII) + kreiranje. */
export function VozaciTab({ me }: { me: MaintMe | undefined }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const drivers = useDrivers();
  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const rows = drivers.data?.data ?? [];

  const cols: Column<DriverRow>[] = [
    { key: 'name', header: 'Ime i prezime', render: (r) => <span className="font-medium">{r.full_name}</span> },
    { key: 'lic', header: 'Kategorije', render: (r) => <span className="text-ink-secondary">{f(r, 'drivers_license_categories') ?? '—'}</span> },
    { key: 'licv', header: 'Dozvola do', render: (r) => { const dt = f(r, 'drivers_license_valid_until'); return dt ? <StatusBadge tone={deadlineTone(dt)} label={formatDate(dt)} /> : <span className="text-ink-secondary">—</span>; } },
    { key: 'med', header: 'Lekarski do', render: (r) => { const dt = f(r, 'medical_check_valid_until'); return dt ? <StatusBadge tone={deadlineTone(dt)} label={formatDate(dt)} /> : <span className="text-ink-secondary">—</span>; } },
    { key: 'phone', header: 'Telefon', render: (r) => <span className="tnums text-ink-secondary">{f(r, 'phone') ?? '—'}</span> },
  ];

  return (
    <div className="space-y-3">
      {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novi vozač</Button></div>}
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.driver_id}
        loading={drivers.isLoading}
        onRowActivate={(r) => setOpenId(r.driver_id)}
        empty={tableEmpty(drivers.isError, 'Nema vozača', 'Nijedan vozač nije evidentiran.')}
      />
      <VozacCardDialog id={openId} onClose={() => setOpenId(null)} />
      {creating && <CreateDriverDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function VozacCardDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const driver = useDriver(id);
  const d = driver.data?.data;
  if (!id) return null;
  return (
    <Dialog open={!!id} onClose={onClose} title={d ? d.fullName : 'Karton vozača'}>
      {driver.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
            <Field label="Broj dozvole">{d.driversLicenseNumber ?? '—'}</Field>
            <Field label="Kategorije">{d.driversLicenseCategories?.join(', ') || '—'}</Field>
            <Field label="Dozvola važi">{d.driversLicenseValidUntil ? formatDate(d.driversLicenseValidUntil) : '—'}</Field>
            <Field label="Lekarski važi">{d.medicalCheckValidUntil ? formatDate(d.medicalCheckValidUntil) : '—'}</Field>
            <Field label="LK važi">{d.idCardValidUntil ? formatDate(d.idCardValidUntil) : '—'}</Field>
            <Field label="Telefon">{d.phone ?? '—'}</Field>
          </div>
          <div>
            <h4 className="mb-1.5 text-sm font-semibold text-ink">Dokumenta ({d.documents.length})</h4>
            {d.documents.length === 0 ? <p className="text-sm text-ink-secondary">—</p> : d.documents.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
                <span className="text-ink">{doc.fileName}</span>
                <span className="text-2xs text-ink-secondary">{doc.validUntil ? `važi do ${formatDate(doc.validUntil)}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

function CreateDriverDialog({ onClose }: { onClose: () => void }) {
  const [fullName, setName] = useState('');
  const [licNo, setLicNo] = useState('');
  const [cats, setCats] = useState('B');
  const [licValid, setLicValid] = useState('');
  const [phone, setPhone] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateDriver();

  function submit() {
    setErr(null);
    if (!fullName.trim()) return setErr('Ime je obavezno.');
    if (!licNo.trim()) return setErr('Broj dozvole je obavezan.');
    if (!licValid) return setErr('Datum važenja dozvole je obavezan.');
    const categories = cats.split(',').map((c) => c.trim()).filter(Boolean);
    if (categories.length === 0) return setErr('Bar jedna kategorija.');
    create.mutate(
      { fullName: fullName.trim(), driversLicenseNumber: licNo.trim(), driversLicenseCategories: categories, driversLicenseValidUntil: new Date(licValid).toISOString(), phone: phone || undefined },
      { onSuccess: onClose, onError: (e) => setErr((e as Error).message) },
    );
  }

  return (
    <Dialog open onClose={onClose} title="Novi vozač" footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Ime i prezime" required><Input value={fullName} onChange={(e) => setName(e.target.value)} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Broj dozvole" required><Input value={licNo} onChange={(e) => setLicNo(e.target.value)} /></FormField>
          <FormField label="Kategorije" hint="odvoji zarezom" required><Input value={cats} onChange={(e) => setCats(e.target.value)} /></FormField>
          <FormField label="Dozvola važi do" required><Input type="date" value={licValid} onChange={(e) => setLicValid(e.target.value)} /></FormField>
          <FormField label="Telefon"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}
