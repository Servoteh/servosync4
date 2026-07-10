'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useReversiDocument,
  useReversiDocuments,
  type ReversiDocument,
} from '@/api/reversi';
import { DOC_TYPE_LABEL, DocStatusBadge, LineStatusBadge } from './common';

const STATUS_FILTERS = [
  { key: '', label: 'Svi' },
  { key: 'OPEN', label: 'Otvoreni' },
  { key: 'PARTIALLY_RETURNED', label: 'Delimično vraćeni' },
  { key: 'RETURNED', label: 'Vraćeni' },
] as const;

function recipientLabel(d: ReversiDocument): string {
  if (d.recipientType === 'EMPLOYEE') return d.recipientEmployeeName ?? '—';
  if (d.recipientType === 'DEPARTMENT') return d.recipientDepartment ?? '—';
  return d.recipientCompanyName ?? '—';
}

/** Lista reversa (read paritet 1.0 zaduzenjaPanel) + detalj stavki na Enter/klik. */
export function DokumentiTab() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);

  const docs = useReversiDocuments({ q: q || undefined, status: status || undefined, page, pageSize: 50 });
  const detail = useReversiDocument(openId);
  const meta = docs.data?.meta.pagination;

  const cols: Column<ReversiDocument>[] = [
    { key: 'doc', header: 'Broj', render: (r) => <span className="tnums font-medium">{r.docNumber}</span> },
    { key: 'type', header: 'Tip', render: (r) => DOC_TYPE_LABEL[r.docType] ?? r.docType },
    { key: 'recipient', header: 'Primalac', render: (r) => recipientLabel(r) },
    { key: 'issued', header: 'Izdato', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.issuedAt)}</span> },
    { key: 'due', header: 'Rok vraćanja', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.expectedReturnDate)}</span> },
    { key: 'status', header: 'Status', render: (r) => <DocStatusBadge status={r.status} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox
          value={q}
          onChange={(v) => {
            setQ(v);
            setPage(1);
          }}
          placeholder="Broj reversa, radnik, odeljenje, firma…"
        />
        <div className="flex gap-1">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => {
                setStatus(f.key);
                setPage(1);
              }}
              className={
                status === f.key
                  ? 'rounded-control bg-accent px-2.5 py-1 text-xs font-medium text-white'
                  : 'rounded-control border border-line px-2.5 py-1 text-xs text-ink-secondary hover:bg-surface-raised'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={docs.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={docs.isLoading}
        onRowActivate={(r) => setOpenId((cur) => (cur === r.id ? null : r.id))}
        expandedKey={openId}
        renderExpanded={() =>
          detail.isLoading ? (
            <div className="p-3 text-sm text-ink-secondary">Učitavanje stavki…</div>
          ) : (
            <div className="space-y-1 p-3">
              {(detail.data?.data.lines ?? []).map((l) => (
                <div key={l.id} className="flex items-center gap-3 text-sm">
                  <span className="min-w-28 font-medium">{l.tool?.oznaka ?? l.drawingNo ?? '—'}</span>
                  <span className="flex-1 text-ink-secondary">{l.tool?.naziv ?? l.partName ?? ''}</span>
                  <span className="tnums">
                    {formatNumber(Number(l.returnedQuantity))}/{formatNumber(Number(l.quantity))} {l.unit}
                  </span>
                  <LineStatusBadge status={l.lineStatus} />
                </div>
              ))}
              {detail.data?.data.napomena && (
                <div className="pt-1 text-xs text-ink-secondary">Napomena: {detail.data.data.napomena}</div>
              )}
            </div>
          )
        }
        empty={<EmptyState title="Nema reversa" hint="Nijedan dokument ne odgovara filterima." />}
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
