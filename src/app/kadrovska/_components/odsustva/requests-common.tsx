'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';

// Deljeni delovi inbox-ova zahteva (Nadoknada / Plaćeno): prolazna poruka o
// ishodu akcije (1.0 showToast pandan) + „Odbij sa obaveznim razlogom" modal.

export interface Notice {
  kind: 'ok' | 'warn';
  text: string;
}

/** Prolazna statusna poruka (auto-nestaje posle 6s). */
export function useNotice(): { notice: Notice | null; show: (kind: Notice['kind'], text: string) => void } {
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const show = useCallback((kind: Notice['kind'], text: string) => {
    setNotice({ kind, text });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 6000);
  }, []);
  return { notice, show };
}

export function NoticeBar({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  return (
    <div
      role="status"
      className={
        notice.kind === 'ok'
          ? 'rounded-control border border-status-success/40 bg-status-success-bg px-3 py-2 text-sm text-status-success'
          : 'rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-sm text-status-warn'
      }
    >
      {notice.text}
    </div>
  );
}

/** Modal „Odbij" — razlog obavezan (max 300); i „Storno" varijanta (razlog opcion). */
export function ReasonDialog({
  title,
  subtitle,
  confirmLabel,
  requireNote,
  onConfirm,
  onClose,
}: {
  title: string;
  subtitle: string;
  confirmLabel: string;
  requireNote: boolean;
  onConfirm: (note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function confirm() {
    const t = note.trim();
    if (requireNote && !t) {
      setErr('Razlog je obavezan.');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      await onConfirm(t);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button variant="danger" onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-secondary">{subtitle}</p>
      {err && (
        <p className="mb-2 text-sm text-status-danger" role="alert">
          {err}
        </p>
      )}
      <label className="block text-sm font-medium text-ink">
        {requireNote ? 'Razlog *' : 'Razlog (opciono)'}
        <textarea
          autoFocus
          maxLength={300}
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Unesite razlog…"
          className="mt-1.5 w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink"
        />
      </label>
    </Dialog>
  );
}
