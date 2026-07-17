// ============================================================================
// Praćenje proizvodnje — portfolio helperi (čiste funkcije, bez React/DOM/API).
// Port 1.0 src/services/pracenjePortfolio.js: status/napredak derivacija,
// filtriranje i sortiranje za Kontrolnu tablu (ekran 0). Wire format = jsonb
// izlaz get_pracenje_portfolio (kpi + items). Tie-break kanon DOSLOVNO iz 1.0.
// ============================================================================

import type { PortfolioItem } from '@/api/pracenje';

/** Ton pilule (mapiranje na naše StatusBadge tonove). */
export type PortfolioTone = 'danger' | 'info' | 'warn' | 'success' | 'neutral';

/** Status pill metapodaci (sinhronizovano sa get_pracenje_portfolio.status). */
export const PORTFOLIO_STATUS_META: Record<string, { label: string; tone: PortfolioTone; order: number }> = {
  kasni: { label: 'Kasni', tone: 'danger', order: 0 },
  u_toku: { label: 'U toku', tone: 'info', order: 1 },
  na_cekanju: { label: 'Na čekanju', tone: 'warn', order: 2 },
  zavrseno: { label: 'Završeno', tone: 'success', order: 3 },
  bez_podataka: { label: 'Bez podataka', tone: 'neutral', order: 4 },
};

export function portfolioStatusMeta(status: string | null | undefined) {
  return PORTFOLIO_STATUS_META[String(status ?? '')] ?? PORTFOLIO_STATUS_META.bez_podataka;
}

/** Bezbedan procenat 0..100 (null -> null). */
export function clampPct(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Usko grlo može stići kao objekt { naziv, pct } ili kao string. */
export function uskoGrloNaziv(ug: unknown): string {
  if (!ug) return '';
  if (typeof ug === 'string') return ug;
  if (typeof ug === 'object') return String((ug as { naziv?: unknown }).naziv ?? '');
  return '';
}
export function uskoGrloPct(ug: unknown): number | null {
  if (ug && typeof ug === 'object') return clampPct((ug as { pct?: unknown }).pct);
  return null;
}

/** Lista jedinstvenih komitenata (za filter dropdown), sortirana. */
export function portfolioKomitenti(items: PortfolioItem[]): string[] {
  const set = new Set<string>();
  for (const it of items ?? []) {
    const k = String(it?.komitent ?? '').trim();
    if (k) set.add(k);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'sr'));
}

export interface PortfolioFilters {
  search?: string;
  komitent?: string;
  status?: string;
  onlyKasni?: boolean;
  onlyProblemi?: boolean;
}

/** Filtriranje portfolija (DOSLOVNO 1.0 filterPortfolioItems). */
export function filterPortfolioItems(items: PortfolioItem[], f: PortfolioFilters = {}): PortfolioItem[] {
  const search = String(f.search ?? '').trim().toLowerCase();
  const komitent = String(f.komitent ?? '').trim();
  const status = String(f.status ?? 'sve');
  return (items ?? []).filter((it) => {
    if (search) {
      const hay = [it.broj_predmeta, it.naziv_predmeta, it.komitent, uskoGrloNaziv(it.usko_grlo)]
        .map((x) => String(x ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (komitent && String(it.komitent ?? '').trim() !== komitent) return false;
    if (status && status !== 'sve' && String(it.status ?? '') !== status) return false;
    if (f.onlyKasni && !(String(it.status) === 'kasni' || Number(it.count_kasni ?? 0) > 0)) return false;
    if (f.onlyProblemi && !(Number(it.problemi ?? 0) > 0)) return false;
    return true;
  });
}

export type PortfolioSortKey = 'prioritet' | 'naziv' | 'napredak' | 'problemi' | 'kasni' | 'rok';
export type SortDir = 'asc' | 'desc';

function nz(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Sortiranje portfolija (DOSLOVNO 1.0 sortPortfolioItems). Tie-break = prioritet. */
export function sortPortfolioItems(
  items: PortfolioItem[],
  key: PortfolioSortKey = 'prioritet',
  dir: SortDir = 'asc',
): PortfolioItem[] {
  const arr = [...(items ?? [])];
  const mul = dir === 'desc' ? -1 : 1;
  const byPrioritet = (a: PortfolioItem, b: PortfolioItem) =>
    nz(a.sort_priority, Infinity) - nz(b.sort_priority, Infinity) ||
    String(a.broj_predmeta ?? '').localeCompare(String(b.broj_predmeta ?? ''), 'sr');
  let cmp: (a: PortfolioItem, b: PortfolioItem) => number;
  switch (key) {
    case 'napredak':
      cmp = (a, b) => (nz(a.op_pct, -1) - nz(b.op_pct, -1)) * mul || byPrioritet(a, b);
      break;
    case 'problemi':
      cmp = (a, b) => (nz(a.problemi, 0) - nz(b.problemi, 0)) * mul || byPrioritet(a, b);
      break;
    case 'kasni':
      cmp = (a, b) => (nz(a.count_kasni, 0) - nz(b.count_kasni, 0)) * mul || byPrioritet(a, b);
      break;
    case 'rok':
      cmp = (a, b) => (nz(a.dani_do_roka, Infinity) - nz(b.dani_do_roka, Infinity)) * mul || byPrioritet(a, b);
      break;
    case 'naziv':
      cmp = (a, b) => String(a.naziv_predmeta ?? '').localeCompare(String(b.naziv_predmeta ?? ''), 'sr') * mul;
      break;
    case 'prioritet':
    default:
      cmp = (a, b) => byPrioritet(a, b) * mul;
      break;
  }
  return arr.sort(cmp);
}

/** Prazan KPI skup (1.0 emptyKpi) — imenovani ključevi RPC-a. */
export function emptyPortfolioKpi(): Record<string, number> {
  return {
    ukupno_predmeta: 0,
    u_toku: 0,
    kasni: 0,
    zavrseno: 0,
    na_cekanju: 0,
    bez_podataka: 0,
    problemi_total: 0,
    predmeti_sa_problemima: 0,
    prosecan_op_napredak: 0,
  };
}
