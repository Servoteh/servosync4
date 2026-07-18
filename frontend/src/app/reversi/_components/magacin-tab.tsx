'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, Package, Pencil, Plus, Upload } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { downloadCsv } from '@/lib/reversi-csv';
import type { ReversiLabelRow } from '@/lib/reversi-labels';
import { useWarehouse, type WarehouseRow } from '@/api/reversi';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { tableEmpty } from './common';
import { ToolDetailDialog } from './tool-detail-dialog';
import { BulkImportDialog } from './bulk-import-dialog';
import { BulkPrintLabelsDialog } from './bulk-print-labels-dialog';
import { IssueDialog } from './issue-dialog';
import { ConsumptionReportDialog } from './consumption-report-dialog';
import {
  CuttingDetailsDialog,
  CuttingEditDialog,
  CuttingTopupDialog,
  HandEditDialog,
  HandStockDialog,
} from './magacin-stock-dialogs';

const SELECT =
  'rounded-control border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent';
const ACT = 'rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink';
const ACT_PRIMARY =
  'rounded-control border border-accent/40 bg-accent-subtle p-1 text-accent hover:bg-accent/15';

type Grupa = 'ALL' | 'HAND' | 'CUTTING';

const GRUPA_SEGMENTS: { key: Grupa; label: string }[] = [
  { key: 'ALL', label: 'Sve' },
  { key: 'HAND', label: 'Ručni' },
  { key: 'CUTTING', label: 'Rezni' },
];

/** Ključ selekcije/reda (item + lokacija — u „Sve lokacije" isti artikal ide u više redova). */
function rowKey(r: WarehouseRow): string {
  return `${r.grupa}-${r.item_id}-${r.location_code ?? ''}`;
}

/** Količinski (potrošni) ručni alat: stanje se vodi kroz qty_on_hand. */
function isQtyHand(r: WarehouseRow): boolean {
  return r.grupa === 'HAND' && r.is_quantity === true;
}

function minForRow(r: WarehouseRow): number {
  if (isQtyHand(r) || r.grupa === 'CUTTING') return Number(r.min_stock_qty) || 0;
  return 1;
}
function maxForRow(r: WarehouseRow): number {
  if (isQtyHand(r) || r.grupa === 'CUTTING') {
    const m = Number(r.max_stock_qty);
    return Number.isFinite(m) && m > 0 ? m : 0;
  }
  return 0;
}

interface Presentation {
  qty: number;
  minQ: number;
  maxQ: number;
  tone: Tone;
  label: string;
}

/**
 * Logika statusa zalihe (RA-33 — DOSLOVNO iz 1.0 `stockPresentation`,
 * magacinTab.js:92-135). Statusi: Nema (0, danger) → Kod primaoca (sve lok.,
 * magacin 0 ali ukupno>0, warn) → Nisko stanje (<min, warn) → Iznad maksimuma
 * (>max, warn) → inače Na stanju (ok).
 */
function stockPresentation(r: WarehouseRow, allLoc: boolean): Presentation {
  const hasExt = typeof r.qty_total !== 'undefined' && r.qty_total !== null && Number.isFinite(Number(r.qty_total));
  const qty = isQtyHand(r)
    ? Number(r.qty_on_hand) || 0
    : allLoc && hasExt
      ? Number(r.qty_total) || 0
      : Number(r.in_warehouse_qty) || 0;
  const warehouseQty = isQtyHand(r) ? Number(r.qty_on_hand) || 0 : Number(r.in_warehouse_qty) || 0;
  const minQ = minForRow(r);
  const maxQ = maxForRow(r);
  let tone: Tone = 'success';
  let label = 'Na stanju';
  if (qty === 0) {
    tone = 'danger';
    label = 'Nema';
  } else if (allLoc && warehouseQty === 0 && hasExt && qty > 0) {
    tone = 'warn';
    label = 'Kod primaoca';
  } else if (minQ > 0) {
    const minCheck = r.grupa === 'CUTTING' && allLoc ? warehouseQty : qty;
    if (minCheck < minQ) {
      tone = 'warn';
      label = 'Nisko stanje';
    }
  }
  if (label === 'Na stanju' && maxQ > 0 && qty > maxQ) {
    tone = 'warn';
    label = 'Iznad maksimuma';
  }
  return { qty, minQ, maxQ, tone, label };
}

/** Badž grupe (RA-32) — Rezni (info) / Ručni (neutral), paritet 1.0 revGrupaBadgeHtml. */
function GrupaBadge({ grupa }: { grupa: string }) {
  return grupa === 'CUTTING' ? (
    <StatusBadge tone="info" label="Rezni" />
  ) : (
    <StatusBadge tone="neutral" label="Ručni" />
  );
}

function qtyToneCls(tone: Tone): string {
  if (tone === 'danger') return 'text-status-danger';
  if (tone === 'warn') return 'text-status-warn';
  return 'text-status-success';
}

function SelectAllBox({
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
      checked={checked}
      disabled={disabled}
      title="Izaberi sve"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * Magacin (zbirno) — objedinjeno stanje po artiklu/lokaciji (paritet 1.0
 * `magacinTab.js`): zaglavlje sa sažetkom (RA-29), traka filtera + „Sve lokacije"
 * (RA-30), akcije trake (RA-31), tabela sa kolonama (RA-32), status-boje (RA-33),
 * akcije reda oko/olovka/+ (RA-34), bulk izbor + štampa nalepnica (RA-35), CSV izvoz
 * (RA-36), dijalozi dopune reznog (RA-37) i prijema/otpisa ručnog količinskog (RA-38),
 * izveštaj potrošnje (RA-39/40/41 — u ConsumptionReportDialog).
 */
export function MagacinTab() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  const [grupa, setGrupa] = useState<Grupa>('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [klasa, setKlasa] = useState('');
  const [includeZero, setIncludeZero] = useState(false);
  const [allLocations, setAllLocations] = useState(false);
  const [selected, setSelected] = useState<Map<string, WarehouseRow>>(new Map());

  // Dijalozi.
  const [detailToolId, setDetailToolId] = useState<string | null>(null);
  const [editToolId, setEditToolId] = useState<string | null>(null);
  const [cuttingDetails, setCuttingDetails] = useState<WarehouseRow | null>(null);
  const [cuttingEditRow, setCuttingEditRow] = useState<WarehouseRow | null>(null);
  const [topupRow, setTopupRow] = useState<WarehouseRow | null>(null);
  const [receiveRow, setReceiveRow] = useState<WarehouseRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [consumptionOpen, setConsumptionOpen] = useState(false);
  const [quickIssueOpen, setQuickIssueOpen] = useState(false);
  const [bulkPrintRows, setBulkPrintRows] = useState<ReversiLabelRow[] | null>(null);

  // Pretraga — debounce 250ms (paritet 1.0).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const warehouse = useWarehouse(allLocations);
  const allRows = useMemo(() => warehouse.data?.data ?? [], [warehouse.data]);

  // Filteri (KLIJENTSKI nad odgovorom view-a — paritet 1.0 fetchUnifiedWarehouse):
  // grupa → nulta stanja → klasa → pretraga; sort grupa asc, oznaka asc.
  const baseByGrupa = useMemo(() => {
    let rows = allRows;
    if (grupa !== 'ALL') rows = rows.filter((r) => r.grupa === grupa);
    if (!includeZero) {
      rows = rows.filter((r) => {
        const q = allLocations
          ? Number(r.qty_total ?? r.in_warehouse_qty) || 0
          : Number(r.in_warehouse_qty) || 0;
        return q > 0;
      });
    }
    return rows;
  }, [allRows, grupa, includeZero, allLocations]);

  // Klasa select je dinamičan — iz skupa posle grupa/nulta/pretraga (bez klasa filtera).
  const klase = useMemo(() => {
    const set = new Set<string>();
    for (const r of baseByGrupa) if (r.klasa) set.add(r.klasa);
    return [...set].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [baseByGrupa]);

  const rows = useMemo(() => {
    let out = baseByGrupa;
    if (klasa) out = out.filter((r) => r.klasa === klasa);
    const s = search.toLowerCase();
    if (s) {
      out = out.filter((r) =>
        [r.oznaka, r.naziv, r.barcode, r.klasa]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(s)),
      );
    }
    return [...out].sort(
      (a, b) => a.grupa.localeCompare(b.grupa) || String(a.oznaka).localeCompare(String(b.oznaka), 'sr'),
    );
  }, [baseByGrupa, klasa, search]);

  // Reset izbor klase kad nestane iz opcija (npr. promena grupe).
  useEffect(() => {
    if (klasa && !klase.includes(klasa)) setKlasa('');
  }, [klase, klasa]);

  // RA-29 — sažetak (nad prikazanim skupom, paritet 1.0 renderMagHeader).
  const summary = useMemo(() => {
    const total = rows.length;
    const handUnits = rows.filter((r) => r.grupa === 'HAND' && Number(r.in_warehouse_qty) > 0).length;
    const rezniKom = rows
      .filter((r) => r.grupa === 'CUTTING')
      .reduce((s, r) => s + (Number(r.in_warehouse_qty) || 0), 0);
    let low = 0;
    for (const r of rows) if (stockPresentation(r, allLocations).label === 'Nisko stanje') low += 1;
    return { total, handUnits, rezniKom, low };
  }, [rows, allLocations]);

  // Izbor redova (RA-35) — čuva pune redove za bulk štampu; select-all nad barkodiranim.
  const selectable = rows.filter((r) => r.barcode);
  const selectedOnPage = selectable.filter((r) => selected.has(rowKey(r))).length;
  const allChecked = selectable.length > 0 && selectedOnPage === selectable.length;
  function toggleRow(r: WarehouseRow, on: boolean) {
    setSelected((m) => {
      const next = new Map(m);
      if (on) next.set(rowKey(r), r);
      else next.delete(rowKey(r));
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected((m) => {
      const next = new Map(m);
      for (const r of selectable) {
        if (on) next.set(rowKey(r), r);
        else next.delete(rowKey(r));
      }
      return next;
    });
  }

  function doBulkPrint() {
    const picked = [...selected.values()].filter((r) => r.barcode);
    if (picked.length === 0) {
      toast('Nema barkodiranih artikala u izboru');
      return;
    }
    setBulkPrintRows(
      picked.map((r) => ({
        barcode: r.barcode as string,
        oznaka: r.oznaka,
        naziv: r.naziv,
        subgroupLabel: r.klasa ?? r.subgroup_label ?? r.group_label ?? '',
        serial: r.serijski_broj,
        // grupa/klasa → composeTspl bira rezni (CUTTING) TSPL2 layout umesto HAND (paritet 1.0).
        grupa: r.grupa as 'HAND' | 'CUTTING',
        klasa: r.klasa,
      })),
    );
  }

  // RA-36 — CSV izvoz (kolone identične 1.0 exportMagacin).
  function exportCsv() {
    if (rows.length === 0) {
      toast('Nema redova za izvoz');
      return;
    }
    downloadCsv(
      `magacin-reversi-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'Grupa',
        'Kataloški broj',
        'Barkod',
        'Naziv',
        'Klasa',
        'Lokacija (primalac ili kod)',
        'Količina prikaz',
        'U magacin',
        'Min',
        'Status',
        'Napomena',
      ],
      rows.map((r) => {
        const p = stockPresentation(r, allLocations);
        const loc = String(r.location_label || '').trim() || r.location_code || '';
        return [
          r.grupa === 'CUTTING' ? 'Rezni' : 'Ručni',
          r.oznaka,
          r.barcode ?? '',
          r.naziv,
          r.klasa ?? '',
          loc,
          String(p.qty),
          String(Number(r.in_warehouse_qty) || 0),
          String(p.minQ),
          p.label,
          r.napomena ?? '',
        ];
      }),
    );
    toast(`Eksport ${formatNumber(rows.length)} redova`);
  }

  function openEye(r: WarehouseRow) {
    if (r.grupa === 'CUTTING') setCuttingDetails(r);
    else setDetailToolId(r.item_id);
  }

  const cols: Column<WarehouseRow>[] = [
    ...(manage
      ? [
          {
            key: 'sel',
            header: (
              <SelectAllBox
                checked={allChecked}
                indeterminate={selectedOnPage > 0}
                disabled={selectable.length === 0}
                onChange={toggleAll}
              />
            ),
            render: (r: WarehouseRow) => (
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
                checked={selected.has(rowKey(r))}
                disabled={!r.barcode}
                title={r.barcode ? undefined : 'Nema barkoda'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  toggleRow(r, e.target.checked);
                }}
              />
            ),
          } satisfies Column<WarehouseRow>,
        ]
      : []),
    {
      key: 'kat',
      header: 'Kataloški broj',
      render: (r) => (
        <div className="leading-tight">
          <div className="tnums font-medium">{r.oznaka || '—'}</div>
          {r.barcode && <div className="tnums text-2xs text-ink-secondary">{r.barcode}</div>}
        </div>
      ),
    },
    {
      key: 'naziv',
      header: 'Naziv',
      render: (r) => (
        <span>
          {r.naziv}
          {r.is_consumable && (
            <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">
              Potrošno
            </span>
          )}
        </span>
      ),
    },
    { key: 'grupa', header: 'Grupa', render: (r) => <GrupaBadge grupa={r.grupa} /> },
    {
      key: 'loc',
      header: 'Lokacija',
      render: (r) =>
        r.grupa === 'HAND' ? (
          <span className="text-ink-disabled">—</span>
        ) : (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">
            {r.location_code || r.location_label || '—'}
          </span>
        ),
    },
    {
      key: 'qty',
      header: 'Količina',
      align: 'right',
      numeric: true,
      render: (r) => {
        const p = stockPresentation(r, allLocations);
        const bits: string[] = [];
        if (p.minQ > 0) bits.push(`min. ${p.minQ}`);
        if (p.maxQ > 0) bits.push(`max. ${p.maxQ}`);
        if (bits.length === 0 && r.grupa === 'HAND' && !isQtyHand(r)) bits.push('1 kom');
        return (
          <div className="flex flex-col items-end leading-tight">
            <span>
              <span className={`font-semibold ${qtyToneCls(p.tone)}`}>{formatNumber(p.qty)}</span>{' '}
              <span className="text-ink-secondary">{r.unit || 'kom'}</span>
            </span>
            {bits.length > 0 && <span className="text-2xs text-ink-secondary">{bits.join(' · ')}</span>}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const p = stockPresentation(r, allLocations);
        return <StatusBadge tone={p.tone} label={p.label} />;
      },
    },
    { key: 'azur', header: 'Ažurirano', render: () => <span className="text-ink-disabled">—</span> },
    ...(manage
      ? [
          {
            key: 'akcije',
            header: '',
            align: 'right' as const,
            render: (r: WarehouseRow) => (
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  className={ACT}
                  title="Pregled"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEye(r);
                  }}
                >
                  <Eye className="h-4 w-4" aria-hidden />
                </button>
                <button
                  type="button"
                  className={ACT}
                  title={r.grupa === 'CUTTING' ? 'Izmena šifre' : 'Izmena artikla'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (r.grupa === 'CUTTING') setCuttingEditRow(r);
                    else setEditToolId(r.item_id);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden />
                </button>
                {r.grupa === 'CUTTING' ? (
                  <button
                    type="button"
                    className={ACT_PRIMARY}
                    title="Dopuna zalihe"
                    onClick={(e) => {
                      e.stopPropagation();
                      setTopupRow(r);
                    }}
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </button>
                ) : isQtyHand(r) ? (
                  <button
                    type="button"
                    className={ACT_PRIMARY}
                    title="Prijem u magacin"
                    onClick={(e) => {
                      e.stopPropagation();
                      setReceiveRow(r);
                    }}
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </button>
                ) : null}
              </div>
            ),
          } satisfies Column<WarehouseRow>,
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      {/* RA-29 — zaglavlje sa sažetkom + „Brzo zaduženje" */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Package className="h-5 w-5 text-ink-secondary" aria-hidden />
          <h2 className="text-md font-semibold text-ink">Magacin</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Chip>
            <strong className="tnums">{formatNumber(summary.total)}</strong>{' '}
            {allLocations ? 'sve lok.' : 'u prikazu'}
          </Chip>
          <Chip>
            <strong className="tnums">{formatNumber(summary.handUnits)}</strong> ručni
          </Chip>
          <Chip tone="warn">
            <strong className="tnums">{formatNumber(summary.rezniKom)}</strong> rezni
          </Chip>
          <Chip tone="danger">
            <strong className="tnums">{formatNumber(summary.low)}</strong> nisko
          </Chip>
        </div>
        {manage && (
          <div className="ml-auto">
            <Button variant="primary" onClick={() => setQuickIssueOpen(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> Brzo zaduženje
            </Button>
          </div>
        )}
      </div>

      {/* RA-30/31 — traka filtera + akcije */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Kataloški broj, naziv ili barkod…"
        />
        <div className="flex items-center gap-1">
          <span className="text-xs text-ink-secondary">Grupa</span>
          <div className="flex gap-1">
            {GRUPA_SEGMENTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setGrupa(s.key)}
                className={
                  grupa === s.key
                    ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg'
                    : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-2'
                }
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {klase.length > 0 && (
          <select className={SELECT} title="Klasa" value={klasa} onChange={(e) => setKlasa(e.target.value)}>
            <option value="">Sve klase</option>
            {klase.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={includeZero}
            onChange={(e) => setIncludeZero(e.target.checked)}
          />
          Prikaži i nulta stanja
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--accent)]"
            checked={allLocations}
            onChange={(e) => setAllLocations(e.target.checked)}
          />
          Sve lokacije
        </label>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" aria-hidden /> Izvoz CSV
          </Button>
          {manage && (
            <>
              <Button variant="secondary" onClick={() => setConsumptionOpen(true)}>
                Potrošnja
              </Button>
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1 h-4 w-4" aria-hidden /> Uvoz
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  toast('Novi artikal: Inventar → Alat i oprema → „Nova jedinica" (ručni) ili Rezni alat → „Nova šifra".')
                }
              >
                Novi artikal
              </Button>
            </>
          )}
        </div>
      </div>

      {/* RA-35 — bulk bar */}
      {manage && selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-panel border border-accent/30 bg-accent-subtle px-3 py-2 text-sm">
          <span>
            <strong className="tnums">{selected.size}</strong> odabrano
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="primary" onClick={doBulkPrint}>
              Štampa nalepnica ({selected.size})
            </Button>
            <Button variant="secondary" onClick={() => setSelected(new Map())}>
              Poništi izbor
            </Button>
          </div>
        </div>
      )}

      <div className="text-xs text-ink-secondary">
        <strong className="tnums">{formatNumber(rows.length)}</strong> artikala prikazano
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={rowKey}
        loading={warehouse.isLoading}
        onRowActivate={openEye}
        empty={tableEmpty(
          warehouse.isError,
          'Magacin je prazan',
          'Nema artikala u magacinu prema filteru. Proširi pretragu ili uključi „Prikaži i nulta stanja".',
        )}
      />

      {/* Dijalozi */}
      <ToolDetailDialog toolId={detailToolId} onClose={() => setDetailToolId(null)} />
      {editToolId && <HandEditDialog toolId={editToolId} onClose={() => setEditToolId(null)} />}
      {cuttingDetails && (
        <CuttingDetailsDialog row={cuttingDetails} onClose={() => setCuttingDetails(null)} />
      )}
      {manage && cuttingEditRow && (
        <CuttingEditDialog row={cuttingEditRow} onClose={() => setCuttingEditRow(null)} />
      )}
      {manage && topupRow && <CuttingTopupDialog row={topupRow} onClose={() => setTopupRow(null)} />}
      {manage && receiveRow && <HandStockDialog row={receiveRow} onClose={() => setReceiveRow(null)} />}
      {manage && <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} />}
      {manage && consumptionOpen && <ConsumptionReportDialog onClose={() => setConsumptionOpen(false)} />}
      {manage && quickIssueOpen && (
        <IssueDialog open onClose={() => setQuickIssueOpen(false)} defaultMode="scanner" />
      )}
      {manage && (
        <BulkPrintLabelsDialog
          open={!!bulkPrintRows}
          rows={bulkPrintRows ?? []}
          onClose={() => {
            setBulkPrintRows(null);
            setSelected(new Map());
          }}
        />
      )}
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'danger' }) {
  const toneCls =
    tone === 'warn'
      ? 'text-status-warn'
      : tone === 'danger'
        ? 'text-status-danger'
        : 'text-ink-secondary';
  return (
    <span className={`rounded-full border border-line bg-surface-2 px-2 py-0.5 ${toneCls}`}>
      {children}
    </span>
  );
}
