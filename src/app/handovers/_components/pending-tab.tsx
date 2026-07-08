'use client';

import { useState } from 'react';
import { usePendingApprovalHandovers, useTechnologists, type Handover } from '@/api/handovers';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';
import { NativeSelect, errorBox } from './common';
import { HandoverDetailPanel } from './handover-detail';

const columns: Column<Handover>[] = [
  {
    key: 'drawing',
    header: 'Crtež',
    render: (r) => (
      <span className="tnums font-semibold text-ink">
        {r.drawing ? `${r.drawing.drawingNumber} / ${r.drawing.revision}` : '—'}
      </span>
    ),
  },
  { key: 'name', header: 'Naziv', render: (r) => r.drawing?.name || '—' },
  {
    key: 'draft',
    header: 'Nacrt',
    render: (r) => (
      <span className="tnums text-ink-secondary">{r.draftContext?.draftNumber ?? '—'}</span>
    ),
  },
  {
    key: 'quantity',
    header: 'Kom',
    align: 'right',
    numeric: true,
    render: (r) => (r.draftContext ? formatNumber(r.draftContext.quantityToProduce) : '—'),
  },
  {
    key: 'handoverDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.handoverDate)}</span>,
  },
  {
    key: 'worker',
    header: 'Predato tehnologu',
    render: (r) => <span className="text-ink-secondary">{r.handoverWorker?.fullName ?? 'svima'}</span>,
  },
];

/** Tab "Na čekanju" — tehnolog inbox (§6.5): status U OBRADI, dugmad Odobri/Odbij/Lansiraj u expand-u. */
export function PendingTab() {
  const [q, setQ] = useState('');
  const [handoverWorkerId, setHandoverWorkerId] = useState<number | ''>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const technologists = useTechnologists();
  const list = usePendingApprovalHandovers({
    page,
    drawingNumber: q.trim() || undefined,
    handoverWorkerId,
    from: from || undefined,
    to: to || undefined,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

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
            placeholder="Broj crteža…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Za tehnologa
          <NativeSelect
            value={handoverWorkerId}
            onChange={(e) => {
              setHandoverWorkerId(e.target.value === '' ? '' : Number(e.target.value));
              resetPage();
            }}
          >
            <option value="">Svi</option>
            {(technologists.data?.data ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName ?? t.username}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Predato od
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
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
            className="rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
          />
        </label>
        {(q || handoverWorkerId !== '' || from || to) && (
          <button
            onClick={() => {
              setQ('');
              setHandoverWorkerId('');
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
            {formatNumber(meta.total)} čeka odobravanje
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
        renderExpanded={(r) => <HandoverDetailPanel handover={r} />}
        empty={
          <EmptyState
            title="Nema primopredaja na čekanju"
            hint="Sve predate primopredaje su obrađene."
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
