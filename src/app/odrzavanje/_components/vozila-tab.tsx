'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { useRestoreVehicle, useVehicles, type MaintMe, type VehicleOverviewRow } from '@/api/odrzavanje';
import { f, GPS_PROVIDER_LABEL, KpiButton, OpStatusBadge, tableEmpty, USAGE_LABEL, VEHICLE_KIND_LABEL } from './common';
import { VoziloEditModal } from './vozilo-edit-modal';

/** Broj dana do datuma (YYYY-MM-DD/ISO) u odnosu na danas (ponoć). null = bez datuma. */
function daysUntil(v: unknown): number | null {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && v != null && v !== '' ? n : null; };
function serviceDue(r: VehicleOverviewRow): boolean {
  const days = daysUntil(r.service_due_at);
  const km = num(r.next_service_mileage_km);
  const odo = num(r.odometer_km);
  return (days != null && days <= 30) || (km != null && odo != null && km - odo <= 1000);
}
function firstAidDue(r: VehicleOverviewRow): boolean {
  const st = f(r, 'first_aid_status');
  if (st === 'expired' || st === 'due_soon') return true;
  const days = daysUntil(r.first_aid_kit_expires_at);
  return days != null && days <= 30;
}

/**
 * Vozila — operativna lista (paritet 1.0 maintVehiclesPanel.js:705-1017): 5 filtera
 * (vlasnik/namena/GPS/vrsta/pretraga) + „Samo rokovi" + „Prikaži arhivirana", 4 KPI kartice,
 * kolone Vozilo/Vozač/Stanje/Rokovi-chips/KM + restore. Karton = ruta (/odrzavanje/vozila?id=).
 * Filteri i KPI računaju se klijentski (view vraća pun red; paritet 1.0 client-side filtracije).
 */
export function VozilaTab({ me }: { me: MaintMe | undefined }) {
  const router = useRouter();
  const vehicles = useVehicles();
  const restore = useRestoreVehicle();
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  const [q, setQ] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [usageType, setUsageType] = useState('');
  const [gpsProvider, setGps] = useState('');
  const [vehicleKind, setKind] = useState('');
  const [dueOnly, setDueOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const allRows = (vehicles.data?.data ?? []) as VehicleOverviewRow[];

  const ownerOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of allRows) { const oid = f(r, 'owner_id'); const nm = f(r, 'owner_name'); if (oid && nm) m.set(oid, nm); }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1], 'sr'));
  }, [allRows]);

  // KPI nad NEarhiviranim skupom (kao 1.0).
  const activeRows = allRows.filter((r) => !r.archived_at);
  const kpi = useMemo(() => ({
    reg: activeRows.filter((r) => { const d = daysUntil(r.registration_expires_at); return d != null && d <= 30; }).length,
    ins: activeRows.filter((r) => { const d = daysUntil(r.insurance_expires_at); return d != null && d <= 30; }).length,
    svc: activeRows.filter(serviceDue).length,
    fa: activeRows.filter(firstAidDue).length,
  }), [activeRows]);

  const rows = useMemo(() => {
    let out = allRows;
    if (!showArchived) out = out.filter((r) => !r.archived_at);
    if (ownerId) out = out.filter((r) => f(r, 'owner_id') === ownerId);
    if (usageType) out = out.filter((r) => f(r, 'usage_type') === usageType);
    if (gpsProvider) out = out.filter((r) => (f(r, 'gps_provider') ?? 'nema') === gpsProvider);
    if (vehicleKind) out = out.filter((r) => f(r, 'vehicle_kind') === vehicleKind);
    if (dueOnly) out = out.filter((r) => {
      const reg = daysUntil(r.registration_expires_at); const ins = daysUntil(r.insurance_expires_at);
      return (reg != null && reg <= 30) || (ins != null && ins <= 30) || serviceDue(r) || firstAidDue(r);
    });
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      out = out.filter((r) => [r.asset_code, r.name, f(r, 'registration_plate'), f(r, 'manufacturer'), f(r, 'model')].filter(Boolean).some((x) => String(x).toLowerCase().includes(t)));
    }
    return out;
  }, [allRows, showArchived, ownerId, usageType, gpsProvider, vehicleKind, dueOnly, q]);

  const selCls = 'h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink';
  const cols: Column<VehicleOverviewRow>[] = [
    {
      key: 'vozilo', header: 'Vozilo',
      render: (r) => {
        const meta = [f(r, 'manufacturer'), f(r, 'model'), f(r, 'year_of_manufacture'), f(r, 'registration_plate')].filter(Boolean).join(' · ');
        return (
          <div>
            <span className="font-medium text-ink">{r.name || r.asset_code}</span>
            {r.archived_at && <StatusBadge tone="neutral" label="Arhivirano" />}
            {meta && <div className="text-2xs text-ink-secondary">{meta}</div>}
          </div>
        );
      },
    },
    { key: 'vozac', header: 'Vozač', render: (r) => <span className="text-ink-secondary">{f(r, 'driver_full_name') ? `${f(r, 'driver_full_name')}${r.driver_is_internal === false ? ' (ext.)' : ''}` : '—'}</span> },
    { key: 'stanje', header: 'Stanje', render: (r) => <OpStatusBadge status={r.status} /> },
    { key: 'rokovi', header: 'Rokovi (≤30d)', render: (r) => <DeadlineChips r={r} /> },
    { key: 'km', header: 'KM', align: 'right', numeric: true, render: (r) => (f(r, 'odometer_km') ? `${Number(f(r, 'odometer_km')).toLocaleString('sr-RS')} km` : '—') },
    {
      key: 'akcije', header: '', align: 'right',
      render: (r) => (canManage && r.archived_at ? (
        <Button variant="secondary" onClick={(e) => { e.stopPropagation(); if (confirm('Vratiti vozilo u upotrebu?')) restore.mutate({ id: r.asset_id }, { onSuccess: () => toast('Vozilo vraćeno') }); }}>↩ Vrati</Button>
      ) : null),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <KpiButton label="Registracija ≤30d" value={kpi.reg} tone={kpi.reg ? 'danger' : 'neutral'} onClick={() => { setDueOnly(true); }} />
        <KpiButton label="Osiguranje ≤30d" value={kpi.ins} tone={kpi.ins ? 'danger' : 'neutral'} onClick={() => { setDueOnly(true); }} />
        <KpiButton label="Servis ≤30d / ≤1000km" value={kpi.svc} tone={kpi.svc ? 'warn' : 'neutral'} onClick={() => { setDueOnly(true); }} />
        <KpiButton label="Prva pomoć ≤30d" value={kpi.fa} tone={kpi.fa ? 'danger' : 'neutral'} onClick={() => { setDueOnly(true); }} />
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface p-3">
        <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, tablice, proizvođač…" />
        {ownerOptions.length > 0 && (
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={selCls}>
            <option value="">Svi vlasnici</option>
            {ownerOptions.map(([oid, nm]) => <option key={oid} value={oid}>{nm}</option>)}
          </select>
        )}
        <select value={usageType} onChange={(e) => setUsageType(e.target.value)} className={selCls}>
          <option value="">Sve namene</option>
          {Object.entries(USAGE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={vehicleKind} onChange={(e) => setKind(e.target.value)} className={selCls}>
          <option value="">Sva vozila</option>
          {Object.entries(VEHICLE_KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <select value={gpsProvider} onChange={(e) => setGps(e.target.value)} className={selCls}>
          <option value="">Svi GPS</option>
          {Object.entries(GPS_PROVIDER_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} /> Samo rokovi</label>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Arhivirana</label>
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novo vozilo</Button></div>}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.asset_id}
        loading={vehicles.isLoading}
        onRowActivate={(r) => router.push(`/odrzavanje/vozila?id=${encodeURIComponent(r.asset_id)}`)}
        empty={tableEmpty(vehicles.isError, 'Nema vozila', 'Nijedno vozilo ne odgovara filterima.')}
      />

      {creating && <VoziloEditModal onClose={() => setCreating(false)} onSaved={(id) => { if (id) router.push(`/odrzavanje/vozila?id=${encodeURIComponent(id)}`); }} />}
    </div>
  );
}

function DeadlineChips({ r }: { r: VehicleOverviewRow }) {
  const chips: { txt: string; expired: boolean }[] = [];
  const push = (prefix: string, v: unknown) => {
    const d = daysUntil(v);
    if (d == null || d > 30) return;
    chips.push({ txt: d < 0 ? `${prefix}: kasni ${-d}d` : `${prefix}: za ${d}d`, expired: d < 0 });
  };
  push('Reg', r.registration_expires_at);
  push('Osig', r.insurance_expires_at);
  push('Servis', r.service_due_at);
  if (f(r, 'first_aid_status') === 'expired' || f(r, 'first_aid_status') === 'due_soon') push('Pp', r.first_aid_kit_expires_at);
  if (chips.length === 0) return <span className="text-2xs text-ink-secondary">— svi OK —</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c, i) => <StatusBadge key={i} tone={c.expired ? 'danger' : 'warn'} label={c.txt} />)}
    </div>
  );
}
