// grid-audit.ts — deljeni formater izmena sati (istorija + potvrda snimanja).
// Veran port 1.0 `src/services/workHoursAudit.js` + `gridSaveConfirm.gridChangeLines`.
// Isti "staro → novo" tekst se koristi u: istorija ćelije, istorija meseca,
// modal potvrde snimanja. Labeli su LOAD-BEARING (korisnici ih čitaju svaki dan).

/** Redosled polja u prikazu izmena. */
export const WH_AUDIT_FIELD_ORDER = [
  'hours',
  'overtime_hours',
  'field_hours',
  'field_subtype',
  'field_predmet_broj',
  'field_predmet_naziv',
  'two_machine_hours',
  'absence_code',
  'absence_subtype',
  'note',
  'project_ref',
] as const;

export const WH_AUDIT_FIELD_LABELS: Record<string, string> = {
  hours: 'Redovni',
  overtime_hours: 'Prekov.',
  field_hours: 'Teren',
  field_subtype: 'Teren podtip',
  field_predmet_broj: 'Predmet',
  field_predmet_naziv: 'Predmet naziv',
  two_machine_hours: '2 maš.',
  absence_code: 'Odsustvo',
  absence_subtype: 'Odsustvo podtip',
  note: 'Napomena',
  project_ref: 'Projekat (staro polje)',
};

const NUMERIC_KEYS = new Set(['hours', 'overtime_hours', 'field_hours', 'two_machine_hours']);

function fmtNum(v: unknown): string {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '—';
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

/** Vrednost polja za prikaz. */
export function fmtWhAuditValue(key: string, v: unknown): string {
  if (v == null || v === '') return '—';
  if (key === 'field_subtype') {
    if (v === 'foreign') return 'I';
    if (v === 'domestic') return 'D';
    return String(v);
  }
  if (key === 'absence_code') return String(v).toUpperCase();
  if (NUMERIC_KEYS.has(key)) return fmtNum(v);
  return String(v);
}

type Snapshot = Record<string, unknown> | null | undefined;

export interface AuditRow {
  id?: string | number;
  action?: string;
  actorEmail?: string | null;
  changedAt?: string | null;
  employeeId?: string;
  workDate?: string | null;
  oldData?: Snapshot;
  newData?: Snapshot;
  diffKeys?: string[];
}

/** Lista linija „staro → novo" za jednu audit izmenu. */
export function describeWorkHoursAuditRow(row: AuditRow): string[] {
  const action = row.action || 'UPDATE';
  const oldD = row.oldData || {};
  const newD = row.newData || {};

  if (action === 'DELETE') {
    const parts: string[] = [];
    for (const k of WH_AUDIT_FIELD_ORDER) {
      if (k === 'field_predmet_naziv') continue;
      const val = fmtWhAuditValue(k, (oldD as Record<string, unknown>)[k]);
      if (val !== '—') parts.push(`${WH_AUDIT_FIELD_LABELS[k]}: ${val}`);
    }
    return [parts.length ? `Red obrisan (${parts.join(' · ')})` : 'Red obrisan'];
  }

  if (action === 'INSERT') {
    const lines: string[] = [];
    for (const k of WH_AUDIT_FIELD_ORDER) {
      if (k === 'field_predmet_naziv') continue;
      const after = fmtWhAuditValue(k, (newD as Record<string, unknown>)[k]);
      if (after === '—') continue;
      lines.push(`${WH_AUDIT_FIELD_LABELS[k]}: ${after}`);
    }
    return lines;
  }

  // UPDATE
  const diff = row.diffKeys && row.diffKeys.length ? row.diffKeys : WH_AUDIT_FIELD_ORDER.slice();
  const lines: string[] = [];
  for (const k of WH_AUDIT_FIELD_ORDER) {
    if (k === 'field_predmet_naziv') continue;
    if (!diff.includes(k)) continue;
    const before = fmtWhAuditValue(k, (oldD as Record<string, unknown>)[k]);
    const after = fmtWhAuditValue(k, (newD as Record<string, unknown>)[k]);
    if (before === after) continue;
    lines.push(`${WH_AUDIT_FIELD_LABELS[k]}: ${before} → ${after}`);
  }
  return lines;
}

/** Grid „dirty" vrednosti (snake_case) iz audit snapshot-a (za ↩ Vrati). */
export interface WhAuditValues {
  hours: number;
  overtime_hours: number;
  field_hours: number;
  field_subtype: string | null;
  field_predmet_broj: string | null;
  field_predmet_naziv: string | null;
  two_machine_hours: number;
  absence_code: string | null;
  absence_subtype: string | null;
}

export function workHoursAuditValues(data: Snapshot): WhAuditValues {
  const d = (data || {}) as Record<string, unknown>;
  const sub = d.field_subtype;
  return {
    hours: Number(d.hours || 0),
    overtime_hours: Number(d.overtime_hours || 0),
    field_hours: Number(d.field_hours || 0),
    field_subtype: sub === 'foreign' || sub === 'domestic' ? sub : null,
    field_predmet_broj: (d.field_predmet_broj as string) || null,
    field_predmet_naziv: (d.field_predmet_naziv as string) || null,
    two_machine_hours: Number(d.two_machine_hours || 0),
    absence_code: (d.absence_code as string) || null,
    absence_subtype: (d.absence_subtype as string) || null,
  };
}

// ── gridChangeLines: dirty delta vs sy15 red → linije (potvrda snimanja) ──

/** Full-snapshot dirty delta (snake_case; paritet 1.0 grid dirty map). */
export interface GridDelta {
  hours: number;
  overtime_hours: number;
  field_hours: number;
  field_subtype: string | null;
  field_predmet_broj: string | null;
  field_predmet_naziv: string | null;
  two_machine_hours: number;
  absence_code: string | null;
  absence_subtype: string | null;
}

/** camelCase sy15 WorkHours red (relevantna polja). */
export interface DbRowLike {
  hours?: string | number | null;
  overtimeHours?: string | number | null;
  fieldHours?: string | number | null;
  fieldSubtype?: string | null;
  fieldPredmetBroj?: string | null;
  fieldPredmetNaziv?: string | null;
  twoMachineHours?: string | number | null;
  absenceCode?: string | null;
  absenceSubtype?: string | null;
}

/** DB red → snake_case audit snapshot. */
export function dbRowToSnapshot(db: DbRowLike | null | undefined): Record<string, unknown> {
  const r = db || {};
  return {
    hours: Number(r.hours || 0),
    overtime_hours: Number(r.overtimeHours || 0),
    field_hours: Number(r.fieldHours || 0),
    field_subtype: r.fieldSubtype || null,
    field_predmet_broj: r.fieldPredmetBroj || null,
    field_predmet_naziv: r.fieldPredmetNaziv || null,
    two_machine_hours: Number(r.twoMachineHours || 0),
    absence_code: r.absenceCode || null,
    absence_subtype: r.absenceSubtype || null,
  };
}

/**
 * Linije izmene za jednu ćeliju (staro→novo). Prazan niz = nema stvarne promene
 * (isti kao u bazi) → potvrda snimanja to broji kao „bez promene".
 */
export function gridChangeLines(db: DbRowLike | null | undefined, delta: GridDelta): string[] {
  const oldData = dbRowToSnapshot(db);
  const newData: Record<string, unknown> = { ...oldData };
  for (const k of Object.keys(delta) as (keyof GridDelta)[]) {
    newData[k] = delta[k];
  }
  const diffKeys: string[] = [];
  for (const k of Object.keys(newData)) {
    const a = JSON.stringify(oldData[k] ?? null);
    const b = JSON.stringify(newData[k] ?? null);
    if (a !== b) diffKeys.push(k);
  }
  if (diffKeys.length === 0) return [];
  return describeWorkHoursAuditRow({ action: 'UPDATE', oldData, newData, diffKeys });
}

/** 'YYYY-MM-DD' → 'dd.MM.yyyy.' (lokalno, bez TZ pomeraja). */
export function fmtYmd(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).slice(0, 10).split('-');
  if (!y || !m || !d) return String(ymd);
  return `${d}.${m}.${y}.`;
}
