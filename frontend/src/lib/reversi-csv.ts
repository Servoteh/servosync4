/**
 * CSV izvoz za Reversi (port 1.0 `src/lib/csv.js` — RFC 4180 + BOM + CSV-injection
 * escape). Deljeni helper: „Alat i oprema" (RA-23), a spreman i za magacin (RA-36)
 * i izveštaj potrošnje (RA-41). Browser-only download (2.0 Reversi je desktop web;
 * mobilni `/m/reversi` i dalje vozi 1.0 servise).
 *
 * Pravila (identična 1.0):
 *  - separator `,`, redovi `\r\n` (Excel/Windows friendly)
 *  - polje se citira kad sadrži `"`, `,`, `\r` ili `\n`; unutrašnji `"` → `""`
 *  - `null`/`undefined` → prazno polje; `Date` → ISO; objekat → JSON
 *  - CSV-injection escape: string koji počinje sa `= + - @ \t \r \n` (a nije
 *    primitivni broj/bool) dobija vodeći `'` da Excel ne pokrene formulu
 */

const CSV_INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/** UTF-8 BOM — bez njega Excel na Windows-u prikaže ć/č/š/đ/ž kao mojibake. */
export const CSV_BOM = '﻿';

export function toCsvField(v: unknown): string {
  if (v == null) return '';
  let s: string;
  let isNumeric = false;
  if (v instanceof Date) {
    s = Number.isFinite(v.getTime()) ? v.toISOString() : '';
  } else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v);
    } catch {
      s = String(v);
    }
  } else if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    s = String(v);
    isNumeric = true;
  } else {
    s = String(v);
  }
  if (!isNumeric && s.length > 0 && CSV_INJECTION_PREFIXES.has(s.charAt(0))) {
    s = `'${s}`;
  }
  if (/["\r\n,]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(toCsvField).join(',')];
  for (const r of rows) lines.push(r.map(toCsvField).join(','));
  return lines.join('\r\n');
}

/** Sastavi CSV (sa BOM) i pokreni download u browseru. `filename` uključuje `.csv`. */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
): void {
  const csv = CSV_BOM + rowsToCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}
