'use client';

import { useState } from 'react';
import { Plus, Upload, History } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Input, FormField } from '@/components/ui-kit/form-field';
import { formatDateTime } from '@/lib/format';
import {
  useCreateMachine,
  useDeletionLog,
  useImportableMachines,
  useImportMachines,
  useMachines,
  type MachineRow,
  type MaintMe,
} from '@/api/odrzavanje';
import { f, OpStatusBadge, tableEmpty } from './common';
import { MasinaCardDialog } from './masina-card-dialog';

/** Mašine (registar + katalog): CRUD, arhiva toggle, uvoz iz BigTehn, deletion log, karton. */
export function MasineTab({ me }: { me: MaintMe | undefined }) {
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const machines = useMachines({ q, archived, page, pageSize: 40 });
  const rows = machines.data?.data ?? [];
  const meta = machines.data?.meta.pagination;
  const canManage = me?.gates.canManageMaintCatalog ?? false;

  const cols: Column<MachineRow>[] = [
    { key: 'code', header: 'Šifra', render: (r) => <span className="tnums font-medium">{r.machineCode}</span> },
    { key: 'name', header: 'Naziv', render: (r) => r.name },
    { key: 'type', header: 'Tip', render: (r) => <span className="text-ink-secondary">{r.type ?? '—'}</span> },
    { key: 'mfg', header: 'Proizvođač / model', render: (r) => <span className="text-ink-secondary">{[r.manufacturer, r.model].filter(Boolean).join(' / ') || '—'}</span> },
    { key: 'loc', header: 'Lokacija', render: (r) => <span className="text-ink-secondary">{r.location ?? '—'}</span> },
    { key: 'status', header: 'Status', render: (r) => <OpStatusBadge status={r.effectiveStatus} /> },
    {
      key: 'tracked',
      header: 'Praćenje',
      render: (r) => (r.archivedAt ? <StatusBadge tone="neutral" label="Arhivirana" /> : r.tracked ? <StatusBadge tone="success" label="Prati se" /> : <StatusBadge tone="neutral" label="Ne prati se" />),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Šifra, naziv, proizvođač…" />
        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={archived} onChange={(e) => { setArchived(e.target.checked); setPage(1); }} />
          Prikaži arhivirane
        </label>
        {canManage && (
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setShowLog(true)}><History className="h-4 w-4" aria-hidden /> Log brisanja</Button>
            <Button variant="secondary" onClick={() => setImporting(true)}><Upload className="h-4 w-4" aria-hidden /> Uvoz</Button>
            <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden /> Nova mašina</Button>
          </div>
        )}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.machineCode}
        loading={machines.isLoading}
        onRowActivate={(r) => setOpenCode(r.machineCode)}
        empty={tableEmpty(machines.isError, 'Nema mašina', 'Nijedna mašina ne odgovara pretrazi.')}
      />
      {meta && meta.totalPages > 1 && (
        <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
      )}

      <MasinaCardDialog code={openCode} me={me} onClose={() => setOpenCode(null)} />
      {creating && <CreateMachineDialog onClose={() => setCreating(false)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {showLog && <DeletionLogDialog onClose={() => setShowLog(false)} />}
    </div>
  );
}

function CreateMachineDialog({ onClose }: { onClose: () => void }) {
  const [machineCode, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [manufacturer, setMfg] = useState('');
  const [model, setModel] = useState('');
  const [location, setLoc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const create = useCreateMachine();

  function submit() {
    setErr(null);
    if (!machineCode.trim()) return setErr('Šifra je obavezna.');
    if (!name.trim()) return setErr('Naziv je obavezan.');
    create.mutate(
      { machineCode: machineCode.trim(), name: name.trim(), type: type || undefined, manufacturer: manufacturer || undefined, model: model || undefined, location: location || undefined, source: 'manual' },
      { onSuccess: onClose, onError: (e) => setErr((e as Error).message) },
    );
  }

  return (
    <Dialog open onClose={onClose} title="Nova mašina" footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button onClick={submit} loading={create.isPending}>Sačuvaj</Button></>}>
      <div className="space-y-3">
        {err && <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">{err}</p>}
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Šifra" required><Input value={machineCode} onChange={(e) => setCode(e.target.value)} /></FormField>
          <FormField label="Naziv" required><Input value={name} onChange={(e) => setName(e.target.value)} /></FormField>
          <FormField label="Tip"><Input value={type} onChange={(e) => setType(e.target.value)} /></FormField>
          <FormField label="Lokacija"><Input value={location} onChange={(e) => setLoc(e.target.value)} /></FormField>
          <FormField label="Proizvođač"><Input value={manufacturer} onChange={(e) => setMfg(e.target.value)} /></FormField>
          <FormField label="Model"><Input value={model} onChange={(e) => setModel(e.target.value)} /></FormField>
        </div>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const importable = useImportableMachines(true);
  const doImport = useImportMachines();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const rows = importable.data?.data ?? [];

  function toggle(code: string) {
    setSel((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code); else n.add(code);
      return n;
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Uvoz mašina iz BigTehn"
      footer={<><Button variant="ghost" onClick={onClose}>Otkaži</Button><Button disabled={sel.size === 0} loading={doImport.isPending} onClick={() => doImport.mutate({ codes: [...sel] }, { onSuccess: onClose })}>Uvezi ({sel.size})</Button></>}
    >
      {importable.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema kandidata za uvoz.</p>
      ) : (
        <div className="max-h-96 space-y-1 overflow-auto">
          {rows.map((r, i) => {
            const code = f(r, 'machine_code', 'code', 'sifra') ?? String(i);
            const name = f(r, 'name', 'naziv') ?? '';
            return (
              <label key={code} className="flex cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={sel.has(code)} onChange={() => toggle(code)} />
                <span className="tnums font-medium text-ink">{code}</span>
                <span className="text-ink-secondary">{name}</span>
              </label>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

function DeletionLogDialog({ onClose }: { onClose: () => void }) {
  const log = useDeletionLog(true);
  const rows = log.data?.data ?? [];
  return (
    <Dialog open onClose={onClose} title="Log trajnog brisanja mašina">
      {log.isLoading ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-secondary">Nema zapisa.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-control border border-line p-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="tnums font-medium text-ink">{r.machineCode}</span>
                <span className="text-2xs text-ink-secondary">{formatDateTime(r.deletedAt)}</span>
              </div>
              <p className="text-ink-secondary">{r.machineName ?? ''}</p>
              <p className="mt-1 text-xs text-ink-secondary">Razlog: {r.reason} · {r.deletedByEmail ?? '—'}</p>
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
