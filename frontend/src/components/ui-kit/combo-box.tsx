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
  /**
   * Prikaz IZABRANE vrednosti u dugmetu; podrazumevano isti kao `getLabel`
   * (zahtev 052/26). U listi red ima dva sprata (`getLabel` + `getSublabel`),
   * ali dugme posle izbora ima samo jedan — u šifarnicima gde je `getLabel`
   * gola šifra (crteži: „1141072 / A") korisnik izgubi opis koji je video dok
   * je birao. Ovim se za taj slučaj složi jednorednički prikaz sa opisom;
   * pozivi koji prop ne prosleđuju rade tačno kao pre.
   */
  getValueLabel?: (item: T) => string;
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
  getValueLabel,
  placeholder,
}: ComboBoxProps<T>) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const search = useSearch(q);
  const items = search.data?.data ?? [];

  if (value) {
    // Tekst je `truncate` (dugme je usko), pa uz njega ide i `title` — pun
    // sadržaj ostaje dostupan na prelaz mišem i kad ga stane samo pola.
    const selected = (getValueLabel ?? getLabel)(value);
    return (
      <button
        type="button"
        onClick={() => {
          onChange(null);
          setQ('');
          setOpen(true);
        }}
        title={selected}
        // Telefon (< sm): 44px meta + 16px tekst (iOS zumira stranu ispod 16px
        // i ne vraća zum); od `sm` naviše gust desktop ritam ostaje isti.
        className="flex min-h-11 w-full items-center justify-between rounded-control border border-line bg-surface px-2.5 py-1.5 text-md text-ink sm:min-h-0 sm:text-sm"
      >
        <span className="truncate">{selected}</span>
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
        className="min-h-11 w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-md text-ink placeholder:text-ink-disabled focus:outline-none focus:ring-2 focus:ring-accent/40 sm:min-h-0 sm:text-sm"
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
                // Red rezultata je meta za prst — na telefonu ≥ 44px (DS §11).
                className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left hover:bg-surface-2 sm:min-h-0"
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
