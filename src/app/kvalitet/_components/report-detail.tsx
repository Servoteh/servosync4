'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  NONCONFORMITY_STATUS,
  NONCONFORMITY_TYPE,
  useConfirmNonconformityReport,
  useDeleteNonconformityReport,
  useUpdateNonconformityReport,
  type NonconformityReport,
} from '@/api/kvalitet';
import { ReportFields } from './report-fields';
import { DocumentsSection } from './documents-shared';
import {
  DetailField,
  culpritSummary,
  formFromReport,
  formToInput,
  statusMeta,
  typeLabel,
  type ReportFormState,
} from './helpers';

/** Read-only prikaz svih polja izveštaja (za uloge bez `kvalitet.write`). */
function ReadOnlyDetail({ report }: { report: NonconformityReport }) {
  const isRework = report.type === NONCONFORMITY_TYPE.REWORK;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
      <DetailField label="Datum" value={formatDate(report.reportDate)} />
      <DetailField label="Količina" value={`${report.quantity} kom`} />
      <DetailField label="Radna jedinica" value={report.workUnit} />
      <DetailField label="Broj RN" value={report.identNumber} />
      <DetailField label="Broj crteža" value={report.drawingNumber} />
      <DetailField label="Naziv pozicije" value={report.partName} />
      <DetailField label="Kupac" value={report.customerName} />
      <DetailField label="Uzrok" value={report.cause} />
      <DetailField label="Izvršioci" value={culpritSummary(report)} />
      <DetailField label="Trošak materijala" value={report.materialCostNote} />
      <DetailField label="Trošak kooperacije" value={report.coopCostNote} />
      <DetailField label="Utrošeno sati" value={report.spentHoursText} />
      <DetailField label="Preventivne mere" value={report.preventiveMeasures} />
      <DetailField label="Napomena" value={report.note} />
      {isRework && <DetailField label="Dodatno" value={report.extra} />}
      <DetailField label="Ističe" value={report.raisedBy?.fullName} />
    </dl>
  );
}

/**
 * Detalj izveštaja (expand reda). Kontrolor (`kvalitet.write`) dobija editabilnu
 * formu + akcije Potvrdi / Obriši nacrt / Sačuvaj izmene; ostali vide read-only.
 * Potvrda draft-a dodeljuje broj — prikazujemo ga po uspehu. Brisanje samo za draft.
 */
export function ReportDetail({ report }: { report: NonconformityReport }) {
  const can = useCan();
  const canWrite = can(PERMISSIONS.KVALITET_WRITE);
  const isDraft = report.status === NONCONFORMITY_STATUS.DRAFT;

  const [form, setForm] = useState<ReportFormState>(() => formFromReport(report));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmedNumber, setConfirmedNumber] = useState<string | null>(null);

  const update = useUpdateNonconformityReport();
  const confirm = useConfirmNonconformityReport();
  const del = useDeleteNonconformityReport();

  // Re-sinhronizuj formu kad se red osveži (nakon potvrde / izmene / invalidacije).
  useEffect(() => {
    setForm(formFromReport(report));
  }, [report]);

  const patch = (p: Partial<ReportFormState>) => setForm((f) => ({ ...f, ...p }));

  const qtyValid = form.quantity.trim() !== '' && Number(form.quantity) > 0;
  const valid = !!form.reportDate && qtyValid && form.defectDescription.trim() !== '';
  const busy = update.isPending || confirm.isPending || del.isPending;

  const s = statusMeta(report.status);

  function save() {
    if (!valid) return;
    update.mutate({ id: report.id, data: formToInput(form, report.type, false) });
  }

  function doConfirm() {
    confirm.mutate(report.id, {
      onSuccess: (res) => setConfirmedNumber(res.data.reportNumber),
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={s.tone} label={s.label} />
        <StatusBadge
          tone={report.type === NONCONFORMITY_TYPE.SCRAP ? 'danger' : 'warn'}
          label={typeLabel(report.type)}
        />
        {report.reportNumber && (
          <span className="tnums text-sm font-semibold text-ink">
            Br. {report.reportNumber}
          </span>
        )}
        <span className="flex-1" />
        {canWrite && (
          <>
            <Button variant="secondary" onClick={save} loading={update.isPending} disabled={!valid || busy}>
              Sačuvaj izmene
            </Button>
            {isDraft && (
              <>
                <Button onClick={doConfirm} loading={confirm.isPending} disabled={busy || !valid}>
                  Potvrdi izveštaj
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  Obriši nacrt
                </Button>
              </>
            )}
          </>
        )}
      </div>

      {confirmedNumber && (
        <p className="rounded-panel border border-status-success/30 bg-status-success-bg px-4 py-2 text-sm text-status-success">
          Izveštaj potvrđen — dodeljen broj <span className="tnums font-semibold">{confirmedNumber}</span>.
        </p>
      )}
      {update.isSuccess && !update.isPending && (
        <p className="text-sm text-status-success">Izmene sačuvane.</p>
      )}
      {(update.error || confirm.error) && (
        <p className="text-sm text-status-danger" role="alert">
          {((update.error || confirm.error) as Error).message}
        </p>
      )}

      {canWrite ? (
        <ReportFields form={form} onChange={patch} type={report.type} />
      ) : (
        <ReadOnlyDetail report={report} />
      )}

      <DocumentsSection reportId={report.id} />

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Brisanje nacrta"
        footer={
          <>
            <button
              onClick={() => setConfirmDelete(false)}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Otkaži
            </button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                del.mutate(report.id, { onSuccess: () => setConfirmDelete(false) })
              }
            >
              Obriši nacrt
            </Button>
          </>
        }
      >
        <div className="space-y-2 text-sm text-ink">
          <p>
            Trajno obrisati ovaj nacrt ({typeLabel(report.type).toLowerCase()},{' '}
            {report.quantity} kom)? Nacrt nema dodeljen broj pa se sekvenca ne remeti.
          </p>
          {del.error && (
            <p className="text-status-danger" role="alert">
              {(del.error as Error).message}
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
