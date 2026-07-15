'use client';

import { useMemo, useState } from 'react';
import { ScanLine, X } from 'lucide-react';
import { LOC_TYPE_LABEL, type LocLocation } from '@/api/lokacije';

/**
 * Pretraživi izbor lokacije iz učitane liste aktivnih lokacija (klijentski filter
 * po šifri / nazivu / path_cached). Opcioni `onScan` dodaje dugme za skener police.
 * `kinds` opciono ograničava tipove (npr. samo hale za premeštaj kaveza).
 */
const HALL_SET = new Set(['WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP']);

export function LocationSelect({
  locations,
  value,
  onChange,
  onScan,
  placeholder = 'Pretraži lokaciju…',
  kinds,
  groupByHall = false,
}: {
  locations: LocLocation[];
  value: string | null;
  onChange: (id: string | null) => void;
  onScan?: () => void;
  placeholder?: string;
  kinds?: string[];
  /** Grupiši rezultate po nadređenoj hali (optgroup — paritet 1.0 grupisana destinacija). */
  groupByHall?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => (value ? locations.find((l) => l.id === value) ?? null : null),
    [value, locations],
  );

  const filtered = useMemo(() => {
    const base = kinds ? locations.filter((l) => kinds.includes(l.locationType)) : locations;
    const s = q.trim().toLowerCase();
    if (!s) return base.slice(0, 40);
    return base
      .filter(
        (l) =>
          l.locationCode.toLowerCase().includes(s) ||
          l.name.toLowerCase().includes(s) ||
          l.pathCached.toLowerCase().includes(s),
      )
      .slice(0, 40);
  }, [locations, q, kinds]);

  // Grupisanje po hali: nađi najbližeg pretka tipa HALA (šetnja parentId unutar liste).
  const groups = useMemo(() => {
    if (!groupByHall) return null;
    const byId = new Map(locations.map((l) => [l.id, l]));
    const hallLabelOf = (l: LocLocation): string => {
      let cur: LocLocation | undefined = l;
      const seen = new Set<string>();
      for (let i = 0; i < 32 && cur; i++) {
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        if (HALL_SET.has(cur.locationType)) return `${cur.locationCode}${cur.name ? ` — ${cur.name}` : ''}`;
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return 'Ostalo';
    };
    const map = new Map<string, LocLocation[]>();
    for (const l of filtered) {
      const key = hallLabelOf(l);
      const arr = map.get(key);
      if (arr) arr.push(l);
      else map.set(key, [l]);
    }
    return [...map.entries()];
  }, [filtered, groupByHall, locations]);

  const renderOption = (l: LocLocation) => (
    <button
      type="button"
      key={l.id}
      onMouseDown={(e) => { e.preventDefault(); onChange(l.id); setOpen(false); setQ(''); }}
      className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
    >
      <span className="text-sm text-ink">
        {l.locationCode}
        <span className="text-ink-disabled"> · {LOC_TYPE_LABEL[l.locationType] ?? l.locationType}</span>
      </span>
      {l.pathCached && <span className="text-xs text-ink-disabled">{l.pathCached}</span>}
    </button>
  );

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
        <span className="truncate">
          <span className="font-medium">{selected.locationCode}</span>
          <span className="text-ink-secondary"> · {LOC_TYPE_LABEL[selected.locationType] ?? selected.locationType}</span>
        </span>
        <button type="button" onClick={() => onChange(null)} aria-label="Ukloni izbor" className="ml-2 shrink-0 text-ink-secondary hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <div className="relative flex-1">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-disabled outline-none focus:border-accent"
        />
        {open && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-ink-disabled">Nema rezultata.</div>
            ) : groups ? (
              groups.map(([label, items]) => (
                <div key={label}>
                  <div className="sticky top-0 bg-surface-2 px-3 py-1 text-2xs font-semibold uppercase tracking-wide text-ink-secondary">{label}</div>
                  {items.map(renderOption)}
                </div>
              ))
            ) : (
              filtered.map(renderOption)
            )}
          </div>
        )}
      </div>
      {onScan && (
        <button
          type="button"
          onClick={onScan}
          className="shrink-0 rounded-control border border-line bg-surface-2 px-2 text-ink-secondary hover:bg-surface"
          aria-label="Skeniraj lokaciju"
          title="Skeniraj lokaciju"
        >
          <ScanLine className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
