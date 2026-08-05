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
 *
 * 🔴 GOTOVOST OPERACIJE (odluka Nenad 05.08.2026): „Kraj rada" je ranije UVEK
 * gasio operaciju, pa je „gotov sam za danas" značilo „operacija je završena"
 * (1.475 operacija je tako stajalo kao gotovo sa nepotpunom količinom). Sada:
 * kad kumulativ POSLE ove prijave ne dostiže plan, iskače pitanje „Otkucao si X
 * od Y. Da li je operacija gotova?" sa podrazumevanim NE. Kad je plan dostignut
 * — nema pitanja, server gasi operaciju kao i do sada.
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
  // „samo moj rad / za sve" pre slanja (null = dijalog zatvoren). `gotova` nosi
  // već dat odgovor na pitanje o gotovosti (undefined = pitanje nije ni bilo).
  const [stopChoice, setStopChoice] = useState<{
    row: MyOpenRow;
    pieces: number;
    gotova?: boolean;
  } | null>(null);
  // Pitanje „Otkucao si X od Y. Da li je operacija gotova?" (null = zatvoreno).
  const [finishAsk, setFinishAsk] = useState<{
    row: MyOpenRow;
    pieces: number;
    /** Kumulativ na operaciji POSLE ove prijave (X u pitanju). */
    ukupno: number;
    /** Plan RN-a (Y u pitanju); null = plan nije poznat. */
    plan: number | null;
  } | null>(null);

  const rows = query.data?.data ?? [];

  async function onStop(
    row: MyOpenRow,
    pieces: number,
    finishForAll = false,
    operacijaGotova?: boolean,
  ) {
    setStopChoice(null);
    setFinishAsk(null);
    setFeedback(null);
    setBusyId(row.id);
    try {
      const { data } = await stopWork.mutateAsync({
        id: row.id,
        pieceCount: pieces,
        workerCard: card ?? undefined,
        finishForAll: finishForAll || undefined,
        operacijaGotova,
      });
      const parts = [
        pieces > 0
          ? `Prijavljeno ${formatNumber(data.reportedPieces)} kom`
          : 'Evidentirano samo vreme rada',
      ];
      if (data.operationFinished) parts.push('Operacija je dostigla plan i zatvorena.');
      // Zatvorena ispod plana — samo zato što je radnik rekao „Da, gotova je".
      else if (data.operationClosed && operacijaGotova === true)
        parts.push('Operacija je označena kao gotova (količina nije puna).');
      // Opšti nalog: red se čisti bez pitanja (sledeći sken otvara nov).
      else if (data.operationClosed) parts.push('Red je zatvoren.');
      else if (operacijaGotova === false)
        parts.push('Operacija ostaje otvorena — nastavlja se.');
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

  /**
   * „Kraj rada" klik. Redosled pitanja:
   *  1. GOTOVOST — samo kad kumulativ POSLE ove prijave ne dostiže plan (Nenad
   *     05.08.2026). Opšti nalog (RC bez postupka) se preskače: nema plan.
   *  2. DELJENI RED — „samo moj rad / za sve"; ima smisla samo kad se red i gasi
   *     (plan dostignut ili odgovor „Da — gotova je").
   */
  function onStopRequest(row: MyOpenRow, pieces: number) {
    const plan = row.plannedPieces;
    // Kumulativ CELE operacije (FIX A ume da razbije kucanja na više redova);
    // stariji backend ne vraća polje → fallback na red.
    const ukupno = (row.cumulativePieces ?? row.pieceCount) + pieces;
    const planPoznat = plan != null && plan > 0;
    const opstiNalog = row.operation?.withoutProcess === true;
    if (!opstiNalog && (!planPoznat || ukupno < plan!)) {
      setFinishAsk({ row, pieces, ukupno, plan: planPoznat ? plan! : null });
      return;
    }
    onStopAfterFinishAnswer(row, pieces, undefined);
  }

  /** Posle (eventualnog) pitanja o gotovosti — deljeni red pita „samo moj / za sve". */
  function onStopAfterFinishAnswer(row: MyOpenRow, pieces: number, gotova?: boolean) {
    setFinishAsk(null);
    // Red ostaje otvoren („Ne — nastavlja se") → nema šta da se gasi ni za koga.
    if (gotova !== false && (row.othersOpenCount ?? 0) > 0)
      setStopChoice({ row, pieces, gotova });
    else void onStop(row, pieces, false, gotova);
  }

  /**
   * „Odustani" — sklanja pogrešno otvoren red sa MOJE liste BEZ evidentiranja
   * komada (POST /:id/dismiss). Od 05.08.2026 NE proglašava operaciju završenom
   * (odustajanje je čišćenje greške): red bez komada se otkupljuje i nestaje,
   * red sa komadima ostaje i završava se kroz „Kraj rada". Isti busyId/spinner
   * obrazac kao onStop; poziva se tek POSLE eksplicitne potvrde u dijalogu.
   */
  async function onDismiss(row: MyOpenRow) {
    setConfirmRow(null);
    setFeedback(null);
    setBusyId(row.id);
    try {
      const { data } = await dismissOpen.mutateAsync({ id: row.id, workerCard: card ?? undefined });
      setFeedback({
        ok: true,
        text: data.released
          ? `RN ${row.identNumber} · Op. ${row.operationNumber} — red je odbačen i sklonjen sa tvoje liste (bez evidentiranja komada). Operacija NIJE proglašena završenom.`
          : `RN ${row.identNumber} · Op. ${row.operationNumber} — tvoja sesija je zatvorena, ali red nosi evidentirane komade pa ostaje na listi. Završi ga kroz „Kraj rada".`,
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
        title="Odustati od reda?"
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
              <span className="tnums font-semibold">{confirmRow.operationNumber}</span> — red se
              sklanja sa tvoje liste <span className="font-semibold">BEZ evidentiranja komada</span>.
            </p>
            <p className="text-ink-secondary">
              Koristi ovo samo za pogrešno otvorene redove. Operacija se{' '}
              <span className="font-semibold">NE</span> proglašava završenom — za to služi „Kraj
              rada".
            </p>
            {confirmRow.pieceCount > 0 && (
              <p className="text-ink-secondary">
                Ovaj red već nosi {formatNumber(confirmRow.pieceCount)} evidentiranih kom, pa ostaje
                na listi (evidencija se ne briše) — završi ga kroz „Kraj rada".
              </p>
            )}
            {(confirmRow.othersOpenCount ?? 0) > 0 && (
              <p className="text-ink-secondary">
                Na operaciji trenutno radi još {confirmRow.othersOpenCount}{' '}
                {confirmRow.othersOpenCount === 1 ? 'radnik' : 'radnika'} — njihov rad se ne dira.
              </p>
            )}
          </div>
        )}
      </Dialog>

      {/* 🔴 GOTOVOST OPERACIJE (Nenad 05.08.2026) — iskače SAMO kad količina nije
          puna. Podrazumevani odgovor je NE (istaknuto dugme + fokus, tako da i
          slučajan tap/Enter ostavlja operaciju otvorenom). Dodirni ekran u pogonu:
          krupan tekst, dugmad visine 20 (80px), bez sitnog fonta. */}
      <Dialog
        open={finishAsk !== null}
        onClose={() => setFinishAsk(null)}
        title="Da li je operacija gotova?"
        size="lg"
        footer={
          <>
            <Button
              variant="primary"
              autoFocus
              onClick={() =>
                finishAsk &&
                onStopAfterFinishAnswer(finishAsk.row, finishAsk.pieces, false)
              }
              className="h-20 flex-1 px-6 text-2xl font-bold"
            >
              Ne — nastavlja se
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                finishAsk && onStopAfterFinishAnswer(finishAsk.row, finishAsk.pieces, true)
              }
              className="h-20 flex-1 px-6 text-2xl font-bold"
            >
              Da — gotova je
            </Button>
          </>
        }
      >
        {finishAsk && (
          <div className="space-y-4 text-ink">
            <p className="text-3xl font-bold">
              {finishAsk.plan != null ? (
                <>
                  Otkucao si{' '}
                  <span className="tnums text-accent">{formatNumber(finishAsk.ukupno)}</span> od{' '}
                  <span className="tnums">{formatNumber(finishAsk.plan)}</span> kom.
                </>
              ) : (
                <>
                  Otkucano ukupno{' '}
                  <span className="tnums text-accent">{formatNumber(finishAsk.ukupno)}</span> kom
                  (plan nije poznat).
                </>
              )}
            </p>
            <p className="text-xl">
              RN <span className="tnums font-semibold">{finishAsk.row.identNumber}</span> · Op.{' '}
              <span className="tnums font-semibold">{finishAsk.row.operationNumber}</span> ·{' '}
              {finishAsk.row.operation?.workCenterName ?? finishAsk.row.workCenterCode}
            </p>
            <p className="text-xl text-ink-secondary">
              „Ne" upisuje tvoj rad i vreme, a operacija ostaje otvorena za nastavak. „Da" je
              zatvara iako količina nije puna.
            </p>
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
              onClick={() =>
                stopChoice &&
                onStop(stopChoice.row, stopChoice.pieces, true, stopChoice.gotova)
              }
            >
              Zatvori za sve
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                stopChoice &&
                onStop(stopChoice.row, stopChoice.pieces, false, stopChoice.gotova)
              }
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
              {/* Kumulativ CELE operacije — isti broj koji ulazi u pitanje o gotovosti
                  i u serversko poređenje sa planom (FIX A ume da razbije kucanja na
                  više redova, pa `pieceCount` jednog reda nije merodavan). */}
              {formatNumber(row.cumulativePieces ?? row.pieceCount)}
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
