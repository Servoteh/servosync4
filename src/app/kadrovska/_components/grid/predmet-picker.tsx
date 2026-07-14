'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { usePredmetiLookup } from '@/api/plan-montaze';

export interface PredmetPick {
  broj: string;
  naziv: string;
}

const RECENT_KEY = 'ss2_kadr_grid_predmet_recent_v1';
const RECENT_MAX = 8;

export function readRecentPredmeti(): PredmetPick[] {
  if (typeof window === 'undefined') return [];
  try {
    const arr = JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x: PredmetPick) => x && x.broj) : [];
  } catch {
    return [];
  }
}
export function pushRecentPredmet(p: PredmetPick) {
  if (typeof window === 'undefined' || !p.broj) return;
  const cur = readRecentPredmeti().filter((x) => x.broj !== p.broj);
  cur.unshift({ broj: p.broj, naziv: p.naziv || '' });
  try {
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
  } catch {
    /* ignore */
  }
}

/** Veži/promeni predmet za teren ćeliju (typeahead + skorašnji). Port openPredmetPicker. */
export function PredmetPickerDialog({
  open,
  current,
  onPick,
  onClear,
  onClose,
}: {
  open: boolean;
  current: PredmetPick | null;
  onPick: (p: PredmetPick) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const search = usePredmetiLookup(q, true);
  const recent = useMemo(() => (open ? readRecentPredmeti() : []), [open]);
  const results = search.data?.data ?? [];

  function pick(p: PredmetPick) {
    pushRecentPredmet(p);
    onPick(p);
    onClose();
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Veži predmet (teren)"
      footer={
        <>
          {onClear && (
            <Button variant="danger" onClick={() => { onClear(); onClose(); }}>
              ✕ Ukloni predmet
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Zatvori
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {current && (
          <p className="text-xs text-ink-secondary">
            Trenutno: <code className="rounded bg-surface-2 px-1 text-ink">{current.broj}</code> {current.naziv}
          </p>
        )}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Broj ili naziv predmeta…" autoFocus />
        <div className="max-h-60 overflow-auto rounded-control border border-line-soft">
          {search.isLoading ? (
            <div className="px-3 py-2 text-sm text-ink-disabled">Tražim…</div>
          ) : q ? (
            results.length === 0 ? (
              <div className="px-3 py-2 text-sm text-ink-disabled">Nema pogodaka — proveri broj (aktuelni „U TOKU").</div>
            ) : (
              results.map((r) => (
                <ResultRow key={r.id} broj={r.broj_predmeta} naziv={r.naziv_predmeta || ''} sub={r.customer_name} onClick={() => pick({ broj: r.broj_predmeta, naziv: r.naziv_predmeta || '' })} />
              ))
            )
          ) : recent.length > 0 ? (
            <>
              <div className="bg-surface-2 px-3 py-1 text-2xs font-semibold uppercase text-ink-secondary">Skorašnji</div>
              {recent.map((r) => (
                <ResultRow key={r.broj} broj={r.broj} naziv={r.naziv} onClick={() => pick(r)} />
              ))}
            </>
          ) : (
            <div className="px-3 py-2 text-sm text-ink-disabled">Kucaj broj ili naziv predmeta (aktuelni „U TOKU").</div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function ResultRow({ broj, naziv, sub, onClick }: { broj: string; naziv: string; sub?: string | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-surface-2">
      <code className="shrink-0 rounded bg-surface-2 px-1 text-xs text-ink">{broj}</code>
      <span className="truncate text-sm text-ink">{naziv}</span>
      {sub && <span className="ml-auto shrink-0 text-2xs text-ink-disabled">{sub}</span>}
    </button>
  );
}
