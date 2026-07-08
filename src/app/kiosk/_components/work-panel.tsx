'use client';

import { useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Check, Lock, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

interface WorkPanelProps {
  /** npr. „Op. 30 · Struganje". */
  operationLabel: string;
  identMark: string;
  /** Planirano (potrebno) sa RN-a; null ako RN nije razrešen. */
  planned: number | null;
  /** Napravljeno (akumulirano) na ovoj operaciji. */
  made: number;
  finished: boolean;
  /** Skenirana operacija nije nađena u tehnološkom postupku ovog naloga. */
  missing: boolean;
  loading: boolean;
  evidentiranje: boolean;
  zatvaranje: boolean;
  onEvidentiraj: (pieces: number) => void;
  onZatvori: () => void;
}

function Stat({
  label,
  value,
  tone = 'muted',
}: {
  label: string;
  value: string;
  tone?: 'accent' | 'success' | 'muted';
}) {
  return (
    <div className="rounded-panel border border-line bg-surface px-4 py-5 text-center">
      <div className="text-sm font-semibold uppercase tracking-wide text-ink-secondary">
        {label}
      </div>
      <div
        className={cn(
          'tnums mt-1 text-5xl font-bold',
          tone === 'success'
            ? 'text-status-success'
            : tone === 'accent'
              ? 'text-accent'
              : 'text-ink',
        )}
      >
        {value}
      </div>
    </div>
  );
}

export function WorkPanel({
  operationLabel,
  identMark,
  planned,
  made,
  finished,
  missing,
  loading,
  evidentiranje,
  zatvaranje,
  onEvidentiraj,
  onZatvori,
}: WorkPanelProps) {
  const [pieces, setPieces] = useState(1);
  const [confirm, setConfirm] = useState(false);
  const busy = evidentiranje || zatvaranje;
  const remaining = planned != null ? Math.max(0, planned - made) : null;

  if (loading) {
    return (
      <div className="grid place-items-center rounded-panel border border-line bg-surface px-6 py-12 text-xl text-ink-secondary">
        Učitavanje operacije…
      </div>
    );
  }

  if (missing) {
    return (
      <div className="flex items-start gap-4 rounded-panel border-2 border-status-danger/40 bg-status-danger-bg px-6 py-5 text-status-danger">
        <AlertTriangle className="h-11 w-11 shrink-0" aria-hidden />
        <div>
          <p className="text-2xl font-bold uppercase tracking-wide">Operacija nije u nalogu</p>
          <p className="mt-1 text-xl">
            Skenirana operacija ne postoji u tehnološkom postupku ovog naloga. Skenirajte drugu
            operaciju ili počnite novi nalog.
          </p>
        </div>
      </div>
    );
  }

  const step = (d: number) => setPieces((p) => Math.max(1, p + d));
  const submit = () => {
    if (!busy && pieces >= 1) onEvidentiraj(pieces);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line bg-surface-2 px-5 py-4">
        <div>
          <div className="text-sm font-semibold uppercase tracking-wide text-ink-secondary">
            Operacija
          </div>
          <div className="mt-0.5 text-3xl font-bold text-ink">{operationLabel}</div>
          {identMark && (
            <div className="tnums mt-0.5 text-lg text-ink-secondary">Toznaka: {identMark}</div>
          )}
        </div>
        {finished && <StatusBadge tone="success" label="Zatvorena" />}
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Potrebno" value={planned != null ? formatNumber(planned) : '—'} />
        <Stat label="Napravljeno" value={formatNumber(made)} tone="accent" />
        <Stat
          label="Preostalo"
          value={remaining != null ? formatNumber(remaining) : '—'}
          tone={remaining === 0 ? 'success' : 'muted'}
        />
      </div>

      {finished ? (
        <div className="flex items-center gap-3 rounded-panel border border-status-success/40 bg-status-success-bg px-5 py-4 text-status-success">
          <Lock className="h-7 w-7 shrink-0" aria-hidden />
          <span className="text-xl font-semibold">
            Operacija je zatvorena — prijava rada nije moguća.
          </span>
        </div>
      ) : (
        <>
          <div>
            <div className="mb-2 text-lg font-semibold uppercase tracking-wide text-ink-secondary">
              Broj napravljenih komada
            </div>
            <div className="flex items-stretch gap-3">
              <button
                type="button"
                onClick={() => step(-1)}
                disabled={busy || pieces <= 1}
                aria-label="Manje"
                className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
              >
                <Minus className="h-8 w-8" aria-hidden />
              </button>
              <input
                type="number"
                min={1}
                inputMode="numeric"
                value={pieces || ''}
                disabled={busy}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  setPieces(Number.isFinite(n) && n > 0 ? n : 0);
                }}
                onKeyDown={onKeyDown}
                aria-label="Broj napravljenih komada"
                className="tnums h-20 w-full min-w-0 flex-1 rounded-panel border-2 border-line bg-surface text-center text-5xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => step(1)}
                disabled={busy}
                aria-label="Više"
                className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
              >
                <Plus className="h-8 w-8" aria-hidden />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Button
              variant="primary"
              loading={evidentiranje}
              disabled={busy || pieces < 1}
              onClick={submit}
              className="h-20 gap-3 text-2xl font-bold"
            >
              <Check className="h-7 w-7" aria-hidden />
              Evidentiraj
            </Button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirm(true)}
              className="inline-flex h-20 items-center justify-center gap-3 rounded-control border-2 border-status-danger px-4 text-2xl font-bold text-status-danger hover:bg-status-danger-bg disabled:opacity-50"
            >
              <Lock className="h-7 w-7" aria-hidden />
              Zatvori operaciju
            </button>
          </div>
        </>
      )}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Zatvoriti operaciju?"
        footer={
          <>
            <button
              onClick={() => setConfirm(false)}
              className="rounded-control border border-line px-4 py-2 text-base text-ink-secondary hover:bg-surface-2"
            >
              Otkaži
            </button>
            <button
              onClick={() => {
                setConfirm(false);
                onZatvori();
              }}
              className="rounded-control bg-status-danger px-4 py-2 text-base font-semibold text-white"
            >
              Zatvori operaciju
            </button>
          </>
        }
      >
        <p className="text-base text-ink">
          Operacija <span className="font-semibold">{operationLabel}</span> će biti trajno zatvorena
          sa <span className="tnums font-semibold">{formatNumber(made)}</span> napravljenih komada.
          Dalja prijava rada neće biti moguća.
        </p>
      </Dialog>
    </div>
  );
}
