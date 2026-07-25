'use client';

import { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { localTodayIso } from '@/lib/sastanci-print';
import { formatDatum, INPUT_CLS } from './common';

/**
 * Izbor datuma koji nosi ZAPISNIK — zahtev 014/26 + presuda vlasnika 25.07.2026:
 * „datum o zapisniku nek bude onaj sa zaključavanja, ali da može da se promeni;
 *  ukoliko datum zaključavanja sastanka nije isti kao [datum] sastanka, da se ponudi
 *  taj datum održavanja i da se to namesti."
 *
 * Otuda: polje je podrazumevano DANAS (po pravilu se zaključava na dan sastanka), a
 * kad se DANAS razlikuje od zakazanog termina nudi se prečica na `sastanci.datum`.
 * Treći, proizvoljan datum se prosto ukuca. Isti modal koristi i zaključavanje i
 * ispravka posle zaključavanja — tekst se razlikuje samo u `mode`.
 *
 * Tastatura: Enter potvrđuje, Esc odustaje (Esc rešava ui-kit Dialog).
 */
export function ZapisnikDatumModal({
  mode,
  datumSastanka,
  initialDatum,
  busy,
  onPotvrdi,
  onClose,
}: {
  /** 'lock' = potvrda zaključavanja; 'ispravka' = izmena na već zaključanom. */
  mode: 'lock' | 'ispravka';
  /** `sastanci.datum` — zakazani termin; nudi se kao prečica kad se razlikuje. */
  datumSastanka: string;
  /** Početna vrednost polja. Izostavljena → DANAS (lokalno, ne UTC). */
  initialDatum?: string | null;
  busy?: boolean;
  onPotvrdi: (datum: string) => void;
  onClose: () => void;
}) {
  const danas = localTodayIso();
  const [datum, setDatum] = useState<string>(initialDatum?.slice(0, 10) || danas);
  const terminIso = String(datumSastanka).slice(0, 10);
  // Prečica se nudi samo kad zaista donosi drugu vrednost od one u polju.
  const nudiTermin = terminIso && terminIso !== datum;

  function potvrdi() {
    if (!datum) return;
    onPotvrdi(datum);
  }

  return (
    <Dialog
      open
      onClose={onClose}
      // Esc/pozadina odustaju (presuda: „Esc odustaje"), ALI ne dok radnja traje —
      // zaključavanje/zamena PDF-a je već u letu i zatvaranje bi sakrilo ishod.
      dismissable={!busy}
      title={mode === 'lock' ? 'Zaključavanje sastanka' : 'Ispravi datum zapisnika'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={busy} disabled={!datum} onClick={potvrdi}>
            {mode === 'lock' ? 'Zaključaj' : 'Sačuvaj i zameni PDF'}
          </Button>
        </div>
      }
    >
      <div
        className="space-y-3"
        onKeyDown={(e) => {
          // Enter potvrđuje — osim kad je fokus na dugmetu („Datum sastanka"), gde bi
          // ga browser već pretvorio u klik pa bismo potvrdili i pre nego što se
          // izabrana vrednost vidi.
          if (e.key !== 'Enter' || busy || !datum) return;
          if ((e.target as HTMLElement).tagName === 'BUTTON') return;
          e.preventDefault();
          potvrdi();
        }}
      >
        <p className="text-sm text-ink-secondary">
          {mode === 'lock'
            ? 'Ovaj datum nosi PDF zapisnik, mejl učesnicima i naziv priloga. Podrazumevano je današnji dan (dan zaključavanja).'
            : 'Ovaj datum nosi PDF zapisnik i mejl učesnicima. Po snimanju se PDF u arhivi automatski re-generiše sa novim datumom.'}
        </p>
        <FormField label="Datum zapisnika (datum održavanja)" required>
          <input
            className={INPUT_CLS}
            type="date"
            value={datum}
            onChange={(e) => setDatum(e.target.value)}
            autoFocus
          />
        </FormField>
        {nudiTermin && (
          <div className="rounded-panel border border-line bg-surface-2 p-3">
            <p className="text-sm text-ink-secondary">
              Zakazani termin sastanka je <strong>{formatDatum(terminIso)}</strong> — razlikuje se od izabranog datuma.
            </p>
            <Button variant="secondary" className="mt-2" onClick={() => setDatum(terminIso)}>
              <CalendarDays className="h-4 w-4" aria-hidden /> Datum sastanka ({formatDatum(terminIso)})
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
