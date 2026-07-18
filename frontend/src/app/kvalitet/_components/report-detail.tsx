'use client';

import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  NONCONFORMITY_STATUS,
  NONCONFORMITY_TYPE,
  useConfirmNonconformityReport,
  useDeleteNonconformityReport,
  useRecomputeNonconformityReport,
  useUpdateNonconformityReport,
  type NonconformityReport,
  type RecomputeMeta,
} from '@/api/kvalitet';
import { ReportFields } from './report-fields';
import { DocumentsSection } from './documents-shared';
import {
  DetailField,
  culpritSummary,
  formFromReport,
  formToInput,
  responsiblePartyLabel,
  statusMeta,
  typeLabel,
  type ReportFormState,
} from './helpers';

/** Read-only prikaz svih polja izveštaja (za uloge bez `kvalitet.write`). */
function ReadOnlyDetail({ report }: { report: NonconformityReport }) {
  const isRework = report.type === NONCONFORMITY_TYPE.REWORK;
  const isScrap = report.type === NONCONFORMITY_TYPE.SCRAP;
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
      <DetailField
        label="Odgovoran"
        value={responsiblePartyLabel(report.responsibleParty)}
      />
      <DetailField label="Utrošeni radni sati" value={report.spentHours != null ? `${formatDecimal(report.spentHours)} h` : report.spentHoursText} />
      {isScrap && (
        <DetailField
          label="Trošak materijala (kg)"
          value={report.materialKg != null ? `${formatDecimal(report.materialKg)} kg` : null}
        />
      )}
      <DetailField label="Materijal — opis" value={report.materialCostNote} />
      <DetailField label="Trošak kooperacije" value={report.coopCostNote} />
      <DetailField label="Preventivne mere" value={report.preventiveMeasures} />
      <DetailField label="Napomena" value={report.note} />
      {isRework && <DetailField label="Dodatno" value={report.extra} />}
      <DetailField label="Ističe" value={report.raisedByWorker?.fullName} />
    </dl>
  );
}

/** Diskretni opis izvora izračuna posle „Preračunaj". */
function recomputeMetaLine(meta: RecomputeMeta): string {
  const parts: string[] = [`sati iz ${meta.hoursOps} op.`];
  if (meta.massSource === 'drawing')
    parts.push(`masa sa crteža: ${formatDecimal(meta.unitWeightKg)} kg`);
  else if (meta.massSource === 'workOrder')
    parts.push(`masa sa RN: ${formatDecimal(meta.unitWeightKg)} kg`);
  else parts.push('masa nepoznata — materijal nije izračunat');
  return `Preračunato · ${parts.join(' · ')}`;
}

/**
 * Auto-izračunate vrednosti (utrošeni radni sati + materijal u kg) za ŠKART, sa
 * dugmetom „Preračunaj" (recompute endpoint). Renderuje se kao `autoExtras` na vrhu
 * bele („Automatski podaci") sekcije. Po uspehu keš se invalidira → red se osveži i
 * forma resinhronizuje; meta izvora mase prikazujemo diskretno.
 */
function AutoComputedPanel({ report }: { report: NonconformityReport }) {
  const recompute = useRecomputeNonconformityReport();
  const [meta, setMeta] = useState<RecomputeMeta | null>(null);

  function doRecompute() {
    recompute.mutate(report.id, { onSuccess: (res) => setMeta(res.meta) });
  }

  return (
    <div className="rounded-control border border-line bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-secondary">Utrošeni radni sati</div>
          <div className="tnums text-md font-semibold text-ink">
            {formatDecimal(report.spentHours)} <span className="text-sm font-normal text-ink-secondary">h</span>
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-ink-secondary">Trošak materijala</div>
          <div className="tnums text-md font-semibold text-ink">
            {formatDecimal(report.materialKg)} <span className="text-sm font-normal text-ink-secondary">kg</span>
          </div>
        </div>
        <span className="flex-1" />
        <Button variant="secondary" onClick={doRecompute} loading={recompute.isPending}>
          <RefreshCw className="h-4 w-4" aria-hidden />
          Preračunaj
        </Button>
      </div>
      <p className="mt-2 text-xs text-ink-secondary">
        Automatski iz proizvodnih podataka; vrednosti se mogu ručno korigovati ispod.
      </p>
      {meta && <p className="mt-1 text-xs text-ink-secondary">{recomputeMetaLine(meta)}</p>}
      {recompute.error && (
        <p className="mt-1 text-xs text-status-danger" role="alert">
          {(recompute.error as Error).message}
        </p>
      )}
    </div>
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
        <ReportFields
          form={form}
          onChange={patch}
          type={report.type}
          autoExtras={
            report.type === NONCONFORMITY_TYPE.SCRAP ? (
              <AutoComputedPanel report={report} />
            ) : undefined
          }
        />
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
