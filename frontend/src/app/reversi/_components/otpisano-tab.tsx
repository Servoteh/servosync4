'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Button } from '@/components/ui-kit/button';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { newClientEventId, useRestoreTool, useScrapped, type ScrappedRow } from '@/api/reversi';
import { tableEmpty } from './common';
import { ToolDetailDialog } from './tool-detail-dialog';

/** Nabavna/trošak → „X din" (paritet 1.0 fmtDin — 0 i prazno = „—"). */
function fmtDin(n: string | number | null | undefined): string {
  if (n == null || n === '') return '—';
  const v = Number(n);
  if (!isFinite(v) || v === 0) return '—';
  return `${v.toLocaleString('sr-RS', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} din`;
}

/** Klasifikacija „grupa · podgrupa" (paritet 1.0 — inače „Nesvrstano"). */
function classPath(r: ScrappedRow): string {
  const parts = [r.group_label, r.subgroup_label].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'Nesvrstano';
}

/**
 * Otpisan/izgubljen alat (v_rev_otpisani_alat — manage-only tab, paritet 1.0
 * `reversiScrappedTab`). Klijentska pretraga (RB-50) + inline „Otvori"/„♻ Vrati"
 * (RB-51 restore poništava otpis i vraća zalihu). Klik na red → kartica alata.
 */
export function OtpisanoTab() {
  const { can } = useAuth();
  const manage = can(PERMISSIONS.REVERSI_MANAGE);
  const scrapped = useScrapped();
  const restore = useRestoreTool();
  const [q, setQ] = useState('');
  const [toolId, setToolId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = scrapped.data?.data ?? [];
    if (!q.trim()) return all;
    const t = q.trim().toLowerCase();
    return all.filter((r) =>
      [r.oznaka, r.naziv, r.barcode, r.serijski_broj, r.group_label, r.subgroup_label, r.otpis_razlog]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [scrapped.data, q]);

  async function doRestore(r: ScrappedRow) {
    if (restore.isPending) return;
    if (!window.confirm('Vrati alat u upotrebu (poništi otpis)?')) return;
    try {
      const res = await restore.mutateAsync({ clientEventId: newClientEventId(), toolId: r.id });
      const restored = Number((res.data as { stock_restored?: number } | null)?.stock_restored) || 0;
      toast(restored > 0 ? `Alat vraćen u upotrebu (zaliha +${restored})` : 'Alat vraćen u upotrebu');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Vraćanje nije uspelo.');
    }
  }

  const cols: Column<ScrappedRow>[] = [
    {
      key: 'oznaka',
      header: 'Oznaka',
      render: (r) => (
        <div className="flex flex-col leading-tight">
          <span className="font-medium tnums">{r.oznaka || '—'}</span>
          {r.barcode && <span className="text-2xs tnums text-ink-secondary">{r.barcode}</span>}
        </div>
      ),
    },
    { key: 'klasa', header: 'Klasifikacija', render: (r) => <StatusBadge tone="neutral" label={classPath(r)} /> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv || '—' },
    {
      key: 'vrsta',
      header: 'Vrsta',
      render: (r) =>
        r.status === 'lost' ? (
          <StatusBadge tone="warn" label="Izgubljen" />
        ) : (
          <StatusBadge tone="danger" label="Otpisan" />
        ),
    },
    { key: 'datum', header: 'Datum otpisa', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.otpis_datum)}</span> },
    { key: 'razlog', header: 'Razlog', render: (r) => <span className="text-ink-secondary">{r.otpis_razlog || '—'}</span> },
    {
      key: 'servis',
      header: 'Trošak popravki',
      align: 'right',
      numeric: true,
      render: (r) =>
        r.broj_servisa ? `${r.broj_servisa}× (${fmtDin(r.ukupan_servis_trosak)})` : '—',
    },
    {
      key: 'akcije',
      header: '',
      render: (r) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()} role="presentation">
          <button
            type="button"
            className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2"
            onClick={() => setToolId(r.id)}
          >
            Otvori
          </button>
          {manage && (
            <button
              type="button"
              disabled={restore.isPending}
              className="rounded-control border border-line px-2 py-0.5 text-xs hover:bg-surface-2 disabled:opacity-50"
              onClick={() => void doRestore(r)}
            >
              ♻ Vrati
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SearchBox value={q} onChange={setQ} placeholder="Pretraga otpisanog alata…" />
        <span className="whitespace-nowrap text-sm text-ink-secondary">
          Ukupno: <strong className="text-ink">{rows.length}</strong>
        </span>
      </div>
      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={scrapped.isLoading}
        onRowActivate={(r) => setToolId(r.id)}
        empty={tableEmpty(
          scrapped.isError,
          'Nema otpisanog alata',
          'Alat se otpisuje sa kartice alata (dugme „Otpiši alat").',
        )}
      />
      <ToolDetailDialog toolId={toolId} onClose={() => setToolId(null)} />
    </div>
  );
}
