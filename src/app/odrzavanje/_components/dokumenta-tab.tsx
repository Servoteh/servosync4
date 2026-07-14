'use client';

import { useState } from 'react';
import { Download, Trash2 } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Pager } from '@/components/ui-kit/pager';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { signDocumentUrl, useDeleteDocument, useDocuments, type MaintDocument, type MaintMe } from '@/api/odrzavanje';
import { deadlineTone, tableEmpty } from './common';

const ENTITY_FILTERS = ['', 'asset', 'work_order', 'incident', 'preventive_task', 'driver'] as const;
const ENTITY_LABEL: Record<string, string> = {
  asset: 'Sredstvo',
  work_order: 'Radni nalog',
  incident: 'Kvar',
  preventive_task: 'Preventiva',
  driver: 'Vozač',
};

/** Dokumenta (globalno, svi entiteti) + valid_until status. */
export function DokumentaTab({ me }: { me: MaintMe | undefined }) {
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(1);
  const docs = useDocuments({ entityType, page, pageSize: 40 });
  const del = useDeleteDocument();
  const canManage = me?.gates.canManageMaintCatalog ?? false;
  const rows = docs.data?.data ?? [];
  const meta = docs.data?.meta.pagination;

  async function open(id: string) {
    try { const res = await signDocumentUrl(id); window.open(res.data.url, '_blank'); } catch { /* ignore */ }
  }

  const cols: Column<MaintDocument>[] = [
    { key: 'file', header: 'Fajl', render: (r) => <button onClick={() => open(r.documentId)} className="flex items-center gap-2 text-accent"><Download className="h-3.5 w-3.5" aria-hidden />{r.fileName}</button> },
    { key: 'entity', header: 'Entitet', render: (r) => <span className="text-ink-secondary">{ENTITY_LABEL[r.entityType] ?? r.entityType}</span> },
    { key: 'cat', header: 'Kategorija', render: (r) => <span className="text-ink-secondary">{r.category ?? '—'}</span> },
    { key: 'valid', header: 'Važi do', render: (r) => (r.validUntil ? <StatusBadge tone={deadlineTone(r.validUntil)} label={formatDate(r.validUntil)} /> : <span className="text-ink-secondary">—</span>) },
    { key: 'up', header: 'Otpremljen', render: (r) => <span className="text-ink-secondary">{formatDate(r.uploadedAt)}</span> },
    ...(canManage ? [{ key: 'act', header: '', align: 'right' as const, render: (r: MaintDocument) => <button onClick={(e) => { e.stopPropagation(); del.mutate({ id: r.documentId }); }} className="text-ink-disabled hover:text-status-danger"><Trash2 className="h-3.5 w-3.5" aria-hidden /></button> }] : []),
  ];

  return (
    <div className="space-y-3">
      <select value={entityType} onChange={(e) => { setEntityType(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
        {ENTITY_FILTERS.map((e) => <option key={e} value={e}>{e ? ENTITY_LABEL[e] : 'Svi entiteti'}</option>)}
      </select>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.documentId} loading={docs.isLoading} empty={tableEmpty(docs.isError, 'Nema dokumenata', 'Nema dokumenata za izabrani filter.')} />
      {meta && meta.totalPages > 1 && <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />}
    </div>
  );
}
