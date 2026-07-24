'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';

/**
 * Deljeni dijalog „Pošalji na mail" (Talas 3 A6) — jedan obrazac za sve tri mail
 * rute (faktura, IOS, PP-PDV). Polja: adresa primaoca (email) + opciona propratna
 * poruka. PDF se generiše i prilaže na backendu; ovde se samo prosleđuje `to`/`note`.
 *
 * `toRequired=false` (faktura) dozvoljava praznu adresu — backend tada šalje na
 * email komitenta sa računa. `toRequired=true` (IOS/PP-PDV) traži unetu adresu.
 * Osnovna provera formata je i ovde (brz feedback) i na backendu (autoritet).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SendMailDialog({
  title,
  intro,
  defaultTo = '',
  toRequired = true,
  toHint,
  withNote = false,
  sending = false,
  error,
  onSend,
  onClose,
}: {
  title: string;
  /** Kratak opis šta se šalje (npr. „Faktura 2026-0042 sa PDF prilogom."). */
  intro?: string;
  defaultTo?: string;
  /** false = prazna adresa dozvoljena (backend fallback na email komitenta). */
  toRequired?: boolean;
  toHint?: string;
  withNote?: boolean;
  sending?: boolean;
  error?: string | null;
  onSend: (args: { to: string; note?: string }) => void;
  onClose: () => void;
}) {
  const [to, setTo] = useState(defaultTo);
  const [note, setNote] = useState('');

  const trimmed = to.trim();
  const emailOk = trimmed === '' ? !toRequired : EMAIL_RE.test(trimmed);
  const canSend = emailOk && !sending;

  function submit() {
    if (!canSend) return;
    onSend({ to: trimmed, note: note.trim() || undefined });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      dismissable={false}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={sending} disabled={!canSend}>
            Pošalji
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {intro && <p className="text-sm text-ink-secondary">{intro}</p>}
        <FormField
          label="Email primaoca"
          required={toRequired}
          hint={toHint}
          error={trimmed !== '' && !emailOk ? 'Neispravan format email adrese.' : undefined}
        >
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="ime@primer.rs"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !withNote) {
                e.preventDefault();
                submit();
              }
            }}
          />
        </FormField>
        {withNote && (
          <FormField label="Propratna poruka" hint="opciono">
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Poruka koja ide u telo mejla…"
            />
          </FormField>
        )}
        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
