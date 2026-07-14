'use client';

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import {
  useArchiveVehicle,
  useCreateBooking,
  useCreateTire,
  useCreateVehicleServicePlan,
  useDeleteTire,
  useDeleteVehicleServicePlan,
  useGenerateVehicleServiceWos,
  useUpsertVehicleDetails,
  useVehicle,
  useVehicleBookings,
  useVehicleParts,
  useVehicleServicePlan,
  useVehicleTires,
  type MaintMe,
  type TireSeason,
} from '@/api/odrzavanje';
import { BOOKING_STATUS_LABEL, deadlineTone, f, Field, OpStatusBadge } from './common';
import { Tabs } from './tabs';

type VTab = 'pregled' | 'servis' | 'gume' | 'delovi' | 'carpool';

export function VoziloCardDialog({ id, me, onClose }: { id: string | null; me: MaintMe | undefined; onClose: () => void }) {
  const [tab, setTab] = useState<VTab>('pregled');
  const vehicle = useVehicle(id);
  const d = vehicle.data?.data;
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  if (!id) return null;
  return (
    <Dialog open={!!id} onClose={onClose} title={d ? `${d.assetCode} · ${d.name}` : 'Karton vozila'}>
      {vehicle.isLoading || !d ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <div className="space-y-4">
          <Tabs
            tabs={[
              { key: 'pregled', label: 'Pregled' },
              { key: 'servis', label: 'Servisni plan' },
              { key: 'gume', label: 'Gume' },
              { key: 'delovi', label: 'Delovi' },
              { key: 'carpool', label: 'Carpool' },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Karton vozila"
          />
          {tab === 'pregled' && <VPregled id={id} canManage={canManage} />}
          {tab === 'servis' && <VServis id={id} canManage={canManage} />}
          {tab === 'gume' && <VGume id={id} canManage={canManage} />}
          {tab === 'delovi' && <VDelovi id={id} />}
          {tab === 'carpool' && <VCarpool id={id} />}
        </div>
      )}
    </Dialog>
  );
}

function VPregled({ id, canManage }: { id: string; canManage: boolean }) {
  const vehicle = useVehicle(id);
  const upsert = useUpsertVehicleDetails();
  const archive = useArchiveVehicle();
  const d = vehicle.data?.data;
  const det = d?.details;
  const [km, setKm] = useState('');
  if (!d) return null;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between"><OpStatusBadge status={d.status} />{d.archivedAt && <StatusBadge tone="neutral" label="Arhivirano" />}</div>
      <div className="grid grid-cols-2 gap-3 rounded-panel border border-line bg-surface-2/40 p-3">
        <Field label="Tablice">{det?.registrationPlate ?? '—'}</Field>
        <Field label="VIN">{det?.vin ?? '—'}</Field>
        <Field label="Kilometraža">{det?.odometerKm ?? '—'}</Field>
        <Field label="Gorivo">{det?.fuelType ?? '—'}</Field>
        <Field label="Vlasnik">{d.owner?.name ?? '—'}</Field>
        <Field label="ENP/TAG">{det?.tollTagSerial ?? '—'}</Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Rok label="Registracija" date={det?.registrationExpiresAt} />
        <Rok label="Osiguranje" date={det?.insuranceExpiresAt} />
        <Rok label="Servis" date={det?.serviceDueAt} />
        <Rok label="Prva pomoć" date={det?.firstAidKitExpiresAt} />
      </div>
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
          <FormField label="Ažuriraj kilometražu"><Input value={km} onChange={(e) => setKm(e.target.value)} inputMode="numeric" className="w-32" /></FormField>
          <Button variant="secondary" disabled={!km || upsert.isPending} onClick={() => upsert.mutate({ id, details: { odometer_km: Number(km) } }, { onSuccess: () => setKm('') })}>Sačuvaj</Button>
          {!d.archivedAt && <Button variant="danger" className="ml-auto" onClick={() => { const reason = prompt('Razlog arhiviranja?'); if (reason) archive.mutate({ id, reason }); }}>Arhiviraj</Button>}
        </div>
      )}
    </div>
  );
}
function Rok({ label, date }: { label: string; date: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between rounded-control border border-line px-3 py-2 text-sm">
      <span className="text-ink-secondary">{label}</span>
      {date ? <StatusBadge tone={deadlineTone(date)} label={formatDate(date)} /> : <span className="text-ink-disabled">—</span>}
    </div>
  );
}

function VServis({ id, canManage }: { id: string; canManage: boolean }) {
  const plans = useVehicleServicePlan(id);
  const create = useCreateVehicleServicePlan();
  const del = useDeleteVehicleServicePlan();
  const gen = useGenerateVehicleServiceWos();
  const [name, setName] = useState('');
  const [km, setKm] = useState('');
  const [months, setMonths] = useState('');
  const rows = plans.data?.data ?? [];
  return (
    <div className="space-y-2">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
          <FormField label="Naziv"><Input value={name} onChange={(e) => setName(e.target.value)} className="w-40" /></FormField>
          <FormField label="Interval km"><Input value={km} onChange={(e) => setKm(e.target.value)} className="w-24" inputMode="numeric" /></FormField>
          <FormField label="Interval mes."><Input value={months} onChange={(e) => setMonths(e.target.value)} className="w-24" inputMode="numeric" /></FormField>
          <Button variant="secondary" disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ id, name, intervalKm: km ? Number(km) : undefined, intervalMonths: months ? Number(months) : undefined }, { onSuccess: () => { setName(''); setKm(''); setMonths(''); } })}><Plus className="h-4 w-4" aria-hidden /> Dodaj</Button>
          <Button className="ml-auto" disabled={gen.isPending} onClick={() => gen.mutate({ id })}>Generiši naloge</Button>
        </div>
      )}
      {rows.length === 0 ? <p className="py-2 text-center text-sm text-ink-secondary">Nema servisnih planova.</p> : rows.map((p) => (
        <div key={p.planId} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
          <span className="text-ink">{p.name} <span className="text-ink-secondary">· {[p.intervalKm && `${p.intervalKm} km`, p.intervalMonths && `${p.intervalMonths} mes`].filter(Boolean).join(' / ')}</span></span>
          {canManage && <button onClick={() => del.mutate({ id, planId: p.planId })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
        </div>
      ))}
    </div>
  );
}

const SEASONS: TireSeason[] = ['summer', 'winter', 'all_season'];
function VGume({ id, canManage }: { id: string; canManage: boolean }) {
  const tires = useVehicleTires(id);
  const create = useCreateTire();
  const del = useDeleteTire();
  const [dimension, setDim] = useState('');
  const [count, setCount] = useState('4');
  const [season, setSeason] = useState<TireSeason>('summer');
  const rows = tires.data?.data ?? [];
  return (
    <div className="space-y-2">
      {canManage && (
        <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
          <FormField label="Dimenzija"><Input value={dimension} onChange={(e) => setDim(e.target.value)} className="w-32" /></FormField>
          <FormField label="Komada"><Input value={count} onChange={(e) => setCount(e.target.value)} className="w-16" inputMode="numeric" /></FormField>
          <select value={season} onChange={(e) => setSeason(e.target.value as TireSeason)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <Button variant="secondary" disabled={!dimension.trim() || create.isPending} onClick={() => create.mutate({ id, dimension, count: Number(count) || 4, season }, { onSuccess: () => setDim('') })}><Plus className="h-4 w-4" aria-hidden /> Dodaj</Button>
        </div>
      )}
      {rows.length === 0 ? <p className="py-2 text-center text-sm text-ink-secondary">Nema guma.</p> : rows.map((t) => (
        <div key={t.tireSetId} className="flex items-center justify-between rounded-control border border-line p-2 text-sm">
          <span className="text-ink">{t.dimension} · {t.count} kom · {t.season} <span className="text-ink-secondary">{t.status}</span></span>
          {canManage && <button onClick={() => del.mutate({ id, tireId: t.tireSetId })} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button>}
        </div>
      ))}
    </div>
  );
}

function VDelovi({ id }: { id: string }) {
  const parts = useVehicleParts(id);
  const rows = parts.data?.data ?? [];
  return (
    <div className="space-y-1">
      {rows.length === 0 ? <p className="py-2 text-center text-sm text-ink-secondary">Nema vezanih delova.</p> : rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
          <span className="text-ink">{f(r, 'part_name', 'name') ?? '—'} <span className="text-ink-secondary">{f(r, 'part_code') ?? ''}</span></span>
          <span className="tnums text-ink-secondary">{f(r, 'qty_min', 'current_stock') ?? ''}</span>
        </div>
      ))}
    </div>
  );
}

function VCarpool({ id }: { id: string }) {
  const bookings = useVehicleBookings(id);
  const create = useCreateBooking();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [purpose, setPurpose] = useState('');
  const rows = bookings.data?.data ?? [];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2 rounded-panel border border-line p-3">
        <FormField label="Od"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></FormField>
        <FormField label="Do"><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></FormField>
        <FormField label="Svrha"><Input value={purpose} onChange={(e) => setPurpose(e.target.value)} className="w-40" /></FormField>
        <Button variant="secondary" disabled={!start || !end || create.isPending} onClick={() => create.mutate({ id, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), purpose: purpose || undefined }, { onSuccess: () => { setStart(''); setEnd(''); setPurpose(''); } })}><Plus className="h-4 w-4" aria-hidden /> Rezerviši</Button>
      </div>
      {rows.length === 0 ? <p className="py-2 text-center text-sm text-ink-secondary">Nema rezervacija.</p> : rows.map((r, i) => (
        <div key={i} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
          <span className="text-ink">{f(r, 'purpose') ?? '—'} <span className="text-ink-secondary">{f(r, 'driver_name') ?? ''}</span></span>
          <span className="text-2xs text-ink-secondary">{f(r, 'start_at') ? formatDate(String(f(r, 'start_at'))) : ''} — {f(r, 'status') ? BOOKING_STATUS_LABEL[f(r, 'status') as never] ?? f(r, 'status') : ''}</span>
        </div>
      ))}
    </div>
  );
}
