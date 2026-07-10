'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  HANDOVER_STATUS,
  usePrepareHandoverWorkOrder,
  useRejectHandover,
  type Handover,
} from '@/api/handovers';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDateTime } from '@/lib/format';
import { ErrorText, Field, Textarea, handoverStatusMeta } from './common';
import {
  ApproveHandoverDialog,
  LaunchHandoverDialog,
  ReturnToPendingDialog,
} from './workflow-dialogs';

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

/**
 * Zajednički detalj primopredaje + workflow dugmad "po statusu" — koristi se u
 * tabovima "Na čekanju", "Odobrene" i "Sve primopredaje" (DataTable
 * `renderExpanded`). Podaci dolaze iz reda liste (već enriched na backendu) —
 * bez dodatnog fetch-a. Tok: Odobri (dodela tehnologa) → Otkucaj TP (RN bez
 * lansiranja) → Lansiraj; "Vrati na čekanje" je undo odobravanja.
 */
export function HandoverDetailPanel({ handover }: { handover: Handover }) {
  const router = useRouter();
  const reject = useRejectHandover();
  const prepare = usePrepareHandoverWorkOrder();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [returning, setReturning] = useState(false);
  const busy = reject.isPending || prepare.isPending;

  const s = handoverStatusMeta(handover.statusId);
  const locked = !!handover.isLocked;
  const drawing = handover.drawing;
  // Odbij/Lansiraj/Vrati greške se prikazuju unutar svog dijaloga — ovde samo
  // "Otkucaj TP" (nema dijalog, direktna mutacija).
  const actionError = prepare.error;

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {locked && <StatusBadge tone="warn" label="Zaključana" />}
        <span className="flex-1" />
        {/* Permission gate po obrascu sa work-orders/page.tsx — dugmad bez
            permisije se kriju (backend enforce vraća 403). Odobri/Odbij/
            Lansiraj/Vrati = primopredaje.approve; Otkucaj TP kreira RN = rn.write. */}
        {!locked && handover.statusId === HANDOVER_STATUS.PENDING && (
          <Can permission={PERMISSIONS.PRIMOPREDAJE_APPROVE}>
            <button
              disabled={busy}
              onClick={() => setApproving(true)}
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
          </Can>
        )}
        {!locked && handover.statusId === HANDOVER_STATUS.APPROVED && (
          <>
            {handover.workOrder ? (
              <button
                disabled={busy}
                onClick={() => router.push(`/work-orders?open=${handover.workOrder!.id}`)}
                className={`${actionBtn} bg-accent text-accent-fg`}
              >
                Otvori RN
              </button>
            ) : (
              <Can permission={PERMISSIONS.RN_WRITE}>
                <button
                  disabled={busy}
                  onClick={() =>
                    prepare.mutate(handover.id, {
                      onSuccess: (res) => router.push(`/work-orders?open=${res.data.workOrderId}`),
                    })
                  }
                  className={`${actionBtn} bg-accent text-accent-fg`}
                >
                  Otkucaj TP
                </button>
              </Can>
            )}
            <Can permission={PERMISSIONS.PRIMOPREDAJE_APPROVE}>
              <button
                disabled={busy}
                onClick={() => setLaunching(true)}
                className={`${actionBtn} border border-accent text-accent`}
              >
                Lansiraj
              </button>
              <button
                disabled={busy}
                onClick={() => setReturning(true)}
                className={`${actionBtn} border border-line text-ink-secondary`}
              >
                Vrati na čekanje
              </button>
            </Can>
          </>
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
        <Field label="Tehnolog (TP)" value={handover.technologist?.fullName ?? '—'} />
        <Field
          label="RN"
          value={
            handover.workOrder ? (
              <span className="tnums font-semibold">{handover.workOrder.identNumber}</span>
            ) : (
              '—'
            )
          }
        />
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

      <ApproveHandoverDialog
        handover={handover}
        open={approving}
        onClose={() => setApproving(false)}
      />
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
      <LaunchHandoverDialog
        handover={handover}
        open={launching}
        onClose={() => setLaunching(false)}
      />
      <ReturnToPendingDialog
        handover={handover}
        open={returning}
        onClose={() => setReturning(false)}
      />
    </div>
  );
}
