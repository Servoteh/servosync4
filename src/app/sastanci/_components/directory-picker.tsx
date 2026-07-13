'use client';

import { useMemo, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useUserDirectory, type DirectoryEntry } from '@/api/sastanci';
import { INPUT_CLS } from './common';

/**
 * Biranje korisnika iz `get_sastanci_user_directory` (autocomplete učesnika/vodio/
 * odgovoran). Client-side filter (direktorijum je mali). DB traži has_edit_role →
 * 403 za viewer; tada pada na slobodan unos (dozvoli ručni email). Selekcija vraća
 * {email, label} (label = full_name snapshot — §parity: label je snapshot imena).
 */
export function DirectoryPicker({
  value,
  onChange,
  placeholder = 'Ime ili email…',
  allowFreeEmail = true,
}: {
  value: { email: string; label?: string } | null;
  onChange: (v: { email: string; label?: string } | null) => void;
  placeholder?: string;
  allowFreeEmail?: boolean;
}) {
  const dir = useUserDirectory();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const entries = dir.data?.data ?? [];
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return entries.slice(0, 30);
    return entries
      .filter((e) => e.email.includes(t) || (e.full_name ?? '').toLowerCase().includes(t))
      .slice(0, 30);
  }, [entries, q]);

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="flex-1 truncate rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink">
          {value.label || value.email}
        </span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setQ('');
          }}
          className="rounded-control p-1 text-ink-secondary hover:bg-surface-2"
          aria-label="Ukloni"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  function pick(e: DirectoryEntry) {
    onChange({ email: e.email, label: e.full_name ?? e.email });
    setQ('');
    setOpen(false);
  }

  function commitFree() {
    const t = q.trim();
    if (allowFreeEmail && t.includes('@')) onChange({ email: t.toLowerCase(), label: t });
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
          onBlur={() => {
            setTimeout(() => setOpen(false), 150);
            commitFree();
          }}
          placeholder={placeholder}
        />
        <ChevronDown className="pointer-events-none -ml-6 h-4 w-4 text-ink-disabled" aria-hidden />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
          {dir.isLoading ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Učitavanje…</div>
          ) : dir.isError ? (
            <div className="px-3 py-2 text-xs text-ink-disabled">
              Direktorijum nedostupan — unesi email ručno.
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Nema rezultata.</div>
          ) : (
            filtered.map((e) => (
              <button
                key={e.email}
                type="button"
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(e);
                }}
                className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
              >
                <span className="text-sm text-ink">{e.full_name || e.email}</span>
                <span className="text-xs text-ink-disabled">{e.email}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
