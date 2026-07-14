'use client';

import { useState } from 'react';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useSearchDelovi } from '@/api/pracenje';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pretraga delova (search_proizvodnja_delovi) → otvara RN drill-down. Živi RPC vraća
 * `bigtehn_work_order_id` (bigint MES id) i `rn_id` (uuid Faza-2 RN, NULL za bigtehn pogodak).
 * MES pogodak (rn_id uuid) ide direktno; inače ensure-from-bigtehn preko bigtehn_work_order_id.
 */
export function PretragaTab({
  onOpenRnBigtehn,
  onOpenRnUuid,
}: {
  onOpenRnBigtehn: (bigtehnRnId: string) => void;
  onOpenRnUuid: (rnId: string) => void;
}) {
  const [q, setQ] = useState('');
  const search = useSearchDelovi(q);
  const rows = search.data?.data ?? [];

  function openRow(r: Record<string, unknown>) {
    const rnId = r.rn_id;
    if (typeof rnId === 'string' && UUID_RE.test(rnId)) {
      onOpenRnUuid(rnId);
      return;
    }
    const wo = r.bigtehn_work_order_id;
    if (wo != null && wo !== '') onOpenRnBigtehn(String(wo));
  }

  return (
    <div className="space-y-3">
      <SearchBox value={q} onChange={setQ} placeholder="Crtež / naziv dela / RN…" />
      {q.trim().length < 2 ? (
        <EmptyState title="Ukucaj bar 2 znaka" />
      ) : search.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Pretraga…</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nema rezultata" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="px-3 py-1.5">Crtež</th>
                <th className="px-3 py-1.5">Naziv</th>
                <th className="px-3 py-1.5">RN</th>
                <th className="px-3 py-1.5">Koordinator</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rev = r.revision ? ` (${String(r.revision)})` : '';
                return (
                  <tr
                    key={i}
                    className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    onClick={() => openRow(r)}
                  >
                    <td className="px-3 py-1.5 font-medium text-ink">
                      {r.drawing_no ? `${String(r.drawing_no)}${rev}` : '—'}
                    </td>
                    <td className="px-3 py-1.5">{String(r.naziv ?? '—')}</td>
                    <td className="px-3 py-1.5 text-xs">{String(r.rn_broj ?? '—')}</td>
                    <td className="px-3 py-1.5 text-xs">{String(r.koordinator ?? '—')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
