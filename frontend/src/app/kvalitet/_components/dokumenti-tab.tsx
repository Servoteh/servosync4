'use client';

// Tab „Dokumenti" (K4): centralni registar QC dokumenata (skenirani nalozi,
// kontrolna dokumentacija, fotke). Upload kroz aplikaciju → PostgreSQL (bytea);
// bez share-a/mount-a (odluka 15.07). Toolbar „Dodaj fajl" + pretraga/period +
// lista sa akcijama Otvori / Obriši. reportId/techProcessId vezivanje ide sa
// drugih mesta (detalj izveštaja, Realizacija); ovde je opciona veza za RN.

import { useState } from 'react';
import { Paperclip, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Can, useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useQualityDocs, type QualityDoc } from '@/api/kvalitet';
import {
  AddDocDialog,
  DeleteDocConfirm,
  OpenDocButton,
  formatDocSize,
} from './documents-shared';

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

export function DokumentiTab() {
  const can = useCan();
  const canWrite = can(PERMISSIONS.KVALITET_WRITE);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<QualityDoc | null>(null);
  const resetPage = () => setPage(1);

  const list = useQualityDocs({
    q: q.trim() || undefined,
    from: from || undefined,
    to: to || undefined,
    page,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const hasFilter = !!(q || from || to);

  const columns: Column<QualityDoc>[] = [
    {
      key: 'fileName',
      header: 'Naziv',
      render: (d) => (
        <span className="text-ink" title={d.fileName}>
          {d.fileName}
        </span>
      ),
    },
    { key: 'identNumber', header: 'RN', render: (d) => <span className="tnums">{d.identNumber || '—'}</span> },
    {
      key: 'sizeKb',
      header: 'Veličina',
      align: 'right',
      numeric: true,
      render: (d) => formatDocSize(d.sizeKb),
    },
    {
      key: 'uploadedBy',
      header: 'Dodao',
      render: (d) => <span className="text-ink-secondary">{d.uploadedBy || '—'}</span>,
    },
    {
      key: 'createdAt',
      header: 'Datum',
      render: (d) => <span className="tnums text-ink-secondary">{formatDateTime(d.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (d) => (
        <div className="flex items-center justify-end gap-1.5">
          <OpenDocButton id={d.id} />
          {canWrite && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPendingDelete(d);
              }}
              className="rounded-control border border-status-danger/40 p-1 text-status-danger hover:bg-status-danger/10"
              aria-label="Obriši dokument"
              title="Obriši dokument"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      ),
    },
  ];

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
            placeholder="Naziv fajla, RN…"
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
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
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
            <span className="text-sm text-ink-secondary">{formatNumber(meta.total)} dokumenata</span>
          )}
          <Can permission={PERMISSIONS.KVALITET_WRITE}>
            <Button onClick={() => setAddOpen(true)}>
              <Paperclip className="h-4 w-4" aria-hidden />
              Dodaj fajl
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
        rowKey={(d) => d.id}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="Nema dokumenata"
            hint="Promeni filtere ili dodaj novi QC dokument."
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

      <AddDocDialog open={addOpen} onClose={() => setAddOpen(false)} showIdentField />
      <DeleteDocConfirm doc={pendingDelete} onClose={() => setPendingDelete(null)} />
    </div>
  );
}
