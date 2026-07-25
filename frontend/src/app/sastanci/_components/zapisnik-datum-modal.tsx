'use client';

import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { localTodayIso } from '@/lib/sastanci-print';
import { formatDatum, INPUT_CLS } from './common';

/** `YYYY-MM-DD` minus godina dana (samo kao donja granica poređenja — 29.02 sme). */
function minusGodina(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${Number(y) - 1}-${m}-${d}`;
}

/**
 * Provera unetog datuma PRE slanja. Pravi razlog: `type="date"` prima i 2062-07-25
 * (tipfeler u godini), a taj datum bi otišao u ZVANIČNI zapisnik i mejl svim
 * učesnicima. `IsCalendarDate` na backendu hvata samo nepostojeće datume, ne besmislene.
 * Granice su namerno široke — nikad ne smeju odbiti vrednost koju sam modal nudi
 * (dugme „Datum termina" ume da bude i u budućnosti ako je sastanak zakazan unapred).
 */
function proveriDatum(v: string, donja: string, gornja: string): string | null {
  if (!v) return 'Datum je obavezan.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'Datum nije ispravan.';
  if (v < donja) return `Datum je pre ${formatDatum(donja)} — proveri godinu.`;
  if (v > gornja) return `Datum je posle ${formatDatum(gornja)} — proveri godinu.`;
  return null;
}

/**
 * Izbor datuma koji nosi ZAPISNIK — zahtev 014/26 + presuda vlasnika 25.07.2026:
 * „datum o zapisniku nek bude onaj sa zaključavanja, ali da može da se promeni;
 *  ukoliko datum zaključavanja sastanka nije isti kao [datum] sastanka, da se ponudi
 *  taj datum održavanja i da se to namesti."
 *
 * Otuda: polje je podrazumevano DANAS (po pravilu se zaključava na dan sastanka), a
 * kad se DANAS razlikuje od zakazanog TERMINA nudi se prečica na `sastanci.datum`.
 * Treći, proizvoljan datum se prosto ukuca. Isti modal koristi i zaključavanje
 * (`lock`) i ispravka posle zaključavanja (`ispravka`).
 *
 * Tastatura: Enter potvrđuje, Esc odustaje — ali NIJEDNO dok radnja traje.
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
  /** `sastanci.datum` — zakazani TERMIN; nudi se kao prečica kad se razlikuje. */
  datumSastanka: string;
  /** Početna vrednost polja. Izostavljena → DANAS (lokalno, ne UTC). */
  initialDatum?: string | null;
  busy?: boolean;
  onPotvrdi: (datum: string) => void;
  onClose: () => void;
}) {
  const danas = localTodayIso();
  const inputRef = useRef<HTMLInputElement>(null);
  const [datum, setDatum] = useState<string>(initialDatum?.slice(0, 10) || danas);
  // Ispravka regeneriše CEO zvanični PDF iz trenutnih podataka (v. tekst ispod) —
  // to je veće od „promeni datum", pa traži izričitu potvrdu. Lock je ne traži.
  const [svestanRegen, setSvestanRegen] = useState(false);

  const terminIso = String(datumSastanka).slice(0, 10);
  // Prečica se nudi samo kad zaista donosi drugu vrednost od one u polju.
  const nudiTermin = Boolean(terminIso) && terminIso !== datum;

  // Gornja granica prima i termin u budućnosti (sastanak zakazan unapred, pa
  // zaključan ranije) — inače bi validacija odbila baš ono što dugme nudi.
  const gornja = terminIso && terminIso > danas ? terminIso : danas;
  const donja = minusGodina(terminIso && terminIso < danas ? terminIso : danas);
  const greska = proveriDatum(datum, donja, gornja);
  const smePotvrditi = !greska && !busy && (mode === 'lock' || svestanRegen);

  function potvrdi() {
    if (!smePotvrditi) return;
    onPotvrdi(datum);
  }

  return (
    <Dialog
      open
      // Dok radnja traje NIŠTA ne zatvara modal — ni Esc/pozadina (`dismissable`),
      // ni „X" u zaglavlju (ui-kit Dialog zove ovaj `onClose`; guard je ovde jer
      // ugovor `Dialog`-a deli još ~20 dijaloga i ne dira se). Zaključavanje šalje
      // mejl SVIM učesnicima — zatvoren modal bi sakrio da je to već u toku.
      onClose={busy ? () => {} : onClose}
      dismissable={!busy}
      title={mode === 'lock' ? 'Zaključavanje sastanka' : 'Ispravi datum zapisnika'}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>
            Otkaži
          </Button>
          <Button loading={busy} disabled={!smePotvrditi} onClick={potvrdi}>
            {mode === 'lock' ? 'Zaključaj' : 'Sačuvaj i zameni PDF'}
          </Button>
        </>
      }
    >
      <div
        className="space-y-3"
        onKeyDown={(e) => {
          // Enter potvrđuje — osim kad je fokus na dugmetu ili čekboksu, gde bi ga
          // browser već pretvorio u klik pa bismo potvrdili pre nego što se izbor vidi.
          if (e.key !== 'Enter' || !smePotvrditi) return;
          const t = e.target as HTMLElement;
          if (t.tagName === 'BUTTON' || (t as HTMLInputElement).type === 'checkbox') return;
          e.preventDefault();
          potvrdi();
        }}
      >
        <p className="text-sm text-ink-secondary">
          {mode === 'lock'
            ? 'Ovaj datum nosi PDF zapisnik, mejl učesnicima i naziv priloga. Podrazumevano je današnji dan — dan zaključavanja.'
            : 'Ovaj datum nosi PDF zapisnik i naziv priloga.'}
        </p>

        <FormField
          label="Datum zapisnika"
          required
          error={greska ?? undefined}
          hint={
            greska
              ? undefined
              : mode === 'lock'
                ? 'Dan kada je sastanak stvarno održan. Podrazumevano je današnji (dan zaključavanja).'
                : 'Dan kada je sastanak stvarno održan.'
          }
        >
          <input
            ref={inputRef}
            id="zapisnik-datum-polje"
            aria-label="Datum zapisnika"
            // 16px + 44px SAMO ovde: ispod 16px iOS Safari zumira stranu na fokus,
            // a 44px je minimalna pouzdana meta prstom (ovaj modal se koristi i sa
            // telefona, na licu mesta posle sastanka). Ne diramo deljeni INPUT_CLS.
            className={`${INPUT_CLS} min-h-[44px] text-[16px]`}
            type="date"
            min={donja}
            max={gornja}
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
            <Button
              variant="secondary"
              className="mt-2 min-h-[44px]"
              disabled={busy}
              onClick={() => {
                setDatum(terminIso);
                // Fokus nazad na polje: bez ovoga Enter prestaje da potvrđuje jer
                // ostaje na dugmetu (koje Enter tumači kao još jedan klik).
                inputRef.current?.focus();
              }}
            >
              <CalendarDays className="h-4 w-4" aria-hidden /> Datum termina ({formatDatum(terminIso)})
            </Button>
          </div>
        )}

        {mode === 'ispravka' && (
          <div className="space-y-2 rounded-panel border border-status-warn/40 bg-status-warn-bg p-3">
            <p className="text-sm text-ink">
              Snimanje ne menja samo datum: <strong>zvanični PDF se generiše iznova</strong> iz
              trenutnih podataka o sastanku (tačke zapisnika, akcioni plan, rezime „Od prošlog
              sastanka", redosled po prioritetu predmeta) i zamenjuje postojeći u arhivi. Ako se
              nešto od toga menjalo posle zaključavanja, novi PDF neće biti istovetan starom.
            </p>
            <p className="text-sm text-ink-secondary">
              Učesnici <strong>neće</strong> automatski dobiti ispravljen zapisnik — mejl se ne
              šalje ponovo. Za to posle upotrebi „Pošalji ponovo".
            </p>
            <label className="flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={svestanRegen}
                disabled={busy}
                onChange={(e) => setSvestanRegen(e.target.checked)}
              />
              <span>Razumem — generiši zapisnik iznova i zameni PDF u arhivi.</span>
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}
