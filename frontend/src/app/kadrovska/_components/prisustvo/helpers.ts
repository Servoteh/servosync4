// Deljeni pomoćnici TAB-a Prisustvo (P10) — paritet 1.0 prisustvoTab.js.
import type { Tone } from '@/components/ui-kit/status-badge';

/** Smer prolaza (attendance_events.direction / v_attendance_now) → srpska labela. */
export const DIRECTION_LABEL: Record<string, string> = {
  in: 'Ulaz',
  out: 'Izlaz',
  break: 'Pauza',
  official_out: 'Službeni izlaz',
  other: 'Ostalo',
  unknown: '—',
};

/** Status uživo (v_attendance_now.status) → labela + ton pilule. */
export const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  prisutan: { label: 'Prisutan', tone: 'success' },
  pauza: { label: 'Pauza', tone: 'warn' },
  odsutan: { label: 'Odsutan', tone: 'neutral' },
};

export const MESECI = [
  'januar', 'februar', 'mart', 'april', 'maj', 'jun',
  'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar',
];

/** Broj sa zarezom kao decimalnim, 2 decimale (npr. -1,50). */
export function fmt2(v: number): string {
  return v.toFixed(2).replace('.', ',');
}

/** Ø/dnevna razlika sati → boja po pragu (±0,5 neutralno / ±1,5 warn / iznad danger). */
export function diffTone(v: number | null | undefined): 'neutral' | 'warn' | 'danger' {
  if (v == null) return 'neutral';
  const a = Math.abs(v);
  if (a <= 0.5) return 'neutral';
  if (a <= 1.5) return 'warn';
  return 'danger';
}

export const DIFF_TONE_CLASS: Record<'neutral' | 'warn' | 'danger', string> = {
  neutral: 'text-ink-secondary',
  warn: 'text-status-warn',
  danger: 'text-status-danger',
};

/** Formatiran prikaz razlike sa predznakom i jedinicom (npr. „+0,75 h"). */
export function fmtDiff(v: number | null | undefined): string {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${fmt2(v)} h`;
}

/** Broj iz view reda (Prisma Decimal/string/number/null) → number|null. */
export function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** „HH:mm" iz ISO/timestamp stringa (badge lanci su lokalni; bez TZ konverzije). */
export function hhmm(ts: string | null | undefined): string {
  if (!ts) return '—';
  // Podržava „YYYY-MM-DDTHH:mm…" i „YYYY-MM-DD HH:mm…".
  const m = String(ts).match(/[T ](\d{2}:\d{2})/);
  return m ? m[1] : '—';
}
