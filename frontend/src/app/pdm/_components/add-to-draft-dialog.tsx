'use client';

// „Dodaj u nacrt" iz PDM crteža (red liste / detalj / čvor sastavnice) — legacy
// „Sastavnica delova za sklop" akcija: projektant hvata crtež u nacrt primopredaje.
// Dva puta (Nenad 16.07): (1) u POSTOJEĆI otvoren nacrt — POST /handover-drafts/:id/items
// (useAppendDraftItems), ili (2) NOVI nacrt sa ovim crtežom — router.push('/nacrti?noviCrtez=…')
// (Agent D taj param obrađuje u /nacrti). Toast po `meta.added/skipped`. Tastatura
// (DESIGN_SYSTEM §8): Esc zatvara (kit Dialog), Enter potvrđuje kad je izbor validan.

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2 } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { useAppendDraftItems, useOpenDraftsLookup } from '@/api/handovers';

/** Broj + naziv crteža koji se dodaje — prikaz u zaglavlju dijaloga. */
export interface AddToDraftTarget {
  drawingId: number;
  drawingNumber: string;
  name: string | null;
}

type Mode = 'existing' | 'new';

const selectInput =
  'w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink ' +
  'focus-visible:outline-none focus-visible:border-accent focus-visible:shadow-[var(--focus-ring)] ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

export function AddToDraftDialog({
  target,
  open,
  onClose,
}: {
  target: AddToDraftTarget;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const lookup = useOpenDraftsLookup();
  const append = useAppendDraftItems();
  const drafts = lookup.data ?? [];

  const [mode, setMode] = useState<Mode>('existing');
  const [draftId, setDraftId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  // Reset pri svakom otvaranju; ako nema otvorenih nacrta forsiraj „novi".
  useEffect(() => {
    if (!open) return;
    setMode('existing');
    setDraftId('');
    setError(null);
  }, [open, target.drawingId]);

  const noOpenDrafts = !lookup.isLoading && drafts.length === 0;
  const effectiveMode: Mode = noOpenDrafts ? 'new' : mode;

  const canSubmit =
    effectiveMode === 'new'
      ? true
      : draftId !== '' && !append.isPending;

  function submit() {
    if (!canSubmit) return;
    setError(null);

    if (effectiveMode === 'new') {
      onClose();
      router.push(`/nacrti?noviCrtez=${target.drawingId}`);
      return;
    }

    // Postojeći nacrt — dodaj jednu stavku (crtež) preko Agent D ugovora.
    append.mutate(
      { id: draftId as number, items: [{ drawingId: target.drawingId }] },
      {
        onSuccess: (res) => {
          const { added, skipped } = res.meta;
          const draft = drafts.find((d) => d.id === draftId);
          const label = draft ? draft.draftNumber : String(draftId);
          const msg =
            added > 0
              ? `Dodato u nacrt ${label}.`
              : `Crtež je već u nacrtu ${label} (preskočeno).`;
          const extra = added > 0 && skipped > 0 ? ` Preskočeno: ${skipped}.` : '';
          toast(msg + extra);
          onClose();
        },
        onError: (e) =>
          setError(e instanceof Error ? e.message : 'Greška pri dodavanju u nacrt.'),
      },
    );
  }

  // Enter potvrđuje kad je izbor validan (Esc zatvara kroz kit Dialog). Ref čuva
  // svež closure; Enter na dugmetu ostaje klik tog dugmeta (ne kradem ga).
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return;
      e.preventDefault();
      submitRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Dodaj u nacrt"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={append.isPending} disabled={!canSubmit}>
            {effectiveMode === 'new' ? 'Otvori novi nacrt' : 'Dodaj'}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-ink-secondary">
          Crtež{' '}
          <span className="tnums font-semibold text-ink">{target.drawingNumber}</span>
          {target.name ? ` · ${target.name}` : ''}
        </p>

        <fieldset className="space-y-2">
          <label
            className="flex items-start gap-2"
            aria-disabled={noOpenDrafts || undefined}
          >
            <input
              type="radio"
              name="add-to-draft-mode"
              className="mt-0.5"
              checked={effectiveMode === 'existing'}
              disabled={noOpenDrafts}
              onChange={() => setMode('existing')}
            />
            <span className={noOpenDrafts ? 'text-ink-disabled' : 'text-ink'}>
              U postojeći nacrt
            </span>
          </label>

          {effectiveMode === 'existing' && (
            <div className="pl-6">
              {lookup.isLoading ? (
                <span className="text-ink-disabled">Učitavanje nacrta…</span>
              ) : (
                <select
                  value={draftId === '' ? '' : String(draftId)}
                  onChange={(e) =>
                    setDraftId(e.target.value === '' ? '' : Number(e.target.value))
                  }
                  className={selectInput}
                >
                  <option value="">Izaberi nacrt…</option>
                  {drafts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.draftNumber}
                      {d.subject ? ` · ${d.subject}` : ''}
                      {d.designerName ? ` (${d.designerName})` : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="add-to-draft-mode"
              className="mt-0.5"
              checked={effectiveMode === 'new'}
              onChange={() => setMode('new')}
            />
            <span className="text-ink">Novi nacrt sa ovim crtežom</span>
          </label>
        </fieldset>

        {noOpenDrafts && (
          <p className="text-xs text-ink-secondary">
            Nema otvorenih nacrta — crtež se dodaje u novi nacrt.
          </p>
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

/**
 * Dugme „Dodaj u nacrt" + interni dijalog, zaštićeno `PRIMOPREDAJE_WRITE`.
 * Jedan potrošač za sva tri mesta (red liste / detalj / čvor sastavnice) —
 * `variant`:
 *   - `button` (default) — standardno sekundarno dugme (red/detalj),
 *   - `compact` — sitno ikonica+tekst za gustu sastavnicu (čvor stabla).
 * `stopRowActivate` sprečava da klik u redu tabele okine expand reda.
 */
export function AddToDraftButton({
  target,
  variant = 'button',
  stopRowActivate,
}: {
  target: AddToDraftTarget;
  variant?: 'button' | 'compact';
  stopRowActivate?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const onClick = (e: MouseEvent) => {
    if (stopRowActivate) e.stopPropagation();
    setOpen(true);
  };

  return (
    <Can permission={PERMISSIONS.PRIMOPREDAJE_WRITE}>
      {variant === 'compact' ? (
        <button
          type="button"
          onClick={onClick}
          title="Dodaj crtež u nacrt primopredaje"
          aria-label="Dodaj u nacrt"
          className="inline-flex shrink-0 items-center gap-1 rounded-control border border-line px-1.5 py-0.5 text-2xs font-medium text-ink-secondary hover:bg-surface-2 hover:text-ink"
        >
          <FilePlus2 className="h-3 w-3" aria-hidden />
          U nacrt
        </button>
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1 text-xs font-semibold text-ink-secondary hover:bg-surface-2 hover:text-ink"
        >
          <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
          Dodaj u nacrt
        </button>
      )}
      {/* Dijalog se montira tek na prvi otvor da lookup ne krene bez potrebe. */}
      {open && (
        <AddToDraftDialog target={target} open={open} onClose={() => setOpen(false)} />
      )}
    </Can>
  );
}
