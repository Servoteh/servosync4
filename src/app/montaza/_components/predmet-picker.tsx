'use client';

// Picker BigTehn predmeta (ručni izbor / ispravka veze izveštaja). Deli ga create-wizard
// i „Poveži predmet" u detalju. onlyActive=false (paritet 1.0: servis vezuje i zatvorene).

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { useMontazaPredmetLookup } from '@/api/plan-montaze';

export interface PredmetSelection {
  predmet_item_id: number;
  predmet_broj: string;
  naziv_projekta: string;
  klijent: string;
}

export function PredmetPicker({
  open,
  onClose,
  onSelect,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (sel: PredmetSelection) => void;
  onClear?: () => void;
}) {
  const [q, setQ] = useState('');
  const lookup = useMontazaPredmetLookup(q, false);
  const rows = lookup.data?.data ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izaberi predmet (BigTehn)"
      footer={
        onClear ? (
          <Button
            variant="secondary"
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            Ukloni vezu (bez predmeta)
          </Button>
        ) : undefined
      }
    >
      <input
        type="search"
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Broj predmeta, naziv ili ugovor…"
        className="h-9 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled"
      />
      <div className="mt-3 space-y-1">
        {q.trim().length < 2 ? (
          <p className="py-4 text-center text-sm text-ink-disabled">Ukucaj broj ili naziv predmeta…</p>
        ) : lookup.isLoading ? (
          <p className="py-4 text-center text-sm text-ink-secondary">Tražim…</p>
        ) : rows.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-disabled">Nema predmeta za „{q}".</p>
        ) : (
          rows.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onSelect({
                  predmet_item_id: Number(r.id),
                  predmet_broj: r.broj_predmeta || '',
                  naziv_projekta: r.naziv_predmeta || '',
                  klijent: r.customer_name || '',
                });
                onClose();
              }}
              className="flex w-full items-baseline gap-2 rounded-control border border-line px-3 py-2 text-left hover:bg-surface-2"
            >
              <span className="tnums font-medium text-ink">{r.broj_predmeta || '—'}</span>
              <span className="flex-1 truncate text-sm text-ink-secondary">
                {r.naziv_predmeta || ''}
                {r.customer_name ? ` · ${r.customer_name}` : ''}
              </span>
            </button>
          ))
        )}
      </div>
    </Dialog>
  );
}
