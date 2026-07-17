'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Upload, History } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import { formatDateTime } from '@/lib/format';
import {
  useAssignableUsers,
  useCreateMachine,
  useDashboard,
  useDeletionLog,
  useImportableMachines,
  useImportMachines,
  useMachines,
  useTasksDue,
  type MachineRow,
  type MaintMe,
  type ViewRow,
} from '@/api/odrzavanje';
import { cn } from '@/lib/cn';
import { f, fnum, machinePriorityRank, type MachineListFilter, OpStatusBadge, relDays, tableEmpty } from './common';

type StatusChip = 'running' | 'degraded' | 'down' | 'maintenance';
type DeadlineChip = 'overdue' | 'danas' | '7d';
const STATUS_CHIPS: { key: StatusChip; label: string }[] = [
  { key: 'down', label: 'Zastoj' },
  { key: 'degraded', label: 'Smetnje' },
  { key: 'maintenance', label: 'Održavanje' },
  { key: 'running', label: 'Radi' },
];
const DEADLINE_CHIPS: { key: DeadlineChip; label: string }[] = [
  { key: 'overdue', label: 'Kasni' },
  { key: 'danas', label: 'Danas' },
  { key: '7d', label: '≤7 dana' },
];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-sm transition-colors',
        active ? 'border-accent bg-accent-subtle text-ink' : 'border-line text-ink-secondary hover:bg-surface-2',
      )}
    >
      {children}
    </button>
  );
}

/**
 * Mašine — operativna lista (paritet 1.0 index.js:663-975): chip filteri Status/Rok/Dodela +
 * lokacija select + pretraga, prioritet-sort (Zastoj→Radi, index.js:120-168), kolone „Sledeći
 * rok" i „Čeka deo" badge; + katalog akcije (pun create, uvoz iz BigTehn, log brisanja). BE nosi
 * status/rok/lokacija/mine filtere; sort i „Čeka deo"/„inc" izvode se klijentski. Karton = ruta.
 */
export function MasineTab({ me, initFilter }: { me: MaintMe | undefined; initFilter?: MachineListFilter }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusChip | null>(initFilter?.status ?? null);
  const [deadline, setDeadline] = useState<DeadlineChip | null>(initFilter?.deadline ?? null);
  const [mine, setMine] = useState(false);
  const [inc, setInc] = useState(initFilter?.inc ?? false);
  const [location, setLocation] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showLog, setShowLog] = useState(false);

  // BE filteri: status/deadline/mine/q/archived. Lokacija i „inc" filtriramo klijentski
  // (opcije lokacije moraju ostati stabilne, „inc" nema BE parametar). pageSize=500 → prioritet-sort nad celim skupom.
  const machines = useMachines({ q, status: status ?? undefined, deadline: deadline ?? undefined, mine, archived, pageSize: 500 });
  const dash = useDashboard();
  const dueQ = useTasksDue();

  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const baseRows = machines.data?.data ?? [];

  // Per-code obogaćenje: otvoreni kvarovi / kasne kontrole / override (dashboard status view) + sledeći rok (due view).
  const statusByCode = useMemo(() => {
    const m = new Map<string, { openInc: number; overdue: number; override: string | null }>();
    for (const r of (dash.data?.data.machineStatus ?? []) as ViewRow[]) {
      const code = f(r, 'machine_code');
      if (code) m.set(code, { openInc: fnum(r, 'open_incidents_count') ?? 0, overdue: fnum(r, 'overdue_checks_count') ?? 0, override: f(r, 'override_reason') });
    }
    return m;
  }, [dash.data]);
  const nextDueByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of (dueQ.data?.data ?? []) as ViewRow[]) {
      const code = f(r, 'machine_code');
      const due = f(r, 'next_due_at');
      if (code && due && !m.has(code)) m.set(code, due); // view je ASC → prvi hit = najbliži
    }
    return m;
  }, [dueQ.data]);

  const locationOptions = useMemo(() => {
    const s = new Set<string>();
    for (const r of baseRows) if (r.location) s.add(r.location);
    return [...s].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [baseRows]);

  const rows = useMemo(() => {
    const enriched = baseRows
      .filter((r) => (location ? r.location === location : true))
      .filter((r) => (inc ? (statusByCode.get(r.machineCode)?.openInc ?? 0) > 0 : true))
      .map((r) => {
        const ext = statusByCode.get(r.machineCode);
        return {
          row: r,
          openInc: ext?.openInc ?? 0,
          overdue: ext?.overdue ?? 0,
          override: ext?.override ?? null,
          nextDue: nextDueByCode.get(r.machineCode) ?? null,
        };
      });
    enriched.sort((a, b) => {
      const ra = machinePriorityRank({ status: a.row.effectiveStatus, openInc: a.openInc, overdue: a.overdue, nextDueAt: a.nextDue, archived: !!a.row.archivedAt });
      const rb = machinePriorityRank({ status: b.row.effectiveStatus, openInc: b.openInc, overdue: b.overdue, nextDueAt: b.nextDue, archived: !!b.row.archivedAt });
      if (ra !== rb) return ra - rb;
      return a.row.machineCode.localeCompare(b.row.machineCode);
    });
    return enriched;
  }, [baseRows, location, inc, statusByCode, nextDueByCode]);

  type EnrichedRow = (typeof rows)[number];
  const clearFilters = () => { setStatus(null); setDeadline(null); setMine(false); setInc(false); setLocation(''); };
  const anyFilter = status || deadline || mine || inc || location || q;

  const cols: Column<EnrichedRow>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.row.machineCode}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.row.name },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.row.location ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={r.row.effectiveStatus} /> },
    {
      key: 'due',
      header: 'Sledeći rok',
      render: (r) => <span className={cn('text-sm', dueTone(r.nextDue, r.overdue))}>{r.overdue > 0 ? `kasni (${r.overdue})` : relDays(r.nextDue)}</span>,
    },
    {
      key: 'flags',
      header: '',
      render: (r) =>
        r.openInc > 0 && /deo|part/i.test(r.override ?? '') ? <StatusBadge tone="warn" label="Čeka deo" /> : r.row.archivedAt ? <StatusBadge tone="neutral" label="Arhivirana" /> : null,
    },
  ];

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="space-y-2 rounded-panel border border-line bg-surface p-3">
        <div className="flex flex-wrap items-center gap-3">
          <SearchBox value={q} onChange={setQ} placeholder="Šifra, naziv, proizvođač…" />
          {locationOptions.length > 0 && (
            <select value={location} onChange={(e) => setLocation(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">Sve lokacije</option>
              {locationOptions.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          )}
          {anyFilter && <button type="button" onClick={() => { clearFilters(); setQ(''); }} className="text-2xs text-accent hover:underline">Očisti filtere</button>}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-2xs uppercase tracking-wider text-ink-secondary">Status</span>
          {STATUS_CHIPS.map((c) => <Chip key={c.key} active={status === c.key} onClick={() => setStatus(status === c.key ? null : c.key)}>{c.label}</Chip>)}
          <span className="ml-2 text-2xs uppercase tracking-wider text-ink-secondary">Rok</span>
          {DEADLINE_CHIPS.map((c) => <Chip key={c.key} active={deadline === c.key} onClick={() => setDeadline(deadline === c.key ? null : c.key)}>{c.label}</Chip>)}
          <span className="ml-2 text-2xs uppercase tracking-wider text-ink-secondary">Dodela</span>
          <Chip active={mine} onClick={() => setMine(!mine)}>Moje</Chip>
          <Chip active={inc} onClick={() => setInc(!inc)}>Otvoreni kvarovi</Chip>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Arhivirane
          </label>
        </div>
      </div>

      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setShowLog(true)}><History className="h-4 w-4" aria-hidden /> Log brisanja</Button>
          <Button variant="secondary" onClick={() => setImporting(true)}><Upload className="h-4 w-4" aria-hidden /> Uvoz</Button>
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Nova mašina</Button>
        </div>
      )}

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.row.machineCode}
        loading={machines.isLoading}
        onRowActivate={(r) => router.push(`/odrzavanje/masine?code=${encodeURIComponent(r.row.machineCode)}`)}
        empty={tableEmpty(machines.isError, 'Nema mašina', anyFilter ? 'Nijedna mašina ne odgovara filterima.' : 'Nema evidentiranih mašina.')}
      />

      {creating && <CreateMachineDialog canManage={canManage} onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {showLog && <DeletionLogDialog onClose={() => setShowLog(false)} />}
    </div>
  );
}

function dueTone(nextDue: string | null, overdue: number): string {
  if (overdue > 0) return 'text-status-danger';
  if (!nextDue) return 'text-ink-secondary';
  const days = (new Date(nextDue).getTime() - Date.now()) / 86_400_000;
  if (days <= 0) return 'text-status-danger';
  if (days <= 7) return 'text-status-warn';
  return 'text-ink-secondary';
}

function CreateMachineDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const create = useCreateMachine();
  const assignable = useAssignableUsers(canManage);
  const users = assignable.data?.data ?? [];
  const [v, setV] = useState({
    machineCode: '', name: '', type: '', location: '', manufacturer: '', model: '',
    serialNumber: '', yearOfManufacture: '', yearCommissioned: '', powerKw: '', weightKg: '',
    notes: '', responsibleUserId: '',
  });
  const [tracked, setTracked] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));
  const numOrNull = (s: string) => (s.trim() === '' ? null : Number(s));

  function submit() {
    setErr(null);
    if (!v.machineCode.trim()) return setErr('Šifra je obavezna.');
    if (!v.name.trim()) return setErr('Naziv je obavezan.');
    create.mutate(
      {
        machineCode: v.machineCode.trim(), name: v.name.trim(), source: 'manual', tracked,
        type: v.type || null, location: v.location || null, manufacturer: v.manufacturer || null, model: v.model || null,
        serialNumber: v.serialNumber || null, yearOfManufacture: numOrNull(v.yearOfManufacture), yearCommissioned: numOrNull(v.yearCommissioned),
        powerKw: numOrNull(v.powerKw), weightKg: numOrNull(v.weightKg), notes: v.notes || null,
        responsibleUserId: v.responsibleUserId || null,
      },
      { onSuccess: () => { toast('Mašina kreirana'); onClose(); }, onError: (e) => setErr((e as Error).message) },
    );
  }

  return (
    <Dialog open onClose={onClose} title="Nova mašina" size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra" required><Input value={v.machineCode} onChange={set('machineCode')} /></FormField>
          <FormField label="Naziv" required><Input value={v.name} onChange={set('name')} /></FormField>
          <FormField label="Tip"><Input value={v.type} onChange={set('type')} /></FormField>
          <FormField label="Lokacija"><Input value={v.location} onChange={set('location')} /></FormField>
          <FormField label="Proizvođač"><Input value={v.manufacturer} onChange={set('manufacturer')} /></FormField>
          <FormField label="Model"><Input value={v.model} onChange={set('model')} /></FormField>
          <FormField label="Serijski broj"><Input value={v.serialNumber} onChange={set('serialNumber')} /></FormField>
          <FormField label="Odgovoran">
            <select value={v.responsibleUserId} onChange={set('responsibleUserId')} className="h-9 w-full rounded-control border border-line bg-surface px-2 text-sm text-ink">
              <option value="">— niko —</option>
              {users.map((u) => <option key={u.user_id} value={u.user_id}>{u.full_name} ({u.maint_role})</option>)}
            </select>
          </FormField>
          <FormField label="Godina proizvodnje"><Input value={v.yearOfManufacture} onChange={set('yearOfManufacture')} inputMode="numeric" /></FormField>
          <FormField label="Godina puštanja"><Input value={v.yearCommissioned} onChange={set('yearCommissioned')} inputMode="numeric" /></FormField>
          <FormField label="Snaga (kW)"><Input value={v.powerKw} onChange={set('powerKw')} inputMode="decimal" /></FormField>
          <FormField label="Masa (kg)"><Input value={v.weightKg} onChange={set('weightKg')} inputMode="decimal" /></FormField>
        </div>
        <FormField label="Napomena"><Textarea value={v.notes} onChange={set('notes')} rows={2} /></FormField>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} /> Prati se (uključena u preventivu/rokove)
        </label>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [includeNoProc, setIncludeNoProc] = useState(false);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const importable = useImportableMachines(true, includeNoProc);
  const doImport = useImportMachines();
  const all = importable.data?.data ?? [];

  const filtered = useMemo(() => {
    const t = filter.trim().toLowerCase();
    return all
      .map((r) => ({ code: f(r, 'machine_code', 'code', 'sifra') ?? '', name: f(r, 'name', 'naziv') ?? '', noProc: r.no_procedure === true }))
      .filter((r) => r.code && (!t || `${r.code} ${r.name}`.toLowerCase().includes(t)));
  }, [all, filter]);

  const toggle = (code: string) => setSel((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const selectAll = () => setSel(new Set(filtered.map((r) => r.code)));

  return (
    <Dialog
      open
      onClose={onClose}
      title="Uvoz mašina iz BigTehn"
      size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Zatvori</Button><Button disabled={sel.size === 0} loading={doImport.isPending} onClick={() => doImport.mutate({ codes: [...sel] }, { onSuccess: () => { toast(`Uvezeno: ${sel.size}`); onClose(); } })}>Uvezi ({sel.size})</Button></>}
    >
      <div className="space-y-3">
        <p className="text-2xs text-ink-secondary">Prikazuju se samo šifre kojih još nema u katalogu. Pomoćne operacije (no_procedure) skrivene su po defaultu.</p>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={includeNoProc} onChange={(e) => { setIncludeNoProc(e.target.checked); setSel(new Set()); }} />
          Prikaži i pomoćne operacije (Kontrola, Kooperacija…)
        </label>
        <div className="flex flex-wrap gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter (šifra ili naziv)…" className="flex-1" />
          <Button variant="secondary" onClick={selectAll} disabled={filtered.length === 0}>Selektuj sve prikazane</Button>
          <Button variant="secondary" onClick={() => setSel(new Set())} disabled={sel.size === 0}>Poništi</Button>
        </div>
        {importable.isLoading ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-secondary">Nema kandidata (sve je već uvezeno ili filter ne odgovara).</p>
        ) : (
          <div className="max-h-96 space-y-1 overflow-auto rounded-control border border-line p-2">
            {filtered.map((r) => (
              <label key={r.code} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={sel.has(r.code)} onChange={() => toggle(r.code)} />
                <span className="tnums font-medium text-ink">{r.code}</span>
                <span className="text-ink-secondary">{r.name}</span>
                {r.noProc && <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary" title="U BigTehn-u označena kao pomoćna operacija">no_procedure</span>}
              </label>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function DeletionLogDialog({ onClose }: { onClose: () => void }) {
  const log = useDeletionLog(true);
  const rows = log.data?.data ?? [];
  return (
    <Dialog open onClose={onClose} title="Log trajnog brisanja mašina" size="lg">
      {log.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema zapisa.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const counts = Object.entries(r.relatedCounts ?? {}).filter(([, v]) => Number(v) > 0);
            const snap = (r.snapshot ?? {}) as Record<string, unknown>;
            const snapBits = ['name', 'type', 'manufacturer', 'model', 'location', 'serial_number']
              .map((k) => snap[k]).filter((v) => v != null && v !== '');
            return (
              <div key={r.id} className="rounded-control border border-line p-2.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="tnums font-medium text-ink">{r.machineCode}</span>
                  <span className="text-2xs text-ink-secondary">{formatDateTime(r.deletedAt)}</span>
                </div>
                <p className="text-ink-secondary">{r.machineName ?? ''}</p>
                {snapBits.length > 0 && <p className="mt-0.5 text-2xs text-ink-secondary">{snapBits.join(' · ')}</p>}
                {counts.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {counts.map(([k, v]) => <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">{k}: {v}</span>)}
                  </div>
                )}
                <p className="mt-1 text-xs text-ink-secondary">Razlog: {r.reason} · {r.deletedByEmail ?? '—'}</p>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
