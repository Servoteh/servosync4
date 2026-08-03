'use client';

import { useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { toast } from '@/lib/toast';
import {
  useConfirmDelivery,
  useReopenDelivery,
  type ChangeRequestDetail,
} from '@/api/zahtevi';

/**
 * Baner provere isporuke (03.08.2026) — vidi ga PODNOSILAC (i admin) dok je zahtev
 * u statusu READY_FOR_TEST.
 *
 * Zašto postoji: do sada je jedini prelaz statusa bio admin-only `POST :id/status`,
 * pa je korisnik koji je probao isporuku mogao SAMO da napiše komentar „RADI" — i da
 * se nada da će ga neko pročitati. Zahtevi su se gomilali u READY_FOR_TEST (40 komada
 * na dan uvođenja), a ljudi su mislili da su ih potvrdili. Sada je potvrda radnja:
 *
 *   „Potvrđujem — radi"  → POST :id/confirm → DONE      (komentar OPCIONO)
 *   „Ne radi…"           → POST :id/reopen  → SUBMITTED (komentar OBAVEZAN + mejl)
 *
 * Obe radnje idu kroz dijalog (idiom modula — kao Povuci/Obriši nacrt): potvrda
 * zatvara zahtev, pa slučajan klik ne sme da bude neopoziv, a dijalog je i mesto
 * gde staje propratna poruka. Nagrada se ovde NE dira (admin odluka, tab Nagrade).
 */
export function DeliveryCheckBanner({ detail }: { detail: ChangeRequestDetail }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  return (
    <section className="rounded-panel border border-status-success/40 bg-status-success-bg p-5">
      <div className="flex items-start gap-3">
        <CheckCircle2
          className="mt-0.5 h-5 w-5 shrink-0 text-status-success"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold text-status-success">
            Urađeno je — molimo proveri
          </h2>
          <p className="mt-1 text-sm text-ink">
            Vaš zahtev je isporučen i čeka vašu proveru. Probajte kako sada radi pa
            javite ishod — dok ne javite, zahtev ostaje otvoren.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setConfirmOpen(true)}>
              ✔ Potvrđujem — radi
            </Button>
            <Button variant="secondary" onClick={() => setReopenOpen(true)}>
              ⚠ Ne radi…
            </Button>
          </div>
        </div>
      </div>

      {confirmOpen && (
        <ConfirmDeliveryDialog
          detail={detail}
          onClose={() => setConfirmOpen(false)}
        />
      )}
      {reopenOpen && (
        <ReopenDeliveryDialog
          detail={detail}
          onClose={() => setReopenOpen(false)}
        />
      )}
    </section>
  );
}

/** Potvrda da isporuka radi — komentar je OPCIONO (pohvala, napomena, sitna primedba). */
function ConfirmDeliveryDialog({
  detail,
  onClose,
}: {
  detail: ChangeRequestDetail;
  onClose: () => void;
}) {
  const confirmDelivery = useConfirmDelivery();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    confirmDelivery.mutate(
      { id: detail.id, comment: comment.trim() || undefined },
      {
        onSuccess: (res) => {
          // BE vraća `noop:true` ako je zahtev već zatvoren (dupli klik / stari tab) —
          // to nije greška, samo drugačija poruka.
          toast(res.noop ? (res.message ?? 'Zahtev je već zatvoren.') : 'Hvala — zahtev je potvrđen i zatvoren.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title="Potvrda da radi"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={confirmDelivery.isPending}
          >
            Potvrđujem — radi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        <p className="text-sm text-ink">
          Zahtev <strong>{detail.reqNo}</strong> se zatvara kao završen. Ako nešto i
          dalje ne valja, umesto ovoga izaberite „Ne radi…".
        </p>
        <FormField label="Komentar (opciono)" hint="Npr. napomena ili sitna primedba za ubuduće.">
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={4000}
          />
        </FormField>
      </div>
    </Dialog>
  );
}

/** Prijava da isporuka NE radi — opis je OBAVEZAN (BE vraća 422 bez njega). */
function ReopenDeliveryDialog({
  detail,
  onClose,
}: {
  detail: ChangeRequestDetail;
  onClose: () => void;
}) {
  const reopen = useReopenDelivery();
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);

  function submit() {
    setErr(null);
    const text = comment.trim();
    // Ista provera i na BE (422) — ovde samo da korisnik ne čeka mrežu za očiglednu grešku.
    if (!text)
      return setErr('Napišite šta ne radi — bez toga se zahtev ne vraća u rad.');
    reopen.mutate(
      { id: detail.id, comment: text },
      {
        onSuccess: () => {
          toast('Prijavljeno — zahtev je vraćen u rad.');
          onClose();
        },
        onError: (e) => setErr((e as Error).message),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissable={false}
      title="Šta ne radi?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={reopen.isPending}>
            Vrati u rad
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {err && (
          <p className="rounded-control bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </p>
        )}
        <div className="flex items-start gap-2 rounded-control bg-status-warn-bg px-3 py-2 text-sm text-ink">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-status-warn"
            aria-hidden
          />
          <span>
            Opišite što konkretnije šta ste radili i šta se desilo — po tome se traži
            greška. Zahtev se vraća u red za rad, a administracija dobija obaveštenje.
          </span>
        </div>
        <FormField
          label="Šta ne radi"
          required
          hint={'Npr. „Kad kliknem Sačuvaj, javi grešku i ne snimi red."'}
        >
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            maxLength={4000}
            autoFocus
          />
        </FormField>
      </div>
    </Dialog>
  );
}
