// Persistencija izbora/filtera Plana proizvodnje u localStorage (GAP-PM-21).
// Paritet 1.0 (poMasiniTab.js LS_* ključevi + poCrtezuTab auto-pretraga): šef se
// posle svakog ulaska vraća tačno gde je stao — poslednje odeljenje+mašina, RN
// filteri po tabu, rework filter, upit „Po crtežu" (+ auto-pretraga na mount).
// SVE SSR-safe (typeof window guard — static export prerender ne sme da padne).

/** LS ključevi — identični 1.0 imenima gde postoje (kontinuitet za korisnika). */
export const LS = {
  lastMachine: 'plan-proizvodnje:last-machine',
  lastDept: 'plan-proizvodnje:last-department',
  rnFilter: (tab: string) => `plan-proizvodnje:filter-rn:${tab}`,
  reworkFilter: 'plan-proizvodnje:filter-rework:po-masini',
  crtezQuery: 'plan-proizvodnje:query:po-crtezu',
  // GAP-PM-13/14 — sort Zauzetosti + „Samo proceduralne" toggle po tabu (paritet 1.0
  // STORAGE_KEY_SORT/STORAGE_KEY_FILTER u zauzetostTab.js/pregledTab.js).
  zauzetostSort: 'plan-proizvodnje:zauzetost:sort',
  procFilter: (tab: string) => `plan-proizvodnje:${tab}:filter`, // 'all' | 'proc'
  // GAP-PM-12 — skok iz Zauzetost/Pregled u „Po mašini" (LS handover, 1.0 jumpToPoMasini).
  jumpMachine: 'plan-proizvodnje:jump-machine',
} as const;

/** Perzistiran sort Zauzetosti { key, dir }. */
export interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}
export function lsGetSort(fallback: SortState): SortState {
  const raw = lsGet(LS.zauzetostSort);
  if (!raw) return fallback;
  try {
    const p = JSON.parse(raw) as Partial<SortState>;
    if (p && typeof p.key === 'string' && (p.dir === 'asc' || p.dir === 'desc')) {
      return { key: p.key, dir: p.dir };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}
export function lsSetSort(s: SortState): void {
  lsSet(LS.zauzetostSort, JSON.stringify(s));
}

export function lsGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function lsSet(key: string, value: string | null | undefined): void {
  if (typeof window === 'undefined') return;
  try {
    if (value == null || value === '') window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* privatni mod / puna kvota — izbor važi samo unutar mount-a */
  }
}

export function lsGetBool(key: string): boolean {
  return lsGet(key) === 'true';
}

export function lsSetBool(key: string, value: boolean): void {
  lsSet(key, value ? 'true' : 'false');
}
