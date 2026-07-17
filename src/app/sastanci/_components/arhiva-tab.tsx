'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileDown, Printer } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import {
  fetchArhivaPdfUrl,
  fetchSastanakFull,
  fetchSlikaUrl,
  sastanakFullQueryKey,
  useArhive,
  type Arhiva,
  type SastanakFull,
} from '@/api/sastanci';
import { formatDateTime } from '@/lib/format';
import { printZapisnik } from '@/lib/sastanci-print';
import { toast } from '@/lib/toast';
import { tableEmpty } from './common';
import { useDetailNav } from './detail-nav';

/** Snapshot je upotrebljiv za štampu samo ako nosi tačke zapisnika — 2.0 lock
 *  snapshot (schemaVersion 2, DB RPC) ima aktivnosti/akcije/pmTeme = [] pa bi
 *  štampa iz njega bila skoro prazna (samo meta zaglavlje). */
function snapshotImaAktivnosti(snap: Record<string, unknown> | null | undefined): boolean {
  if (!snap) return false;
  const akt = snap['aktivnosti'];
  return Array.isArray(akt) && akt.length > 0;
}

/** SastanakFull → oblik `sastanak_arhiva.snapshot` koji printZapisnik čita
 *  (camelCase ključevi — `pick(camel, snake)` u sastanci-print ih razume).
 *  pmTeme nisu deo full odgovora → sekcija „Dnevni red" se izostavlja. */
function liveSnapshotZaPrint(
  full: SastanakFull,
  slike: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    sastanak: full,
    ucesnici: full.ucesnici,
    aktivnosti: full.aktivnosti,
    akcije: full.akcije,
    pmTeme: [],
    slike,
  };
}

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

  /** Štampaj zapisnik: pun (1.0) snapshot direktno; okrnjen 2.0 snapshot →
   *  dohvati ŽIVE podatke (deli query keš sa detaljem) i sagradi print iz njih;
   *  ako su i živi prazni → toast umesto skoro prazne štampe. */
  async function stampaj(r: Arhiva) {
    if (snapshotImaAktivnosti(r.snapshot)) {
      printZapisnik(r.snapshot);
      return;
    }
    if (printBusyId) return;
    setPrintBusyId(r.id);
    try {
      const res = await qc.fetchQuery({
        queryKey: sastanakFullQueryKey(r.sastanakId),
        queryFn: () => fetchSastanakFull(r.sastanakId),
      });
      const full = res.data;
      if (!full || (full.aktivnosti.length === 0 && full.akcije.length === 0)) {
        toast('Nema podataka za štampu — snapshot i živi zapisnik su prazni.');
        return;
      }
      // Signed URL po slici za sekciju „Foto dokumentacija"; slika kojoj
      // potpisivanje padne se preskače (štampa ne sme da padne zbog priloga).
      const slike = (
        await Promise.all(
          full.slike.map(async (s) => {
            try {
              const u = await fetchSlikaUrl(s.id);
              return { ...s, signedUrl: u.data.url } as Record<string, unknown>;
            } catch {
              return null;
            }
          }),
        )
      ).filter((s): s is Record<string, unknown> => s !== null);
      printZapisnik(liveSnapshotZaPrint(full, slike));
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Ne mogu da učitam podatke za štampu.');
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
