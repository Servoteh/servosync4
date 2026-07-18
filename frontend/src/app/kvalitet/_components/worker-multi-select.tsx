'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { useWorkers } from '@/api/structures';
import type { CulpritWorker } from '@/api/kvalitet';

/**
 * Multi-select izvršilaca-radnika (M:N ka `workers`). Koristi postojeći
 * `useWorkers` lookup (pretraga po imenu, samo aktivni). Izabrani radnici se
 * prikazuju kao čipovi; org-jedinice/spoljni izvršioci se unose kroz slobodan
 * tekst `culpritText` (odvojeno polje u formi). Bez novih zavisnosti.
 */
export function WorkerMultiSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: CulpritWorker[];
  onChange: (next: CulpritWorker[]) => void;
  /** Meko usmeravanje po ulozi: zaključan prikaz (čipovi bez uklanjanja, bez pretrage). */
  disabled?: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const list = useWorkers({ q: q.trim() || undefined, active: 'true', pageSize: 20 });
  const selectedIds = new Set(value.map((w) => w.workerId));
  const options = (list.data?.data ?? []).filter((w) => !selectedIds.has(w.id));

  function add(id: number, fullName: string | null) {
    if (selectedIds.has(id)) return;
    onChange([...value, { workerId: id, fullName }]);
    setQ('');
  }

  function remove(id: number) {
    onChange(value.filter((w) => w.workerId !== id));
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((w) => (
            <span
              key={w.workerId}
              className="inline-flex items-center gap-1 rounded-full bg-accent-subtle px-2 py-0.5 text-xs text-ink"
            >
              {w.fullName ?? `Radnik #${w.workerId}`}
              {!disabled && (
                <button
                  type="button"
                  onClick={() => remove(w.workerId)}
                  className="rounded-full p-0.5 text-ink-secondary hover:text-status-danger"
                  aria-label="Ukloni izvršioca"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {disabled ? (
        value.length === 0 && <p className="text-sm text-ink-disabled">—</p>
      ) : (
      <div className="relative">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Dodaj radnika (pretraga po imenu)…"
          className="h-9 w-full rounded-control border border-line bg-surface px-3 text-base text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
        />
        {open && (
          <div className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-control border border-line bg-surface shadow-lg">
            {list.isLoading ? (
              <div className="px-3 py-2 text-sm text-ink-disabled">Učitavanje…</div>
            ) : options.length === 0 ? (
              <div className="px-3 py-2 text-sm text-ink-disabled">
                {q ? 'Nema rezultata.' : 'Kucaj za pretragu…'}
              </div>
            ) : (
              options.map((w) => (
                <button
                  type="button"
                  key={w.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(w.id, w.fullName);
                    setOpen(false);
                  }}
                  className="flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-surface-2"
                >
                  <span className="text-sm text-ink">{w.fullName ?? w.username}</span>
                  {w.workUnit?.name && (
                    <span className="text-xs text-ink-disabled">{w.workUnit.name}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
