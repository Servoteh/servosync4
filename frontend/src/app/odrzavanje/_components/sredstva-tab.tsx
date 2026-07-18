'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Pencil, Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import { useFacilities, useItAssets, useRestoreAsset, type MaintMe, type ViewRow } from '@/api/odrzavanje';
import {
  criticalityTone,
  CRITICALITY_LABEL,
  daysUntil,
  dueDaysLabel,
  f,
  KpiButton,
  OpStatusBadge,
  tableEmpty,
} from './common';
import { SredstvoEditModal } from './sredstvo-edit-modal';

type Kind = 'it' | 'facility';

const num = (v: unknown): number | null => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };
function due30(v: unknown): boolean { const d = daysUntil(v); return d != null && d <= 30; }
function backupAttention(r: ViewRow): boolean {
  if (f(r, 'backup_required') !== 'true') return false;
  const last = f(r, 'last_backup_at');
  if (!last) return true;
  const d = daysUntil(last);
  return d != null && d < -7;
}
function itNeedsAttention(r: ViewRow): boolean {
  if (f(r, 'archived_at')) return false;
  if (f(r, 'status') && f(r, 'status') !== 'running') return true;
  if (['expired', 'due_soon'].includes(f(r, 'license_status') ?? '')) return true;
  if (['expired', 'due_soon'].includes(f(r, 'warranty_status') ?? '')) return true;
  if (['missing', 'stale'].includes(f(r, 'backup_status') ?? '')) return true;
  return false;
}
function facilityNeedsAttention(r: ViewRow): boolean {
  if (f(r, 'archived_at')) return false;
  if (f(r, 'status') && f(r, 'status') !== 'running') return true;
  if (['high', 'critical'].includes(f(r, 'criticality') ?? '')) return true;
  if (['expired', 'due_soon'].includes(f(r, 'inspection_status') ?? '')) return true;
  if (['expired', 'due_soon'].includes(f(r, 'fire_safety_status') ?? '')) return true;
  return false;
}

/** CSV izvoz (klijentski, UTF-8 BOM) — 1.0 kolone. */
function exportCsv(kind: Kind, rows: ViewRow[]) {
  const headers = kind === 'it'
    ? ['asset_code', 'name', 'status', 'device_type', 'hostname', 'ip_address', 'license_expires_at', 'warranty_expires_at', 'backup_required', 'license_status', 'warranty_status', 'backup_status']
    : ['asset_code', 'name', 'status', 'facility_type', 'floor_or_zone', 'cadastral_parcels', 'criticality', 'inspection_due_at', 'fire_safety_due_at', 'inspection_status', 'fire_safety_status', 'service_provider'];
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const body = rows.map((r) => headers.map((h) => esc(h === 'backup_required' ? (f(r, h) === 'true' ? 'da' : 'ne') : r[h])).join(',')).join('\n');
  const text = `﻿${headers.join(',')}\n${body}`;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${kind === 'it' ? 'it_oprema' : 'objekti'}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('CSV izvezen');
}

/**
 * IT oprema / Objekti — operativna lista (H12/H13; paritet 1.0 maintItAssetsPanel.js /
 * maintFacilitiesPanel.js): kolone sa due-bedževima, KPI kartice (3 IT / 4 objekti),
 * „Samo pažnja" + „Arhivirana", šira pretraga, Export CSV, edit i restore po redu.
 * Karton = ruta (`/odrzavanje/sredstva?id=&kind=`). Filteri/KPI klijentski (view = pun red).
 */
export function SredstvaTab({ kind, me }: { kind: Kind; me: MaintMe | undefined }) {
  const router = useRouter();
  const itList = useItAssets();
  const facList = useFacilities();
  const list = kind === 'it' ? itList : facList;
  const restore = useRestoreAsset();
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  const [q, setQ] = useState('');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  const allRows = (list.data?.data ?? []) as ViewRow[];
  const activeRows = allRows.filter((r) => !f(r, 'archived_at'));

  const kpi = useMemo(() => {
    if (kind === 'it') {
      return {
        licenses: activeRows.filter((r) => due30(f(r, 'license_expires_at'))).length,
        warranties: activeRows.filter((r) => due30(f(r, 'warranty_expires_at') ?? f(r, 'warranty_until'))).length,
        backups: activeRows.filter(backupAttention).length,
      };
    }
    return {
      inspections: activeRows.filter((r) => due30(f(r, 'inspection_due_at'))).length,
      fireSafety: activeRows.filter((r) => due30(f(r, 'fire_safety_due_at'))).length,
      critical: activeRows.filter((r) => ['high', 'critical'].includes(f(r, 'criticality') ?? '')).length,
      missing: activeRows.filter((r) => !f(r, 'facility_type')).length,
    };
  }, [activeRows, kind]);

  const rows = useMemo(() => {
    let out = allRows;
    if (!showArchived) out = out.filter((r) => !f(r, 'archived_at'));
    if (attentionOnly) out = out.filter(kind === 'it' ? itNeedsAttention : facilityNeedsAttention);
    if (q.trim()) {
      const t = q.trim().toLowerCase();
      const keys = kind === 'it'
        ? ['asset_code', 'name', 'hostname', 'device_type', 'ip_address']
        : ['asset_code', 'name', 'facility_type', 'floor_or_zone', 'cadastral_parcels'];
      out = out.filter((r) => keys.map((k) => f(r, k)).filter(Boolean).some((x) => String(x).toLowerCase().includes(t)));
    }
    return out;
  }, [allRows, showArchived, attentionOnly, q, kind]);

  const restoreCell = (r: ViewRow) => (canManage && f(r, 'archived_at') ? (
    <Button variant="secondary" onClick={(e) => { e.stopPropagation(); if (confirm('Vratiti u upotrebu?')) restore.mutate({ id: String(f(r, 'asset_id')) }, { onSuccess: () => toast('Vraćeno') }); }}>↩ Vrati</Button>
  ) : canManage ? (
    <button title="Izmeni" onClick={(e) => { e.stopPropagation(); setEditId(String(f(r, 'asset_id'))); }} className="text-ink-disabled hover:text-ink"><Pencil className="h-4 w-4" aria-hidden /></button>
  ) : null);

  const nameCell = (r: ViewRow) => (
    <div>
      <span className="tnums text-2xs text-ink-secondary">{f(r, 'asset_code') ?? ''}</span>
      <div className="flex items-center gap-1.5"><span className="font-medium text-ink">{f(r, 'name') ?? '—'}</span>{f(r, 'archived_at') && <StatusBadge tone="neutral" label="Arhivirano" />}</div>
    </div>
  );
  const dueCell = (v: unknown) => { const d = daysUntil(v); return v ? <StatusBadge tone={d != null && d < 0 ? 'danger' : d != null && d <= 30 ? 'warn' : 'success'} label={dueDaysLabel(v)} /> : <span className="text-ink-disabled">—</span>; };

  const itCols: Column<ViewRow>[] = [
    { key: 'sredstvo', header: 'Sredstvo', render: nameCell },
    { key: 'tip', header: 'Tip / host', render: (r) => <div><div className="text-ink">{f(r, 'device_type') ?? '—'}</div><div className="text-2xs text-ink-secondary">{[f(r, 'hostname'), f(r, 'ip_address')].filter(Boolean).join(' · ')}</div></div> },
    { key: 'zaduzen', header: 'Zadužen / OS', render: (r) => <div><div className="text-ink-secondary">{f(r, 'assigned_to') ?? '—'}</div><div className="text-2xs text-ink-secondary">{f(r, 'operating_system') ?? ''}</div></div> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={f(r, 'status')} /> },
    { key: 'licenca', header: 'Licenca', render: (r) => dueCell(f(r, 'license_expires_at')) },
    { key: 'garancija', header: 'Garancija', render: (r) => dueCell(f(r, 'warranty_expires_at') ?? f(r, 'warranty_until')) },
    { key: 'backup', header: 'Backup', render: (r) => <BackupText r={r} /> },
    { key: 'akcije', header: '', align: 'right', render: restoreCell },
  ];
  const facCols: Column<ViewRow>[] = [
    { key: 'sredstvo', header: 'Sredstvo', render: nameCell },
    { key: 'tip', header: 'Tip / zona', render: (r) => <div><div className="text-ink">{f(r, 'facility_type') ?? '—'}</div><div className="text-2xs text-ink-secondary">{f(r, 'floor_or_zone') ?? ''}</div></div> },
    { key: 'povrsina', header: 'Površina', render: (r) => { const a = num(f(r, 'floor_area_m2')); return a != null ? `${a.toLocaleString('sr-RS')} m²` : '—'; } },
    { key: 'krit', header: 'Kritičnost', render: (r) => f(r, 'criticality') ? <StatusBadge tone={criticalityTone(f(r, 'criticality'))} label={CRITICALITY_LABEL[f(r, 'criticality') ?? ''] ?? String(f(r, 'criticality'))} /> : <span className="text-ink-disabled">—</span> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={f(r, 'status')} /> },
    { key: 'insp', header: 'Inspekcija', render: (r) => dueCell(f(r, 'inspection_due_at')) },
    { key: 'pp', header: 'PP', render: (r) => dueCell(f(r, 'fire_safety_due_at')) },
    { key: 'serviser', header: 'Serviser', render: (r) => <span className="text-ink-secondary">{f(r, 'service_provider') ?? '—'}</span> },
    { key: 'akcije', header: '', align: 'right', render: restoreCell },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {kind === 'it' ? (
          <>
            <KpiButton label="Licence ≤30d" value={kpi.licenses ?? 0} tone={kpi.licenses ? 'danger' : 'neutral'} onClick={() => setAttentionOnly(true)} />
            <KpiButton label="Garancije ≤30d" value={kpi.warranties ?? 0} tone={kpi.warranties ? 'danger' : 'neutral'} onClick={() => setAttentionOnly(true)} />
            <KpiButton label="Backup pažnja" value={kpi.backups ?? 0} tone={kpi.backups ? 'warn' : 'neutral'} onClick={() => setAttentionOnly(true)} />
          </>
        ) : (
          <>
            <KpiButton label="Inspekcije ≤30d" value={kpi.inspections ?? 0} tone={kpi.inspections ? 'danger' : 'neutral'} onClick={() => setAttentionOnly(true)} />
            <KpiButton label="PP rokovi ≤30d" value={kpi.fireSafety ?? 0} tone={kpi.fireSafety ? 'danger' : 'neutral'} onClick={() => setAttentionOnly(true)} />
            <KpiButton label="Visoka kritičnost" value={kpi.critical ?? 0} tone={kpi.critical ? 'warn' : 'neutral'} onClick={() => setAttentionOnly(true)} />
            <KpiButton label="Bez detalja" value={kpi.missing ?? 0} tone={kpi.missing ? 'warn' : 'neutral'} onClick={() => setAttentionOnly(false)} />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface p-3">
        <SearchBox value={q} onChange={setQ} placeholder={kind === 'it' ? 'Šifra, naziv, hostname, IP…' : 'Šifra, naziv, tip, zona, parcele…'} />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={attentionOnly} onChange={(e) => setAttentionOnly(e.target.checked)} /> Samo pažnja</label>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Arhivirana</label>
        <Button variant="ghost" onClick={() => exportCsv(kind, rows)}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> {kind === 'it' ? 'Nova IT oprema' : 'Novi objekat'}</Button></div>}
      </div>

      <DataTable
        columns={kind === 'it' ? itCols : facCols}
        rows={rows}
        rowKey={(r) => String(f(r, 'asset_id') ?? Math.random())}
        loading={list.isLoading}
        onRowActivate={(r) => router.push(`/odrzavanje/sredstva?id=${encodeURIComponent(String(f(r, 'asset_id')))}&kind=${kind}`)}
        empty={tableEmpty(list.isError, kind === 'it' ? 'Nema IT opreme' : 'Nema objekata', 'Nijedno sredstvo ne odgovara filterima.')}
      />

      {creating && <SredstvoEditModal kind={kind} onClose={() => setCreating(false)} onSaved={(id) => { if (id) router.push(`/odrzavanje/sredstva?id=${encodeURIComponent(id)}&kind=${kind}`); }} />}
      {editId && <SredstvoEditModal kind={kind} assetId={editId} onClose={() => setEditId(null)} />}
    </div>
  );
}

/** Backup kolona (1.0 tekst): „—" (nije obavezan) / „treba" / „pre X d" / „za X d". */
function BackupText({ r }: { r: ViewRow }) {
  if (f(r, 'backup_required') !== 'true') return <span className="text-ink-disabled">—</span>;
  const last = f(r, 'last_backup_at');
  if (!last) return <span className="text-status-danger">treba</span>;
  const d = daysUntil(last);
  if (d == null) return <span className="text-ink-disabled">—</span>;
  const txt = d < 0 ? `pre ${-d} d` : d === 0 ? 'danas' : `za ${d} d`;
  return <span className={d < -7 ? 'text-status-warn' : 'text-ink-secondary'}>{txt}</span>;
}
