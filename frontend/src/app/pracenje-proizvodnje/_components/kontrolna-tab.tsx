'use client';

import { useMemo, useState } from 'react';
import { RefreshCw, Star, ChevronUp, ChevronDown } from 'lucide-react';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { KpiTile } from '@/components/ui-kit/tabs';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { usePortfolio, usePlanPrioritet, type PortfolioItem } from '@/api/pracenje';
import {
  clampPct,
  filterPortfolioItems,
  portfolioKomitenti,
  portfolioStatusMeta,
  sortPortfolioItems,
  type PortfolioFilters,
  type PortfolioSortKey,
  type SortDir,
} from '@/lib/pracenje-portfolio';

/** 7 imenovanih KPI kartica (PR-12) — ključ RPC-a → labela + ton + tooltip. */
const KPI_CARDS: Array<{
  key: string;
  label: string;
  tone: 'ink' | 'info' | 'warn' | 'danger' | 'success';
  title?: (k: Record<string, unknown>) => string;
}> = [
  { key: 'ukupno_predmeta', label: 'Aktivnih predmeta', tone: 'ink' },
  { key: 'u_toku', label: 'U toku', tone: 'success' },
  { key: 'kasni', label: 'Kasni', tone: 'danger', title: () => 'Predmeti sa bar jednom zakasnelom pozicijom' },
  { key: 'na_cekanju', label: 'Na čekanju', tone: 'warn' },
  { key: 'zavrseno', label: 'Završeno', tone: 'info' },
  {
    key: 'predmeti_sa_problemima',
    label: 'Sa problemima',
    tone: 'warn',
    title: (k) => `Ukupno problema: ${Number(k.problemi_total ?? 0)} (nema TP / crtež / završnu kontrolu)`,
  },
  {
    key: 'prosecan_op_napredak',
    label: 'Prosečan napredak',
    tone: 'ink',
    title: () => 'Prosek operacionog napretka po predmetu',
  },
];

const STATUS_OPTS: Array<[string, string]> = [
  ['sve', 'Svi statusi'],
  ['kasni', 'Kasni'],
  ['u_toku', 'U toku'],
  ['na_cekanju', 'Na čekanju'],
  ['zavrseno', 'Završeno'],
  ['bez_podataka', 'Bez podataka'],
];

/** Klik-sortirljive kolone (PR-10) — key iz sortPortfolioItems + labela. */
const SORT_COLS: Array<{ key: PortfolioSortKey; label: string }> = [
  { key: 'prioritet', label: 'Prioritet' },
  { key: 'naziv', label: 'Predmet' },
  { key: 'napredak', label: 'Napredak' },
  { key: 'problemi', label: 'Problemi' },
  { key: 'kasni', label: 'Kasni' },
  { key: 'rok', label: 'Rok' },
];

const EMPTY_FILTERS: PortfolioFilters = { search: '', komitent: '', status: 'sve', onlyKasni: false, onlyProblemi: false };

function itemId(it: PortfolioItem): number {
  return Number(it.item_id ?? it.predmet_item_id ?? NaN);
}

/** Kontrolna tabla (ekran 0) — portfolio rollup: 7 KPI + filteri + klik-sort + puna tabela. */
export function KontrolnaTab({ onOpenPredmet }: { onOpenPredmet: (itemId: number, rootRn?: string) => void }) {
  const q = usePortfolio();
  const prioritet = usePlanPrioritet();
  const data = q.data?.data;
  const items = useMemo(() => data?.items ?? [], [data]);

  const [filters, setFilters] = useState<PortfolioFilters>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<PortfolioSortKey>('prioritet');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const prioIds = useMemo(() => new Set((prioritet.data?.data.ids ?? []).map(Number)), [prioritet.data]);
  const komitenti = useMemo(() => portfolioKomitenti(items), [items]);

  const rows = useMemo(
    () => sortPortfolioItems(filterPortfolioItems(items, filters), sortKey, sortDir),
    [items, filters, sortKey, sortDir],
  );

  function setF<K extends keyof PortfolioFilters>(k: K, v: PortfolioFilters[K]) {
    setFilters((prev) => ({ ...prev, [k]: v }));
  }
  function toggleSort(key: PortfolioSortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  const kpi = (data?.kpi ?? {}) as Record<string, unknown>;

  // PR-27: error stanje sa retry.
  if (q.isError) {
    return (
      <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center">
        <p className="text-sm text-status-danger">
          Portfolio nije učitan{q.error instanceof Error ? `: ${q.error.message}` : ''}.
        </p>
        <Button variant="secondary" onClick={() => q.refetch()} className="mt-3">
          Pokušaj ponovo
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Naslov + Osveži (PR-27) */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-md font-semibold text-ink">Kontrolna tabla</h2>
          <p className="text-xs text-ink-secondary">Svi aktivni predmeti na jednom ekranu. Klik na red otvara stablo predmeta.</p>
        </div>
        <div className="flex items-center gap-2">
          {data?.generated_at && (
            <span className="text-xs text-ink-disabled">
              osveženo {new Date(data.generated_at).toLocaleTimeString('sr-RS')}
            </span>
          )}
          <Button variant="secondary" onClick={() => q.refetch()} disabled={q.isFetching} title="Osveži portfolio">
            <RefreshCw className={cn('h-4 w-4', q.isFetching && 'animate-spin')} />
            {q.isFetching ? 'Osvežavam…' : 'Osveži'}
          </Button>
        </div>
      </div>

      {/* KPI traka: 7 imenovanih kartica (PR-12) */}
      <div className="flex flex-wrap gap-3 overflow-x-auto">
        {KPI_CARDS.map((c) => {
          const raw = kpi[c.key];
          const val = c.key === 'prosecan_op_napredak' ? `${Number(raw ?? 0)}%` : Number(raw ?? 0);
          return <KpiTile key={c.key} value={val} label={c.label} tone={c.tone} title={c.title?.(kpi)} />;
        })}
      </div>

      {/* Filter bar (PR-10) */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wider text-ink-secondary">Pretraga</span>
          <SearchBox
            value={filters.search ?? ''}
            onChange={(v) => setF('search', v)}
            placeholder="Broj, naziv, komitent…"
          />
        </div>
        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Komitent
          <select
            value={filters.komitent ?? ''}
            onChange={(e) => setF('komitent', e.target.value)}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            <option value="">Svi komitenti</option>
            {komitenti.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase tracking-wider text-ink-secondary">
          Status
          <select
            value={filters.status ?? 'sve'}
            onChange={(e) => setF('status', e.target.value)}
            className="h-8 rounded-control border border-line bg-surface px-2 text-sm normal-case tracking-normal text-ink"
          >
            {STATUS_OPTS.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={!!filters.onlyKasni} onChange={(e) => setF('onlyKasni', e.target.checked)} /> Samo kasni
        </label>
        <label className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <input type="checkbox" checked={!!filters.onlyProblemi} onChange={(e) => setF('onlyProblemi', e.target.checked)} /> Samo
          problemi
        </label>
        <Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>
          Reset
        </Button>
        <span className="ml-auto text-sm text-ink-secondary">{rows.length} predmeta</span>
      </div>

      {q.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          Učitavanje portfolija aktivnih predmeta…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          {items.length > 0 ? 'Nema predmeta za izabrane filtere.' : 'Nema aktivnih predmeta.'}
        </div>
      ) : (
        <div className="max-h-[min(64vh,640px)] overflow-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-surface-2">
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <SortTh col={SORT_COLS[0]} active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-1.5">Broj</th>
                <SortTh col={SORT_COLS[1]} active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-1.5">Komitent</th>
                <SortTh col={SORT_COLS[2]} active={sortKey} dir={sortDir} onSort={toggleSort} />
                <th className="px-3 py-1.5">Status</th>
                <SortTh col={SORT_COLS[3]} active={sortKey} dir={sortDir} onSort={toggleSort} />
                <SortTh col={SORT_COLS[5]} active={sortKey} dir={sortDir} onSort={toggleSort} />
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const id = itemId(it);
                return (
                  <tr
                    key={String(it.item_id ?? it.predmet_item_id ?? it.broj_predmeta)}
                    className="cursor-pointer border-b border-line-soft hover:bg-surface-2"
                    onClick={() => Number.isFinite(id) && onOpenPredmet(id)}
                    title="Otvori stablo predmeta"
                  >
                    <td className="tnums px-3 py-1.5 text-xs text-ink-secondary">{it.sort_priority ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <span className="inline-flex items-center gap-1 font-medium text-ink">
                        {prioIds.has(id) && <Star className="h-3.5 w-3.5 fill-status-warn text-status-warn" aria-label="Prioritetni predmet" />}
                        {it.broj_predmeta ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">{it.naziv_predmeta ?? '—'}</td>
                    <td className="px-3 py-1.5">{it.komitent ?? '—'}</td>
                    <td className="min-w-[160px] px-3 py-1.5">
                      <ProgressCell it={it} />
                    </td>
                    <td className="px-3 py-1.5">
                      <StatusPill status={it.status} />
                    </td>
                    <td className="px-3 py-1.5">
                      <ProblemiBadge it={it} />
                    </td>
                    <td className="px-3 py-1.5 text-xs">
                      <Rok dani={it.dani_do_roka} />
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

function SortTh({
  col,
  active,
  dir,
  onSort,
}: {
  col: { key: PortfolioSortKey; label: string };
  active: PortfolioSortKey;
  dir: SortDir;
  onSort: (k: PortfolioSortKey) => void;
}) {
  const isActive = active === col.key;
  return (
    <th
      role="button"
      tabIndex={0}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(col.key)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(col.key);
        }
      }}
      className={cn('cursor-pointer select-none px-3 py-1.5 hover:text-ink', isActive && 'text-ink')}
      title="Sortiraj"
    >
      <span className="inline-flex items-center gap-0.5">
        {col.label}
        {isActive && (dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </span>
    </th>
  );
}

/** Dualni bar op%/KK% sa tooltip-om (PR-11). KK% se prikazuje samo ako stiže sa BE. */
function ProgressCell({ it }: { it: PortfolioItem }) {
  const op = clampPct(it.op_pct);
  const kk = clampPct(it.kk_pct);
  const bar = op ?? 0;
  const opTxt = op == null ? 'n/a' : `${op}%`;
  const kkTxt = kk == null ? '—' : `${kk}%`;
  return (
    <div title={`Operacioni napredak ${opTxt} · KK (završna kontrola) ${kkTxt}`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width: `${bar}%` }} />
      </div>
      <div className="mt-0.5 flex justify-between gap-2 text-2xs text-ink-secondary">
        <span>op {opTxt}</span>
        <span>KK {kkTxt}</span>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string | null | undefined }) {
  const meta = portfolioStatusMeta(status);
  return <StatusBadge tone={meta.tone} label={meta.label} />;
}

/** Problemi badge sa raščlambom „X bez TP · Y bez crteža · Z bez ZK" (PR-11). */
function ProblemiBadge({ it }: { it: PortfolioItem }) {
  const n = Number(it.problemi ?? 0);
  if (!n) return <span className="text-ink-secondary">—</span>;
  const title =
    [
      Number(it.count_nema_tp) ? `${it.count_nema_tp} bez TP` : '',
      Number(it.count_nema_crtez) ? `${it.count_nema_crtez} bez crteža` : '',
      Number(it.count_nema_zavrsnu_kontrolu) ? `${it.count_nema_zavrsnu_kontrolu} bez završne kontrole` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Problemi';
  return (
    <span
      className="inline-flex min-w-[1.5rem] justify-center rounded-full bg-status-warn-bg px-2 py-0.5 text-xs font-medium text-status-warn"
      title={title}
    >
      {n}
    </span>
  );
}

function Rok({ dani }: { dani: number | null | undefined }) {
  if (dani == null) return <span className="text-ink-secondary">—</span>;
  const n = Number(dani);
  if (!Number.isFinite(n)) return <span className="text-ink-secondary">—</span>;
  if (n < 0) return <span className="text-status-danger">kasni {Math.abs(n)} d</span>;
  if (n <= 7) return <span className="text-status-warn">za {n} d</span>;
  return <span className="text-ink-secondary">za {n} d</span>;
}
