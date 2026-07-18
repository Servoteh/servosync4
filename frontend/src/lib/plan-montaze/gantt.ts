// Plan montaže — Gantt helperi (port 1:1 iz 1.0 src/lib/gantt.js).

import { MONTHS_SR } from './constants';
import { parseDateLocal, getToday } from './date';

/** Širina dnevne kolone u px (fiksna → delta dana = round(dx / CELL_W)). */
export const GANTT_CELL_W = 26;

/** Inkluzivan niz Date instanci od start do end (ponoć, lokalno). */
export function buildDayRange(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cur = new Date(start);
  cur.setHours(0, 0, 0, 0);
  const lim = new Date(end);
  lim.setHours(0, 0, 0, 0);
  while (cur <= lim) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

export interface MonthSpan {
  key: string;
  label: string;
  count: number;
}

/** Mesečni header: uređen niz {label, count} (colspan po mesecu). */
export function buildMonthsHeader(days: Date[]): MonthSpan[] {
  const out: MonthSpan[] = [];
  let cur: MonthSpan | null = null;
  for (const d of days) {
    const key = d.getFullYear() + '-' + d.getMonth();
    if (!cur || cur.key !== key) {
      cur = { key, label: `${MONTHS_SR[d.getMonth()]} ${d.getFullYear()}`, count: 0 };
      out.push(cur);
    }
    cur.count++;
  }
  return out;
}

/**
 * Raspon prikaza: [today − 3 dana, today + 60 dana ili max(end)+5].
 * `getToday()` (ne zamrznut) — sesija preko ponoći ne pomera opseg.
 */
export function inferGanttBounds<T>(
  rows: T[],
  getStart: (r: T) => string | null,
  getEnd: (r: T) => string | null,
): { min: Date; max: Date } {
  const now = getToday();
  let min = new Date(now);
  let max = new Date(now);
  max.setDate(max.getDate() + 60);
  for (const r of rows) {
    const ds = parseDateLocal(getStart(r));
    const de = parseDateLocal(getEnd(r));
    if (ds && ds < min) min = ds;
    if (de && de > max) max = de;
  }
  min.setDate(min.getDate() - 3);
  max.setDate(max.getDate() + 5);
  return { min, max };
}
