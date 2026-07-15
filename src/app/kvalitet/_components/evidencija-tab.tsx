'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useNonconformityReports,
  type NonconformityReport,
  type NonconformityType,
} from '@/api/kvalitet';
import { culpritSummary } from './helpers';
import { ReportDetail } from './report-detail';
import { NewReportDialog } from './report-dialog';

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

const columns: Column<NonconformityReport>[] = [
  {
    key: 'reportNumber',
    header: 'Br. izveštaja',
    render: (r) =>
      r.reportNumber ? (
        <span className="tnums font-semibold text-ink">{r.reportNumber}</span>
      ) : (
        <StatusBadge tone="warn" label="Nacrt" />
      ),
  },
  {
    key: 'reportDate',
    header: 'Datum',
    render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.reportDate)}</span>,
  },
  {
    key: 'identNumber',
    header: 'RN',
    render: (r) => <span className="tnums">{r.identNumber || '—'}</span>,
  },
  {
    key: 'drawingNumber',
    header: 'Crtež',
    render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber || '—'}</span>,
  },
  { key: 'partName', header: 'Naziv pozicije', render: (r) => r.partName || '—' },
  {
    key: 'customerName',
    header: 'Kupac',
    render: (r) => <span className="text-ink-secondary">{r.customerName || '—'}</span>,
  },
  {
    key: 'quantity',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => formatNumber(r.quantity),
  },
  {
    key: 'workUnit',
    header: 'Radna jedinica',
    render: (r) => <span className="text-ink-secondary">{r.workUnit || '—'}</span>,
  },
  {
    key: 'culprits',
    header: 'Izvršioci',
    render: (r) => culpritSummary(r) || '—',
  },
  {
    key: 'raisedBy',
    header: 'Ističe',
    render: (r) => <span className="text-ink-secondary">{r.raisedBy?.fullName || '—'}</span>,
  },
];

/** Zajednička evidencija — `type` (1 dorada / 2 škart) određuje tab i filter. */
export function EvidencijaTab({ type }: { type: NonconformityType }) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | '0' | '1'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const resetPage = () => setPage(1);

  const list = useNonconformityReports({
    type,
    page,
    q: q.trim() || undefined,
    status: status || undefined,
    from: from || undefined,
    to: to || undefined,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || status || from || to);

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
            placeholder="RN, crtež, pozicija, kupac…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period od
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period do
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPage();
            }}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Status
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | '0' | '1');
              resetPage();
            }}
            className={filterInput}
          >
            <option value="">Svi</option>
            <option value="0">Nacrti</option>
            <option value="1">Potvrđeni</option>
          </select>
        </label>
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setStatus('');
              setFrom('');
              setTo('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          {meta && (
            <span className="text-sm text-ink-secondary">{formatNumber(meta.total)} zapisa</span>
          )}
          <Can permission={PERMISSIONS.KVALITET_WRITE}>
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi izveštaj
            </Button>
          </Can>
        </div>
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
        renderExpanded={(r) => <ReportDetail report={r} />}
        empty={
          <EmptyState
            title="Nema izveštaja"
            hint="Promeni filtere ili dodaj novi izveštaj o neusaglašenosti."
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

      <NewReportDialog open={newOpen} onClose={() => setNewOpen(false)} type={type} />
    </div>
  );
}
