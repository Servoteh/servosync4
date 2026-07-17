'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, FolderTree, Plus, Upload } from 'lucide-react';
import { DataTable, type Column, type SortState } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { downloadCsv } from '@/lib/reversi-csv';
import type { ReversiLabelRow } from '@/lib/reversi-labels';
import {
  fetchInventoryUnits,
  useInventoryTree,
  useInventoryUnits,
  type InventoryUnitRow,
  type InventoryUnitsParams,
  type IssuedHolder,
  type ReversiTool,
} from '@/api/reversi';
import { tableEmpty } from './common';
import { ToolDetailDialog } from './tool-detail-dialog';
import { IssueDialog } from './issue-dialog';
import { ToolCreateDialog } from './tool-create-dialog';
import { InventoryGroupsDialog } from './inventory-groups-dialog';
import { BulkImportDialog } from './bulk-import-dialog';
import { BulkPrintLabelsDialog } from './bulk-print-labels-dialog';

const PAGE_SIZE = 50;
const CSV_LIMIT = 5000; // BE cap (RA-23 — ceo filtrirani skup)
const STAT_SAMPLE = 2000; // uzorak za stat kartice (paritet 1.0 inventarUnitView)

const SELECT =
  'rounded-control border border-line bg-surface-2 px-2 py-1.5 text-sm text-ink outline-none focus:border-accent';
const ACT = 'rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2 hover:text-ink';
const ACT_PRIMARY =
  'rounded-control border border-accent/40 bg-accent-subtle p-1 text-accent hover:bg-accent/15';

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'active', label: 'Aktivan' },
  { value: 'scrapped', label: 'Otpisan' },
  { value: 'lost', label: 'Izgubljen' },
  { value: 'all', label: 'Svi zapisi' },
];

function statusLabel(s: string): string {
  if (s === 'scrapped') return 'Otpisan';
  if (s === 'lost') return 'Izgubljen';
  if (s === 'active') return 'Aktivan';
  return s || '—';
}

/** Pilula statusa (paritet 1.0 revToolStatusPillHtml + RA-52: Na reversu vs Aktivan). */
function StatusPill({ row }: { row: InventoryUnitRow }) {
  if (row.status === 'scrapped') return <StatusBadge tone="danger" label="Otpisan" />;
  if (row.status === 'lost') return <StatusBadge tone="danger" label="Izgubljen" />;
  if (row.status === 'active' && row.issuedHolder) return <StatusBadge tone="warn" label="Na reversu" />;
  if (row.status === 'active') return <StatusBadge tone="success" label="Aktivan" />;
  return <StatusBadge tone="neutral" label={statusLabel(row.status)} />;
}

function classPath(r: InventoryUnitRow): string[] {
  return [r.group?.label, r.subgroup?.label, r.subsubgroup?.label].filter(Boolean) as string[];
}

function issuanceWho(h: IssuedHolder): string {
  if (h.recipientType === 'EMPLOYEE' && h.recipientEmployeeName) return h.recipientEmployeeName;
  if (h.recipientType === 'DEPARTMENT' && h.recipientDepartment) return h.recipientDepartment;
  if (h.recipientCompanyName) return h.recipientCompanyName;
  return 'Primalac';
}

/** Ćelija „Zaduženje i lokacija" (RA-16). */
function IssuanceCell({ row }: { row: InventoryUnitRow }) {
  if (!row.issuedHolder) {
    const loc = row.currentLocationCode ? `Magacin · ${row.currentLocationCode}` : 'U magacinu';
    return (
      <div className="leading-tight">
        <div className="text-status-success">Slobodan za izdavanje</div>
        <div className="text-2xs text-ink-secondary">{loc}</div>
      </div>
    );
  }
  const h = row.issuedHolder;
  return (
    <div className="leading-tight">
      <div className="text-status-warn">Na reversu</div>
      <div className="text-2xs text-ink-secondary">
        <span className="tnums">{h.docNumber || '—'}</span> · {issuanceWho(h)}
      </div>
    </div>
  );
}

/** Red CSV izvoza (RA-23 — kolone identične 1.0 toolExportRow). */
function unitExportRow(r: InventoryUnitRow): (string | number)[] {
  let zad: string;
  if (!r.issuedHolder) {
    zad = r.currentLocationCode ? `Slobodan, magacin ${r.currentLocationCode}` : 'Slobodan u magacinu';
  } else {
    zad = r.issuedHolder.docNumber ? `Na reversu ${r.issuedHolder.docNumber}` : 'Na reversu';
  }
  return [
    r.oznaka,
    r.group?.label ?? '',
    r.subgroup?.label ?? '',
    r.subsubgroup?.label ?? '',
    r.naziv,
    statusLabel(r.status),
    zad,
  ];
}

/** Red jedinice → oblik `ReversiTool` za preselekciju u Izdaj (RA-17). */
function toReversiTool(r: InventoryUnitRow): ReversiTool {
  return {
    id: r.id,
    oznaka: r.oznaka,
    naziv: r.naziv,
    serijskiBroj: r.serijskiBroj,
    barcode: r.barcode,
    status: r.status as ReversiTool['status'],
    isQuantity: r.isQuantity,
    isConsumable: r.isConsumable,
    totalQty: r.totalQty,
    subgroupId: r.subgroupId,
    napomena: r.napomena,
  };
}

function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'success' | 'warn' }) {
  const valueCls = tone === 'success' ? 'text-status-success' : tone === 'warn' ? 'text-status-warn' : 'text-ink';
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</div>
      <div className={`tnums mt-1 text-2xl font-semibold ${valueCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-2xs text-ink-secondary">{hint}</div>}
    </div>
  );
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
      title="Izaberi sve na strani"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

/**
 * „Alat i oprema" — per-jedinica katalog ručnog alata/opreme/LZO (paritet 1.0
 * `inventarUnitView.js`). Pokriva RA-08/10/12/13/14/15/16/17/18/21/23 + toolbar
 * akcije Nova jedinica (RB-46), Grupe (RA-25–28), Uvoz CSV (RA-24) i bulk štampu
 * nalepnica (RA-22): 4 stat kartice, kaskadni filteri + status, sortabilna tabela
 * sa svim kolonama, paginacija 50/str, akcije reda (pregled/izdaj), izbor redova +
 * bulk bar, CSV izvoz celog filtriranog skupa.
 *
 * `onBulkPrint` = opcioni override štampe (prima izabrane redove); bez njega bulk
 * dugme štampa lokalno preko `printReversiLabels` (browser preview + mrežni TSC).
 */
export function AlatOpremaTab({ onBulkPrint }: { onBulkPrint?: (rows: InventoryUnitRow[]) => void }) {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);

  const [status, setStatus] = useState('active');
  const [groupCode, setGroupCode] = useState('ALL');
  const [subgroupId, setSubgroupId] = useState('ALL');
  const [subsubgroupId, setSubsubgroupId] = useState('ALL');
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'oznaka', dir: 'asc' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, InventoryUnitRow>>(new Map());
  const [detailToolId, setDetailToolId] = useState<string | null>(null);
  const [issueTool, setIssueTool] = useState<InventoryUnitRow | null>(null);
  const [exporting, setExporting] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // Snimljeni izbor za bulk-print dijalog (RA-22) — nezavisan od kasnijih promena izbora.
  const [bulkPrintRows, setBulkPrintRows] = useState<ReversiLabelRow[] | null>(null);

  // Debounce pretrage (300ms — paritet 1.0), reset na prvu stranu.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const tree = useInventoryTree();
  const { groups, subgroups, subsubgroups } = useMemo(() => {
    const g = tree.data?.data.groups ?? [];
    const s = tree.data?.data.subgroups ?? [];
    const ss = tree.data?.data.subsubgroups ?? [];
    // rev_tools pokriva HAND + LZO; REZNI grupa se isključuje iz kaskadnih filtera.
    const rezni = g.find((x) => x.code === 'REZNI')?.id ?? null;
    return {
      groups: g.filter((x) => x.code !== 'REZNI'),
      subgroups: s.filter((x) => x.groupId !== rezni),
      subsubgroups: ss,
    };
  }, [tree.data]);

  const selectedGroupId = useMemo(
    () => (groupCode === 'ALL' ? null : (groups.find((g) => g.code === groupCode)?.id ?? null)),
    [groupCode, groups],
  );
  const visibleSubgroups = useMemo(
    () => (selectedGroupId ? subgroups.filter((s) => s.groupId === selectedGroupId) : subgroups),
    [subgroups, selectedGroupId],
  );
  const visibleSubsubs = useMemo(
    () => (subgroupId === 'ALL' ? [] : subsubgroups.filter((s) => s.subgroupId === subgroupId)),
    [subsubgroups, subgroupId],
  );

  const filters: InventoryUnitsParams = {
    status,
    q: q || undefined,
    groupCode: groupCode !== 'ALL' ? groupCode : undefined,
    subgroupId: subgroupId !== 'ALL' ? subgroupId : undefined,
    subsubgroupId: subsubgroupId !== 'ALL' ? subsubgroupId : undefined,
    sort: sort.key,
    dir: sort.dir,
  };
  const unitsQ = useInventoryUnits({ ...filters, page, pageSize: PAGE_SIZE });
  const rows = unitsQ.data?.data ?? [];
  const total = unitsQ.data?.meta.pagination.total ?? 0;
  const totalPages = unitsQ.data?.meta.pagination.totalPages ?? 1;

  // Stat kartice (RA-10) — uzorak aktivnih (do 2000) za slobodno/na-reversu + broj
  // otpisanih. Duži staleTime (R1-REV-03): skup od 2000 redova se ne re-fetchuje na
  // svaki fokus/mount — pločice su izvedene vrednosti, ne trebaju sveže po sekundi.
  const statsQ = useInventoryUnits(
    { status: 'active', page: 1, pageSize: STAT_SAMPLE },
    { staleTime: 60_000 },
  );
  const scrappedQ = useInventoryUnits(
    { status: 'scrapped', page: 1, pageSize: 1 },
    { staleTime: 60_000 },
  );
  const stats = useMemo(() => {
    const sample = statsQ.data?.data ?? [];
    const activeTotal = statsQ.data?.meta.pagination.total ?? 0;
    const issued = sample.filter((r) => r.issuedHolder).length;
    const free = sample.length - issued;
    return {
      activeTotal,
      issued,
      free,
      moreThanSample: activeTotal > sample.length,
      scrapped: scrappedQ.data?.meta.pagination.total ?? 0,
    };
  }, [statsQ.data, scrappedQ.data]);

  // Preselektovan alat za Izdaj (RA-17) — memoizovan da statsQ re-render (0.5–3s
  // posle otvaranja) ne iskuje NOV objekat i time ne resetuje već popunjeni revers
  // (linije/primalac) + nov idempotency ključ u IssueDialog-u (R1-REV-02).
  const issueInitialTool = useMemo(
    () => (issueTool ? toReversiTool(issueTool) : null),
    [issueTool],
  );

  function onGroupChange(v: string) {
    setGroupCode(v);
    if (v !== 'ALL' && subgroupId !== 'ALL') {
      const gid = groups.find((g) => g.code === v)?.id ?? null;
      const sg = subgroups.find((s) => s.id === subgroupId);
      if (!sg || sg.groupId !== gid) setSubgroupId('ALL');
    }
    setSubsubgroupId('ALL');
    setPage(1);
  }
  function onSortToggle(key: string) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
    setPage(1);
  }

  // Izbor redova (RA-21). Čuva pune redove (Map) da bulk štampa ima podatke i
  // posle promene strane; select-all deluje na barkodirane redove trenutne strane.
  const selectablePage = rows.filter((r) => r.barcode);
  const selectedOnPage = selectablePage.filter((r) => selected.has(r.id)).length;
  const allChecked = selectablePage.length > 0 && selectedOnPage === selectablePage.length;
  function toggleRow(r: InventoryUnitRow, on: boolean) {
    setSelected((m) => {
      const next = new Map(m);
      if (on) next.set(r.id, r);
      else next.delete(r.id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected((m) => {
      const next = new Map(m);
      for (const r of selectablePage) {
        if (on) next.set(r.id, r);
        else next.delete(r.id);
      }
      return next;
    });
  }

  // RA-22 — bulk štampa nalepnica: otvori dijalog (izbor formata A4/TSC + kopije +
  // pregled). `onBulkPrint` (ako je prosleđen) ima prednost — roditelj preuzima štampu.
  function doBulkPrint() {
    const rows = [...selected.values()].filter((r) => r.barcode);
    if (rows.length === 0) {
      toast('Nema barkodiranih jedinica u izboru');
      return;
    }
    if (onBulkPrint) {
      onBulkPrint(rows);
      return;
    }
    setBulkPrintRows(
      rows.map((r) => ({
        barcode: r.barcode,
        oznaka: r.oznaka,
        naziv: r.naziv,
        subgroupLabel: r.subgroup?.label ?? r.group?.label ?? '',
        serial: r.serijskiBroj,
      })),
    );
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const all = await fetchInventoryUnits({ ...filters, page: 1, pageSize: CSV_LIMIT });
      const data = all.data ?? [];
      if (data.length === 0) {
        toast('Nema redova za izvoz');
        return;
      }
      downloadCsv(
        `reversi-inventar-${status}.csv`,
        ['Oznaka', 'Grupa', 'Podgrupa', 'Podpodgrupa', 'Naziv', 'Status jedinice', 'Zaduženje / lokacija'],
        data.map(unitExportRow),
      );
      toast(`Izvezeno ${data.length} redova`);
    } catch {
      toast('Izvoz nije uspeo');
    } finally {
      setExporting(false);
    }
  }

  const cols: Column<InventoryUnitRow>[] = [
    ...(manage
      ? [
          {
            key: 'sel',
            header: (
              <SelectAllBox
                checked={allChecked}
                indeterminate={selectedOnPage > 0}
                disabled={selectablePage.length === 0}
                onChange={toggleAll}
              />
            ),
            render: (r: InventoryUnitRow) => (
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--accent)] disabled:opacity-40"
                checked={selected.has(r.id)}
                disabled={!r.barcode}
                title={r.barcode ? undefined : 'Nema barkoda'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  e.stopPropagation();
                  toggleRow(r, e.target.checked);
                }}
              />
            ),
          } satisfies Column<InventoryUnitRow>,
        ]
      : []),
    {
      key: 'oznaka',
      header: 'Oznaka',
      sortable: true,
      render: (r) => (
        <div className="leading-tight">
          <div className="tnums font-medium">{r.oznaka}</div>
          {r.barcode && <div className="tnums text-2xs text-ink-secondary">{r.barcode}</div>}
        </div>
      ),
    },
    {
      key: 'klas',
      header: 'Klasifikacija',
      render: (r) => {
        const path = classPath(r);
        return path.length === 0 ? (
          <span className="text-ink-disabled">Nesvrstano</span>
        ) : (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-2xs text-ink-secondary">
            {path.join(' · ')}
          </span>
        );
      },
    },
    {
      key: 'naziv',
      header: 'Naziv / opis',
      sortable: true,
      render: (r) => (
        <span>
          {r.naziv}
          {r.isConsumable && (
            <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">
              Potrošno
            </span>
          )}
        </span>
      ),
    },
    { key: 'zad', header: 'Zaduženje i lokacija', render: (r) => <IssuanceCell row={r} /> },
    { key: 'status', header: 'Status', sortable: true, render: (r) => <StatusPill row={r} /> },
    {
      key: 'akcije',
      header: '',
      align: 'right',
      render: (r) => (
        <div className="flex justify-end gap-1">
          <button
            type="button"
            className={ACT}
            title="Pregled jedinice"
            onClick={(e) => {
              e.stopPropagation();
              setDetailToolId(r.id);
            }}
          >
            <Eye className="h-4 w-4" aria-hidden />
          </button>
          {manage && !r.issuedHolder && r.status === 'active' && (
            <button
              type="button"
              className={ACT_PRIMARY}
              title="Izdaj na revers"
              onClick={(e) => {
                e.stopPropagation();
                setIssueTool(r);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      ),
    },
  ];

  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = (page - 1) * PAGE_SIZE + rows.length;

  return (
    <div className="space-y-3">
      {/* RA-10 — 4 statističke kartice */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Aktivne jedinice" value={formatNumber(stats.activeTotal)} hint="aktivan" />
        <StatCard
          label="Slobodno u magacinu"
          value={`${formatNumber(stats.free)}${stats.moreThanSample ? '+' : ''}`}
          hint="slobodno"
          tone="success"
        />
        <StatCard
          label="Na reversu"
          value={`${formatNumber(stats.issued)}${stats.moreThanSample ? '+' : ''}`}
          hint="izdato"
        />
        <StatCard
          label="Otpisano"
          value={formatNumber(stats.scrapped)}
          hint="rashod"
          tone={stats.scrapped > 0 ? 'warn' : undefined}
        />
      </div>

      {/* RA-12/13 — kaskadni filteri + status; RA-23 — CSV */}
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Oznaka, naziv ili barkod…"
        />
        <select className={SELECT} value={groupCode} title="Grupa" onChange={(e) => onGroupChange(e.target.value)}>
          <option value="ALL">Sve grupe</option>
          {groups.map((g) => (
            <option key={g.code} value={g.code}>
              {g.label}
            </option>
          ))}
        </select>
        <select
          className={SELECT}
          value={subgroupId}
          title="Podgrupa"
          onChange={(e) => {
            setSubgroupId(e.target.value);
            setSubsubgroupId('ALL');
            setPage(1);
          }}
        >
          <option value="ALL">Sve podgrupe</option>
          {visibleSubgroups.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        {subgroupId !== 'ALL' && visibleSubsubs.length > 0 && (
          <select
            className={SELECT}
            value={subsubgroupId}
            title="Podpodgrupa"
            onChange={(e) => {
              setSubsubgroupId(e.target.value);
              setPage(1);
            }}
          >
            <option value="ALL">Sve podpodgrupe</option>
            {visibleSubsubs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <select
          className={SELECT}
          value={status}
          title="Status u evidenciji"
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(1);
          }}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {manage && (
            <>
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" aria-hidden /> Nova jedinica
              </Button>
              <Button variant="secondary" onClick={() => setGroupsOpen(true)}>
                <FolderTree className="mr-1 h-4 w-4" aria-hidden /> Grupe
              </Button>
              <Button variant="secondary" onClick={() => setImportOpen(true)}>
                <Upload className="mr-1 h-4 w-4" aria-hidden /> Uvoz CSV…
              </Button>
            </>
          )}
          <Button variant="secondary" loading={exporting} onClick={() => void exportCsv()}>
            CSV
          </Button>
        </div>
      </div>

      {/* RA-21 — bulk bar (shell; dugme štampe čeka RA-22 preko onBulkPrint) */}
      {manage && selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-panel border border-accent/30 bg-accent-subtle px-3 py-2 text-sm">
          <span>
            <strong className="tnums">{selected.size}</strong> izabrano
          </span>
          <div className="ml-auto flex gap-2">
            <Button variant="primary" onClick={doBulkPrint}>
              Štampa nalepnica ({selected.size})
            </Button>
            <Button variant="secondary" onClick={() => setSelected(new Map())}>
              Poništi
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-ink-secondary">
        <span>
          Prikazano{' '}
          <strong className="tnums">
            {formatNumber(from)}–{formatNumber(to)}
          </strong>{' '}
          od {formatNumber(total)} jedinica
        </span>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={unitsQ.isLoading}
        sort={sort}
        onSortToggle={onSortToggle}
        onRowActivate={(r) => setDetailToolId(r.id)}
        empty={tableEmpty(
          unitsQ.isError,
          'Nema jedinica',
          'Nema jedinica koje odgovaraju filteru. Proširite pretragu ili izaberite „Svi zapisi" u statusu.',
        )}
      />

      <Pager
        page={page}
        totalPages={totalPages}
        onPrev={() => setPage((p) => Math.max(1, p - 1))}
        onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
      />

      <ToolDetailDialog toolId={detailToolId} onClose={() => setDetailToolId(null)} />
      <IssueDialog
        open={!!issueTool}
        initialTool={issueInitialTool}
        onClose={() => setIssueTool(null)}
      />
      {manage && <ToolCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
      {manage && <InventoryGroupsDialog open={groupsOpen} onClose={() => setGroupsOpen(false)} />}
      {manage && <BulkImportDialog open={importOpen} onClose={() => setImportOpen(false)} />}
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
