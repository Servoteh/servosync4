'use client';

import { useState } from 'react';
import { CheckCircle2, Minus, Plus, Printer } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { formatNumber } from '@/lib/format';

/**
 * DOŠTAMPAVANJE NALEPNICA — kad je završna kontrola za operaciju VEĆ urađena, kiosk
 * nudi samo štampu (Nesa 2026-07-10). Ne dira evidenciju (bez novog reda kontrole);
 * povlači podatke nalepnice sa RN-a i šalje štampaču.
 */
export function ReprintPanel({
  operationLabel,
  controlled,
  busy,
  onPrint,
  heading = 'Završna kontrola je već urađena',
  note = 'Možete samo doštampati nalepnice.',
}: {
  /** npr. „Op. 70 · Završna Kontrola". */
  operationLabel: string;
  /** Iskontrolisano komada (info; NIJE podrazumevani broj nalepnica). */
  controlled: number;
  busy: boolean;
  onPrint: (copies: number) => void;
  /** Naslov panela — podešava se za prvu štampu (posle kontrole) vs doštampavanje. */
  heading?: string;
  /** Napomena ispod naslova. */
  note?: string;
}) {
  // Default 1 nalepnica (Nesa 2026-07-10) — broj se po potrebi povećava; NE nudi
  // automatski celu iskontrolisanu količinu.
  const [copies, setCopies] = useState(1);

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-4 rounded-panel border border-status-success/40 bg-status-success-bg px-6 py-5 text-status-success">
        <CheckCircle2 className="h-11 w-11 shrink-0" aria-hidden />
        <div>
          <p className="text-2xl font-bold uppercase tracking-wide">{heading}</p>
          <p className="mt-1 text-xl">
            {operationLabel} · iskontrolisano{' '}
            <span className="tnums font-semibold">{formatNumber(controlled)}</span> kom. {note}
          </p>
        </div>
      </div>

      <div>
        <div className="mb-2 text-lg font-semibold uppercase tracking-wide text-ink-secondary">
          Broj nalepnica
        </div>
        <div className="flex items-stretch gap-3">
          <button
            type="button"
            onClick={() => setCopies((c) => Math.max(1, c - 1))}
            disabled={busy || copies <= 1}
            aria-label="Manje"
            className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            <Minus className="h-8 w-8" aria-hidden />
          </button>
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={copies || ''}
            disabled={busy}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              setCopies(Number.isFinite(n) && n > 0 ? n : 0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && copies >= 1) onPrint(copies);
            }}
            aria-label="Broj nalepnica"
            className="tnums h-20 w-full min-w-0 flex-1 rounded-panel border-2 border-line bg-surface text-center text-5xl font-bold text-ink focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => setCopies((c) => c + 1)}
            disabled={busy}
            aria-label="Više"
            className="grid h-20 w-20 shrink-0 place-items-center rounded-panel border-2 border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-40"
          >
            <Plus className="h-8 w-8" aria-hidden />
          </button>
        </div>
      </div>

      <Button
        variant="primary"
        loading={busy}
        disabled={busy || copies < 1}
        onClick={() => onPrint(copies)}
        className="h-24 w-full gap-3 text-3xl font-bold"
      >
        <Printer className="h-9 w-9" aria-hidden />
        Štampaj nalepnice
      </Button>
    </div>
  );
}
