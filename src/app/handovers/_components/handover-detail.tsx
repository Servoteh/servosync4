'use client';

import { useState } from 'react';
import {
  HANDOVER_STATUS,
  useApproveHandover,
  useLaunchHandover,
  useRejectHandover,
  type Handover,
} from '@/api/handovers';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate, formatDateTime } from '@/lib/format';
import { ErrorText, Field, Textarea, handoverStatusMeta } from './common';

const actionBtn =
  'rounded-control px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';

function RejectDialog({
  open,
  onClose,
  onSubmit,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  loading: boolean;
  error: unknown;
}) {
  const [reason, setReason] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Odbijanje primopredaje"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button
            onClick={() => onSubmit(reason)}
            loading={loading}
            disabled={!reason.trim()}
            className="bg-status-danger text-white hover:bg-status-danger"
          >
            Odbij primopredaju
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Razlog odbijanja" required hint="Obavezno — najviše 250 karaktera.">
          <Textarea
            value={reason}
            maxLength={250}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
            placeholder="Npr. nedostaje materijal u BOM-u za poziciju X…"
          />
        </FormField>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

function LaunchDialog({
  open,
  onClose,
  onSubmit,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { dueDate?: string; comment?: string }) => void;
  loading: boolean;
  error: unknown;
}) {
  const [dueDate, setDueDate] = useState('');
  const [comment, setComment] = useState('');

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Lansiranje primopredaje"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={() => onSubmit({ dueDate: dueDate || undefined, comment: comment.trim() || undefined })} loading={loading}>
            Lansiraj RN
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-ink-disabled">
          Kreira se novi radni nalog iz podataka nacrta povezanog sa ovim crtežom.
        </p>
        <FormField label="Rok isporuke">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </FormField>
        <FormField label="Napomena">
          <Textarea
            value={comment}
            maxLength={250}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Npr. lansirano za sledeću smenu…"
          />
        </FormField>
        <ErrorText error={error} />
      </div>
    </Dialog>
  );
}

/**
 * Zajednički detalj primopredaje + workflow dugmad "po statusu" — koristi se u
 * tabovima "Na čekanju" i "Sve primopredaje" (DataTable `renderExpanded`).
 * Podaci dolaze iz reda liste (već enriched na backendu) — bez dodatnog fetch-a.
 */
export function HandoverDetailPanel({ handover }: { handover: Handover }) {
  const approve = useApproveHandover();
  const reject = useRejectHandover();
  const launch = useLaunchHandover();
  const [rejecting, setRejecting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const busy = approve.isPending || reject.isPending || launch.isPending;

  const s = handoverStatusMeta(handover.statusId);
  const locked = !!handover.isLocked;
  const drawing = handover.drawing;
  // Odbij/Lansiraj greške se prikazuju unutar svog dijaloga — ovde samo Odobri (nema dijalog).
  const actionError = approve.error;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {locked && <StatusBadge tone="warn" label="Zaključana" />}
        <span className="flex-1" />
        {!locked && handover.statusId === HANDOVER_STATUS.PENDING && (
          <>
            <button
              disabled={busy}
              onClick={() => approve.mutate({ id: handover.id })}
              className={`${actionBtn} bg-status-success text-white`}
            >
              Odobri
            </button>
            <button
              disabled={busy}
              onClick={() => setRejecting(true)}
              className={`${actionBtn} border border-status-danger text-status-danger`}
            >
              Odbij
            </button>
          </>
        )}
        {!locked && handover.statusId === HANDOVER_STATUS.APPROVED && (
          <button
            disabled={busy}
            onClick={() => setLaunching(true)}
            className={`${actionBtn} bg-accent text-accent-fg`}
          >
            Lansiraj
          </button>
        )}
      </div>

      {actionError && <ErrorText error={actionError} />}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Crtež" value={drawing ? `${drawing.drawingNumber} / ${drawing.revision}` : '—'} />
        <Field label="Naziv" value={drawing?.name || '—'} />
        <Field label="Materijal" value={drawing?.material || '—'} />
        <Field label="Dimenzije" value={drawing?.dimensions || '—'} />
        <Field
          label="Nacrt / predmet"
          value={
            handover.draftContext
              ? `${handover.draftContext.draftNumber} · ${handover.draftContext.quantityToProduce} kom`
              : 'nije povezan sa nacrtom'
          }
        />
        <Field label="Predato tehnologu" value={handover.handoverWorker?.fullName ?? '—'} />
        <Field label="Datum primopredaje" value={formatDate(handover.handoverDate)} />
        <Field
          label="Promena statusa"
          value={
            handover.statusChangedAt
              ? `${formatDateTime(handover.statusChangedAt)} · ${handover.statusChangedBy?.fullName ?? '—'}`
              : '—'
          }
        />
        {handover.statusChangeComment && (
          <Field label="Komentar" value={handover.statusChangeComment} />
        )}
        {handover.launchedAt && (
          <Field
            label="Lansirano"
            value={`${formatDateTime(handover.launchedAt)} · ${handover.launchedBy?.fullName ?? '—'}`}
          />
        )}
        {handover.note && <Field label="Napomena" value={handover.note} />}
      </dl>

      <RejectDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        loading={reject.isPending}
        error={reject.error}
        onSubmit={(reason) =>
          reject.mutate(
            { id: handover.id, reason },
            { onSuccess: () => setRejecting(false) },
          )
        }
      />
      <LaunchDialog
        open={launching}
        onClose={() => setLaunching(false)}
        loading={launch.isPending}
        error={launch.error}
        onSubmit={(input) =>
          launch.mutate(
            { id: handover.id, ...input },
            { onSuccess: () => setLaunching(false) },
          )
        }
      />
    </div>
  );
}
