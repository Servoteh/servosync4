'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import {
  useDrawings,
  useMaterialsLookup,
  useDesignersLookup,
  type Drawing,
} from '@/api/pdm';
import { formatDate, formatNumber } from '@/lib/format';
import { drawingStatusMeta, weightLabel } from './pdm-helpers';
import { DrawingDetail } from './drawing-detail';
import { AddToDraftButton } from './add-to-draft-dialog';

/** Tip crteža po prefiksu broja: K → gotova roba, M → montažni, ostalo → proizvodnja. */
function drawingTypeLabel(drawingNumber: string): string {
  const first = drawingNumber.trim().charAt(0).toUpperCase();
  if (first === 'K') return 'Gotova roba';
  if (first === 'M') return 'Montažni';
  return 'Proizvodnja';
}

const columns: Column<Drawing>[] = [
  {
    key: 'drawingNumber',
    header: 'Broj crteža',
    render: (r) => <span className="tnums font-semibold text-ink">{r.drawingNumber}</span>,
  },
  {
    key: 'revision',
    header: 'Rev.',
    render: (r) => <span className="tnums text-ink-secondary">{r.revision}</span>,
  },
  {
    key: 'type',
    header: 'Tip',
    render: (r) => (
      <span className="text-ink-secondary">{drawingTypeLabel(r.drawingNumber)}</span>
    ),
  },
  { key: 'name', header: 'Naziv', render: (r) => r.name || '—' },
  {
    key: 'material',
    header: 'Materijal',
    render: (r) => <span className="text-ink-secondary">{r.material || '—'}</span>,
  },
  {
    key: 'weight',
    header: 'Masa',
    align: 'right',
    numeric: true,
    render: (r) => weightLabel(r.weight),
  },
  {
    key: 'designedBy',
    header: 'Projektovao',
    render: (r) => <span className="text-ink-secondary">{r.designedBy || '—'}</span>,
  },
  {
    key: 'designDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.designDate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = drawingStatusMeta(r.status, r.pdmStatus);
      return (
        <span className="inline-flex items-center gap-1.5">
          <StatusBadge tone={s.tone} label={s.label} />
          {r.isProcurement && <StatusBadge tone="info" label="nabavno" />}
        </span>
      );
    },
  },
  {
    key: 'hasPdf',
    header: 'PDF',
    render: (r) =>
      r.hasPdf ? (
        <span className="text-status-success">Ima</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'actions',
    header: '',
    // stopRowActivate: klik na dugme ne sme da okine expand/collapse reda.
    render: (r) => (
      <AddToDraftButton
        target={{ drawingId: r.id, drawingNumber: r.drawingNumber, name: r.name }}
        stopRowActivate
      />
    ),
  },
];

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

export function DrawingsTab() {
  const [q, setQ] = useState('');
  const [revision, setRevision] = useState('');
  const [material, setMaterial] = useState<string | null>(null);
  const [designedBy, setDesignedBy] = useState<string | null>(null);
  const [hasPdf, setHasPdf] = useState<'' | 'yes' | 'no'>('');
  const [type, setType] = useState<'' | 'proizvodnja' | 'gotova' | 'montazni'>('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const list = useDrawings({
    page,
    q: q.trim() || undefined,
    revision: revision.trim() || undefined,
    material: material || undefined,
    designedBy: designedBy || undefined,
    hasPdf: hasPdf || undefined,
    type: type || undefined,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || revision || material || designedBy || hasPdf || type);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Broj, kat. broj, naziv…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Revizija
          <input
            value={revision}
            onChange={(e) => {
              setRevision(e.target.value);
              resetPage();
            }}
            placeholder="npr. A"
            className={`${filterInput} w-24`}
          />
        </label>
        <div className="flex w-52 flex-col gap-1 text-xs text-ink-secondary">
          Materijal
          <ComboBox<string>
            value={material}
            onChange={(m) => {
              setMaterial(m);
              resetPage();
            }}
            useSearch={useMaterialsLookup}
            getKey={(m) => m}
            getLabel={(m) => m}
            placeholder="Svi materijali…"
          />
        </div>
        <div className="flex w-52 flex-col gap-1 text-xs text-ink-secondary">
          Projektant
          <ComboBox<string>
            value={designedBy}
            onChange={(dz) => {
              setDesignedBy(dz);
              resetPage();
            }}
            useSearch={useDesignersLookup}
            getKey={(x) => x}
            getLabel={(x) => x}
            placeholder="Svi projektanti…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Tip
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value as '' | 'proizvodnja' | 'gotova' | 'montazni');
              resetPage();
            }}
            className={filterInput}
          >
            <option value="">Svi</option>
            <option value="proizvodnja">Proizvodnja</option>
            <option value="gotova">Gotova roba</option>
            <option value="montazni">Montažni</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          PDF
          <select
            value={hasPdf}
            onChange={(e) => {
              setHasPdf(e.target.value as '' | 'yes' | 'no');
              resetPage();
            }}
            className={filterInput}
          >
            <option value="">Svi</option>
            <option value="yes">Ima PDF</option>
            <option value="no">Nema PDF</option>
          </select>
        </label>
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setRevision('');
              setMaterial(null);
              setDesignedBy(null);
              setHasPdf('');
              setType('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        {meta && (
          <span className="ml-auto text-sm text-ink-secondary">
            {formatNumber(meta.total)} zapisa
          </span>
        )}
      </div>

      {list.error && (
        <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <DrawingDetail id={r.id} />}
        empty={
          <EmptyState
            title="Nema crteža"
            hint="Promeni filtere ili proveri da je PDM uvoz popunio podatke."
          />
        }
      />

      {meta && meta.totalPages > 1 && (
        <Pager
          page={meta.page}
          totalPages={meta.totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
        />
      )}
    </div>
  );
}
