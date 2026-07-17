'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import { AlatOpremaTab } from './alat-oprema-tab';
import { MagacinTab } from './magacin-tab';

/**
 * „Stanje magacina" — prekidač prikaza (RA-08, paritet 1.0 `inventarTab.js`
 * view-toggle): „Alat i oprema" (per-jedinica katalog) ⇄ „Magacin (zbirno)".
 * Izbor se pamti (localStorage `reversi:inv-view`, migracija legacy vrednosti).
 * „Rezni katalog" je u 2.0 zaseban top-level tab pa nije deo prekidača.
 */

type InvView = 'unit' | 'warehouse';
const STORAGE_KEY = 'reversi:inv-view';

const VIEWS: { id: InvView; label: string; hint: string }[] = [
  { id: 'unit', label: 'Alat i oprema', hint: 'Katalog ručnog alata, opreme, LZO i potrošnog materijala' },
  { id: 'warehouse', label: 'Magacin (zbirno)', hint: 'Sumirano po artiklu i lokaciji' },
];

function loadView(): InvView {
  if (typeof window === 'undefined') return 'unit';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'unit' || raw === 'warehouse') return raw;
    // Migracija legacy REVERSI_INV_VIEW (1.0: unit/warehouse/cutting) — 'cutting' je
    // sada zaseban tab, pa se svodi na podrazumevani „Alat i oprema".
    if (raw === 'cutting') return 'unit';
  } catch {
    /* localStorage nedostupan (privatni režim) — padni na default */
  }
  return 'unit';
}

export function InventarView() {
  // Inicijalno 'unit' na serveru; učitaj sačuvan izbor tek posle mount-a (bez
  // hydration mismatch-a).
  const [view, setView] = useState<InvView>('unit');
  useEffect(() => {
    setView(loadView());
  }, []);

  function pick(v: InvView) {
    setView(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Prikaz magacina"
        className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1"
      >
        {VIEWS.map((v) => {
          const active = v.id === view;
          return (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={v.hint}
              onClick={() => pick(v.id)}
              className={cn(
                'rounded-control px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-fg'
                  : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
              )}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {view === 'unit' ? <AlatOpremaTab /> : <MagacinTab />}
    </div>
  );
}
