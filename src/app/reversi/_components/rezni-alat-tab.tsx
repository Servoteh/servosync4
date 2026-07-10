'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatNumber } from '@/lib/format';
import {
  newClientEventId,
  useCreateCuttingTool,
  useCuttingTools,
  useSeedCuttingStock,
  type CuttingTool,
} from '@/api/reversi';
import { CuttingIssueDialog } from './cutting-issue-dialog';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Rezni alat — katalog + Nova šifra + Zaliha (seed) + Izdaj na mašinu (paritet 1.0 reznialat). */
export function RezniAlatTab() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [seedFor, setSeedFor] = useState<CuttingTool | null>(null);
  const [issueFor, setIssueFor] = useState<CuttingTool | null>(null);
  const catalog = useCuttingTools(q);

  const cols: Column<CuttingTool>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'barcode', header: 'Barkod', render: (r) => <span className="tnums text-ink-secondary">{r.barcode ?? '—'}</span> },
    {
      key: 'stock',
      header: 'Na stanju',
      align: 'right',
      numeric: true,
      render: (r) => {
        const low = r.minStockQty > 0 && r.onHandQty < r.minStockQty;
        return <span className={low ? 'font-semibold text-status-danger' : undefined}>{formatNumber(r.onHandQty)} {r.unit}</span>;
      },
    },
    { key: 'mach', header: 'Mašine', render: (r) => <span className="text-ink-secondary">{r.compatibleMachineCodes.join(', ') || '—'}</span> },
    ...(manage
      ? [{
          key: 'akcije',
          header: '',
          render: (r: CuttingTool) => (
            <div className="flex justify-end gap-1">
              <button type="button" className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setSeedFor(r); }}>Zaliha</button>
              <button type="button" className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2" onClick={(e) => { e.stopPropagation(); setIssueFor(r); }}>Izdaj</button>
            </div>
          ),
        }]
      : []),
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, barkod…" />
        </div>
        {manage && <Button onClick={() => setCreateOpen(true)}>+ Nova šifra</Button>}
      </div>

      <DataTable
        columns={cols}
        rows={catalog.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={catalog.isLoading}
        empty={<EmptyState title="Katalog reznog alata je prazan" hint={'Dodaj šifru dugmetom „Nova šifra“.'} />}
      />

      {manage && createOpen && <CreateCuttingDialog onClose={() => setCreateOpen(false)} />}
      {manage && seedFor && <SeedDialog tool={seedFor} onClose={() => setSeedFor(null)} />}
      {manage && issueFor && <CuttingIssueDialog tool={issueFor} onClose={() => setIssueFor(null)} />}
    </div>
  );
}

function CreateCuttingDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCuttingTool();
  const [oznaka, setOznaka] = useState('');
  const [naziv, setNaziv] = useState('');
  const [unit, setUnit] = useState('kom');
  const [minStock, setMinStock] = useState(0);
  const [machines, setMachines] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!oznaka.trim() || !naziv.trim()) return setError('Oznaka i naziv su obavezni.');
    try {
      await create.mutateAsync({
        oznaka: oznaka.trim(),
        naziv: naziv.trim(),
        unit: unit.trim() || 'kom',
        minStockQty: minStock || 0,
        compatibleMachineCodes: machines.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kreiranje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Nova šifra reznog alata"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={create.isPending} onClick={() => void submit()}>Sačuvaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka" required><input className={INPUT} value={oznaka} onChange={(e) => setOznaka(e.target.value)} /></FormField>
          <FormField label="Jedinica"><input className={INPUT} value={unit} onChange={(e) => setUnit(e.target.value)} /></FormField>
        </div>
        <FormField label="Naziv" required><input className={INPUT} value={naziv} onChange={(e) => setNaziv(e.target.value)} /></FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min. zaliha"><input className={INPUT} type="number" min={0} value={minStock} onChange={(e) => setMinStock(Number(e.target.value) || 0)} /></FormField>
          <FormField label="Mašine (šifre, zarezom)"><input className={INPUT} value={machines} onChange={(e) => setMachines(e.target.value)} placeholder="npr. M12, M15" /></FormField>
        </div>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function SeedDialog({ tool, onClose }: { tool: CuttingTool; onClose: () => void }) {
  const seed = useSeedCuttingStock();
  const [qty, setQty] = useState(1);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await seed.mutateAsync({ clientEventId: newClientEventId(), catalogId: tool.id, locationId: '', qty });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dopuna nije uspela.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Zaliha — ${tool.oznaka}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={seed.isPending} onClick={() => void submit()}>Dodaj u magacin</Button>
        </div>
      }
    >
      <div className="space-y-2">
        <FormField label="Količina (dodaj u magacin ALAT-MAG-01)">
          <input className={`${INPUT} w-32`} type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
