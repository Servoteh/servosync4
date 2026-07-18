'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import {
  useCreateNonconformityReport,
  type NonconformityType,
} from '@/api/kvalitet';
import { ReportFields } from './report-fields';
import { emptyForm, formToInput, typeLabel, type ReportFormState } from './helpers';

/** Dijalog „Novi izveštaj" — tip je iz aktivnog taba (škart/dorada). */
export function NewReportDialog({
  open,
  onClose,
  type,
}: {
  open: boolean;
  onClose: () => void;
  type: NonconformityType;
}) {
  const [form, setForm] = useState<ReportFormState>(emptyForm);
  const create = useCreateNonconformityReport();

  // Reset-na-open: čist obrazac i poništena greška pri svakom otvaranju.
  useEffect(() => {
    if (!open) return;
    setForm(emptyForm());
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const patch = (p: Partial<ReportFormState>) => setForm((f) => ({ ...f, ...p }));

  const qtyValid = form.quantity.trim() !== '' && Number(form.quantity) > 0;
  const valid = !!form.reportDate && qtyValid && form.defectDescription.trim() !== '';

  function submit() {
    if (!valid) return;
    create.mutate(formToInput(form, type, true), { onSuccess: onClose });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Novi izveštaj — ${typeLabel(type).toLowerCase()}`}
      size="xl"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Otkaži
          </button>
          <Button onClick={submit} loading={create.isPending} disabled={!valid}>
            Sačuvaj izveštaj
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ReportFields form={form} onChange={patch} type={type} />
        {create.error && (
          <p className="text-sm text-status-danger" role="alert">
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </Dialog>
  );
}
