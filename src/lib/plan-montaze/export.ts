// Plan montaže — export (increment 6). JSON snapshot + XLSX (paritet 1.0 exportModal.js
// „Plan montaze" + „Sumarno" listovi). PDF Gantta (html2canvas) NIJE u v1 (nema dep).
// SheetJS je bundlovan (`xlsx`). Radi u browseru: writeFile pokreće download.

import * as XLSX from 'xlsx';
import type { MontazaProjectNode } from '@/api/plan-montaze';
import { toPhaseVM } from '@/api/plan-montaze';
import { STATUSES } from './constants';
import { calcReadiness, normalizePhaseType } from './phase';
import { calcDuration } from './date';

function todayYmdSlug(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Pun JSON snapshot (backup) — projekti→WP→faze + meta. */
export function exportPlanJson(projects: MontazaProjectNode[], scopeLabel = 'export'): void {
  const payload = {
    projects,
    _exportedAt: new Date().toISOString(),
    _version: '2.0-fe',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  download(blob, `plan_${scopeLabel}_${todayYmdSlug()}.json`);
}

interface PhaseXlsxRow {
  Projekat: string;
  Pozicija: string;
  RN: string;
  Faza: string;
  Tip: string;
  Lokacija: string;
  'Datum početka': string;
  'Datum kraja': string;
  'Trajanje (d)': number | '';
  'Odgovorni inženjer': string;
  'Vođa montaže': string;
  Status: string;
  'Procenat (%)': number;
  Spremnost: string;
  Razlog: string;
  Blokator: string;
  Napomena: string;
  Crteži: string;
}

function phaseRows(projects: MontazaProjectNode[]): PhaseXlsxRow[] {
  const rows: PhaseXlsxRow[] = [];
  for (const proj of projects) {
    for (const wp of proj.workPackages) {
      for (const raw of wp.phases) {
        const ph = toPhaseVM(raw);
        const rd = calcReadiness(ph);
        const dur = calcDuration(ph.startDate, ph.endDate);
        rows.push({
          Projekat: `${proj.project_code || ''} — ${proj.project_name || ''}`,
          Pozicija: wp.name || '',
          RN: wp.rnCode || '',
          Faza: ph.phaseName || '',
          Tip: normalizePhaseType(ph.phaseType) === 'electrical' ? 'Elektro' : 'Mašinska',
          Lokacija: ph.location || '',
          'Datum početka': ph.startDate || '',
          'Datum kraja': ph.endDate || '',
          'Trajanje (d)': dur != null && dur >= 0 ? dur : '',
          'Odgovorni inženjer': ph.responsibleEngineer || '',
          'Vođa montaže': ph.montageLead || '',
          Status: STATUSES[ph.status] || '',
          'Procenat (%)': ph.pct || 0,
          Spremnost: rd.done ? 'Završeno' : rd.ready ? 'Spreman' : 'Nije spreman',
          Razlog: rd.reasons.join(' | '),
          Blokator: ph.blocker || '',
          Napomena: ph.note || '',
          Crteži: ph.linkedDrawings.join(', '),
        });
      }
    }
  }
  return rows;
}

/** XLSX: „Plan montaze" (faze) + „Sumarno" (po projektu). */
export function exportPlanXlsx(projects: MontazaProjectNode[]): boolean {
  const rows = phaseRows(projects);
  if (!rows.length) return false;

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [
    { wch: 28 }, { wch: 24 }, { wch: 10 }, { wch: 36 }, { wch: 10 },
    { wch: 14 }, { wch: 13 }, { wch: 13 }, { wch: 10 }, { wch: 22 },
    { wch: 22 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 30 },
    { wch: 24 }, { wch: 30 }, { wch: 26 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Plan montaze');

  const summary = projects.map((p) => {
    let total = 0;
    let done = 0;
    let inP = 0;
    let hold = 0;
    for (const wp of p.workPackages) {
      for (const ph of wp.phases) {
        total++;
        if (ph.status === 2) done++;
        else if (ph.status === 1) inP++;
        else if (ph.status === 3) hold++;
      }
    }
    return {
      Projekat: `${p.project_code || ''} — ${p.project_name || ''}`,
      PM: p.projectm || '',
      Rok: p.project_deadline || '',
      'Ukupno faza': total,
      Završeno: done,
      'U toku': inP,
      'Na čekanju': hold,
    };
  });
  if (summary.length) {
    const ws2 = XLSX.utils.json_to_sheet(summary);
    ws2['!cols'] = [{ wch: 30 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Sumarno');
  }

  XLSX.writeFile(wb, `plan_montaze_${todayYmdSlug()}.xlsx`);
  return true;
}
