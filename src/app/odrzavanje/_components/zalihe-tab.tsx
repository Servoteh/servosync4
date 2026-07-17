'use client';

import { useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import {
  useCreateLocation,
  useCreatePart,
  useCreateStockMovement,
  useCreateSupplier,
  useLocations,
  useParts,
  useSuppliers,
  useUpdateLocation,
  type MaintLocation,
  type MaintMe,
  type Part,
  type StockMovementType,
  type Supplier,
} from '@/api/odrzavanje';
import { tableEmpty } from './common';
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

function num(v: string | number | null): number { return v == null ? 0 : Number(v); }

function DeloviView({ me }: { me: MaintMe | undefined }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<Part | null>(null);
  const parts = useParts({ q, pageSize: 100 });
  const canManage = me?.gates.canManageInventory ?? false;
  const canMove = me?.gates.canMoveInventory ?? false;
  const rows = (parts.data?.data ?? []) as Part[];

  const cols: Column<Part>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.partCode}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'stock', header: 'Stanje', numeric: true, render: (r) => <span className="tnums">{num(r.currentStock)} {r.unit}</span> },
    { key: 'min', header: 'Min.', numeric: true, render: (r) => <span className="tnums text-ink-secondary">{num(r.minStock)}</span> },
    { key: 'status', header: 'Status', render: (r) => (num(r.currentStock) <= num(r.minStock) ? <StatusBadge tone="warn" label="Ispod minimuma" /> : <StatusBadge tone="success" label="Na stanju" />) },
    ...(canMove ? [{ key: 'act', header: '', align: 'right' as const, render: (r: Part) => <Button variant="ghost" onClick={(e) => { e.stopPropagation(); setMoving(r); }}>Zaliha</Button> }] : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <SearchBox value={q} onChange={setQ} placeholder="Šifra ili naziv dela…" />
        {canManage && <div className="ml-auto"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novi deo</Button></div>}
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.partId} loading={parts.isLoading} empty={tableEmpty(parts.isError, 'Nema delova', 'Nijedan deo ne odgovara pretrazi.')} />
      {creating && <CreatePartDialog onClose={() => setCreating(false)} />}
      {moving && <StockMovementDialog part={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}

function CreatePartDialog({ onClose }: { onClose: () => void }) {
  const [partCode, setCode] = useState('');
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('kom');
  const [minStock, setMin] = useState('0');
  const [err, setErr] = useState<string | null>(null);
  const create = useCreatePart();
  function submit() {
    setErr(null);
    if (!partCode.trim() || !name.trim()) return setErr('Šifra i naziv su obavezni.');
    create.mutate({ partCode: partCode.trim(), name: name.trim(), unit, minStock: Number(minStock) || 0 }, { onSuccess: onClose, onError: (e) => setErr((e as Error).message) });
  }
  return (
    <Dialog open onClose={onClose} title="Novi deo" footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra" required><Input value={partCode} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Jedinica"><Input value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
          <FormField label="Min. zaliha"><Input value={minStock} onChange={(e) => setMin(e.target.value)} inputMode="decimal" /></FormField>
        </div>
      </div>
    </Dialog>
  );
}

const MOVE_TYPES: { key: StockMovementType; label: string }[] = [
  { key: 'in', label: 'Prijem' },
  { key: 'out', label: 'Izdavanje' },
  { key: 'adjustment', label: 'Korekcija' },
  { key: 'return', label: 'Povraćaj' },
];
function StockMovementDialog({ part, onClose }: { part: Part; onClose: () => void }) {
  const [movementType, setType] = useState<StockMovementType>('in');
  const [quantity, setQty] = useState('');
  const [note, setNote] = useState('');
  const move = useCreateStockMovement();
  return (
    <Dialog open onClose={onClose} title={`Kretanje zalihe · ${part.partCode}`} footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button disabled={!quantity || move.isPending} onClick={() => move.mutate({ id: part.partId, movementType, quantity: Number(quantity), note: note || undefined }, { onSuccess: onClose })}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        <FormField label="Tip kretanja">
          <select value={movementType} onChange={(e) => setType(e.target.value as StockMovementType)} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
            {MOVE_TYPES.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </FormField>
        <FormField label="Količina" required><Input value={quantity} onChange={(e) => setQty(e.target.value)} inputMode="decimal" /></FormField>
        <FormField label="Napomena"><Input value={note} onChange={(e) => setNote(e.target.value)} /></FormField>
      </div>
    </Dialog>
  );
}

function DobavljaciView({ me }: { me: MaintMe | undefined }) {
  const [creating, setCreating] = useState(false);
  const suppliers = useSuppliers();
  const canManage = me?.gates.canManageInventory ?? false;
  const rows = suppliers.data?.data ?? [];
  const cols: Column<Supplier>[] = [
    { key: 'name', header: 'Naziv', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'contact', header: 'Kontakt', render: (r) => <span className="text-ink-secondary">{r.contact ?? '—'}</span> },
    { key: 'phone', header: 'Telefon', render: (r) => <span className="tnums text-ink-secondary">{r.phone ?? '—'}</span> },
    { key: 'email', header: 'Email', render: (r) => <span className="text-ink-secondary">{r.email ?? '—'}</span> },
  ];
  return (
    <div className="space-y-3">
      {canManage && <div className="flex justify-end"><Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Novi dobavljač</Button></div>}
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.supplierId} loading={suppliers.isLoading} empty={tableEmpty(suppliers.isError, 'Nema dobavljača', 'Nijedan dobavljač nije evidentiran.')} />
      {creating && <CreateSupplierDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
function CreateSupplierDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateSupplier();
  function submit() {
    setErr(null);
    if (!name.trim()) return setErr('Naziv je obavezan.');
    create.mutate({ name: name.trim(), contact: contact || undefined, phone: phone || undefined, email: email || undefined }, { onSuccess: onClose, onError: (e) => setErr((e as Error).message) });
  }
  return (
    <Dialog open onClose={onClose} title="Novi dobavljač" footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Kontakt"><Input value={contact} onChange={(e) => setContact(e.target.value)} /></FormField>
          <FormField label="Telefon"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></FormField>
          <FormField label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>
        </div>
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
