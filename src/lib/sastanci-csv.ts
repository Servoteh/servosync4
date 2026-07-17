'use client';

// Export CSV akcionog plana — S-P1 paket B, port 1.0
// sastanakDetalj/akcijeTab.js exportCsv: kolone RN;Zadatak;Odgovoran;Rok;Status
// (statusna LABELA, ne ključ), separator ';', UTF-8 BOM (Excel ispravno čita
// š/đ/č/ć/ž), CRLF prelomi. Redosled redova = ⭐ RN grupe — POZIVALAC grupiše
// kroz groupAkcijeByRn(rows, prioritet, { rowSort: 'rb' }) (1.0 orderedForOutput).

import {
  akcijaOdgovoran,
  akcijaStatusLabela,
  fmtDmy,
  localTodayIso,
  type PrintAkcijeGroup,
} from './sastanci-print';

/**
 * Preuzmi akcioni plan kao CSV. Podrazumevani naziv fajla
 * `akcioni-plan-YYYY-MM-DD.csv` (globalni tab, lokalni datum); detalj sastanka
 * može proslediti 1.0 `akcije_<datum>.csv` kroz `filename`.
 */
export function exportAkcijeCsv(
  groups: PrintAkcijeGroup[],
  opts: { filename?: string } = {},
): void {
  const sep = ';';
  // OWASP CSV injection: vrednost koja počinje sa =, +, -, @ ili TAB bi Excel
  // protumačio kao formulu (npr. =HYPERLINK exfiltracija) — prefiksuj apostrofom.
  const q = (v: unknown) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [['RN', 'Zadatak', 'Odgovoran', 'Rok', 'Status'].join(sep)];
  for (const g of groups) {
    for (const r of g.rows) {
      lines.push(
        [
          q(g.code || g.naziv),
          q(r.naslov),
          q(akcijaOdgovoran(r)),
          q(r.rok_text || fmtDmy(r.rok)),
          q(akcijaStatusLabela(r)),
        ].join(sep),
      );
    }
  }
  // '﻿' = UTF-8 BOM — Excel bez njega pogrešno čita dijakritike (1.0 paritet).
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = opts.filename ?? `akcioni-plan-${localTodayIso()}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
