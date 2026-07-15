'use client';

import { FormField, Input } from '@/components/ui-kit/form-field';
import { Textarea } from '@/components/ui-kit/textarea';
import { NONCONFORMITY_TYPE, type NonconformityType } from '@/api/kvalitet';
import { WorkerMultiSelect } from './worker-multi-select';
import type { ReportFormState } from './helpers';

/**
 * Zajednička polja izveštaja o neusaglašenosti — koristi se i u dijalogu „Novi
 * izveštaj" i u izmeni detalja. Obavezno: datum, količina, opis greške (§10 spec:
 * ostalo opciono, Excel paritet). `Dodatno` (extra) se prikazuje samo za doradu.
 */
export function ReportFields({
  form,
  onChange,
  type,
}: {
  form: ReportFormState;
  onChange: (patch: Partial<ReportFormState>) => void;
  type: NonconformityType;
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Datum" required>
          <Input
            type="date"
            value={form.reportDate}
            onChange={(e) => onChange({ reportDate: e.target.value })}
          />
        </FormField>
        <FormField label="Količina (kom)" required>
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            value={form.quantity}
            onChange={(e) => onChange({ quantity: e.target.value })}
            placeholder="npr. 3"
          />
        </FormField>
        <FormField label="Radna jedinica">
          <Input
            value={form.workUnit}
            onChange={(e) => onChange({ workUnit: e.target.value })}
            placeholder="npr. CNC glodanje"
          />
        </FormField>
      </div>

      <FormField label="Opis greške" required>
        <Textarea
          value={form.defectDescription}
          onChange={(e) => onChange({ defectDescription: e.target.value })}
          placeholder="Šta je neispravno…"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Broj RN (ident)">
          <Input
            value={form.identNumber}
            onChange={(e) => onChange({ identNumber: e.target.value })}
            placeholder="npr. 9400-1/442"
          />
        </FormField>
        <FormField label="Broj crteža">
          <Input
            value={form.drawingNumber}
            onChange={(e) => onChange({ drawingNumber: e.target.value })}
          />
        </FormField>
        <FormField label="Naziv pozicije">
          <Input
            value={form.partName}
            onChange={(e) => onChange({ partName: e.target.value })}
          />
        </FormField>
        <FormField label="Kupac">
          <Input
            value={form.customerName}
            onChange={(e) => onChange({ customerName: e.target.value })}
          />
        </FormField>
      </div>

      <FormField label="Uzrok">
        <Input
          value={form.cause}
          onChange={(e) => onChange({ cause: e.target.value })}
          placeholder="npr. Neopreznost, Loš materijal…"
        />
      </FormField>

      <FormField
        label="Izvršioci (radnici)"
        hint="Org-jedinice / spoljne izvršioce (Magacin alata, Projektni biro…) upiši u polje ispod."
      >
        <WorkerMultiSelect
          value={form.culpritWorkers}
          onChange={(culpritWorkers) => onChange({ culpritWorkers })}
        />
      </FormField>

      <FormField label="Izvršilac (slobodan tekst)">
        <Input
          value={form.culpritText}
          onChange={(e) => onChange({ culpritText: e.target.value })}
          placeholder="npr. Magacin alata, RN 9000…"
        />
      </FormField>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Trošak materijala">
          <Input
            value={form.materialCostNote}
            onChange={(e) => onChange({ materialCostNote: e.target.value })}
            placeholder="npr. Č.4732 — 14,14kg"
          />
        </FormField>
        <FormField label="Trošak kooperacije">
          <Input
            value={form.coopCostNote}
            onChange={(e) => onChange({ coopCostNote: e.target.value })}
          />
        </FormField>
        <FormField label="Utrošeno radnih sati">
          <Input
            value={form.spentHoursText}
            onChange={(e) => onChange({ spentHoursText: e.target.value })}
            placeholder="npr. 4,64h"
          />
        </FormField>
      </div>

      <FormField label="Preventivne mere">
        <Textarea
          value={form.preventiveMeasures}
          onChange={(e) => onChange({ preventiveMeasures: e.target.value })}
        />
      </FormField>

      <FormField label="Napomena">
        <Textarea
          value={form.note}
          onChange={(e) => onChange({ note: e.target.value })}
        />
      </FormField>

      {type === NONCONFORMITY_TYPE.REWORK && (
        <FormField label="Dodatno">
          <Textarea
            value={form.extra}
            onChange={(e) => onChange({ extra: e.target.value })}
          />
        </FormField>
      )}
    </div>
  );
}
