'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface SearchResult<T> {
  data?: { data: T[] };
  isLoading: boolean;
}

interface ComboBoxProps<T> {
  value: T | null;
  onChange: (item: T | null) => void;
  /** Hook koji za upit vraća listu (npr. useProjectsLookup). */
  useSearch: (q: string) => SearchResult<T>;
  getKey: (item: T) => string | number;
  getLabel: (item: T) => string;
  getSublabel?: (item: T) => string;
  placeholder?: string;
}

/**
 * Biranje iz liste sa pretragom (DESIGN_SYSTEM.md §10 — ComboBox). Za velike
 * šifarnike (predmeti/komitenti): kucaš → server vrati do 25 → izabereš.
 */
export function ComboBox<T>({
  value,
  onChange,
  useSearch,
  getKey,
  getLabel,
  getSublabel,
  placeholder,
}: ComboBoxProps<T>) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const search = useSearch(q);
  const items = search.data?.data ?? [];

  if (value) {
    return (
      <button
        type="button"
        onClick={() => {
          onChange(null);
          setQ('');
          setOpen(true);
        }}
        className="flex w-full items-center justify-between rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
      >
        <span className="truncate">{getLabel(value)}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-ink-disabled" aria-hidden />
      </button>
    );
  }

  return (
    <div className="relative">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        className="w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-disabled focus:outline-none focus:ring-2 focus:ring-accent/40"
      />
      {open && (
        <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {search.isLoading ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Učitavanje…</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">
              {q ? 'Nema rezultata.' : 'Kucaj za pretragu…'}
            </div>
          ) : (
            items.map((it) => (
              <button
                type="button"
                key={getKey(it)}
                // onMouseDown (pre blur-a) da izbor prođe pre zatvaranja liste
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(it);
                  setOpen(false);
                  setQ('');
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="text-sm text-ink">{getLabel(it)}</span>
                {getSublabel && (
                  <span className="text-xs text-ink-disabled">{getSublabel(it)}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
