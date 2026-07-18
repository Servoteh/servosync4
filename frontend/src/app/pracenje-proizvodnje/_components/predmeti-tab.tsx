'use client';

import { useMemo, useState } from 'react';
import { ChevronUp, ChevronDown, Star } from 'lucide-react';
import { SearchBox } from '@/components/ui-kit/search-box';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import { usePredmeti, useShiftPrioritet, usePlanPrioritet, normalizePredmeti, type PredmetRow } from '@/api/pracenje';

/** Aktivni predmeti — lista + ↑↓ prioritet (admin) + ⭐ plan-prioritet oznaka. */
export function PredmetiTab({ onOpenPredmet }: { onOpenPredmet: (itemId: number, rootRn?: string) => void }) {
  const q = usePredmeti();
  const planPrio = usePlanPrioritet();
  const shift = useShiftPrioritet();
  const [search, setSearch] = useState('');

  const predmeti = useMemo(() => normalizePredmeti(q.data?.data), [q.data]);
  const starred = new Set(planPrio.data?.data.ids ?? []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return predmeti;
    return predmeti.filter((p) => `${p.broj_predmeta ?? ''} ${p.naziv_predmeta ?? ''} ${p.komitent ?? ''}`.toLowerCase().includes(term));
  }, [predmeti, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Predmet / komitent…" />
        <span className="text-sm text-ink-secondary">{filtered.length} predmeta</span>
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">Učitavanje…</div>
      ) : filtered.length === 0 ? (
        <EmptyState title="Nema aktivnih predmeta" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="w-8 px-2 py-1.5" />
                <th className="w-12 px-3 py-1.5">Red. br.</th>
                <th className="px-3 py-1.5">Predmet</th>
                <th className="px-3 py-1.5">Komitent</th>
                <th className="px-3 py-1.5">Rok</th>
                <th className="px-3 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((p: PredmetRow) => {
                const id = Number(p.predmet_item_id);
                return (
                  <tr key={String(p.predmet_item_id ?? p.broj_predmeta)} className="border-b border-line-soft hover:bg-surface-2">
                    <td className="px-2 py-1.5">
                      {starred.has(id) && <Star className="h-3.5 w-3.5 fill-status-warn text-status-warn" aria-label="Prioritet" />}
                    </td>
                    <td className="tnums px-3 py-1.5 text-xs text-ink-secondary">{p.redni_broj != null ? String(p.redni_broj) : '—'}</td>
                    <td className="cursor-pointer px-3 py-1.5" onClick={() => id && onOpenPredmet(id, p.root_rn_id ? String(p.root_rn_id) : undefined)}>
                      <div className="font-medium text-ink">{p.broj_predmeta ?? '—'}</div>
                      <div className="truncate text-xs text-ink-disabled">{p.naziv_predmeta ?? ''}</div>
                    </td>
                    <td className="px-3 py-1.5">{p.komitent ?? '—'}</td>
                    <td className="px-3 py-1.5 text-xs">{formatDate(p.rok_zavrsetka)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Can permission={PERMISSIONS.PRACENJE_PRIORITET}>
                        <div className="inline-flex gap-0.5">
                          <button
                            onClick={() => id && shift.mutate({ itemId: id, direction: 'up' })}
                            className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
                            aria-label="Gore"
                          >
                            <ChevronUp className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => id && shift.mutate({ itemId: id, direction: 'down' })}
                            className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
                            aria-label="Dole"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </button>
                        </div>
                      </Can>
                    </td>
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
