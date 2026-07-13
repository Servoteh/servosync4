'use client';

import { FileDown } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { fetchArhivaPdfUrl, useArhive, type Arhiva } from '@/api/sastanci';
import { formatDateTime } from '@/lib/format';
import { tableEmpty } from './common';
import { useDetailNav } from './detail-nav';

/** Arhiva zaključanih sastanaka — lista + PDF download (paritet 1.0 arhivaTab). */
export function ArhivaTab() {
  const nav = useDetailNav();
  const arhQ = useArhive();
  const rows = arhQ.data?.data ?? [];

  async function downloadPdf(sastanakId: string) {
    try {
      const res = await fetchArhivaPdfUrl(sastanakId);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PDF nije dostupan.');
    }
  }

  const cols: Column<Arhiva>[] = [
    {
      key: 'naslov',
      header: 'Sastanak',
      render: (r) => {
        const snap = r.snapshot as { naslov?: string } | null;
        return <span className="font-medium">{snap?.naslov ?? r.sastanakId.slice(0, 8)}</span>;
      },
    },
    { key: 'arh', header: 'Arhivirano', render: (r) => <span className="tnums text-ink-secondary">{formatDateTime(r.arhiviranoAt)}</span> },
    { key: 'ko', header: 'Arhivirao', render: (r) => <span className="text-ink-secondary">{r.arhiviraoLabel || r.arhiviraoEmail || '—'}</span> },
    {
      key: 'pdf',
      header: '',
      render: (r) => (
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {r.zapisnikStoragePath ? (
            <button
              title="Preuzmi PDF zapisnika"
              className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-accent hover:bg-surface-2"
              onClick={() => void downloadPdf(r.sastanakId)}
            >
              <FileDown className="h-3.5 w-3.5" aria-hidden /> PDF
            </button>
          ) : (
            <span className="text-xs text-ink-disabled">bez PDF-a</span>
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      loading={arhQ.isLoading}
      onRowActivate={(r) => nav.open(r.sastanakId)}
      empty={tableEmpty(arhQ.isError, 'Arhiva je prazna', 'Zaključani sastanci sa PDF zapisnikom pojaviće se ovde.')}
    />
  );
}
