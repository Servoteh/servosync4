'use client';

import { useState } from 'react';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useSearchDelovi } from '@/api/pracenje';

/** Pretraga delova (search_proizvodnja_delovi) → otvara RN drill-down po bigtehn RN id-ju. */
export function PretragaTab({ onOpenRnBigtehn }: { onOpenRnBigtehn: (bigtehnRnId: string) => void }) {
  const [q, setQ] = useState('');
  const search = useSearchDelovi(q);
  const rows = search.data?.data ?? [];

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
                <th className="px-3 py-1.5">Predmet</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const rnBig = r.bigtehn_rn_id ?? r.work_order_id ?? r.node_id ?? r.rn_id;
                return (
                  <tr
                    key={i}
                    className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    onClick={() => rnBig && onOpenRnBigtehn(String(rnBig))}
                  >
                    <td className="px-3 py-1.5 font-medium text-ink">{String(r.broj_crteza ?? r.drawing_no ?? '—')}</td>
                    <td className="px-3 py-1.5">{String(r.naziv_dela ?? r.naziv ?? '—')}</td>
                    <td className="px-3 py-1.5 text-xs">{String(r.rn_broj ?? r.rn_ident_broj ?? '—')}</td>
                    <td className="px-3 py-1.5 text-xs">{String(r.broj_predmeta ?? r.predmet ?? '—')}</td>
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
