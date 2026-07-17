'use client';

import { useMemo, useState } from 'react';
import { Download, Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { toast } from '@/lib/toast';
import {
  useCreateLocation,
  useCreatePart,
  useCreateStockMovement,
  useCreateSupplier,
  useLocations,
  useParts,
  usePartMovements,
  useSuppliers,
  useUpdateLocation,
  useUpdatePart,
  useUpdateSupplier,
  useVehicles,
  type MaintLocation,
  type MaintMe,
  type Part,
  type StockMovementType,
  type Supplier,
  type ViewRow,
} from '@/api/odrzavanje';
import { f, fnum, StatCard, KpiButton, tableEmpty } from './common';
import { Tabs } from './tabs';

type ZTab = 'delovi' | 'dobavljaci' | 'lokacije';

export function ZaliheTab({ me }: { me: MaintMe | undefined }) {
  const [tab, setTab] = useState<ZTab>('delovi');
  return (
    <div className="space-y-3">
      <Tabs tabs={[{ key: 'delovi', label: 'Delovi' }, { key: 'dobavljaci', label: 'Dobavljači' }, { key: 'lokacije', label: 'Lokacije' }]} value={tab} onChange={setTab} ariaLabel="Zalihe" />
      {tab === 'delovi' && <DeloviView me={me} />}
      {tab === 'dobavljaci' && <DobavljaciView me={me} />}
      {tab === 'lokacije' && <LokacijeView me={me} />}
    </div>
  );
}

function num(v: string | number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
const NF = new Intl.NumberFormat('sr-Latn-RS', { maximumFractionDigits: 4 });
const MF = new Intl.NumberFormat('sr-Latn-RS', { maximumFractionDigits: 2 });
function fmtNum(v: string | number | null | undefined): string { return NF.format(num(v)); }
function money(v: string | number | null | undefined): string { return MF.format(num(v)); }

// ── Delovi (katalog + KPI + filter po vozilu + CSV) ────────────────────────
/** Normalizovan red kataloga (jedinstven oblik nad Prisma `Part` i view `v_maint_parts_with_vehicles`). */
interface PRow {
  partId: string;
  partCode: string;
  name: string;
  unit: string;
  minStock: number;
  currentStock: number;
  unitCost: number | null;
  manufacturer: string | null;
  model: string | null;
  supplierId: string | null;
  active: boolean;
  vehicleCount: number | null;
}
function fromPart(p: Part): PRow {
  return {
    partId: p.partId, partCode: p.partCode, name: p.name, unit: p.unit,
    minStock: num(p.minStock), currentStock: num(p.currentStock),
    unitCost: p.unitCost == null ? null : num(p.unitCost),
    manufacturer: p.manufacturer, model: p.model, supplierId: p.supplierId,
    active: p.active, vehicleCount: null,
  };
}
function fromView(r: ViewRow): PRow {
  return {
    partId: f(r, 'part_id') ?? '', partCode: f(r, 'part_code') ?? '', name: f(r, 'name') ?? '',
    unit: f(r, 'unit') ?? '', minStock: fnum(r, 'min_stock') ?? 0, currentStock: fnum(r, 'current_stock') ?? 0,
    unitCost: fnum(r, 'unit_cost'), manufacturer: f(r, 'manufacturer'), model: f(r, 'model'),
    supplierId: f(r, 'supplier_id'), active: f(r, 'active') !== 'false',
    vehicleCount: fnum(r, 'vehicle_count'),
  };
}

function DeloviView({ me }: { me: MaintMe | undefined }) {
  const [q, setQ] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [vehicleId, setVehicleId] = useState('');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Part | null>(null);
  const [moving, setMoving] = useState<PRow | null>(null);

  const canManage = me?.gates.canManageInventory ?? false;
  const canMove = me?.gates.canMoveInventory ?? false;

  // Osnovni (pun) katalog — izvor za KPI i podrazumevani prikaz. Vozilo-filter ide
  // preko BE `vehicleId` (vraća v_maint_parts_with_vehicles), pa se čita zasebno.
  const base = useParts({ includeInactive, pageSize: 1000 });
  const vparts = useParts({ vehicleId, includeInactive, pageSize: 1000 }, !!vehicleId);
  const suppliers = useSuppliers('all');
  const vehicles = useVehicles();

  const baseRows = useMemo(() => ((base.data?.data ?? []) as Part[]).map(fromPart), [base.data]);
  const supplierName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of suppliers.data?.data ?? []) m.set(s.supplierId, s.name);
    return (id: string | null) => (id ? m.get(id) ?? '—' : '—');
  }, [suppliers.data]);

  // Redovi za prikaz: kad je izabrano vozilo → view-redovi (sa vehicle_count), inače pun katalog.
  const displayAll = useMemo<PRow[]>(
    () => (vehicleId ? ((vparts.data?.data ?? []) as ViewRow[]).map(fromView) : baseRows),
    [vehicleId, vparts.data, baseRows],
  );
  const displayRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return displayAll.filter((p) => {
      if (lowOnly && !(p.currentStock <= p.minStock)) return false; // „Ispod minimuma" = INKLUZIVNO (<=)
      if (!needle) return true;
      return `${p.partCode} ${p.name} ${p.manufacturer ?? ''} ${p.model ?? ''} ${supplierName(p.supplierId)}`.toLowerCase().includes(needle);
    });
  }, [displayAll, q, lowOnly, supplierName]);

  // KPI — uvek nad punim katalogom (nezavisno od pretrage/filtera; paritet 1.0).
  const lowCount = baseRows.filter((p) => p.currentStock <= p.minStock).length;
  const stockValue = baseRows.reduce((sum, p) => sum + p.currentStock * (p.unitCost ?? 0), 0);
  const supplierCount = suppliers.data?.data.length ?? 0;

  function exportCsv() {
    const headers = ['part_code', 'name', 'supplier', 'unit', 'current_stock', 'min_stock', 'unit_cost', 'manufacturer', 'model'];
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const body = displayRows.map((p) => [p.partCode, p.name, supplierName(p.supplierId), p.unit, p.currentStock, p.minStock, p.unitCost ?? '', p.manufacturer ?? '', p.model ?? ''].map(esc).join(',')).join('\n');
    const text = `﻿${headers.join(',')}\n${body}`;
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `odrzavanje_zalihe_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('CSV izvezen');
  }

  const cols: Column<PRow>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.partCode}{!r.active && <span className="ml-1.5 text-2xs text-ink-disabled">(neaktivan)</span>}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'supplier', header: 'Dobavljač', render: (r) => <span className="text-ink-secondary">{supplierName(r.supplierId)}</span> },
    { key: 'model', header: 'Model', render: (r) => <span className="text-ink-secondary">{[r.manufacturer, r.model].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'stock', header: 'Zaliha', numeric: true, render: (r) => <span className="tnums">{fmtNum(r.currentStock)} {r.unit}<span className="ml-1 text-2xs text-ink-secondary">min {fmtNum(r.minStock)}</span></span> },
    { key: 'cost', header: 'Cena', numeric: true, render: (r) => <span className="tnums text-ink-secondary">{r.unitCost == null ? '—' : money(r.unitCost)}</span> },
    { key: 'veh', header: 'Vozila', numeric: true, render: (r) => (r.vehicleCount == null ? <span className="text-ink-disabled">—</span> : r.vehicleCount > 0 ? <StatusBadge tone="info" label={String(r.vehicleCount)} /> : <span className="text-ink-disabled">0</span>) },
    { key: 'status', header: 'Status', render: (r) => (r.currentStock <= r.minStock ? <StatusBadge tone="warn" label="Ispod minimuma" /> : <StatusBadge tone="success" label="Na stanju" />) },
    ...((canMove || canManage)
      ? [{
          key: 'act', header: '', align: 'right' as const,
          render: (r: PRow) => (
            <div className="flex justify-end gap-1.5">
              {canMove && <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setMoving(r); }}>Zaliha</Button>}
              {canManage && <Button variant="ghost" onClick={(e) => { e.stopPropagation(); const p = (base.data?.data as Part[] | undefined)?.find((x) => x.partId === r.partId); if (p) setEditing(p); else toast('Deo nije u punom katalogu — otvori bez vozilo-filtera.'); }}>Izmeni</Button>}
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiButton label="Ispod minimuma" value={lowCount} tone={lowCount ? 'danger' : 'success'} title="Prikaži samo delove ispod minimuma" onClick={() => setLowOnly((v) => !v)} />
        <StatCard label="Ukupno delova" value={baseRows.length} />
        <StatCard label="Vrednost zaliha" value={money(stockValue)} />
        <StatCard label="Dobavljači" value={supplierCount} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Deo, šifra, dobavljač…" />
        <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink" title="Filtriraj delove po vozilu">
          <option value="">— Sva vozila —</option>
          {(vehicles.data?.data ?? []).map((v) => <option key={v.asset_id} value={v.asset_id}>{v.asset_code} · {v.name}</option>)}
        </select>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Ispod minimuma</label>
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Prikaži neaktivne</label>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={exportCsv}><Download className="h-4 w-4" aria-hidden /> CSV</Button>
          {canManage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novi deo</Button>}
        </div>
      </div>

      <DataTable columns={cols} rows={displayRows} rowKey={(r) => r.partId} loading={base.isLoading || (!!vehicleId && vparts.isLoading)} empty={tableEmpty(base.isError, 'Nema delova', 'Nijedan deo ne odgovara filteru.')} />
      <p className="text-2xs text-ink-secondary">Prikazano {displayRows.length} od {displayAll.length}{vehicleId ? ' (filtrirano po vozilu)' : ''}. Kolona „Vozila" popunjena je uz vozilo-filter.</p>

      {creating && <PartDialog suppliers={suppliers.data?.data ?? []} onClose={() => setCreating(false)} />}
      {editing && <PartDialog suppliers={suppliers.data?.data ?? []} existing={editing} onClose={() => setEditing(null)} />}
      {moving && <StockMovementDialog part={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** Puna forma dela — create (sa POČETNIM stanjem) i edit (useUpdatePart; stanje read-only, ide kroz kretanje). */
function PartDialog({ suppliers, existing, onClose }: { suppliers: Supplier[]; existing?: Part; onClose: () => void }) {
  const create = useCreatePart();
  const update = useUpdatePart();
  const [partCode, setCode] = useState(existing?.partCode ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [unit, setUnit] = useState(existing?.unit ?? 'kom');
  const [supplierId, setSupplier] = useState(existing?.supplierId ?? '');
  const [minStock, setMin] = useState(String(existing?.minStock ?? 0));
  const [currentStock, setCurrent] = useState(String(existing?.currentStock ?? 0));
  const [unitCost, setCost] = useState(existing?.unitCost == null ? '' : String(existing.unitCost));
  const [manufacturer, setMfr] = useState(existing?.manufacturer ?? '');
  const [model, setModel] = useState(existing?.model ?? '');
  const [active, setActive] = useState(existing?.active ?? true);
  const [description, setDesc] = useState(existing?.description ?? '');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!partCode.trim() || !name.trim()) return setErr('Šifra i naziv su obavezni.');
    const common = {
      partCode: partCode.trim(),
      name: name.trim(),
      unit: unit.trim() || 'kom',
      supplierId: supplierId || undefined,
      minStock: Number(minStock) || 0,
      unitCost: unitCost === '' ? undefined : Number(unitCost),
      manufacturer: manufacturer.trim() || undefined,
      model: model.trim() || undefined,
      active,
      description: description.trim() || undefined,
    };
    const onDone = { onSuccess: () => { toast(existing ? 'Deo ažuriran' : 'Deo dodat'); onClose(); }, onError: (e: unknown) => setErr((e as Error).message) };
    if (existing) update.mutate({ id: existing.partId, patch: common }, onDone);
    else create.mutate({ ...common, currentStock: Number(currentStock) || 0 }, onDone);
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog open onClose={onClose} title={existing ? 'Izmeni deo' : 'Novi deo'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={pending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra" required><Input value={partCode} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Jedinica"><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
          <FormField label="Dobavljač">
            <select value={supplierId} onChange={(e) => setSupplier(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">—</option>
              {suppliers.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.name}{s.active ? '' : ' (neaktivan)'}</option>)}
            </select>
          </FormField>
          <FormField label="Min. zaliha"><Input value={minStock} onChange={(e) => setMin(e.target.value)} inputMode="decimal" /></FormField>
          <FormField label={existing ? 'Trenutna zaliha' : 'Početno stanje'}>
            <Input value={currentStock} onChange={(e) => setCurrent(e.target.value)} inputMode="decimal" disabled={!!existing} />
          </FormField>
          <FormField label="Jedinična cena"><Input value={unitCost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></FormField>
          <FormField label="Proizvođač"><Input value={manufacturer} onChange={(e) => setMfr(e.target.value)} /></FormField>
          <FormField label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></FormField>
          <FormField label="Aktivan">
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-ink"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Deo je u upotrebi</label>
          </FormField>
        </div>
        <FormField label="Opis"><Input value={description} onChange={(e) => setDesc(e.target.value)} placeholder="opciono" /></FormField>
        {existing && <p className="text-2xs text-ink-secondary">Trenutno stanje se menja kroz „Zaliha" (kretanja), ne ovde.</p>}
      </div>
    </Dialog>
  );
}

const MOVE_TYPES: { key: StockMovementType; label: string }[] = [
  { key: 'in', label: 'Ulaz' },
  { key: 'out', label: 'Izlaz' },
  { key: 'return', label: 'Povrat' },
  { key: 'adjustment', label: 'Korekcija (+/−)' },
];
const MOVE_LABEL: Record<string, string> = { in: 'Ulaz', out: 'Izlaz', adjustment: 'Korekcija', return: 'Povrat' };
function StockMovementDialog({ part, onClose }: { part: PRow; onClose: () => void }) {
  const [movementType, setType] = useState<StockMovementType>('in');
  const [quantity, setQty] = useState('');
  const [unitCost, setCost] = useState(part.unitCost == null ? '' : String(part.unitCost));
  const [note, setNote] = useState('');
  const move = useCreateStockMovement();
  const movements = usePartMovements(part.partId);
  const recent = (movements.data?.data ?? []).slice(0, 12);

  return (
    <Dialog open onClose={onClose} title={`Kretanje zalihe · ${part.partCode}`}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button disabled={!quantity || move.isPending} onClick={() => move.mutate({ id: part.partId, movementType, quantity: Number(quantity), unitCost: unitCost === '' ? undefined : Number(unitCost), note: note || undefined }, { onSuccess: () => { toast('Zaliha ažurirana'); onClose(); } })}>Upiši</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-secondary">{part.name} · trenutno {fmtNum(part.currentStock)} {part.unit}</p>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tip kretanja">
            <select value={movementType} onChange={(e) => setType(e.target.value as StockMovementType)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              {MOVE_TYPES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          </FormField>
          <FormField label="Količina" required><Input value={quantity} onChange={(e) => setQty(e.target.value)} inputMode="decimal" /></FormField>
          <FormField label="Jedinična cena"><Input value={unitCost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></FormField>
          <FormField label="Napomena"><Input value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
        </div>

        <div>
          <p className="mb-1.5 text-2xs uppercase tracking-wider text-ink-secondary">Poslednja kretanja</p>
          {movements.isLoading ? (
            <p className="py-2 text-sm text-ink-secondary">Učitavanje…</p>
          ) : recent.length === 0 ? (
            <p className="py-2 text-sm text-ink-secondary">Nema kretanja.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {recent.map((m) => (
                <li key={m.movementId} className="flex items-center justify-between gap-2 rounded-control border border-line-soft px-2 py-1">
                  <span className="text-ink">{MOVE_LABEL[m.movementType] ?? m.movementType} <span className="tnums">{fmtNum(m.quantity)}</span></span>
                  <span className="tnums text-2xs text-ink-secondary">{String(m.createdAt).replace('T', ' ').slice(0, 16)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// ── Dobavljači (edit + napomena + reaktivacija) ────────────────────────────
function DobavljaciView({ me }: { me: MaintMe | undefined }) {
  const [showInactive, setShowInactive] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const suppliers = useSuppliers(showInactive ? 'all' : undefined);
  const update = useUpdateSupplier();
  const canManage = me?.gates.canManageInventory ?? false;
  const rows = suppliers.data?.data ?? [];

  const cols: Column<Supplier>[] = [
    { key: 'name', header: 'Naziv', render: (r) => <span className="font-medium">{r.name}{!r.active && <span className="ml-1.5 text-2xs text-ink-disabled">(neaktivan)</span>}</span> },
    { key: 'contact', header: 'Kontakt', render: (r) => <span className="text-ink-secondary">{r.contact ?? '—'}</span> },
    { key: 'phone', header: 'Telefon', render: (r) => <span className="tnums text-ink-secondary">{r.phone ?? '—'}</span> },
    { key: 'email', header: 'Email', render: (r) => <span className="text-ink-secondary">{r.email ?? '—'}</span> },
    { key: 'notes', header: 'Napomena', render: (r) => <span className="text-ink-secondary">{r.notes ?? '—'}</span> },
    ...(canManage
      ? [{
          key: 'act', header: '', align: 'right' as const,
          render: (r: Supplier) => (
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Izmeni</Button>
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); update.mutate({ id: r.supplierId, patch: { active: !r.active } }, { onSuccess: () => toast(r.active ? 'Deaktiviran' : 'Reaktiviran') }); }}>{r.active ? 'Deaktiviraj' : 'Reaktiviraj'}</Button>
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> Prikaži neaktivne</label>
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novi dobavljač</Button></div>}
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.supplierId} loading={suppliers.isLoading} empty={tableEmpty(suppliers.isError, 'Nema dobavljača', 'Nijedan dobavljač nije evidentiran.')} />
      {creating && <SupplierDialog onClose={() => setCreating(false)} />}
      {editing && <SupplierDialog existing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SupplierDialog({ existing, onClose }: { existing?: Supplier; onClose: () => void }) {
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const [name, setName] = useState(existing?.name ?? '');
  const [contact, setContact] = useState(existing?.contact ?? '');
  const [phone, setPhone] = useState(existing?.phone ?? '');
  const [email, setEmail] = useState(existing?.email ?? '');
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    const payload = { name: name.trim(), contact: contact.trim() || undefined, phone: phone.trim() || undefined, email: email.trim() || undefined, notes: notes.trim() || undefined };
    const onDone = { onSuccess: () => { toast(existing ? 'Dobavljač ažuriran' : 'Dobavljač dodat'); onClose(); }, onError: (e: unknown) => setErr((e as Error).message) };
    if (existing) update.mutate({ id: existing.supplierId, patch: payload }, onDone);
    else create.mutate(payload, onDone);
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog open onClose={onClose} title={existing ? 'Izmeni dobavljača' : 'Novi dobavljač'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={pending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Kontakt"><Input value={contact} onChange={(e) => setContact(e.target.value)} /></FormField>
          <FormField label="Telefon"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></FormField>
          <FormField label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        </div>
        <FormField label="Napomena"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opciono" /></FormField>
      </div>
    </Dialog>
  );
}

/**
 * Lokacije — pun CRUD sa hijerarhijom (paritet 1.0 maintLocationsTab.js): tabela
 * naziv/šifra/tip/pod-lokacija/aktivno + create sa parent+type+active + EDIT (BE updateLocation)
 * + aktiviraj/deaktiviraj toggle. Pisanje = šef/admin/ERP (canManageMaintCatalog); ostali čitaju.
 */
function LokacijeView({ me }: { me: MaintMe | undefined }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MaintLocation | null>(null);
  const locations = useLocations();
  const update = useUpdateLocation();
  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const rows = locations.data?.data ?? [];
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of rows) m.set(l.locationId, l.name);
    return m;
  }, [rows]);

  const cols: Column<MaintLocation>[] = [
    { key: 'name', header: 'Naziv', render: (l) => <span className="font-medium text-ink">{l.name}</span> },
    { key: 'code', header: 'Šifra', render: (l) => <span className="tnums text-ink-secondary">{l.code ?? '—'}</span> },
    { key: 'type', header: 'Tip', render: (l) => <span className="text-ink-secondary">{l.locationType}</span> },
    { key: 'parent', header: 'Pod-lokacija', render: (l) => <span className="text-ink-secondary">{l.parentLocationId ? (nameById.get(l.parentLocationId) ?? '—') : '—'}</span> },
    { key: 'active', header: 'Aktivno', render: (l) => (l.active ? <StatusBadge tone="success" label="Da" /> : <StatusBadge tone="neutral" label="Neaktivno" />) },
    ...(canManage
      ? [{
          key: 'act', header: '', align: 'right' as const,
          render: (l: MaintLocation) => (
            <div className="flex justify-end gap-1.5">
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setEditing(l); }}>Izmeni</Button>
              <Button variant="ghost" onClick={(e) => { e.stopPropagation(); update.mutate({ id: l.locationId, patch: { active: !l.active } }); }}>{l.active ? 'Deaktiviraj' : 'Aktiviraj'}</Button>
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-ink-secondary">Hijerarhija lokacija (maint_locations) — vezuju se na sredstva.</p>
        {canManage && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Nova lokacija</Button>}
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(l) => l.locationId} loading={locations.isLoading} empty={tableEmpty(locations.isError, 'Nema lokacija', 'Nijedna lokacija nije definisana.')} />
      {creating && <LocationDialog rows={rows} onClose={() => setCreating(false)} />}
      {editing && <LocationDialog rows={rows} existing={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function LocationDialog({ rows, existing, onClose }: { rows: MaintLocation[]; existing?: MaintLocation; onClose: () => void }) {
  const create = useCreateLocation();
  const update = useUpdateLocation();
  const [name, setName] = useState(existing?.name ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [locationType, setType] = useState(existing?.locationType ?? 'lokacija');
  const [parent, setParent] = useState(existing?.parentLocationId ?? '');
  const [active, setActive] = useState(existing?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const parentOptions = rows.filter((r) => r.locationId !== existing?.locationId);

  function submit() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    const payload = { name: name.trim(), code: code.trim() || null, locationType: locationType.trim() || 'lokacija', parentLocationId: parent || null, active };
    const onDone = { onSuccess: onClose, onError: (e: unknown) => setErr((e as Error).message) };
    if (existing) update.mutate({ id: existing.locationId, patch: payload }, onDone);
    else create.mutate(payload, onDone);
  }

  const pending = create.isPending || update.isPending;
  return (
    <Dialog open onClose={onClose} title={existing ? 'Izmeni lokaciju' : 'Nova lokacija'}
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={pending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Šifra"><Input value={code} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Tip"><Input value={locationType} onChange={(e) => setType(e.target.value)} /></FormField>
          <FormField label="Podređena (parent)">
            <select value={parent} onChange={(e) => setParent(e.target.value)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">— nema —</option>
              {parentOptions.map((o) => <option key={o.locationId} value={o.locationId}>{o.name}</option>)}
            </select>
          </FormField>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Aktivno
        </label>
      </div>
    </Dialog>
  );
}
