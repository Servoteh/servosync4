'use client';

/**
 * Platformski CSV izvoz tabela (Talas 3 A6). Klijentski (browser-only) download —
 * bez novih zavisnosti. Namena: „Izvezi CSV" dugme nad DataTable listama (robno
 * lager, saldakonti otvorene stavke, PDV KIF/KUF).
 *
 * Excel (sr lokalizacija) friendly:
 *  - separator `;` (sr Windows Excel podrazumeva tačku-zarez, ne zarez)
 *  - UTF-8 BOM na početku (bez njega Excel prikaže č/ć/š/đ/ž kao mojibake)
 *  - redovi `\r\n` (CRLF)
 *  - polje se citira kad sadrži `"`, `;`, `\r` ili `\n`; unutrašnji `"` → `""`
 *  - CSV-injection escape: string koji počinje sa `= + - @ TAB CR LF` dobija
 *    vodeći `'` da Excel ne pokrene formulu (OWASP)
 *
 * Kolone su nezavisne od DataTable `Column` (koji renderuje ReactNode) — ovde je
 * `value(row)` čista vrednost (string/broj), tako da izvoz odgovara podacima,
 * ne markap-u ćelije.
 */

/** Jedna CSV kolona: naslov + ekstraktor čiste vrednosti iz reda. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** UTF-8 BOM — bez njega Excel na Windows-u prikaže dijakritike kao mojibake. */
const CSV_BOM = '﻿';
const SEP = ';';
const INJECTION_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/** Jedna vrednost → bezbedno CSV polje (injection escape + citiranje). */
function toField(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : v;
  const isNumeric = typeof v === 'number';
  if (!isNumeric && s.length > 0 && INJECTION_PREFIXES.has(s.charAt(0))) {
    s = `'${s}`;
  }
  if (/[";\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Sastavi CSV tekst (sa BOM) iz kolona i redova. */
export function tableToCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const lines = [columns.map((c) => toField(c.header)).join(SEP)];
  for (const row of rows) {
    lines.push(columns.map((c) => toField(c.value(row))).join(SEP));
  }
  return CSV_BOM + lines.join('\r\n');
}

/**
 * Sastavi CSV iz `columns`/`rows` i pokreni download u browseru. `filename` bez
 * ekstenzije dobija `.csv`. No-op van browsera (SSR/prerender).
 */
export function exportTableToCsv<T>(
  columns: CsvColumn<T>[],
  rows: T[],
  filename: string,
): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const csv = tableToCsv(columns, rows);
  const name = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
