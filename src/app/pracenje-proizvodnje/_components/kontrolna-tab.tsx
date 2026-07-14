'use client';

import { useMemo, useState } from 'react';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { KpiTile } from '@/components/ui-kit/tabs';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { usePortfolio, type PortfolioItem } from '@/api/pracenje';

const KPI_LABELS: Record<string, string> = {
  total: 'Predmeta',
  ukupno: 'Predmeta',
  kasni: 'Kasni',
  na_vreme: 'Na vreme',
  bez_podataka: 'Bez podataka',
  usko_grlo: 'Uska grla',
  problemi: 'Problemi',
};

function pctTone(pct: number | null | undefined): Tone {
  const p = Number(pct ?? 0);
  if (p >= 90) return 'success';
  if (p >= 50) return 'info';
  if (p >= 20) return 'warn';
  return 'danger';
}

/** Kontrolna tabla — portfolio rollup po aktivnom predmetu (KPI + tabela + filter/sort). */
export function KontrolnaTab({ onOpenPredmet }: { onOpenPredmet: (itemId: number, rootRn?: string) => void }) {
  const q = usePortfolio();
  const data = q.data?.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const [search, setSearch] = useState('');
  const [kasniOnly, setKasniOnly] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items
      .filter((it) => {
        if (kasniOnly && !Number(it.count_kasni)) return false;
        if (term && !`${it.broj_predmeta ?? ''} ${it.naziv_predmeta ?? ''} ${it.komitent ?? ''}`.toLowerCase().includes(term))
          return false;
        return true;
      })
      .sort((a, b) => Number(a.sort_priority ?? 999) - Number(b.sort_priority ?? 999));
  }, [items, search, kasniOnly]);

  const kpi = data?.kpi ?? {};
  const kpiEntries = Object.entries(kpi).filter(([, v]) => typeof v === 'number' || typeof v === 'string');

  return (
    <div className="space-y-4">
      {kpiEntries.length > 0 && (
        <div className="flex flex-wrap gap-3">
          {kpiEntries.map(([k, v]) => (
            <KpiTile key={k} value={String(v)} label={KPI_LABELS[k] ?? k} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={search} onChange={setSearch} placeholder="Predmet / komitent…" />
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={kasniOnly} onChange={(e) => setKasniOnly(e.target.checked)} /> Samo koji kasne
        </label>
        <span className="text-sm text-ink-secondary">{filtered.length} predmeta</span>
        {data?.generated_at && (
          <span className="ml-auto text-xs text-ink-disabled">osveženo {new Date(data.generated_at).toLocaleTimeString('sr-RS')}</span>
        )}
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
                <th className="px-3 py-1.5">Predmet</th>
                <th className="px-3 py-1.5">Komitent</th>
                <th className="px-3 py-1.5">Napredak</th>
                <th className="px-3 py-1.5">Rok</th>
                <th className="px-3 py-1.5">Usko grlo</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((it: PortfolioItem) => (
                <tr
                  key={String(it.predmet_item_id ?? it.broj_predmeta)}
                  className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                  onClick={() => it.predmet_item_id && onOpenPredmet(Number(it.predmet_item_id))}
                >
                  <td className="px-3 py-1.5">
                    <div className="font-medium text-ink">{it.broj_predmeta ?? '—'}</div>
                    <div className="truncate text-xs text-ink-disabled">{it.naziv_predmeta ?? ''}</div>
                  </td>
                  <td className="px-3 py-1.5">{it.komitent ?? '—'}</td>
                  <td className="px-3 py-1.5">
                    {it.bez_podataka ? (
                      <StatusBadge tone="neutral" label="Bez podataka" />
                    ) : (
                      <StatusBadge tone={pctTone(it.op_pct)} label={`${Math.round(Number(it.op_pct ?? 0))}%`} />
                    )}
                  </td>
                  <td className="tnums px-3 py-1.5 text-xs">
                    {it.dani_do_roka == null ? '—' : Number(it.dani_do_roka) < 0 ? (
                      <span className="text-status-danger">kasni {Math.abs(Number(it.dani_do_roka))}d</span>
                    ) : (
                      `za ${it.dani_do_roka}d`
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-xs text-ink-secondary">{it.usko_grlo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
