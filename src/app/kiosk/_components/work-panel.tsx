'use client';

import { useEffect, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, Check, Clock, FileText, Lock, Minus, Play, Plus, Square } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { openKioskDrawingPdf } from '@/api/kiosk';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

interface WorkPanelProps {
  /** npr. „Op. 30 · Struganje". */
  operationLabel: string;
  identMark: string;
  /** Crtež sa RN-a (za dugme „PDF crteža") — null/undefined kad nije razrešen ili nema PDF. */
  drawing?: { id: number; hasPdf: boolean } | null;
  /** Planirano (potrebno) sa RN-a; null ako RN nije razrešen. */
  planned: number | null;
  /** Napravljeno (akumulirano) na ovoj operaciji. */
  made: number;
  finished: boolean;
  /** Skenirana operacija nije nađena u tehnološkom postupku ovog naloga. */
  missing: boolean;
  loading: boolean;
  /** Otvorena vremenska sesija radnika za ovu operaciju (A-4) — null = START režim. */
  openSession: { id: number; startedAt: string } | null;
  sessionLoading: boolean;
  zapocinjanje: boolean;
  zavrsavanje: boolean;
  onZapocni: () => void;
  onZavrsiRad: (pieces: number) => void;
  /** Brza prijava (scan) — bez merenja vremena. */
  evidentiranje: boolean;
  onEvidentiraj: (pieces: number) => void;
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

/** Živi tajmer trajanja otvorene sesije (osvežava svake sekunde). */
function ElapsedBanner({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const txt = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return (
    <div className="flex items-center justify-center gap-3 rounded-panel border-2 border-accent/40 bg-accent-subtle px-5 py-4 text-accent">
      <Clock className="h-8 w-8 shrink-0" aria-hidden />
      <span className="text-lg font-semibold uppercase tracking-wide">Rad u toku</span>
      <span className="tnums text-5xl font-bold">{txt}</span>
    </div>
  );
}

/** +/- brojač komada (deljeno START-brza-prijava i STOP). */
function PieceStepper({
  pieces,
  setPieces,
  busy,
  min,
  onEnter,
}: {
  pieces: number;
  setPieces: (updater: (p: number) => number) => void;
  busy: boolean;
  /** Najmanja dozvoljena vrednost: 1 („Evidentiraj") ili 0 (aktivna sesija — samo vreme). */
  min: number;
  onEnter: () => void;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') onEnter();
  };
  return (
    <div>
      <div className="mb-2 text-lg font-semibold uppercase tracking-wide text-ink-secondary">
        Broj napravljenih komada
      </div>
      <div className="flex items-stretch gap-3">
        <button
          type="button"
          onClick={() => setPieces((p) => Math.max(min, p - 1))}
          disabled={busy || pieces <= min}
          aria-label="Manje"
          className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
        >
          <Minus className="h-8 w-8" aria-hidden />
        </button>
        <input
          type="number"
          min={min}
          inputMode="numeric"
          value={pieces === 0 && min > 0 ? '' : pieces}
          disabled={busy}
          onChange={(e) => {
            const n = Math.floor(Number(e.target.value));
            setPieces(() => (Number.isFinite(n) && n > 0 ? n : 0));
          }}
          onKeyDown={onKeyDown}
          aria-label="Broj napravljenih komada"
          className="tnums h-20 w-full min-w-0 flex-1 rounded-panel border-2 border-line bg-surface text-center text-5xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => setPieces((p) => p + 1)}
          disabled={busy}
          aria-label="Više"
          className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
        >
          <Plus className="h-8 w-8" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function WorkPanel({
  operationLabel,
  identMark,
  drawing,
  planned,
  made,
  finished,
  missing,
  loading,
  openSession,
  sessionLoading,
  zapocinjanje,
  zavrsavanje,
  onZapocni,
  onZavrsiRad,
  evidentiranje,
  onEvidentiraj,
}: WorkPanelProps) {
  const [pieces, setPieces] = useState(1);
  const busy = evidentiranje || zapocinjanje || zavrsavanje;
  const remaining = planned != null ? Math.max(0, planned - made) : null;
  // Aktivna sesija (borverk radi danima na komadu) dozvoljava 0 kom; „Evidentiraj" traži ≥ 1.
  // Pri izlasku iz sesijskog režima podigni 0 → 1 (isti brojač služi oba režima).
  useEffect(() => {
    if (!openSession) setPieces((p) => Math.max(1, p));
  }, [openSession]);

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

  // Sesijski režim prihvata 0 kom (samo vreme); brza prijava traži ≥ 1.
  const stopWork = () => {
    if (!busy && pieces >= 0) onZavrsiRad(pieces);
  };
  const quickReport = () => {
    if (!busy && pieces >= 1) onEvidentiraj(pieces);
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
        <div className="flex items-center gap-3">
          {drawing?.hasPdf && (
            <button
              type="button"
              onClick={() => openKioskDrawingPdf(drawing.id)}
              className="inline-flex h-14 items-center gap-2 rounded-control border-2 border-line bg-surface px-5 text-lg font-semibold text-ink hover:bg-surface-2"
            >
              <FileText className="h-5 w-5" aria-hidden />
              PDF crteža
            </button>
          )}
          {finished && <StatusBadge tone="success" label="Zatvorena" />}
        </div>
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
      ) : sessionLoading ? (
        <div className="grid place-items-center rounded-panel border border-line bg-surface px-6 py-8 text-lg text-ink-secondary">
          Provera sesije…
        </div>
      ) : openSession ? (
        /* STOP režim: rad je u toku — unesi komade i završi. */
        <>
          <ElapsedBanner startedAt={openSession.startedAt} />
          <PieceStepper pieces={pieces} setPieces={setPieces} busy={busy} min={0} onEnter={stopWork} />
          {pieces === 0 && (
            <p className="text-base text-ink-secondary">
              0 kom — evidentira se samo vreme rada.
            </p>
          )}
          <Button
            variant="primary"
            loading={zavrsavanje}
            disabled={busy}
            onClick={stopWork}
            className="h-20 w-full gap-3 text-2xl font-bold"
          >
            <Square className="h-7 w-7" aria-hidden />
            Završi rad
          </Button>
        </>
      ) : (
        /* START režim: započni merenje vremena, ili brza prijava bez merenja. */
        <>
          <Button
            variant="primary"
            loading={zapocinjanje}
            disabled={busy}
            onClick={onZapocni}
            className="h-24 w-full gap-3 text-3xl font-bold"
          >
            <Play className="h-9 w-9" aria-hidden />
            Započni rad
          </Button>

          <div className="flex items-center gap-3 text-base font-semibold uppercase tracking-wide text-ink-disabled">
            <span className="h-px flex-1 bg-line" />
            ili brza prijava (bez merenja vremena)
            <span className="h-px flex-1 bg-line" />
          </div>

          <PieceStepper pieces={pieces} setPieces={setPieces} busy={busy} min={1} onEnter={quickReport} />
          <Button
            variant="secondary"
            loading={evidentiranje}
            disabled={busy || pieces < 1}
            onClick={quickReport}
            className="h-20 w-full gap-3 text-2xl font-bold"
          >
            <Check className="h-7 w-7" aria-hidden />
            Evidentiraj
          </Button>
        </>
      )}
    </div>
  );
}
