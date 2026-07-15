'use client';

import { useState, type KeyboardEvent } from 'react';
import { ArrowLeft, FileText, Minus, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { ApiError } from '@/api/client';
import { openKioskDrawingPdf, useMyOpen, useStopWorkById, type MyOpenRow } from '@/api/kiosk';
import { formatDate, formatNumber } from '@/lib/format';

/**
 * „Moji otvoreni" (runda 2 t.3) — panel svih operacija koje je prijavljeni
 * radnik započeo a nije zatvorio. Zamenjuje skener korak dok je otvoren.
 *
 * Akcija po redu je „Kraj rada" (POST /:id/stop-work): završava radnikovu
 * vremensku sesiju na tom postupku i evidentira komade napravljene u toj
 * sesiji (0 = samo vreme). Zamenila je raniju „Zatvori operaciju" — završetak
 * rada iz liste ne traži ponovni sken oba barkoda (backend radi po tp.id).
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
  const stopWork = useStopWorkById();
  // id reda za koji mutacija upravo traje (spinner/zaključavanje samo tog reda).
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);

  const rows = query.data?.data ?? [];

  async function onStop(row: MyOpenRow, pieces: number) {
    setFeedback(null);
    setBusyId(row.id);
    try {
      const { data } = await stopWork.mutateAsync({
        id: row.id,
        pieceCount: pieces,
        workerCard: card ?? undefined,
      });
      const parts = [
        pieces > 0
          ? `Prijavljeno ${formatNumber(data.reportedPieces)} kom`
          : 'Evidentirano samo vreme rada',
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      if (data.workOrderCompleted) parts.push('Radni nalog je završen.');
      setFeedback({
        ok: true,
        text: `RN ${row.identNumber} · Op. ${row.operationNumber} — ${parts.join(' · ')}`,
      });
      await query.refetch();
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : 'Nepoznata greška.';
      setFeedback({ ok: false, text: `Kraj rada nije uspeo: ${msg}` });
    } finally {
      setBusyId(null);
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
            <MyOpenRowItem
              key={row.id}
              row={row}
              busy={busyId === row.id}
              disabled={busyId !== null && busyId !== row.id}
              onStop={(pieces) => onStop(row, pieces)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Jedan red „Moji otvoreni" — info + unos komada + „Kraj rada". Broj komada je
 * lokalno stanje po redu (min 0; podrazumevano 1; 0 = samo vreme rada).
 */
function MyOpenRowItem({
  row,
  busy,
  disabled,
  onStop,
}: {
  row: MyOpenRow;
  /** Mutacija ovog reda je u toku (spinner na dugmetu). */
  busy: boolean;
  /** Drugi red je u toku — zaključaj kontrole dok se ne završi. */
  disabled: boolean;
  onStop: (pieces: number) => void;
}) {
  const [pieces, setPieces] = useState(1);
  const locked = busy || disabled;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !locked) onStop(pieces);
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-4 rounded-panel border border-line bg-surface px-5 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="tnums text-2xl font-bold text-ink">{row.identNumber}</span>
          <span className="text-xl text-ink">
            Op. {row.operationNumber} · {row.operation?.workCenterName ?? row.workCenterCode}
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
        {row.drawing && (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => openKioskDrawingPdf(row.drawing!.id)}
              disabled={!row.drawing.hasPdf}
              title={row.drawing.hasPdf ? undefined : 'Crtež nema PDF'}
              className="inline-flex h-10 items-center gap-1.5 rounded-control border border-line bg-surface px-3 text-base font-semibold text-ink hover:bg-surface-2 disabled:opacity-40"
            >
              <FileText className="h-4 w-4" aria-hidden />
              PDF crteža
            </button>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1.5">
        <div className="flex items-stretch gap-2">
          <button
            type="button"
            onClick={() => setPieces((p) => Math.max(0, p - 1))}
            disabled={locked || pieces <= 0}
            aria-label="Manje"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-control border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            <Minus className="h-6 w-6" aria-hidden />
          </button>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={pieces}
            disabled={locked}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              setPieces(Number.isFinite(n) && n > 0 ? n : 0);
            }}
            onKeyDown={onKeyDown}
            aria-label="Broj napravljenih komada"
            className="tnums h-16 w-20 min-w-0 rounded-control border-2 border-line bg-surface text-center text-3xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setPieces((p) => p + 1)}
            disabled={locked}
            aria-label="Više"
            className="grid h-16 w-16 shrink-0 place-items-center rounded-control border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            <Plus className="h-6 w-6" aria-hidden />
          </button>
          <Button
            variant="primary"
            loading={busy}
            disabled={locked}
            onClick={() => onStop(pieces)}
            className="h-16 gap-2 px-5 text-xl font-bold"
          >
            <Square className="h-6 w-6" aria-hidden />
            Kraj rada
          </Button>
        </div>
        {pieces === 0 && (
          <p className="text-base text-ink-secondary">0 kom — evidentira se samo vreme rada.</p>
        )}
      </div>
    </li>
  );
}
