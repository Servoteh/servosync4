'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
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
import { cn } from '@/lib/cn';
import { tableEmpty } from './common';
import { CuttingIssueDialog } from './cutting-issue-dialog';
import { CuttingReturnDialog } from './cutting-return-dialog';
import { RezniMapaView } from './rezni-mapa-view';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

type RezniSubview = 'katalog' | 'mapa';

/**
 * Semafor kolone „Ukupno" — IDENTIČAN 1.0 `ukupnoClass` (reznialat.js:109-116):
 * ukupno===0 → crveno (danger); min>0 && u magacinu<min → žuto (warn); inače zeleno (ok).
 * VAŽNO: warn ide protiv `inWarehouseQty` (magacinski), NE protiv `onHandQty`.
 */
function totalTone(r: CuttingTool): string {
  if (r.onHandQty === 0) return 'text-status-danger';
  if (r.minStockQty > 0 && r.inWarehouseQty < r.minStockQty) return 'text-status-warn';
  return 'text-status-success';
}

/** Rezni alat — katalog + Nova šifra + Zaliha (seed) + Izdaj na mašinu (paritet 1.0 reznialat). */
export function RezniAlatTab() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const [subview, setSubview] = useState<RezniSubview>('katalog');
  const [q, setQ] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [seedFor, setSeedFor] = useState<CuttingTool | null>(null);
  const [issueFor, setIssueFor] = useState<CuttingTool | null>(null);
  const catalog = useCuttingTools(q);

  const cols: Column<CuttingTool>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'barcode', header: 'Barkod', render: (r) => <span className="tnums text-ink-secondary">{r.barcode ?? '—'}</span> },
    {
      key: 'inWarehouse',
      header: 'U magacinu',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span>{formatNumber(r.inWarehouseQty)} <span className="text-ink-secondary">{r.unit}</span></span>
      ),
    },
    {
      key: 'onMachines',
      header: 'Na mašinama',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className={r.onMachinesQty > 0 ? undefined : 'text-ink-secondary'}>{formatNumber(r.onMachinesQty)}</span>
      ),
    },
    {
      key: 'total',
      header: 'Ukupno (min)',
      align: 'right',
      numeric: true,
      render: (r) => (
        <div className="flex flex-col items-end leading-tight">
          <span className={`font-semibold ${totalTone(r)}`}>
            {formatNumber(r.onHandQty)} <span className="font-normal text-ink-secondary">{r.unit}</span>
          </span>
          {r.minStockQty > 0 && (
            <span className="text-2xs text-ink-secondary">min. {formatNumber(r.minStockQty)}</span>
          )}
        </div>
      ),
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
    <div className="space-y-4">
      {/* Pod-tabovi „Katalog" ⇄ „Mapa" (paritet 1.0 reznialat: katalog + grafička Mapa). */}
      <div role="tablist" aria-label="Rezni alat" className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
        {(['katalog', 'mapa'] as RezniSubview[]).map((s) => {
          const active = s === subview;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSubview(s)}
              className={cn(
                'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
                active ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
              )}
            >
              {s === 'katalog' ? 'Katalog' : 'Mapa'}
            </button>
          );
        })}
      </div>

      {subview === 'mapa' ? (
        <RezniMapaView />
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, barkod…" />
            </div>
            {/* Povraćaj NIJE role-gated (paritet 1.0): operater vraća svoj alat — svako sa reversi.read. */}
            <Button variant="secondary" onClick={() => setReturnOpen(true)}>↩ Povraćaj</Button>
            {manage && <Button onClick={() => setCreateOpen(true)}>+ Nova šifra</Button>}
          </div>

          <DataTable
            columns={cols}
            rows={catalog.data?.data ?? []}
            rowKey={(r) => r.id}
            loading={catalog.isLoading}
            empty={tableEmpty(
              catalog.isError,
              'Katalog reznog alata je prazan',
              manage ? 'Dodaj šifru dugmetom „Nova šifra“.' : 'Nema unetog reznog alata.',
            )}
          />
        </div>
      )}

      {returnOpen && <CuttingReturnDialog onClose={() => setReturnOpen(false)} />}
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
      await seed.mutateAsync({ clientEventId: newClientEventId(), catalogId: tool.id, qty });
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
