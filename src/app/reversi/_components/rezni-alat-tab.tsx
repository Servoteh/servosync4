'use client';

import { useEffect, useMemo, useState } from 'react';
import { Eye, Pencil, Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { downloadCsv } from '@/lib/reversi-csv';
import type { ReversiLabelRow } from '@/lib/reversi-labels';
import {
  newClientEventId,
  useCreateCuttingTool,
  useCuttingCatalog,
  useCuttingToolDetail,
  useReversiLocations,
  useReversiMachines,
  useSeedCuttingStock,
  useUpdateCuttingTool,
  type CuttingTool,
} from '@/api/reversi';
import { tableEmpty } from './common';
import { Tabs, type TabItem } from './tabs';
import { CuttingIssueDialog } from './cutting-issue-dialog';
import { CuttingReturnDialog } from './cutting-return-dialog';
import { RezniMapaView } from './rezni-mapa-view';
import { InventoryGroupsDialog } from './inventory-groups-dialog';
import { BulkPrintLabelsDialog } from './bulk-print-labels-dialog';
import { CuttingIssueScannerDialog } from './cutting-issue-scanner-dialog';
import { RezniByMachineView } from './rezni-by-machine-view';
import { RezniByEmployeeView } from './rezni-by-employee-view';
import { BulkImportDialog } from './bulk-import-dialog';
import { ImportRollbackDialog } from './import-rollback-dialog';
import { RezniAlatIcon } from './rezni-icon';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** „Učitaj još" korak (RC-13) — klijentski isečak; 1.0 PAGE=25. */
const PAGE = 25;
/** Katalog se povlači u JEDNOM pozivu (RC-14 CSV ceo skup, RC-02 stat kartice iz liste). */
const CATALOG_CAP = 15000;
/** ALAT-MAG-01 — podrazumevani magacin za početno stanje (RC-23). */
const DEFAULT_WAREHOUSE_CODE = 'ALAT-MAG-01';

type RezniSubview = 'mapa' | 'katalog' | 'masine' | 'zaposleni';

/** Šifra reznog → red za štampu nalepnice (RC-15/RC-26). Deljeno sa deo-B pod-tabovima. */
export function cuttingToolToLabelRow(t: CuttingTool): ReversiLabelRow {
  // grupa CUTTING → composeTspl bira rezni TSPL2 layout (RC-61/RC-62).
  return {
    barcode: t.barcode ?? '',
    oznaka: t.oznaka,
    naziv: t.naziv,
    grupa: 'CUTTING',
    compatibleMachineCodes: t.compatibleMachineCodes,
  };
}

/**
 * Semafor kolone „Ukupno" — IDENTIČAN 1.0 `ukupnoClass` (reznialat.js:109-116):
 * ukupno===0 → crveno; min>0 && u magacinu<min → žuto; inače zeleno.
 * VAŽNO: warn ide protiv `inWarehouseQty` (magacinski), NE protiv `onHandQty`.
 */
function totalTone(r: CuttingTool): string {
  if (r.onHandQty === 0) return 'text-status-danger';
  if (r.minStockQty > 0 && r.inWarehouseQty < r.minStockQty) return 'text-status-warn';
  return 'text-status-success';
}

/** Status pill (RC-08) — Aktivna (zeleno) / Povučena (neutralno). */
function StatusPill({ status }: { status: string }) {
  return status === 'scrapped' ? (
    <StatusBadge tone="neutral" label="Povučena" />
  ) : (
    <StatusBadge tone="success" label="Aktivna" />
  );
}

/**
 * Rezni alat — tab sa 4 pod-taba (RC-01, paritet 1.0 reznialat SUB_TABS):
 * Pregled (grafička mapa), Katalog (šifre), Po mašinama, Po zaposlenima. Podrazumevan
 * pod-tab = Katalog (1.0 `ssGet(SUB_TAB_KEY,'katalog')`).
 */
const SUB_TAB_KEY = 'reversi:rezniSubTab';

/** RC-01 — restauracija poslednjeg pod-taba (paritet 1.0 ssGet(SUB_TAB_KEY)). */
function readSubTab(): RezniSubview {
  if (typeof window === 'undefined') return 'katalog';
  const s = window.sessionStorage.getItem(SUB_TAB_KEY);
  return s === 'mapa' || s === 'katalog' || s === 'masine' || s === 'zaposleni' ? s : 'katalog';
}

export function RezniAlatTab() {
  const [subview, setSubviewState] = useState<RezniSubview>(readSubTab);

  /** RC-01 — aktivni pod-tab se pamti u sessionStorage. */
  function setSubview(v: RezniSubview) {
    setSubviewState(v);
    if (typeof window !== 'undefined') window.sessionStorage.setItem(SUB_TAB_KEY, v);
  }

  const subTabs: TabItem<RezniSubview>[] = [
    { key: 'mapa', label: 'Pregled' },
    { key: 'katalog', label: 'Katalog' },
    { key: 'masine', label: 'Po mašinama' },
    { key: 'zaposleni', label: 'Po zaposlenima' },
  ];

  return (
    <div className="space-y-4">
      {/* RB-61 — dedicirana ikonica reznog (glodalo) + pod-tabovi. */}
      <div className="flex items-center gap-2">
        <RezniAlatIcon className="text-accent" size={18} />
        <span className="text-sm font-semibold text-ink">Rezni alat</span>
      </div>
      <Tabs tabs={subTabs} value={subview} onChange={setSubview} ariaLabel="Rezni alat" />

      {subview === 'mapa' && <RezniMapaView />}
      {subview === 'katalog' && <KatalogSubview />}
      {subview === 'masine' && <RezniByMachineView />}
      {subview === 'zaposleni' && <RezniByEmployeeView />}
    </div>
  );
}

// ------------------------------------------------------------------ Katalog

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'success' | 'warn';
}) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      <div
        className={cn(
          'tnums mt-1 text-2xl font-semibold leading-none',
          tone === 'success' && 'text-status-success',
          tone === 'warn' && 'text-status-warn',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-2xs text-ink-secondary">{hint}</div>}
    </div>
  );
}

function KatalogSubview() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  // Filteri (RC-04 mašina, RC-05 status) + pretraga (debounce 250ms kao 1.0).
  const [q, setQ] = useState('');
  const [qDeb, setQDeb] = useState('');
  const [status, setStatus] = useState<'active' | 'scrapped' | 'all'>('active');
  const [machine, setMachine] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  // Modali/dijalozi.
  const [createOpen, setCreateOpen] = useState(false);
  const [editTool, setEditTool] = useState<CuttingTool | null>(null);
  const [detailTool, setDetailTool] = useState<CuttingTool | null>(null);
  const [seedFor, setSeedFor] = useState<CuttingTool | null>(null);
  const [issueFor, setIssueFor] = useState<CuttingTool | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [bulkPrintRows, setBulkPrintRows] = useState<ReversiLabelRow[] | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Promena filtera → reset isečka + selekcije + expand (paritet 1.0 offset/expanded/selected reset).
  useEffect(() => {
    setShown(PAGE);
    setSelected(new Set());
    setExpanded(null);
  }, [qDeb, status, machine]);

  const machinesQ = useReversiMachines();
  const machineOptions = useMemo(
    () =>
      [...(machinesQ.data?.data ?? [])].sort((a, b) =>
        a.machine_code.localeCompare(b.machine_code, 'sr'),
      ),
    [machinesQ.data],
  );

  const catalog = useCuttingCatalog({ q: qDeb, status, machine, page: 1, pageSize: CATALOG_CAP });
  const all = useMemo(() => catalog.data?.data ?? [], [catalog.data]);
  const total = catalog.data?.meta.pagination.total ?? all.length;
  const rows = useMemo(() => all.slice(0, shown), [all, shown]);

  // 5 stat kartica (RC-02) — iz punog filtriranog skupa (kao 1.0 loadStats).
  const stats = useMemo(() => {
    let sumWh = 0;
    let sumMach = 0;
    let low = 0;
    let active = 0;
    for (const r of all) {
      if (r.status === 'active') active += 1;
      sumWh += r.inWarehouseQty;
      sumMach += r.onMachinesQty;
      if (r.status === 'active' && r.minStockQty > 0 && r.inWarehouseQty < r.minStockQty) low += 1;
    }
    return { active, sumWh, sumMach, low };
  }, [all]);

  const selectedRows = useMemo(
    () => all.filter((r) => selected.has(r.id)),
    [all, selected],
  );
  const allShownSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (rows.every((r) => next.has(r.id))) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function printSelected() {
    const labelRows = selectedRows.filter((r) => r.barcode).map(cuttingToolToLabelRow);
    if (labelRows.length === 0) {
      toast('Označene stavke nemaju barkod');
      return;
    }
    setBulkPrintRows(labelRows);
  }

  function printOne(t: CuttingTool) {
    if (!t.barcode) {
      toast('Nema barkoda za štampu');
      return;
    }
    setBulkPrintRows([cuttingToolToLabelRow(t)]);
  }

  // RC-14 — CSV ceo filtrirani skup (paritet 1.0 exportExcel; BOM+RFC4180 iz reversi-csv).
  function exportCsv() {
    if (all.length === 0) {
      toast('Nema podataka za izvoz');
      return;
    }
    const headers = [
      'Oznaka',
      'Barkod',
      'Naziv',
      'Min. zaliha',
      'U magacinu',
      'Na mašinama',
      'Ukupno',
      'JM',
      'Status',
      'Mašine (ZADU)',
    ];
    const data = all.map((t) => [
      t.oznaka,
      t.barcode ?? '',
      t.naziv,
      t.minStockQty,
      t.inWarehouseQty,
      t.onMachinesQty,
      t.onHandQty,
      t.unit,
      t.status === 'scrapped' ? 'povučena' : 'aktivna',
      t.machineBreakdown.map((b) => `${b.machineCode}:${b.qty}`).join('; '),
    ]);
    downloadCsv(`rezni-alat-${new Date().toISOString().slice(0, 10)}.csv`, headers, data);
    toast(`Eksportovano ${formatNumber(all.length)} redova`);
  }

  const loadingVal = catalog.isLoading ? '—' : undefined;

  const cols: Column<CuttingTool>[] = [
    ...(manage
      ? [
          {
            key: 'sel',
            header: (
              <input
                type="checkbox"
                aria-label="Označi sve"
                checked={allShownSelected}
                onChange={toggleAll}
              />
            ),
            render: (r: CuttingTool) => (
              <input
                type="checkbox"
                aria-label={`Označi ${r.oznaka}`}
                checked={selected.has(r.id)}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggleOne(r.id)}
              />
            ),
          } satisfies Column<CuttingTool>,
        ]
      : []),
    {
      key: 'oznaka',
      header: 'Oznaka',
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium">{r.oznaka}</span>
          <span className="tnums text-2xs text-ink-secondary">{r.barcode ?? '—'}</span>
        </div>
      ),
    },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    {
      key: 'inWarehouse',
      header: 'U magacinu',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span>
          {formatNumber(r.inWarehouseQty)} <span className="text-ink-secondary">{r.unit}</span>
        </span>
      ),
    },
    {
      key: 'onMachines',
      header: 'Na mašinama',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.onMachinesQty > 0 ? (
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 text-sm hover:bg-surface-2',
              expanded === r.id && 'bg-surface-2',
            )}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => (x === r.id ? null : r.id));
            }}
            aria-expanded={expanded === r.id}
            title="Raspored po mašinama"
          >
            <span className="font-medium">{formatNumber(r.onMachinesQty)}</span>
            <span className="text-2xs text-ink-secondary">({r.machineBreakdown.length})</span>
            <span
              className={cn(
                'text-[9px] leading-none text-ink-secondary transition-transform',
                expanded === r.id && 'rotate-180',
              )}
              aria-hidden
            >
              ▾
            </span>
          </button>
        ) : (
          <span className="text-ink-secondary">0</span>
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
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'akcije',
      header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {manage && (
            <>
              <button
                type="button"
                className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setSeedFor(r);
                }}
              >
                Zaliha
              </button>
              <button
                type="button"
                className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setIssueFor(r);
                }}
              >
                Izdaj
              </button>
            </>
          )}
          <IconBtn label="Štampaj nalepnicu" onClick={() => printOne(r)}>
            <Printer className="h-3.5 w-3.5" aria-hidden />
          </IconBtn>
          <IconBtn label="Pregled" onClick={() => setDetailTool(r)}>
            <Eye className="h-3.5 w-3.5" aria-hidden />
          </IconBtn>
          {manage && (
            <IconBtn label="Izmena" onClick={() => setEditTool(r)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </IconBtn>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {/* RC-02 — 5 stat kartica. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Ukupno šifri" value={loadingVal ?? formatNumber(total)} hint="u katalogu" />
        <StatCard
          label="Aktivne"
          value={loadingVal ?? formatNumber(stats.active)}
          hint="dostupne"
          tone="success"
        />
        <StatCard label="Na mašinama" value={loadingVal ?? formatNumber(stats.sumMach)} hint="komada" />
        <StatCard label="U magacinu" value={loadingVal ?? formatNumber(stats.sumWh)} hint="komada" />
        <StatCard
          label="Niska zaliha"
          value={loadingVal ?? formatNumber(stats.low)}
          hint="ispod minimuma"
          tone="warn"
        />
      </div>

      {/* Filteri (RC-04 mašina, RC-05 status) + pretraga. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[220px] flex-1">
          <SearchBox value={q} onChange={setQ} placeholder="Oznaka, naziv, barkod…" />
        </div>
        <select
          className={cn(INPUT, 'w-auto')}
          value={machine}
          onChange={(e) => setMachine(e.target.value)}
          aria-label="Filter po mašini"
        >
          <option value="">— Sve mašine —</option>
          {machineOptions.map((m) => (
            <option key={m.machine_code} value={m.machine_code}>
              {m.machine_code} {m.name}
            </option>
          ))}
        </select>
        <select
          className={cn(INPUT, 'w-auto')}
          value={status}
          onChange={(e) => setStatus(e.target.value as 'active' | 'scrapped' | 'all')}
          aria-label="Filter po statusu"
        >
          <option value="active">Aktivne</option>
          <option value="scrapped">Povučene</option>
          <option value="all">Sve</option>
        </select>
      </div>

      {/* Akcije. */}
      <div className="flex flex-wrap items-center gap-2">
        {manage && (
          <Button variant="secondary" disabled={selected.size === 0} onClick={printSelected}>
            🖨 Štampa odabranih{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        )}
        {/* Povraćaj NIJE role-gated (paritet 1.0): operater vraća svoj alat — svako sa reversi.read. */}
        <Button variant="secondary" onClick={() => setReturnOpen(true)}>
          ↩ Povraćaj
        </Button>
        {manage && (
          <Button variant="secondary" onClick={() => setScannerOpen(true)}>
            🎯 Skenirano zaduženje
          </Button>
        )}
        <span className="flex-1" />
        <Button variant="secondary" onClick={exportCsv}>
          📗 Izvoz CSV
        </Button>
        {manage && (
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            📥 Uvoz reznog
          </Button>
        )}
        {manage && (
          <Button variant="secondary" onClick={() => setRollbackOpen(true)}>
            ↩ Storno uvoza
          </Button>
        )}
        {manage && (
          <Button variant="secondary" onClick={() => setGroupsOpen(true)}>
            📂 Grupe
          </Button>
        )}
        {manage && <Button onClick={() => setCreateOpen(true)}>+ Nova šifra</Button>}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={catalog.isLoading}
        expandedKey={expanded}
        renderExpanded={(r) => (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs uppercase tracking-wider text-ink-secondary">
              Raspored po mašinama:
            </span>
            {r.machineBreakdown.length === 0 ? (
              <span className="text-ink-secondary">—</span>
            ) : (
              r.machineBreakdown.map((b) => (
                <span
                  key={b.machineCode}
                  className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2 py-0.5 text-xs"
                >
                  <span className="tnums font-medium">{b.machineCode || '—'}</span>
                  <span className="text-ink-secondary">{formatNumber(b.qty)} kom</span>
                </span>
              ))
            )}
          </div>
        )}
        empty={tableEmpty(
          catalog.isError,
          'Nema šifri koje odgovaraju filteru',
          manage ? 'Dodaj šifru dugmetom „Nova šifra".' : 'Nema unetog reznog alata.',
        )}
      />

      {/* RC-13 — „Učitaj još" (klijentski isečak). */}
      <div className="flex items-center justify-between text-xs text-ink-secondary">
        <span>
          <strong className="tnums text-ink">{formatNumber(rows.length)}</strong> šifri prikazano
          {total > rows.length && <> · ukupno {formatNumber(total)}</>}
          {selected.size > 0 && <> · {formatNumber(selected.size)} odabrano</>}
        </span>
        {rows.length < all.length && (
          <Button variant="secondary" onClick={() => setShown((s) => s + PAGE)}>
            Učitaj još
          </Button>
        )}
      </div>

      {returnOpen && <CuttingReturnDialog onClose={() => setReturnOpen(false)} />}
      {detailTool && <CuttingDetailDialog tool={detailTool} onClose={() => setDetailTool(null)} />}
      {manage && createOpen && (
        <CuttingToolDialog onClose={() => setCreateOpen(false)} />
      )}
      {manage && editTool && (
        <CuttingToolDialog tool={editTool} onClose={() => setEditTool(null)} />
      )}
      {manage && seedFor && <SeedDialog tool={seedFor} onClose={() => setSeedFor(null)} />}
      {manage && issueFor && <CuttingIssueDialog tool={issueFor} onClose={() => setIssueFor(null)} />}
      {manage && <InventoryGroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} />}
      {scannerOpen && <CuttingIssueScannerDialog open onClose={() => setScannerOpen(false)} />}
      {manage && (
        <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} initialType="cutting" />
      )}
      {manage && <ImportRollbackDialog open={rollbackOpen} onClose={() => setRollbackOpen(false)} />}
      {manage && (
        <BulkPrintLabelsDialog
          open={!!bulkPrintRows}
          rows={bulkPrintRows ?? []}
          onClose={() => {
            setBulkPrintRows(null);
            setSelected(new Set());
          }}
        />
      )}
      {/* Pregled/štampa jedne nalepnice su dostupni i bez manage — isti dijalog, van manage-gate. */}
      {!manage && (
        <BulkPrintLabelsDialog
          open={!!bulkPrintRows}
          rows={bulkPrintRows ?? []}
          onClose={() => setBulkPrintRows(null)}
        />
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-control border border-line text-ink-secondary hover:bg-surface-2 hover:text-ink"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ modali

/**
 * Nova / izmena šifre reznog alata (RC-21) + autocomplete kompatibilnih mašina (RC-22)
 * + početno stanje u magacinu pri novoj šifri (RC-23). Paritet 1.0
 * `openAddCuttingToolModal`. Oznaka je nepromenljiva na izmeni (BE zaključava).
 */
function CuttingToolDialog({ tool, onClose }: { tool?: CuttingTool; onClose: () => void }) {
  const editing = !!tool;
  const create = useCreateCuttingTool();
  const update = useUpdateCuttingTool();
  const seed = useSeedCuttingStock();

  const [oznaka, setOznaka] = useState(tool?.oznaka ?? '');
  const [naziv, setNaziv] = useState(tool?.naziv ?? '');
  const [unit, setUnit] = useState(tool?.unit ?? 'kom');
  const [minStock, setMinStock] = useState(tool?.minStockQty ?? 0);
  const [napomena, setNapomena] = useState(tool?.napomena ?? '');
  const [codes, setCodes] = useState<string[]>(tool?.compatibleMachineCodes ?? []);
  const [mSearch, setMSearch] = useState('');
  // Početno stanje (samo NEW).
  const [initQty, setInitQty] = useState(0);
  const [initLoc, setInitLoc] = useState('');
  const [error, setError] = useState<string | null>(null);

  const machinesQ = useReversiMachines();
  const locationsQ = useReversiLocations();

  const machineMatches = useMemo(() => {
    const term = mSearch.trim().toLowerCase();
    return (machinesQ.data?.data ?? [])
      .filter(
        (m) =>
          !codes.includes(m.machine_code) &&
          (term === '' || `${m.machine_code} ${m.name ?? ''}`.toLowerCase().includes(term)),
      )
      .slice(0, 12);
  }, [machinesQ.data, codes, mSearch]);

  // Podrazumevana lokacija početnog stanja = ALAT-MAG-01 (RC-23).
  useEffect(() => {
    if (editing || initLoc) return;
    const mag = (locationsQ.data?.data ?? []).find((l) => l.location_code === DEFAULT_WAREHOUSE_CODE);
    if (mag) setInitLoc(mag.id);
  }, [editing, initLoc, locationsQ.data]);

  const busy = create.isPending || update.isPending || seed.isPending;

  async function submit() {
    setError(null);
    const oz = oznaka.trim();
    const nz = naziv.trim();
    if (!oz || !nz) return setError('Oznaka i naziv su obavezni.');
    try {
      if (editing && tool) {
        await update.mutateAsync({
          id: tool.id,
          patch: {
            naziv: nz,
            unit: unit.trim() || 'kom',
            minStockQty: minStock || 0,
            compatibleMachineCodes: codes,
            napomena: napomena.trim() || null,
          },
        });
      } else {
        const res = await create.mutateAsync({
          oznaka: oz,
          naziv: nz,
          unit: unit.trim() || 'kom',
          minStockQty: minStock || 0,
          compatibleMachineCodes: codes,
          napomena: napomena.trim() || undefined,
        });
        const qty = Math.max(0, Math.floor(initQty));
        if (qty > 0 && initLoc && res.data?.id) {
          try {
            await seed.mutateAsync({
              clientEventId: newClientEventId(),
              catalogId: res.data.id,
              locationId: initLoc,
              qty,
            });
          } catch (seedErr) {
            // RC-23 — šifra JE kreirana; ne ostavljaj dijalog otvoren (ponovni Sačuvaj → unique violation).
            toast(
              `Šifra „${oz}" dodata, ali početno stanje nije upisano (${
                seedErr instanceof Error ? seedErr.message : 'greška'
              }). Dodaj zalihu ručno.`,
            );
            onClose();
            return;
          }
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Čuvanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Izmena šifre reznog alata' : 'Nova šifra reznog alata'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {editing ? 'Sačuvaj izmene' : 'Sačuvaj'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Oznaka (interni naziv)" required>
            <input
              className={cn(INPUT, editing && 'opacity-60')}
              value={oznaka}
              disabled={editing}
              onChange={(e) => setOznaka(e.target.value)}
              placeholder="npr. GL-D12-HSS"
            />
          </FormField>
          <FormField label="Jedinica">
            <select className={INPUT} value={unit} onChange={(e) => setUnit(e.target.value)}>
              {['kom', 'set', 'pak'].map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Naziv / opis" required>
          <input
            className={INPUT}
            value={naziv}
            onChange={(e) => setNaziv(e.target.value)}
            placeholder="npr. Glodalo HSS Ø12 4-zubo"
          />
        </FormField>

        {/* RC-22 — kompatibilne mašine: čipovi + autocomplete iz v_rev_machines. */}
        <FormField label="Kompatibilne mašine">
          <div className="space-y-1.5">
            <div className="flex flex-wrap gap-1.5">
              {codes.length === 0 ? (
                <span className="text-xs text-ink-secondary">— bez ograničenja —</span>
              ) : (
                codes.map((c) => (
                  <span
                    key={c}
                    className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 px-2 py-0.5 text-xs"
                  >
                    <span className="tnums font-medium">{c}</span>
                    <button
                      type="button"
                      aria-label={`Ukloni ${c}`}
                      className="text-ink-secondary hover:text-status-danger"
                      onClick={() => setCodes((xs) => xs.filter((x) => x !== c))}
                    >
                      ×
                    </button>
                  </span>
                ))
              )}
            </div>
            <input
              className={INPUT}
              value={mSearch}
              onChange={(e) => setMSearch(e.target.value)}
              placeholder="Šifra ili naziv mašine…"
            />
            {mSearch.trim() && (
              <div className="max-h-40 overflow-auto rounded-control border border-line">
                {machineMatches.length === 0 ? (
                  <div className="px-2.5 py-1.5 text-xs text-ink-secondary">Nema mašine.</div>
                ) : (
                  machineMatches.map((m) => (
                    <button
                      key={m.machine_code}
                      type="button"
                      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                      onClick={() => {
                        setCodes((xs) => (xs.includes(m.machine_code) ? xs : [...xs, m.machine_code]));
                        setMSearch('');
                      }}
                    >
                      <span className="tnums font-medium">{m.machine_code}</span>
                      <span className="text-ink-secondary">{m.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Min. zaliha (upozorenje)">
            <input
              className={INPUT}
              type="number"
              min={0}
              value={minStock}
              onChange={(e) => setMinStock(Math.max(0, Number(e.target.value) || 0))}
            />
          </FormField>
          <FormField label="Napomena">
            <input className={INPUT} value={napomena} onChange={(e) => setNapomena(e.target.value)} />
          </FormField>
        </div>

        {/* RC-23 — početno stanje (samo NEW). */}
        {!editing && (
          <fieldset className="rounded-panel border border-line p-3">
            <legend className="px-1 text-2xs uppercase tracking-wider text-ink-secondary">
              Početno stanje (opciono)
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Količina">
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={initQty}
                  onChange={(e) => setInitQty(Math.max(0, Number(e.target.value) || 0))}
                />
              </FormField>
              <FormField label="Lokacija">
                <select className={INPUT} value={initLoc} onChange={(e) => setInitLoc(e.target.value)}>
                  <option value="">— izaberi —</option>
                  {(locationsQ.data?.data ?? []).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.location_code} {l.name ?? ''}
                    </option>
                  ))}
                </select>
              </FormField>
            </div>
            <p className="mt-1 text-2xs text-ink-secondary">
              Ako uneseš količinu, biće odmah upisana u stanje na izabranoj lokaciji (default:
              {' '}
              {DEFAULT_WAREHOUSE_CODE}).
            </p>
          </fieldset>
        )}

        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

/** Detalj šifre + stanje po lokacijama (RC-25) — paritet 1.0 `openCuttingToolDetailsModal`. */
function CuttingDetailDialog({ tool, onClose }: { tool: CuttingTool; onClose: () => void }) {
  const detail = useCuttingToolDetail(tool.id);
  const stock = detail.data?.data.stock ?? [];

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Šifra reznog alata: ${tool.oznaka}`}
      size="lg"
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-ink-secondary">Barkod</dt>
          <dd className="tnums">{tool.barcode ?? '—'}</dd>
          <dt className="text-ink-secondary">Naziv</dt>
          <dd>{tool.naziv}</dd>
          <dt className="text-ink-secondary">Jedinica</dt>
          <dd>{tool.unit}</dd>
          <dt className="text-ink-secondary">Kompatibilne mašine</dt>
          <dd>
            {tool.compatibleMachineCodes.length > 0 ? (
              tool.compatibleMachineCodes.join(', ')
            ) : (
              <span className="text-ink-secondary">bez ograničenja</span>
            )}
          </dd>
          <dt className="text-ink-secondary">Status</dt>
          <dd>
            <StatusPill status={tool.status} />
          </dd>
          {tool.napomena && (
            <>
              <dt className="text-ink-secondary">Napomena</dt>
              <dd>{tool.napomena}</dd>
            </>
          )}
        </dl>

        <div>
          <h3 className="mb-1.5 text-sm font-semibold">Stanje po lokacijama</h3>
          {detail.isLoading ? (
            <p className="text-sm text-ink-secondary">Učitavam stanje…</p>
          ) : detail.isError ? (
            <p className="text-sm text-status-danger">Greška pri učitavanju stanja.</p>
          ) : stock.length === 0 ? (
            <p className="text-sm text-ink-secondary">Nema balansa ni na jednoj lokaciji.</p>
          ) : (
            <div className="overflow-x-auto rounded-panel border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                    <th className="px-3 py-1.5 font-semibold">Lokacija</th>
                    <th className="px-3 py-1.5 font-semibold">Tip</th>
                    <th className="px-3 py-1.5 text-right font-semibold">Količina</th>
                  </tr>
                </thead>
                <tbody>
                  {stock.map((s) => (
                    <tr key={s.location_id} className="border-b border-line-soft">
                      <td className="px-3 py-1.5">
                        <span className="tnums font-medium">{s.location_code}</span>{' '}
                        <span className="text-ink-secondary">{s.name ?? ''}</span>
                      </td>
                      <td className="px-3 py-1.5 text-ink-secondary">{s.location_type ?? ''}</td>
                      <td className="tnums px-3 py-1.5 text-right">{formatNumber(s.on_hand_qty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
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
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={seed.isPending} onClick={() => void submit()}>
            Dodaj u magacin
          </Button>
        </div>
      }
    >
      <div className="space-y-2">
        <FormField label="Količina (dodaj u magacin ALAT-MAG-01)">
          <input
            className={`${INPUT} w-32`}
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
