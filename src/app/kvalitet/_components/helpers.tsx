'use client';

import type { ReactNode } from 'react';
import type { Tone } from '@/components/ui-kit/status-badge';
import {
  NONCONFORMITY_STATUS,
  NONCONFORMITY_TYPE,
  type CulpritWorker,
  type NonconformityReport,
  type NonconformityReportInput,
  type NonconformityType,
} from '@/api/kvalitet';

/** Naziv tipa neusaglašenosti (UI srpski). */
export function typeLabel(type: NonconformityType): string {
  return type === NONCONFORMITY_TYPE.SCRAP ? 'Škart' : 'Dorada';
}

/** Status → ton + labela za `StatusBadge` (draft = žuti „Nacrt"). */
export function statusMeta(status: number): { tone: Tone; label: string } {
  return status === NONCONFORMITY_STATUS.CONFIRMED
    ? { tone: 'success', label: 'Potvrđen' }
    : { tone: 'warn', label: 'Nacrt' };
}

/** ISO datum → vrednost za `<input type="date">` (yyyy-MM-dd), '' ako nema. */
export function toDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Danas kao yyyy-MM-dd (podrazumevani datum novog izveštaja). */
export function todayInput(): string {
  return toDateInput(new Date().toISOString());
}

/**
 * Kontrolisano stanje forme izveštaja (svi tekstualni delovi kao stringovi radi
 * lakšeg vezivanja za `<input>`). `culpritWorkers` čuva i imena za čipove;
 * `culpritWorkerIds` se izvodi pri slanju.
 */
export interface ReportFormState {
  reportDate: string;
  quantity: string;
  defectDescription: string;
  cause: string;
  workUnit: string;
  identNumber: string;
  drawingNumber: string;
  partName: string;
  customerName: string;
  culpritText: string;
  materialCostNote: string;
  coopCostNote: string;
  spentHoursText: string;
  note: string;
  preventiveMeasures: string;
  extra: string;
  culpritWorkers: CulpritWorker[];
}

/** Prazna forma za novi izveštaj (datum = danas, količina prazna). */
export function emptyForm(): ReportFormState {
  return {
    reportDate: todayInput(),
    quantity: '',
    defectDescription: '',
    cause: '',
    workUnit: '',
    identNumber: '',
    drawingNumber: '',
    partName: '',
    customerName: '',
    culpritText: '',
    materialCostNote: '',
    coopCostNote: '',
    spentHoursText: '',
    note: '',
    preventiveMeasures: '',
    extra: '',
    culpritWorkers: [],
  };
}

/** Popuni formu iz postojećeg izveštaja (za izmenu draft-a / potvrđenog). */
export function formFromReport(r: NonconformityReport): ReportFormState {
  return {
    reportDate: toDateInput(r.reportDate),
    quantity: String(r.quantity ?? ''),
    defectDescription: r.defectDescription ?? '',
    cause: r.cause ?? '',
    workUnit: r.workUnit ?? '',
    identNumber: r.identNumber ?? '',
    drawingNumber: r.drawingNumber ?? '',
    partName: r.partName ?? '',
    customerName: r.customerName ?? '',
    culpritText: r.culpritText ?? '',
    materialCostNote: r.materialCostNote ?? '',
    coopCostNote: r.coopCostNote ?? '',
    spentHoursText: r.spentHoursText ?? '',
    note: r.note ?? '',
    preventiveMeasures: r.preventiveMeasures ?? '',
    extra: r.extra ?? '',
    culpritWorkers: r.culpritWorkers ?? [],
  };
}

/** Prazan string → null (backend paritet Excel-a: nepopunjeno = null). */
function nn(v: string): string | null {
  const t = v.trim();
  return t ? t : null;
}

/**
 * Forma → telo za POST/PATCH. `includeType` dodaje tip (obavezan na POST-u).
 * Prazna tekstualna polja se šalju kao null; `extra` samo za doradu (tip 1).
 */
export function formToInput(
  form: ReportFormState,
  type: NonconformityType,
  includeType: boolean,
): NonconformityReportInput {
  const input: NonconformityReportInput = {
    reportDate: form.reportDate || undefined,
    quantity: form.quantity.trim() === '' ? undefined : Number(form.quantity),
    defectDescription: form.defectDescription.trim(),
    cause: nn(form.cause),
    workUnit: nn(form.workUnit),
    identNumber: nn(form.identNumber),
    drawingNumber: nn(form.drawingNumber),
    partName: nn(form.partName),
    customerName: nn(form.customerName),
    culpritText: nn(form.culpritText),
    materialCostNote: nn(form.materialCostNote),
    coopCostNote: nn(form.coopCostNote),
    spentHoursText: nn(form.spentHoursText),
    note: nn(form.note),
    preventiveMeasures: nn(form.preventiveMeasures),
    extra: type === NONCONFORMITY_TYPE.REWORK ? nn(form.extra) : null,
    culpritWorkerIds: form.culpritWorkers.map((w) => w.workerId),
  };
  if (includeType) input.type = type;
  return input;
}

/** Spisak izvršilaca (imena radnika + slobodan tekst) za kolonu tabele / detalj. */
export function culpritSummary(r: NonconformityReport): string {
  const names = (r.culpritWorkers ?? [])
    .map((w) => w.fullName)
    .filter((n): n is string => !!n);
  const parts = [...names];
  if (r.culpritText && r.culpritText.trim()) parts.push(r.culpritText.trim());
  return parts.join(', ');
}

/** Sitni „label + value" red za read-only prikaz detalja. */
export function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-ink-secondary">{label}</dt>
      <dd className="text-sm text-ink">{value == null || value === '' ? '—' : value}</dd>
    </div>
  );
}
