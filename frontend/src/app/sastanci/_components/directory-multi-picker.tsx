'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { useUserDirectory, type DirectoryEntry } from '@/api/sastanci';
import { INPUT_CLS } from './common';

export interface PickedUser {
  email: string;
  label?: string;
}

/** Meki email guard za slobodan unos (BE potvrđuje @IsEmail). Traži nešto@nešto.nešto. */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/**
 * Više-izbor korisnika iz `get_sastanci_user_directory` (zahtev 005/26 — pozivanje
 * učesnika iz „prve forme"). Sestra `DirectoryPicker` (single); ista logika i
 * izgled, ali drži listu i renderuje čip-ove izabranih. DB traži has_edit_role →
 * 403 za viewer; tada pada na slobodan unos (ručni email). Već izabrani se ne
 * nude ponovo; dedup po lower(email) na obe strane (izbor + BE PK).
 */
export function DirectoryMultiPicker({
  value,
  onChange,
  placeholder = 'Dodaj učesnika…',
}: {
  value: PickedUser[];
  onChange: (v: PickedUser[]) => void;
  placeholder?: string;
}) {
  const dir = useUserDirectory();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);

  const entries = dir.data?.data ?? [];
  const chosen = useMemo(() => new Set(value.map((v) => v.email.toLowerCase())), [value]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const base = entries.filter((e) => !chosen.has(e.email.toLowerCase()));
    if (!t) return base.slice(0, 30);
    return base
      .filter((e) => e.email.includes(t) || (e.full_name ?? '').toLowerCase().includes(t))
      .slice(0, 30);
  }, [entries, q, chosen]);

  function add(u: PickedUser) {
    if (chosen.has(u.email.toLowerCase())) return;
    onChange([...value, u]);
    setQ('');
    setOpen(false);
  }

  function addFree() {
    const t = q.trim().toLowerCase();
    if (EMAIL_RE.test(t) && !chosen.has(t)) {
      onChange([...value, { email: t, label: t }]);
      setQ('');
    }
  }

  // Enter: dodaj ukucani email (slobodan unos) ili prvi predlog iz direktorijuma.
  // Bez ovoga se na blur oslanjamo, a Safari zna da izgubi unos pri zatvaranju modala.
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const t = q.trim().toLowerCase();
    if (EMAIL_RE.test(t)) addFree();
    else if (filtered.length > 0) {
      const first = filtered[0];
      add({ email: first.email, label: first.full_name ?? first.email });
    }
  }

  function remove(email: string) {
    onChange(value.filter((v) => v.email.toLowerCase() !== email.toLowerCase()));
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((u) => (
            <span
              key={u.email}
              className="inline-flex items-center gap-1 rounded-control bg-surface-2 px-2 py-1 text-xs text-ink"
            >
              {u.label || u.email}
              <button
                type="button"
                onClick={() => remove(u.email)}
                className="text-ink-secondary hover:text-status-danger"
                aria-label={`Ukloni ${u.label || u.email}`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
        </div>
      )}
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
            onKeyDown={onKeyDown}
            onBlur={() => {
              setTimeout(() => setOpen(false), 150);
              addFree();
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
              filtered.map((e: DirectoryEntry) => (
                <button
                  key={e.email}
                  type="button"
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    add({ email: e.email, label: e.full_name ?? e.email });
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
    </div>
  );
}
