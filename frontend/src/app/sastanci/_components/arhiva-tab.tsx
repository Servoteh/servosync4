'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileDown, Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { fetchArhivaPdfUrl, useArhive, type Arhiva } from '@/api/sastanci';
import { formatDateTime } from '@/lib/format';
import { tableEmpty } from './common';
import { snapshotImaAktivnosti, stampajZapisnik } from './print-zapisnik';
import { useDetailNav } from './detail-nav';

/** Arhiva zaključanih sastanaka — lista + PDF download (paritet 1.0 arhivaTab). */
export function ArhivaTab() {
  const nav = useDetailNav();
  const qc = useQueryClient();
  const arhQ = useArhive();
  const rows = arhQ.data?.data ?? [];
  const [printBusyId, setPrintBusyId] = useState<string | null>(null);

  async function downloadPdf(sastanakId: string) {
    try {
      const res = await fetchArhivaPdfUrl(sastanakId);
      if (res.data?.url) window.open(res.data.url, '_blank', 'noopener');
    } catch (e) {
      alert(e instanceof Error ? e.message : 'PDF nije dostupan.');
    }
  }

  /** Štampaj zapisnik (deljeni helper, S1): pun snapshot → direktno, PRE busy
   *  guarda i bez busy stanja (kao raniji inline tok — sme i dok drugi red
   *  učitava); okrnjen → živi podaci + potpisane slike uz busy guard. */
  async function stampaj(r: Arhiva) {
    if (snapshotImaAktivnosti(r.snapshot)) {
      await stampajZapisnik(qc, r.sastanakId, r.snapshot);
      return;
    }
    if (printBusyId) return;
    setPrintBusyId(r.id);
    try {
      await stampajZapisnik(qc, r.sastanakId, r.snapshot);
    } finally {
      setPrintBusyId(null);
    }
  }

  const cols: Column<Arhiva>[] = [
    {
      key: 'naslov',
      header: 'Sastanak',
      render: (r) => {
        // Snapshot drži sastanak pod `sastanak` ključem (1.0 saveSnapshot/RPC);
        // `naslov` na korenu je tolerancija za starije/ručne redove.
        const snap = r.snapshot as { naslov?: string; sastanak?: { naslov?: string } } | null;
        return <span className="font-medium">{snap?.sastanak?.naslov ?? snap?.naslov ?? r.sastanakId.slice(0, 8)}</span>;
      },
    },
    { key: 'arh', header: 'Arhivirano', render: (r) => <span className="tnums text-ink-secondary">{formatDateTime(r.arhiviranoAt)}</span> },
    { key: 'ko', header: 'Arhivirao', render: (r) => <span className="text-ink-secondary">{r.arhiviraoLabel || r.arhiviraoEmail || '—'}</span> },
    {
      key: 'pdf',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            title="Štampaj zapisnik"
            disabled={printBusyId === r.id}
            className="flex items-center gap-1 rounded-control border border-line px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-60"
            onClick={() => void stampaj(r)}
          >
            <Printer className="h-3.5 w-3.5" aria-hidden /> {printBusyId === r.id ? 'Učitavam…' : 'Štampaj'}
          </button>
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
