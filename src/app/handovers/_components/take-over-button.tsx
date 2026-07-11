'use client';

import { useEffect, useState } from 'react';
import {
  HANDOVER_STATUS,
  useMyWorkerId,
  useTakeOverHandover,
  useTechnologists,
  type Handover,
} from '@/api/handovers';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorText } from './common';

const cancelBtn =
  'rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40';

/**
 * „Preuzmi izradu" (P4 §6.4, odluka #4) — dugme + potvrdni dijalog, deljeno
 * između taba „Odobrene" (red) i detalja primopredaje. Vidljivo SAMO kad:
 * primopredaja je SAGLASAN + nezaključana + ne-legacy, moj nalog ima `workerId`
 * (JWT claim — vidi `useMyWorkerId`) koji JESTE aktivan tehnolog (lista
 * `/handovers/technologists`, isti kriterijum kao backend gate) i zaduženje
 * NIJE već na meni; permisioni gate `primopredaje.write` preko <Can>. UI gate
 * je afordansa — backend 409/422 je krajnja istina (prikaz u dijalogu).
 * `alreadyOwner` (moguće samo uz stale listu) → info poruka umesto zatvaranja.
 */
export function TakeOverButton({
  handover,
  className,
}: {
  handover: Handover;
  className: string;
}) {
  const myWorkerId = useMyWorkerId();
  const technologists = useTechnologists();
  const takeOver = useTakeOverHandover();
  const [open, setOpen] = useState(false);
  const [alreadyOwner, setAlreadyOwner] = useState(false);

  // Reset-na-open (isti obrazac kao workflow-dialogs) — bez ovoga ponovno
  // otvaranje na istom redu prikaže staru grešku/info.
  useEffect(() => {
    if (!open) return;
    takeOver.reset();
    setAlreadyOwner(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isTechnologist =
    myWorkerId != null && (technologists.data?.data ?? []).some((t) => t.id === myWorkerId);
  if (
    handover.statusId !== HANDOVER_STATUS.APPROVED ||
    handover.isLegacy ||
    !!handover.isLocked ||
    !isTechnologist ||
    handover.technologistId === myWorkerId
  ) {
    return null;
  }

  function confirm() {
    takeOver.mutate(handover.id, {
      onSuccess: (res) => {
        // Već moj (stale lista): hook je invalidirao cache — ostavi dijalog
        // otvoren sa info porukom da klik ne "propadne" bez objašnjenja.
        if (res.alreadyOwner) setAlreadyOwner(true);
        else setOpen(false);
      },
    });
  }

  const drawingLabel = handover.drawing
    ? `${handover.drawing.drawingNumber} / ${handover.drawing.revision}`
    : `#${handover.drawingId}`;

  return (
    <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
      <button onClick={() => setOpen(true)} className={className}>
        Preuzmi izradu
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Preuzimanje izrade"
        footer={
          alreadyOwner ? (
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Zatvori
            </Button>
          ) : (
            <>
              <button
                onClick={() => setOpen(false)}
                disabled={takeOver.isPending}
                className={cancelBtn}
              >
                Otkaži
              </button>
              <Button onClick={confirm} loading={takeOver.isPending}>
                Preuzmi izradu
              </Button>
            </>
          )
        }
      >
        {alreadyOwner ? (
          <p className="text-sm text-ink">
            Izrada je već na vama — zaduženje je nepromenjeno (lista je bila zastarela i upravo je
            osvežena).
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-ink-secondary">
              Zaduženje za crtež{' '}
              <span className="tnums font-semibold text-ink">{drawingLabel}</span> prelazi na vas —
              vi postajete tehnolog koji piše TP
              {handover.technologist
                ? ` (trenutno: ${handover.technologist.fullName ?? handover.technologist.username})`
                : ''}
              . Ako je RN već otkucan a nije lansiran, i RN prelazi na vas. Prethodni tehnolog
              dobija obaveštenje.
            </p>
            <ErrorText error={takeOver.error} />
          </div>
        )}
      </Dialog>
    </Can>
  );
}
