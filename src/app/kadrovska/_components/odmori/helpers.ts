// Deljeni pure helperi za GO (P5). Port 1.0 date/gantt/dept logike bez JSX.

import type { KadrHoliday } from '@/api/kadrovska';

/* ── dept paleta (1.0 vacationTab DEPT_COLORS) ─────────────────────────── */
export const DEPT_COLORS = [
  '#4F86C6', '#6BBF5A', '#E8A838', '#9B59B6',
  '#38B2C4', '#E06898', '#5AAA7A', '#C48038',
  '#688CC4', '#BF5A5A',
];

export function deptColor(name: string): string {
  if (!name) return '#888';
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return DEPT_COLORS[h % DEPT_COLORS.length];
}

/* ── review flag bedževi iz uvoza (1.0 REVIEW_FLAG_BADGE) ──────────────── */
export const REVIEW_FLAG_BADGE: Record<string, { icon: string; label: string; color: string; tip: string }> = {
  overdraw: { icon: '⚠', label: 'prekoračeno', color: '#C6534F', tip: 'Uvoz: radnik je prekoračio GO 2025 (ukupno < 20). Proveriti grid.' },
  outlier: { icon: '🔎', label: 'outlier', color: '#B07A1E', tip: 'Uvoz: neuobičajeno velik saldo — proveriti.' },
  unmatched: { icon: '❓', label: 'nemapiran', color: '#B07A1E', tip: 'Uvoz: ime nije pouzdano mapirano.' },
  missing: { icon: '∅', label: 'bez podatka', color: '#8a8a8a', tip: 'Uvoz: nedostaje vrednost u izvoru.' },
  corrected: { icon: '✔', label: 'korigovano', color: '#3B8C4E', tip: 'Saldo je ručno korigovan.' },
};

/* ── ISO datum helperi ─────────────────────────────────────────────────── */

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ukupan broj kalendarskih dana (uključivo) između dva YYYY-MM-DD. */
export function daysInclusive(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/** Radni dani (uključivo) — bez subota/nedelja i praznika. */
export function workDaysInclusive(fromIso: string, toIso: string, holidays: Set<string>): number {
  if (!fromIso || !toIso) return 0;
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const [ty, tm, td] = toIso.split('-').map(Number);
  const end = Date.UTC(ty, tm - 1, td);
  if (end < start) return 0;
  let n = 0;
  for (let t = start; t <= end; t += 86400000) {
    const dt = new Date(t);
    const dow = dt.getUTCDay();
    const iso = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !holidays.has(iso)) n++;
  }
  return n;
}

/** Prvi radni dan posle ISO datuma (preskače subote/nedelje i praznike). */
export function nextWorkingDay(iso: string, holidays: Set<string> | null): string {
  if (!iso) return '';
  const [yy, mm, dd] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  for (let i = 0; i < 30; i++) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    const cur = dt.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !(holidays && holidays.has(cur))) return cur;
  }
  return dt.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, n: number): string {
  const [yy, mm, dd] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(yy, mm - 1, dd));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Set nedatuma-radnih (praznik ∧ ne-radni) iz GET /holidays. */
export function holidaySetFromRows(rows: KadrHoliday[] | undefined | null): Set<string> {
  const s = new Set<string>();
  for (const h of rows || []) {
    if (h.isWorkday) continue;
    const iso = String(h.holidayDate || '').slice(0, 10);
    if (iso) s.add(iso);
  }
  return s;
}

/* ── Gantt godišnja skala ──────────────────────────────────────────────── */

export function daysInYear(year: number): number {
  return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
}

export function dayOfYearZero(ymd: string, year: number): number {
  const d = Date.parse(`${ymd}T00:00:00Z`);
  const s = Date.parse(`${year}-01-01T00:00:00Z`);
  return Math.max(0, Math.round((d - s) / 86400000));
}

export function clampYmd(ymd: string, year: number): string {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  if (ymd < from) return from;
  if (ymd > to) return to;
  return ymd;
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Avg', 'Sep', 'Okt', 'Nov', 'Dec'];
