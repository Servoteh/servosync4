'use client';

import { useState, type KeyboardEvent } from 'react';
import { ArrowLeft, Check, Lock, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { ApiError } from '@/api/client';
import { useFinish, useMyOpen, type MyOpenRow } from '@/api/kiosk';
import { formatDate, formatNumber } from '@/lib/format';

/**
 * „Moji otvoreni" (runda 2 t.3) — panel svih operacija koje je prijavljeni
 * radnik započeo a nije zatvorio. Zamenjuje skener korak dok je otvoren.
 *
 * Akcija po redu je SAMO „Zatvori operaciju" (POST /:id/finish, treba samo
 * tp.id iz liste). „Završi rad" (STOP sesije) se NAMERNO ne nudi ovde:
 * `useStopWork` (POST /work/stop) traži oba BARKODA (orderBarcode +
 * operationBarcode) koje ova lista NEMA — završetak rada iz liste bi tražio
 * backend dopunu (stop endpoint po tp.id). Zato red sa otvorenom sesijom nosi
 * samo badge „Rad u toku" (informativno) + „Zatvori operaciju".
 * TODO(backend): „Završi rad iz liste" traži stop endpoint po tp.id.
 */
export function MyOpenPanel({
  card,
  onBack,
}: {
  /** Kartica radnika (audit) — null za lični nalog (backend čita iz JWT-a). */
  card: string | null;
  onBack: () => void;
}) {
  const query = useMyOpen(card, true);
  const finish = useFinish();
  const [closing, setClosing] = useState<MyOpenRow | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = query.data?.data ?? [];

  async function onClose(row: MyOpenRow, pieces: number | null) {
    setFeedback(null);
    try {
      const { data } = await finish.mutateAsync({
        id: row.id,
        pieceCount: pieces ?? undefined,
        workerCard: card ?? undefined,
      });
      const parts = [`Zatvoreno sa ${formatNumber(data.finishedPieces)} kom`];
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      setFeedback({ ok: true, text: `RN ${row.identNumber} · Op. ${row.operationNumber} — ${parts.join(' · ')}` });
      setClosing(null);
      await query.refetch();
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : 'Nepoznata greška.';
      setFeedback({ ok: false, text: `Zatvaranje nije uspelo: ${msg}` });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-3xl font-bold text-ink">
          Moji otvoreni {rows.length > 0 && <span className="tnums">({rows.length})</span>}
        </h2>
        <button
          onClick={onBack}
          className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-line bg-surface px-5 text-lg font-semibold text-ink hover:bg-surface-2"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden />
          Skener
        </button>
      </div>

      {feedback && (
        <div
          role={feedback.ok ? undefined : 'alert'}
          className={
            feedback.ok
              ? 'rounded-panel border border-status-success/40 bg-status-success-bg px-5 py-4 text-lg font-semibold text-status-success'
              : 'rounded-panel border-2 border-status-danger/40 bg-status-danger-bg px-5 py-4 text-lg font-semibold text-status-danger'
          }
        >
          {feedback.text}
        </div>
      )}

      {query.isLoading ? (
        <div className="grid place-items-center rounded-panel border border-line bg-surface px-6 py-12 text-xl text-ink-secondary">
          Učitavanje…
        </div>
      ) : query.error ? (
        <div className="rounded-panel border-2 border-status-danger/40 bg-status-danger-bg px-6 py-5 text-xl text-status-danger">
          Greška pri učitavanju otvorenih operacija.
        </div>
      ) : rows.length === 0 ? (
        <div className="grid place-items-center rounded-panel border border-line bg-surface px-6 py-12 text-center text-xl text-ink-secondary">
          Nemate otvorenih operacija.
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-line bg-surface px-5 py-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tnums text-2xl font-bold text-ink">{row.identNumber}</span>
                  <span className="text-xl text-ink">
                    Op. {row.operationNumber} ·{' '}
                    {row.operation?.workCenterName ?? row.workCenterCode}
                  </span>
                  {row.hasOpenSession && <StatusBadge tone="info" label="Rad u toku" />}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-6 gap-y-0.5 text-lg text-ink-secondary">
                  <span>
                    Napravljeno{' '}
                    <span className="tnums font-semibold text-ink">
                      {formatNumber(row.pieceCount)}
                      {row.plannedPieces != null ? ' / ' + formatNumber(row.plannedPieces) : ''}
                    </span>{' '}
                    kom
                  </span>
                  <span>Otvoreno {formatDate(row.enteredAt)}</span>
                </div>
              </div>
              <button
                onClick={() => setClosing(row)}
                className="inline-flex h-16 shrink-0 items-center gap-2 rounded-control border-2 border-status-danger px-5 text-xl font-bold text-status-danger hover:bg-status-danger-bg"
              >
                <Lock className="h-6 w-6" aria-hidden />
                Zatvori operaciju
              </button>
            </li>
          ))}
        </ul>
      )}

      {closing && (
        <CloseOperationDialog
          row={closing}
          busy={finish.isPending}
          onCancel={() => setClosing(null)}
          onConfirm={(pieces) => onClose(closing, pieces)}
        />
      )}
    </div>
  );
}

/** Potvrda zatvaranja operacije + opcioni unos komada (bez unosa → trenutna količina). */
function CloseOperationDialog({
  row,
  busy,
  onCancel,
  onConfirm,
}: {
  row: MyOpenRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (pieces: number | null) => void;
}) {
  // Predlog = trenutno napravljeno; korisnik može korigovati pre zatvaranja.
  const [pieces, setPieces] = useState<number>(row.pieceCount > 0 ? row.pieceCount : 1);
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !busy && pieces >= 1) onConfirm(pieces);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Zatvoriti operaciju?"
      footer={
        <>
          <button
            onClick={onCancel}
            className="rounded-control border border-line px-4 py-2 text-base text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button
            onClick={() => onConfirm(pieces >= 1 ? pieces : null)}
            loading={busy}
            disabled={pieces < 1}
            className="bg-status-danger text-white hover:bg-status-danger"
          >
            <Check className="h-4 w-4" aria-hidden />
            Zatvori operaciju
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-base text-ink">
          RN <span className="tnums font-semibold">{row.identNumber}</span> · operacija{' '}
          <span className="font-semibold">
            {row.operationNumber} · {row.operation?.workCenterName ?? row.workCenterCode}
          </span>{' '}
          će biti trajno zatvorena. Dalja prijava rada neće biti moguća.
        </p>
        <div>
          <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-ink-secondary">
            Broj napravljenih komada
          </div>
          <div className="flex items-stretch gap-3">
            <button
              type="button"
              onClick={() => setPieces((p) => Math.max(1, p - 1))}
              disabled={busy || pieces <= 1}
              aria-label="Manje"
              className="grid h-16 w-16 shrink-0 place-items-center rounded-control border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
            >
              <Minus className="h-6 w-6" aria-hidden />
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
              className="tnums h-16 w-full min-w-0 flex-1 rounded-control border-2 border-line bg-surface text-center text-3xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => setPieces((p) => p + 1)}
              disabled={busy}
              aria-label="Više"
              className="grid h-16 w-16 shrink-0 place-items-center rounded-control border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
            >
              <Plus className="h-6 w-6" aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
