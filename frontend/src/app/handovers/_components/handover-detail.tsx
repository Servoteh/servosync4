'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  HANDOVER_STATUS,
  usePendingHandoversByDraft,
  usePrepareHandoverWorkOrder,
  useRejectHandover,
  type Handover,
} from '@/api/handovers';
import { openDrawingPdf } from '@/api/pdm';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  ErrorText,
  Field,
  LEGACY_TOOLTIP,
  LegacyBadge,
  Textarea,
  UrgentBadge,
  handoverStatusMeta,
} from './common';
import {
  ApproveHandoverDialog,
  LaunchHandoverDialog,
  RejectAllHandoverDialog,
  ReturnToPendingDialog,
  type HandoverBatch,
} from './workflow-dialogs';
import { TakeOverButton } from './take-over-button';
import { PrintDrawingsDialog } from './print-drawings-dialog';

const actionBtn =
  'rounded-control px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40';

function RejectDialog({
  open,
  onClose,
  onSubmit,
  onOpenReset,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
  /** Reset mutacije iz panela (hook živi tamo) — poziva se pri otvaranju. */
  onOpenReset: () => void;
  loading: boolean;
  error: unknown;
}) {
  const [reason, setReason] = useState('');

  // Reset-na-open (isti obrazac kao Approve/Launch/Return u workflow-dialogs):
  // bez ovoga ponovno otvaranje na ISTOM redu prikaže stari razlog i staru grešku.
  useEffect(() => {
    if (!open) return;
    setReason('');
    onOpenReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
  const [approvingAll, setApprovingAll] = useState(false);
  const [rejectingAll, setRejectingAll] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [returning, setReturning] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const busy = reject.isPending || prepare.isPending;

  // Grupno odobri/odbij cele primopredaje (runda 2 t.4) — prikupi SVE PENDING
  // pozicije istog broja nacrta (klijentski filter nad pending-approval listom,
  // pageSize=500). Dostupno samo kad red pripada nacrtu (`draftContext.draftNumber`).
  const draftNumber = handover.draftContext?.draftNumber ?? null;
  const showGroup =
    !!draftNumber &&
    !handover.isLocked &&
    handover.statusId === HANDOVER_STATUS.PENDING &&
    !handover.isLegacy;
  const groupPending = usePendingHandoversByDraft(draftNumber, showGroup);
  const batch: HandoverBatch | null =
    draftNumber && groupPending.rows.length
      ? {
          handoverIds: groupPending.rows.map((r) => r.id),
          count: groupPending.rows.length,
          draftNumber,
        }
      : null;
  const groupDisabled = busy || groupPending.isLoading || !batch;

  const s = handoverStatusMeta(handover.statusId);
  const locked = !!handover.isLocked;
  // Legacy red (deriviran iz QBigTehn tRN-a): mutacije do cutover-a idu u
  // QBigTehn — dugmad disabled sa tooltipom; backend 409 poruka je krajnja
  // istina ako stariji tab ipak okine (prikaz kroz postojeći ApiError tok).
  // Čitanje i štampa crteža rade normalno.
  const legacy = handover.isLegacy;
  const legacyTitle = legacy ? LEGACY_TOOLTIP : undefined;
  const drawing = handover.drawing;
  // Odbij/Lansiraj/Vrati greške se prikazuju unutar svog dijaloga — ovde samo
  // "Otkucaj TP" (nema dijalog, direktna mutacija).
  const actionError = prepare.error;

  /**
   * PDF crteža stavke (Paket A t.3) — isti obrazac kao /pdm i print dijalog:
   * endpoint traži JWT pa običan <a href> NE radi; fetch blob kroz api klijent
   * (`openDrawingPdf` = apiBlob → objectURL → window.open). PDF koji ne postoji
   * (404) prikazuje poruku ispod dugmadi — ekran se ne ruši.
   */
  async function onOpenPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      await openDrawingPdf(handover.drawingId);
    } catch (e) {
      setPdfError(
        e instanceof Error && e.message
          ? e.message
          : 'PDF crteža nije dostupan — proveri da je PDF uvezen u PDM.',
      );
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        {/* HITNO (Paket A t.10) — uz status, ne umesto njega (DESIGN_SYSTEM §7). */}
        {handover.isUrgent && <UrgentBadge />}
        {locked && <StatusBadge tone="warn" label="Zaključana" />}
        {legacy && <LegacyBadge />}
        <span className="flex-1" />
        {/* PDF crteža je read-only kao i štampa — dostupan u svakom statusu. */}
        <button
          onClick={onOpenPdf}
          disabled={pdfBusy}
          className={`${actionBtn} border border-line text-ink-secondary`}
        >
          {pdfBusy ? 'Otvaranje PDF-a…' : 'PDF crteža'}
        </button>
        {/* Štampa crteža je read-only (endpoint = primopredaje.read, kao i sam
            prikaz) — dostupna u svakom statusu, bez permission gate-a. */}
        <button
          onClick={() => setPrintOpen(true)}
          className={`${actionBtn} border border-line text-ink-secondary`}
        >
          Štampaj sve crteže
        </button>
        {/* Permission gate po obrascu sa work-orders/page.tsx — dugmad bez
            permisije se kriju (backend enforce vraća 403). Odobri/Odbij/
            Lansiraj/Vrati = primopredaje.approve; Otkucaj TP kreira RN = rn.write. */}
        {!locked && handover.statusId === HANDOVER_STATUS.PENDING && (
          <Can permission={PERMISSIONS.PRIMOPREDAJE_APPROVE}>
            <button
              disabled={busy || legacy}
              title={legacyTitle}
              onClick={() => setApproving(true)}
              className={`${actionBtn} bg-status-success text-white`}
            >
              Odobri
            </button>
            {/* Grupno odobravanje cele primopredaje (runda 2 t.4) — Miljan:
                „odobrava se cela primopredaja, sve pozicije istog broja nacrta".
                Dostupno samo kad red pripada nacrtu (`draftContext.draftNumber`);
                disabled dok se lista pozicija učitava. */}
            {showGroup && (
              <button
                disabled={groupDisabled}
                title={
                  groupPending.isLoading
                    ? 'Učitavanje pozicija nacrta…'
                    : `Odobri sve pozicije nacrta ${draftNumber}`
                }
                onClick={() => setApprovingAll(true)}
                className={`${actionBtn} bg-status-success text-white`}
              >
                Odobri ceo nacrt
              </button>
            )}
            <button
              disabled={busy || legacy}
              title={legacyTitle}
              onClick={() => setRejecting(true)}
              className={`${actionBtn} border border-status-danger text-status-danger`}
            >
              Odbij
            </button>
            {showGroup && (
              <button
                disabled={groupDisabled}
                title={
                  groupPending.isLoading
                    ? 'Učitavanje pozicija nacrta…'
                    : `Odbij sve pozicije nacrta ${draftNumber}`
                }
                onClick={() => setRejectingAll(true)}
                className={`${actionBtn} border border-status-danger text-status-danger`}
              >
                Odbij ceo nacrt
              </button>
            )}
          </Can>
        )}
        {!locked && handover.statusId === HANDOVER_STATUS.APPROVED && (
          <>
            {/* „Preuzmi izradu" (P4 §6.4) — komponenta se sama krije kad je red
                legacy/zaključan ili je zaduženje već moje (workerId iz JWT-a). */}
            <TakeOverButton
              handover={handover}
              className={`${actionBtn} border border-line text-ink-secondary hover:bg-surface-2`}
            />
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
                  disabled={busy || legacy}
                  title={legacyTitle}
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
                disabled={busy || legacy}
                title={legacyTitle}
                onClick={() => setLaunching(true)}
                className={`${actionBtn} border border-accent text-accent`}
              >
                Lansiraj
              </button>
              <button
                disabled={busy || legacy}
                title={legacyTitle}
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
      {pdfError && (
        <p className="text-sm text-status-danger" role="alert">
          {pdfError}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Crtež" value={drawing ? `${drawing.drawingNumber} / ${drawing.revision}` : '—'} />
        <Field label="Naziv" value={drawing?.name || '—'} />
        <Field label="Materijal" value={drawing?.material || '—'} />
        <Field label="Dimenzije" value={drawing?.dimensions || '—'} />
        <Field
          label="Nacrt"
          value={
            handover.draftContext
              ? `${handover.draftContext.draftNumber} · ${handover.draftContext.quantityToProduce} kom`
              : 'nije povezan sa nacrtom'
          }
        />
        {/* Predmet = broj predmeta po kome je crtež pušten (backend enrich). */}
        <Field
          label="Predmet"
          value={
            handover.project ? (
              <span className="tnums">{handover.project.projectNumber}</span>
            ) : (
              '—'
            )
          }
        />
        {/* `handoverWorker` = PROJEKTANT koji je predao (ne tehnolog!) — tačna
            semantika potvrđena na živoj probi primopredaje. */}
        <Field label="Predao (projektant)" value={handover.handoverWorker?.fullName ?? '—'} />
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
        {/* Rok izrade unet pri odobravanju (P4 §6.5.1) — propagira se u RN. */}
        <Field
          label="Rok izrade"
          value={handover.productionDeadline ? formatDate(handover.productionDeadline) : '—'}
        />
        {/* Audit dodele tehnologa (approve = šef; take-over = sam preuzimalac). */}
        {handover.technologistAssignedAt && (
          <Field
            label="Tehnolog dodeljen"
            value={`${formatDateTime(handover.technologistAssignedAt)} · ${handover.technologistAssignedBy?.fullName ?? '—'}`}
          />
        )}
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
      {/* Grupni mod (runda 2 t.4) — batch se računa tek kad je lista pozicija
          učitana; dijalog se ne renderuje bez njega (dugme je do tad disabled). */}
      {batch && (
        <ApproveHandoverDialog
          handover={handover}
          open={approvingAll}
          onClose={() => setApprovingAll(false)}
          batch={batch}
        />
      )}
      {batch && (
        <RejectAllHandoverDialog
          batch={batch}
          open={rejectingAll}
          onClose={() => setRejectingAll(false)}
        />
      )}
      <RejectDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        onOpenReset={() => reject.reset()}
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
      <PrintDrawingsDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        // „Štampaj sve crteže" = SVI crteži nacrta (draft scope), ne samo ovaj
        // jedan crtež primopredaje (handover bundle je uvek 1 stavka). Fallback
        // na handover scope za derivirane legacy redove bez razrešivog nacrta.
        scope={
          handover.draftContext
            ? { kind: 'draft', id: handover.draftContext.draftId }
            : { kind: 'handover', id: handover.id }
        }
        subtitle={
          handover.draftContext
            ? `Nacrt ${handover.draftContext.draftNumber} — svi crteži`
            : drawing
              ? `Crtež ${drawing.drawingNumber} / ${drawing.revision}`
              : `Primopredaja #${handover.id}`
        }
      />
    </div>
  );
}
