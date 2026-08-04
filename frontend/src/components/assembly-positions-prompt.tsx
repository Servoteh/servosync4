'use client';

// Pitanje „ubaciti i sve pozicije sklopa?" — zahtev 027/26, dopuna (Igor 30.07):
// „kada izaberem sklop pri ubacivanju u nacrt, pita da li hoću SVE POZICIJE iz
// sklopa da ubacim u nacrt; ako neću, onda ubacuje samo crtež sklopa."
//
// JEDNA komponenta za oba mesta ubacivanja (pouka: bez kopija deljene logike):
//  - PDM „Dodaj u nacrt" (add-to-draft-dialog) — postojeći i novi nacrt,
//  - forma novog nacrta (drafts-tab) — ručni izbor „Glavni crtež sklopa".
// Pozicije = rekurzivni flat agregat sastavnice (isti skup koji auto-popuna
// novog nacrta koristi od ranije): proizvodni (ne-nabavni) delovi ODOBRENI u
// PDM-u. `onDismiss` (X/Esc/klik van) je ZASEBAN izlaz — potrošač bira da li
// znači „otkaži sve" (PDM dijalog) ili „Ne — samo sklop" (forma nacrta).

import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { formatNumber } from '@/lib/format';

/** Srpska množina uz broj pozicija: 1 pozicija · 2–4 pozicije · ostalo pozicija. */
export function positionsCountLabel(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word =
    mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
      ? 'pozicije'
      : 'pozicija';
  return `${formatNumber(n)} ${word}`;
}

export function AssemblyPositionsPrompt({
  open,
  drawingNumber,
  count,
  skippedUnapproved,
  onYes,
  onNo,
  onDismiss,
}: {
  open: boolean;
  /** Broj crteža sklopa — prikaz u pitanju. */
  drawingNumber: string;
  /** Broj pozicija koje bi „Da" ubacilo (proizvodne, odobrene, rekurzivno). */
  count: number;
  /** Proizvodne pozicije koje se preskaču jer NISU odobrene u PDM-u (brojevi). */
  skippedUnapproved?: string[];
  /** „Da — ubaci i pozicije": sklop + sve pozicije kao stavke. */
  onYes: () => void;
  /** „Ne — samo crtež sklopa": ubacuje se samo sklop, bez pozicija. */
  onNo: () => void;
  /** X / Esc / klik van — potrošač određuje semantiku (otkaži ili isto što i „Ne"). */
  onDismiss: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onDismiss}
      title="Pozicije sklopa"
      footer={
        <>
          <button
            onClick={onNo}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Ne — samo crtež sklopa
          </button>
          <Button onClick={onYes}>Da — ubaci i pozicije</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink">
          Sklop <span className="tnums font-semibold">{drawingNumber}</span> ima{' '}
          <span className="font-semibold">{positionsCountLabel(count)}</span>. Ubaciti i sve
          pozicije u nacrt?
        </p>
        <p className="text-xs text-ink-secondary">
          „Da” ubacuje crtež sklopa i sve pozicije iz sastavnice (uključujući delove
          podsklopova) kao stavke; „Ne” ubacuje samo crtež sklopa. Količine se posle mogu
          menjati po stavci.
        </p>
        {skippedUnapproved != null && skippedUnapproved.length > 0 && (
          <p className="rounded-control border border-status-warn/30 bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
            Nisu ODOBRENI u PDM-u pa se preskaču i uz „Da”:{' '}
            <span className="tnums">{skippedUnapproved.join(', ')}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
