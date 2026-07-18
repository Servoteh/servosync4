// Regrupisanje GO istorije (vacation_history) po KALENDARSKOJ godini datuma.
// Port 1.0 `src/lib/vacationDateRegroup.js` (bez zavisnosti) — prikaz-only;
// saldo (v_vacation_balance) se NE dira. Stari Excel listovi su „rolajući":
// u list jedne godine se nastavljalo upisivati korišćenje iz sledeće (npr. u
// „2025" listu stoje 5,6.01.2026). Ovaj modul parsira slobodan tekst datuma i
// raspoređuje dane u godinu u kojoj su STVARNO korišćeni.

export interface ParsedDate {
  day: number;
  month: number;
  year: number;
}

/** Sirovi unos jedne godine iz vacation_history (BE camelCase entries JSON). */
export interface HistoryEntry {
  days?: number | string | null;
  kind?: string;
  dates?: string | null;
  comment?: string | null;
}

export interface HistoryRow {
  year: number;
  entitled?: number | null;
  used?: number | null;
  remaining?: number | null;
  entries?: HistoryEntry[] | null;
  sourceFile?: string | null;
}

/** Fragment jedne kalendarske godine posle regrupisanja. */
export interface RegroupedEntry {
  days: number | null;
  kind: string;
  dates: string;
  comment: string;
  approx: boolean;
  fromYear: number | null;
}
export interface RegroupedYear {
  year: number;
  entitled: number | null;
  used: number;
  remaining: number | null;
  entries: RegroupedEntry[];
  sourceFile: string;
  recomputed: boolean;
}

interface Group {
  days: number[];
  month: number | null;
  year: number | null;
}

/**
 * Parsiraj slobodan string datuma u listu eksplicitnih {day, month, year}.
 * Podržava: "5,6.03.2026", "30,31.12.2025-5,6.01.2026", "31.12 i 3,6.01.2025",
 *           "12.05.2026", "31.12.2025-08.01.2026", "2.12.2025", "—".
 */
export function parseVacationDates(str: string | null | undefined, recYear: number): ParsedDate[] {
  if (str == null) return [];
  let s = String(str).trim();
  if (!s || !/\d/.test(s)) return [];

  // Skini vodeći ne-datumski tekst do prve cifre.
  s = s.replace(/^[^\d]+/, '');
  // Granice grupa: crtica (svi tipovi), " i ", ";". Tačka je unutar datuma.
  s = s.replace(/\s*(?:[-–—]|;|\bi\b)\s*/gi, '|');
  const rawGroups = s.split('|').map((g) => g.trim()).filter(Boolean);

  const groups: Group[] = [];
  for (const g of rawGroups) {
    const m = g.match(/^(\d{1,2}(?:\s*,\s*\d{1,2})*)\s*\.\s*(\d{1,2})(?:\s*\.\s*(\d{4}))?/);
    if (m) {
      const month = parseInt(m[2], 10);
      if (month >= 1 && month <= 12) {
        const days = m[1].split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 31);
        groups.push({ days, month, year: m[3] ? parseInt(m[3], 10) : null });
        continue;
      }
    }
    const my = g.match(/^(\d{1,2}(?:\s*,\s*\d{1,2})*)\s*\.\s*(\d{4})$/);
    if (my) {
      groups.push({ days: my[1].split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 31), month: 0, year: parseInt(my[2], 10) });
      continue;
    }
    const md = g.match(/^(\d{1,2}(?:\s*,\s*\d{1,2})*)$/);
    if (md) {
      groups.push({ days: md[1].split(',').map((x) => parseInt(x, 10)).filter((n) => n >= 1 && n <= 31), month: null, year: null });
      continue;
    }
    groups.push({ days: [], month: null, year: null });
  }

  // Nasledi mesec/godinu za gole grupe dana od PRVE sledeće grupe sa mesecom.
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].month == null && groups[i].days.length) {
      const nx = groups.slice(i + 1).find((q) => q.month != null);
      if (nx) { groups[i].month = nx.month; groups[i].year = nx.year; }
    }
  }

  const explicitYears = [...new Set(groups.filter((p) => p.year).map((p) => p.year as number))];
  const janYears = groups.filter((p) => p.month === 1 && p.year).map((p) => p.year as number);

  const dates: ParsedDate[] = [];
  for (const p of groups) {
    if (p.month == null || !p.days.length) continue;
    let y = p.year;
    if (y == null) {
      if (p.month === 12 && janYears.length) y = Math.min(...janYears) - 1;
      else if (explicitYears.length === 1) y = explicitYears[0];
      else y = recYear;
    }
    for (const d of p.days) dates.push({ day: d, month: p.month, year: y });
  }
  return dates;
}

/** Lepi „d,d.MM.YYYY" iz liste {day,month,year}, grupisano po mesecu. */
export function formatDateList(dts: ParsedDate[]): string {
  const byMo = new Map<string, number[]>();
  for (const d of dts) {
    const k = `${String(d.month).padStart(2, '0')}.${d.year}`;
    if (!byMo.has(k)) byMo.set(k, []);
    byMo.get(k)!.push(d.day);
  }
  return [...byMo.entries()]
    .map(([k, days]) => `${days.sort((a, b) => a - b).join(',')}.${k}`)
    .join(', ');
}

interface Fragment {
  year: number;
  days: number | null;
  dates: string;
  count: number;
  approx: boolean;
  noDate?: boolean;
}

/**
 * Raspodeli `days` na kalendarske godine prema parsiranim datumima. Vraća niz
 * fragmenata; approx=true = raspodela proporcionalna (largest remainder, zbir == days).
 */
export function attributeEntryByYear(entry: HistoryEntry, recYear: number): Fragment[] {
  const daysNum = entry.days == null || entry.days === '' ? null : Number(entry.days);
  const dates = parseVacationDates(entry.dates, recYear);

  const byYear = new Map<number, ParsedDate[]>();
  for (const dt of dates) {
    if (!byYear.has(dt.year)) byYear.set(dt.year, []);
    byYear.get(dt.year)!.push(dt);
  }

  if (byYear.size === 0) {
    if (!/\d/.test(String(entry.dates || ''))) return [];
    return [{ year: recYear, days: daysNum, dates: entry.dates || '', count: 0, approx: false, noDate: true }];
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const totalParsed = dates.length;

  if (years.length === 1) {
    return [{ year: years[0], days: daysNum, dates: entry.dates || '', count: totalParsed, approx: false }];
  }

  let alloc: Record<number, number | null> = {};

  if (daysNum == null) {
    for (const y of years) alloc[y] = null;
  } else if (totalParsed === daysNum) {
    for (const y of years) alloc[y] = byYear.get(y)!.length;
  } else {
    const raw: Record<number, number> = {}, floor: Record<number, number> = {};
    let used = 0;
    for (const y of years) { raw[y] = (daysNum * byYear.get(y)!.length) / totalParsed; floor[y] = Math.floor(raw[y]); used += floor[y]; }
    let rem = daysNum - used;
    const order = years.slice().sort((a, b) => (raw[b] - floor[b]) - (raw[a] - floor[a]));
    for (const y of order) { if (rem <= 0) break; floor[y]++; rem--; }
    alloc = floor;
  }

  return years.map((y) => ({
    year: y,
    days: alloc[y],
    dates: formatDateList(byYear.get(y)!),
    count: byYear.get(y)!.length,
    approx: daysNum != null && totalParsed !== daysNum,
  }));
}

function kindRank(k: string): number { return k === 'go' ? 0 : k === 'slava' ? 1 : k === 'bolovanje' ? 2 : 3; }

/**
 * Regrupiši mapirane history redove u redove po KALENDARSKOJ godini. `entitled`
 * ostaje iz Excel zapisa te godine; `used`/`remaining` se preračunavaju iz
 * preraspoređenih GO dana. Saldo se NE dira.
 */
export function regroupHistoryByCalendarYear(rows: HistoryRow[] | null | undefined): RegroupedYear[] {
  if (!Array.isArray(rows) || !rows.length) return [];

  const recByYear = new Map<number, HistoryRow>();
  for (const r of rows) recByYear.set(r.year, r);

  const cal = new Map<number, { year: number; entries: RegroupedEntry[]; goUsed: number; sourceFiles: Set<string> }>();
  const ensure = (y: number) => {
    if (!cal.has(y)) cal.set(y, { year: y, entries: [], goUsed: 0, sourceFiles: new Set() });
    return cal.get(y)!;
  };

  for (const r of rows) {
    if (r.sourceFile) ensure(r.year);
    for (const e of (r.entries || [])) {
      const frags = attributeEntryByYear(e, r.year);
      for (const f of frags) {
        const bucket = ensure(f.year);
        bucket.entries.push({
          days: f.days,
          kind: e.kind || 'other',
          dates: f.dates,
          comment: e.comment || '',
          approx: f.approx,
          fromYear: r.year !== f.year ? r.year : null,
        });
        if ((e.kind === 'go') && typeof f.days === 'number') bucket.goUsed += f.days;
        if (r.sourceFile) bucket.sourceFiles.add(r.sourceFile);
      }
    }
  }

  const out: RegroupedYear[] = [...cal.values()].map((b) => {
    const rec = recByYear.get(b.year);
    const entitled = rec && rec.entitled != null ? rec.entitled : null;
    const used = b.goUsed || 0;
    return {
      year: b.year,
      entitled,
      used,
      remaining: entitled != null ? entitled - used : null,
      entries: b.entries.sort((a, z) => (kindRank(a.kind) - kindRank(z.kind))),
      sourceFile: [...b.sourceFiles][0] || (rec ? rec.sourceFile || '' : '') || '',
      recomputed: true,
    };
  });
  out.sort((a, z) => z.year - a.year);
  return out;
}

/**
 * Iz teksta datuma jednog unosa istorije izvuci OD/DO ISO (min/max stvarnog datuma).
 * Vraća null ako nema parsabilnog datuma sa mesecom.
 */
export function entryDateRangeIso(
  datesText: string | null | undefined,
  year: number,
): { fromIso: string; toIso: string; count: number } | null {
  const parsed = parseVacationDates(datesText, year).filter((p) => p.month >= 1 && p.month <= 12);
  if (!parsed.length) return null;
  const isos = parsed
    .map((p) => `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`)
    .sort();
  return { fromIso: isos[0], toIso: isos[isos.length - 1], count: parsed.length };
}
