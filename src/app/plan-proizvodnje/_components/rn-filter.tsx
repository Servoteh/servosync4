'use client';

import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { LS, lsGet, lsSet } from './pp-storage';

/**
 * „RN ili crtež…" klijentski filter (GAP-PM-04) — debounce 200ms (paritet 1.0
 * wireRnFilter, poMasiniTab.js:722), odvojeni LS ključ po tabu (GAP-PM-21), i
 * odvojena „raw" (input) vs „debounced" (primenjena) vrednost. Prikaz + drag
 * gating rešava pozivalac: dok je debounced != '' drag mora biti isključen.
 */
export function useRnFilter(tab: string) {
  const key = LS.rnFilter(tab);
  const [raw, setRaw] = useState<string>(() => lsGet(key) ?? '');
  const [applied, setApplied] = useState<string>(raw);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    lsSet(key, raw);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setApplied(raw), 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [raw, key]);

  // GAP-PM-04 fix: `active` mora pratiti DEBOUNCED (applied) vrednost, ne raw.
  // Paritet 1.0 (poMasiniTab.js:729-730): drag-gating i „Nema rezultata" empty-state
  // se preračunavaju TEK unutar 200ms debounce-a (renderTable u setTimeout), pa se
  // vezuju za primenjeni filter. Da je vezan za raw, CLEAR bi otvorio 200ms prozor
  // u kom je drag/reorder dozvoljen nad JOŠ-filtriranim podskupom (stale rows).
  const active = applied.trim().length > 0;
  return { raw, setRaw, applied, active };
}

/** Input polje „RN ili crtež…" (kontrolisano kroz useRnFilter). */
export function RnFilterInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label
      className="flex items-center gap-2 rounded-control border border-line bg-surface-2 px-2.5 py-1.5"
      title="Filtriraj po RN-u ili broju crteža"
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-ink-disabled" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="RN ili crtež…"
        autoComplete="off"
        className="w-40 bg-transparent text-sm text-ink placeholder:text-ink-disabled focus:outline-none"
      />
    </label>
  );
}

/** Brojač „N / ukupno" (paritet 1.0 setCounter { total }). */
export function FilterCounter({ shown, total, unit = 'operacija' }: { shown: number; total: number; unit?: string }) {
  if (shown === total) return <span className="text-sm text-ink-secondary">{total} {unit}</span>;
  return (
    <span className="text-sm text-ink-secondary">
      <strong className="text-ink">{shown}</strong> / {total} {unit}
    </span>
  );
}
