'use client';

import { useState, type KeyboardEvent } from 'react';
import { ArrowLeft, FileText, Minus, Plus, Square, XCircle } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { ApiError } from '@/api/client';
import {
  openKioskDrawingPdf,
  useDismissOpen,
  useMyOpen,
  useStopWorkById,
  type MyOpenRow,
} from '@/api/kiosk';
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
  const dismissOpen = useDismissOpen();
  // id reda za koji mutacija upravo traje (spinner/zaključavanje samo tog reda).
  const [busyId, setBusyId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  // Red za koji je otvorena potvrda „Odustani" (null = zatvorena).
  const [confirmRow, setConfirmRow] = useState<MyOpenRow | null>(null);
  // „Kraj rada" na DELJENOM redu (drugi radnici imaju otvorene sesije) — izbor
  // „samo moj rad / za sve" pre slanja (null = dijalog zatvoren).
  const [stopChoice, setStopChoice] = useState<{ row: MyOpenRow; pieces: number } | null>(null);

  const rows = query.data?.data ?? [];

  async function onStop(row: MyOpenRow, pieces: number, finishForAll = false) {
    setStopChoice(null);
    setFeedback(null);
    setBusyId(row.id);
    try {
      const { data } = await stopWork.mutateAsync({
        id: row.id,
        pieceCount: pieces,
        workerCard: card ?? undefined,
        finishForAll: finishForAll || undefined,
      });
      const parts = [
        pieces > 0
          ? `Prijavljeno ${formatNumber(data.reportedPieces)} kom`
          : 'Evidentirano samo vreme rada',
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      else if (data.finishSkipped) {
        // Deljeni red: gašenje preskočeno — operaciju i dalje koristi neko drugi.
        const others = (data.otherOpenWorkers ?? [])
          .map((w) => w.fullName)
          .filter(Boolean)
          .join(', ');
        parts.push(
          others
            ? `Operacija ostaje otvorena — još radi: ${others}.`
            : 'Operacija ostaje otvorena — još neko radi na njoj.',
        );
      } else if (finishForAll) parts.push('Operacija zatvorena i za ostale radnike.');
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

  /** „Kraj rada" klik: deljeni red (drugi još rade) prvo pita „samo moj / za sve". */
  function onStopRequest(row: MyOpenRow, pieces: number) {
    if ((row.othersOpenCount ?? 0) > 0) setStopChoice({ row, pieces });
    else void onStop(row, pieces);
  }

  /**
   * „Odustani" — zatvara pogrešno otvoren red BEZ evidentiranja komada
   * (POST /:id/dismiss). Isti busyId/spinner obrazac kao onStop. Poziva se tek
   * POSLE eksplicitne potvrde u dijalogu (komadi se NE evidentiraju).
   */
  async function onDismiss(row: MyOpenRow) {
    setConfirmRow(null);
    setFeedback(null);
    setBusyId(row.id);
    try {
      const { data } = await dismissOpen.mutateAsync({ id: row.id, workerCard: card ?? undefined });
      setFeedback({
        ok: true,
        // finishSkipped: deljeni red — zatvoreno samo svoje učešće, red ostaje ostalima.
        text: data.finishSkipped
          ? `RN ${row.identNumber} · Op. ${row.operationNumber} — tvoje učešće je odbačeno; operacija ostaje otvorena (još neko radi na njoj).`
          : `RN ${row.identNumber} · Op. ${row.operationNumber} — operacija odbačena (bez evidentiranja komada).`,
      });
      await query.refetch();
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : 'Nepoznata greška.';
      setFeedback({ ok: false, text: `Odustajanje nije uspelo: ${msg}` });
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
              onStop={(pieces) => onStopRequest(row, pieces)}
              onDismiss={() => setConfirmRow(row)}
            />
          ))}
        </ul>
      )}

      {/* Potvrda „Odustani" — pogrešno otvoren red se ZATVARA bez evidentiranja
          komada. Poruka je namerno eksplicitna (ne samo Da/Ne). */}
      <Dialog
        open={confirmRow !== null}
        onClose={() => setConfirmRow(null)}
        title="Odustati od operacije?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRow(null)}>
              Ne
            </Button>
            <Button
              variant="danger"
              onClick={() => confirmRow && onDismiss(confirmRow)}
            >
              Da, odustani
            </Button>
          </>
        }
      >
        {confirmRow && (
          <div className="space-y-2 text-lg text-ink">
            <p>
              RN <span className="tnums font-semibold">{confirmRow.identNumber}</span> · Op.{' '}
              <span className="tnums font-semibold">{confirmRow.operationNumber}</span> — red će biti
              zatvoren <span className="font-semibold">BEZ evidentiranja komada</span>.
            </p>
            <p className="text-ink-secondary">
              Koristi ovo samo za pogrešno otvorene redove. Napravljeni komadi se NE evidentiraju.
            </p>
            {(confirmRow.othersOpenCount ?? 0) > 0 && (
              <p className="text-ink-secondary">
                Na operaciji trenutno radi još {confirmRow.othersOpenCount}{' '}
                {confirmRow.othersOpenCount === 1 ? 'radnik' : 'radnika'} — zatvoriće se samo
                tvoje učešće, operacija njima ostaje otvorena.
              </p>
            )}
          </div>
        )}
      </Dialog>

      {/* „Kraj rada" na deljenom redu — korak-pitanje (Nenad 22.07): podrazumevano
          se završava SAMO svoj rad; gašenje operacije za sve je eksplicitan izbor. */}
      <Dialog
        open={stopChoice !== null}
        onClose={() => setStopChoice(null)}
        title="Na ovoj operaciji radi još neko"
        footer={
          <>
            <Button variant="secondary" onClick={() => setStopChoice(null)}>
              Otkaži
            </Button>
            <Button
              variant="danger"
              onClick={() => stopChoice && onStop(stopChoice.row, stopChoice.pieces, true)}
            >
              Zatvori za sve
            </Button>
            <Button
              variant="primary"
              onClick={() => stopChoice && onStop(stopChoice.row, stopChoice.pieces)}
            >
              Završi samo moj rad
            </Button>
          </>
        }
      >
        {stopChoice && (
          <div className="space-y-2 text-lg text-ink">
            <p>
              RN <span className="tnums font-semibold">{stopChoice.row.identNumber}</span> · Op.{' '}
              <span className="tnums font-semibold">{stopChoice.row.operationNumber}</span> — otvorenu
              sesiju ima još{' '}
              <span className="font-semibold">
                {stopChoice.row.othersOpenCount}{' '}
                {stopChoice.row.othersOpenCount === 1 ? 'radnik' : 'radnika'}
              </span>
              .
            </p>
            <p className="text-ink-secondary">
              „Završi samo moj rad" upisuje tvoje komade i vreme — operacija ostalima ostaje
              otvorena. „Zatvori za sve" gasi operaciju i završava i njihove sesije.
            </p>
          </div>
        )}
      </Dialog>
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
  onDismiss,
}: {
  row: MyOpenRow;
  /** Mutacija ovog reda je u toku (spinner na dugmetu). */
  busy: boolean;
  /** Drugi red je u toku — zaključaj kontrole dok se ne završi. */
  disabled: boolean;
  onStop: (pieces: number) => void;
  /** Otvara potvrdu „Odustani" (zatvaranje bez komada) — akcija je u panelu. */
  onDismiss: () => void;
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
          {/* Deljeni red: još neko ima otvorenu sesiju — „Kraj rada" će pitati. */}
          {(row.othersOpenCount ?? 0) > 0 && (
            <StatusBadge tone="warn" label={`+${row.othersOpenCount} radi`} />
          )}
          {/* Revizija crteža zastarela — mali žuti indikator (upozorenje, ne blokira). */}
          {row.drawing?.revisionStale && (
            <span className="inline-flex items-center rounded-full bg-status-warn-bg px-2.5 py-0.5 text-base font-semibold text-status-warn">
              novija rev {row.drawing.latestRevision ?? '—'}
            </span>
          )}
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
        {/* „Odustani" — sekundarno/diskretno (ne meša se sa „Kraj rada"). Zatvara
            pogrešno otvoren red BEZ komada, uz obaveznu potvrdu u dijalogu. */}
        <button
          type="button"
          onClick={onDismiss}
          disabled={locked}
          className="inline-flex h-11 items-center gap-1.5 rounded-control border border-line bg-surface px-4 text-base font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink disabled:opacity-40"
        >
          <XCircle className="h-4 w-4" aria-hidden />
          Odustani
        </button>
      </div>
    </li>
  );
}
