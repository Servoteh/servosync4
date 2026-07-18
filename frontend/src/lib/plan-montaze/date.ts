// Plan montaže — date helperi (port 1:1 iz 1.0 src/lib/date.js).
// Modul radi sa kanonskim 'YYYY-MM-DD' stringovima u LOKALNOM kalendaru; prikaz je
// dd.MM.yyyy. (DESIGN_SYSTEM §5). NIKAD toISOString().slice(0,10) za „danas" — to je UTC.

/** DANAS u lokalnoj zoni, na ponoć. */
export function getToday(): Date {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function dateToYMD(dt: Date | null): string | null {
  if (!(dt instanceof Date) || isNaN(dt.getTime())) return null;
  return formatYMD(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

/** DANAS kao 'YYYY-MM-DD' (lokalno). */
export function todayYmd(): string {
  return dateToYMD(getToday())!;
}

/** Parsira 'YYYY-MM-DD…' / Date u lokalni Date na ponoć; null ako je nevalidno/prazno. */
export function parseDateLocal(s: string | Date | null | undefined): Date | null {
  if (!s) return null;
  if (s instanceof Date) {
    if (isNaN(s.getTime())) return null;
    return new Date(s.getFullYear(), s.getMonth(), s.getDate());
  }
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 'YYYY-MM-DD' → 'dd.MM.yyyy.' (prazan string ako je nevalidno). */
export function formatDmy(d: string | Date | null | undefined): string {
  const dt = parseDateLocal(d);
  if (!dt) return '';
  return `${String(dt.getDate()).padStart(2, '0')}.${String(dt.getMonth() + 1).padStart(2, '0')}.${dt.getFullYear()}.`;
}

/**
 * PostgREST/Prisma `date`/`timestamptz` (ISO string ili Date) → kanonsko 'YYYY-MM-DD'
 * u lokalnom kalendaru (bez TZ pomaka). Prazan string ako je null/prazno.
 */
export function apiDateToYmd(v: string | Date | null | undefined): string {
  if (v == null || v === '') return '';
  if (v instanceof Date) return dateToYMD(v) ?? '';
  const s = String(v).trim();
  const cal = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (cal) return `${cal[1]}-${cal[2]}-${cal[3]}`;
  const dt = parseDateLocal(s);
  return dt ? (dateToYMD(dt) ?? '') : '';
}

/**
 * 'dd.mm.yyyy.' / 'dd.mm.yyyy' / 'dd/mm/yyyy' → ISO 'yyyy-mm-dd'.
 * @returns null = prazno; '' = nevalidan unos; inače ISO string.
 */
export function parseDmyToIso(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})\.?$/);
  if (!m) return '';
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Inkluzivna razlika u danima; -1 ako je end < start; null ako je nevalidno. */
export function calcDuration(s: string | null | undefined, e: string | null | undefined): number | null {
  const a = parseDateLocal(s);
  const b = parseDateLocal(e);
  if (!a || !b) return null;
  const d = Math.round((b.getTime() - a.getTime()) / 864e5);
  return d < 0 ? -1 : d + 1;
}

/** Razlika danas vs. dati datum (negativno = prošlost, pozitivno = budućnost); null ako nevalidno. */
export function dayDiffFromToday(s: string | null | undefined): number | null {
  const d = parseDateLocal(s);
  if (!d) return null;
  return Math.round((d.getTime() - getToday().getTime()) / 864e5);
}

/** Subota/nedelja? */
export function isWeekend(dt: Date): boolean {
  if (!(dt instanceof Date)) return false;
  const dow = dt.getDay();
  return dow === 0 || dow === 6;
}

/** 'YYYY-MM-DD' + N dana → 'YYYY-MM-DD'. */
export function ymdAddDays(ymd: string, days: number): string {
  const d = parseDateLocal(ymd);
  if (!d) return ymd;
  d.setDate(d.getDate() + days);
  return dateToYMD(d)!;
}
