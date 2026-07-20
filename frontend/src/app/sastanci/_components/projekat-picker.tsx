'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useSastanciProjekti, type SastanciProjekat } from '@/api/sastanci';
import { INPUT_CLS } from './common';

/** Izabrani projekat u AkcijaModal (S5) — id + prikazni podaci (`code — naziv`). */
export type ProjekatIzbor = { id: string; code: string | null; naziv: string | null };

/** Prikaz jednog projekta: „code — naziv" (bilo koje polje sme faliti). */
function labelOf(p: { code: string | null; naziv: string | null }): string {
  const code = p.code?.trim() || '';
  const naziv = p.naziv?.trim() || '';
  if (code && naziv) return `${code} — ${naziv}`;
  return code || naziv || '—';
}

/**
 * Biranje projekta/RN za akciju (S5). Obrazac kao `DirectoryPicker`, ali pretraga
 * ide na server (`useSastanciProjekti`, debounce 250ms — lista projekata je velika).
 * Selekcija vraća `{ id, code, naziv }`; „X" briše izbor (akcija „Bez RN / projekta").
 */
export function ProjekatPicker({
  value,
  onChange,
  placeholder = 'Broj RN ili naziv projekta…',
}: {
  value: ProjekatIzbor | null;
  onChange: (v: ProjekatIzbor | null) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);

  // Debounce kucanja — ne gađaj BE na svaki pritisak (obrazac velikih lista).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  const projektiQ = useSastanciProjekti(debounced);
  const entries = projektiQ.data?.data ?? [];

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink">
          {labelOf(value)}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setQ('');
          }}
          className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
          aria-label="Ukloni projekat"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  function pick(p: SastanciProjekat) {
    onChange({ id: p.id, code: p.code, naziv: p.naziv });
    setQ('');
    setOpen(false);
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-1">
        <input
          className={INPUT_CLS}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
        />
        <ChevronDown className="pointer-events-none -ml-6 h-4 w-4 text-ink-disabled" aria-hidden />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {debounced.trim().length === 0 ? (
            <div className="px-3 py-2 text-xs text-ink-disabled">Ukucaj broj RN ili naziv…</div>
          ) : projektiQ.isLoading ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Učitavanje…</div>
          ) : projektiQ.isError ? (
            <div className="px-3 py-2 text-xs text-ink-disabled">Pretraga projekata nedostupna.</div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Nema rezultata.</div>
          ) : (
            entries.map((p) => (
              <button
                key={p.id}
                type="button"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(p);
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="text-sm text-ink">{p.code || p.naziv || '—'}</span>
                {p.code && p.naziv && <span className="text-xs text-ink-disabled">{p.naziv}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
