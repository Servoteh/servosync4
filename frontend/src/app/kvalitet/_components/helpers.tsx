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

/**
 * „Odgovoran" — KO/ŠTA je odgovorno za neusaglašenost (fiksna lista, jedan izbor;
 * odluka vlasnika, jul 2026). Različito od Izvršioca (radnik na operaciji).
 * Redosled je i redosled opcija u `<select>`-u; vrednosti prate backend whitelist-u.
 */
export const RESPONSIBLE_PARTY_OPTIONS: { value: string; label: string }[] = [
  { value: 'izvrsilac', label: 'Izvršilac' },
  { value: 'kontrolor', label: 'Kontrolor' },
  { value: 'masina', label: 'Mašina' },
  { value: 'materijal', label: 'Materijal' },
  { value: 'tehnologija', label: 'Tehnologija' },
  { value: 'ostalo', label: 'Ostalo' },
];

const RESPONSIBLE_PARTY_LABELS: Record<string, string> = Object.fromEntries(
  RESPONSIBLE_PARTY_OPTIONS.map((o) => [o.value, o.label]),
);

/**
 * Vrednost „Odgovoran" → srpska labela za prikaz. Nepoznata (npr. starija ili
 * ručno upisana vrednost) se vraća kako jeste; prazno → '' (pozivalac stavlja „—").
 */
export function responsiblePartyLabel(v: string | null | undefined): string {
  if (!v) return '';
  return RESPONSIBLE_PARTY_LABELS[v] ?? v;
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
  /** „Odgovoran" — vrednost iz `RESPONSIBLE_PARTY_OPTIONS`; '' = nije izabrano. */
  responsibleParty: string;
  materialCostNote: string;
  coopCostNote: string;
  spentHoursText: string;
  /** Utrošeni materijal (kg) — ručna korekcija auto vrednosti; string sa zarezom u UI. */
  materialKg: string;
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
    responsibleParty: '',
    materialCostNote: '',
    coopCostNote: '',
    spentHoursText: '',
    materialKg: '',
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
    responsibleParty: r.responsibleParty ?? '',
    materialCostNote: r.materialCostNote ?? '',
    coopCostNote: r.coopCostNote ?? '',
    spentHoursText: r.spentHoursText ?? '',
    materialKg: toDecimalField(r.materialKg),
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
 * Decimal-as-string / broj iz backenda → vrednost za unos: zarez kao decimalni,
 * bez grupisanja i repova nula („8.640000" → „8,64", 14 → „14"). Prazno → ''.
 */
export function toDecimalField(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) return String(v);
  return String(n).replace('.', ',');
}

/**
 * Unos (zarez ili tačka) → Decimal-as-string za backend („8,64" → „8.64").
 * Prazno → null. Nenumerički unos se šalje kako jeste (backend validira → poruka).
 */
function toDecimalInput(v: string): string | null {
  const t = v.trim().replace(/\s+/g, '').replace(',', '.');
  return t === '' ? null : t;
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
    responsibleParty: nn(form.responsibleParty),
    materialCostNote: nn(form.materialCostNote),
    coopCostNote: nn(form.coopCostNote),
    spentHoursText: nn(form.spentHoursText),
    materialKg: toDecimalInput(form.materialKg),
    note: nn(form.note),
    preventiveMeasures: nn(form.preventiveMeasures),
    extra: type === NONCONFORMITY_TYPE.REWORK ? nn(form.extra) : null,
    culpritWorkerIds: form.culpritWorkers.map((w) => w.workerId),
  };
  if (includeType) input.type = type;
  return input;
}

/**
 * Meko usmeravanje unosa po ulozi (nije bezbednosna granica — backend presuđuje).
 *   'control' → kontrolor: unosi Kontrola (žuto), Tehnologija (zeleno) zaključana.
 *   'tech'    → tehnolog: unosi Tehnologija (zeleno), Kontrola (žuto) zaključana.
 *   'all'     → menadžment/admin/šef ILI nepoznata uloga: sve editabilno (ne blokiraj).
 * Bela (automatska) polja nisu deo podele — ostaju editabilna svima koji pišu.
 */
export type FieldMode = 'control' | 'tech' | 'all';

export function roleFieldMode(role: string | null | undefined): FieldMode {
  const r = (role ?? '').trim().toLowerCase();
  if (r === 'kontrolor') return 'control';
  if (r === 'tehnolog') return 'tech';
  return 'all';
}

/**
 * Spisak izvršilaca (imena radnika + slobodan tekst) za kolonu tabele / detalj.
 * `culpritText` često ponovi ista imena iz M:N veze — dedupe: dodaj samo delove
 * (split po zarezu) čiji trim/lowercase oblik nije već prisutan.
 */
export function culpritSummary(r: NonconformityReport): string {
  const names = (r.culpritWorkers ?? [])
    .map((w) => w.fullName)
    .filter((n): n is string => !!n);
  const parts = [...names];
  const seen = new Set(names.map((n) => n.trim().toLowerCase()));
  if (r.culpritText && r.culpritText.trim()) {
    for (const raw of r.culpritText.split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(part);
    }
  }
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
