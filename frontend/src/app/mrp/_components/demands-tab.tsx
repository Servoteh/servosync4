'use client';

import { useState } from 'react';
import { useMrpDemands, type MrpDemand } from '@/api/mrp';
import { useProjectsLookup, type ProjectLookup } from '@/api/lookups';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate, formatNumber } from '@/lib/format';
import { ComingSoonNote, errorBox, planMeta, qtyLabel, sourceLabel } from './common';
import { DemandDetail } from './demand-detail';

const columns: Column<MrpDemand>[] = [
  {
    key: 'id',
    header: 'Potreba',
    render: (r) => <span className="tnums font-semibold text-ink">#{r.id}</span>,
  },
  {
    key: 'project',
    header: 'Predmet',
    render: (r) => (r.project ? r.project.projectNumber : r.projectId ? `#${r.projectId}` : '—'),
  },
  {
    key: 'rootDrawing',
    header: 'Koren crteža',
    render: (r) => (
      <span className="tnums text-ink-secondary">{r.rootDrawing?.drawingNumber ?? '—'}</span>
    ),
  },
  {
    key: 'demandDate',
    header: 'Datum potrebe',
    render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.demandDate)}</span>,
  },
  {
    key: 'source',
    header: 'Izvor',
    render: (r) => <span className="text-ink-secondary">{sourceLabel(r.source)}</span>,
  },
  {
    key: 'itemsCount',
    header: 'Stavki',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.itemsCount),
  },
  {
    key: 'plannedQuantity',
    header: 'Planirano',
    align: 'right',
    numeric: true,
    render: (r) => qtyLabel(r.plannedQuantity),
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = planMeta(r.planId);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'worker',
    header: 'Otvorio',
    render: (r) => <span className="text-ink-secondary">{r.worker?.fullName ?? '—'}</span>,
  },
];

const dateInput = 'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

export function DemandsTab() {
  const [q, setQ] = useState('');
  const [project, setProject] = useState<ProjectLookup | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const list = useMrpDemands({
    page,
    q: q.trim() || undefined,
    projectId: project?.id ?? '',
    from: from || undefined,
    to: to || undefined,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || project || from || to);

  return (
    <div className="space-y-4">
      <ComingSoonNote
        title="Planiranje nabavke i BOM eksplozija dolaze u sledećoj fazi."
        hint="Ovde je samo uvid u već evidentirane potrebe i njihove stavke — bez izmena."
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Napomena…"
          />
        </div>
        <div className="flex w-52 flex-col gap-1 text-xs text-ink-secondary">
          Predmet
          <ComboBox<ProjectLookup>
            value={project}
            onChange={(p) => {
              setProject(p);
              resetPage();
            }}
            useSearch={useProjectsLookup}
            getKey={(p) => p.id}
            getLabel={(p) => p.projectNumber}
            getSublabel={(p) => p.projectName ?? ''}
            placeholder="Broj/naziv predmeta…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Potreba od
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
            className={dateInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          do
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPage();
            }}
            className={dateInput}
          />
        </label>
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setProject(null);
              setFrom('');
              setTo('');
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

      {list.error && <div className={errorBox}>{(list.error as Error).message}</div>}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <DemandDetail id={r.id} />}
        empty={
          <EmptyState
            title="Nema MRP potreba"
            hint="Promeni filtere ili proveri da je sync popunio potrebe."
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
