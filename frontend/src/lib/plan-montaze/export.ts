// Plan montaže — export/uvoz (increment 6 + uvoz). JSON snapshot + XLSX (paritet 1.0
// exportModal.js „Plan montaze" + „Sumarno" listovi) + parsePlanImport za JSON uvoz
// (podržava 2.0 izvoz ovog modula I 1.0 snapshot `_version 5.x`). PDF Gantta
// (html2canvas) NIJE u v1 (nema dep). SheetJS je bundlovan (`xlsx`). Radi u browseru:
// writeFile pokreće download.

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

// ------------------------------------------------------------------ JSON uvoz
// Ulaz = raspakovan JSON (unknown). Izlaz = normalizovano ugnježdeno stablo u 2.0
// imenima polja, spremno za sekvencijalni upsert-po-id (projekat → WP → faza).
// Podržana OBA formata:
//   (a) 2.0 izvoz ovog modula (`_version: '2.0-fe'`, projekti = MontazaProjectNode),
//   (b) 1.0 snapshot (`_version: '5.x'`, exportModal.js/buildPhasePayload imena:
//       code/name/projectM/deadline + WP defaultEngineer/defaultLead + faza
//       name/loc/start/end/engineer/person/type…).

export interface PlanImportPhase {
  id?: string;
  phaseName: string;
  location?: string;
  startDate?: string | null;
  endDate?: string | null;
  responsibleEngineer?: string;
  montageLead?: string;
  status?: number;
  pct?: number;
  checks?: boolean[];
  blocker?: string;
  note?: string;
  phaseType?: 'mechanical' | 'electrical';
  description?: string;
  linkedDrawings?: string[];
  actualStartDate?: string | null;
  actualEndDate?: string | null;
}

export interface PlanImportWp {
  id?: string;
  name: string;
  rnCode?: string;
  rnOrder?: number;
  location?: string;
  responsibleEngineerDefault?: string;
  montageLeadDefault?: string;
  deadline?: string | null;
  assemblyDrawingNo?: string;
  phases: PlanImportPhase[];
}

export interface PlanImportProject {
  id?: string;
  projectCode: string;
  projectName: string;
  projectm?: string;
  projectDeadline?: string | null;
  pmEmail?: string;
  leadpmEmail?: string;
  status?: string;
  workPackages: PlanImportWp[];
}

export interface PlanImportResult {
  projects: PlanImportProject[];
  counts: { projects: number; wps: number; phases: number };
  sourceVersion: string;
}

// Tolerantni čitači sirovih vrednosti (uvoz ne sme da pukne na null/pogrešnom tipu).
function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function idOrUndef(v: unknown): string | undefined {
  const s = str(v).trim();
  return s || undefined;
}
/** Kanonski 'YYYY-MM-DD' iz stringa/ISO datetime-a; sve ostalo → null. */
function ymdOrNull(v: unknown): string | null {
  const m = str(v).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function checks8(v: unknown): boolean[] {
  const arr = Array.isArray(v) ? v.slice(0, 8).map(Boolean) : [];
  while (arr.length < 8) arr.push(false);
  return arr;
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x).trim()).filter(Boolean) : [];
}
function recArr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
    : [];
}

// --- 1.0 snapshot (exportModal.js allData oblik) ---

function phase10(raw: Record<string, unknown>): PlanImportPhase {
  return {
    id: idOrUndef(raw.id),
    phaseName: str(raw.name),
    location: str(raw.loc),
    startDate: ymdOrNull(raw.start),
    endDate: ymdOrNull(raw.end),
    responsibleEngineer: str(raw.engineer),
    montageLead: str(raw.person),
    status: num(raw.status),
    pct: num(raw.pct),
    checks: checks8(raw.checks),
    blocker: str(raw.blocker),
    note: str(raw.note),
    phaseType: normalizePhaseType(str(raw.type)),
    description: str(raw.description),
    linkedDrawings: strArr(raw.linkedDrawings),
    actualStartDate: ymdOrNull(raw.actualStartDate),
    actualEndDate: ymdOrNull(raw.actualEndDate),
  };
}

function wp10(raw: Record<string, unknown>): PlanImportWp {
  return {
    id: idOrUndef(raw.id),
    name: str(raw.name),
    rnCode: str(raw.rnCode),
    rnOrder: raw.rnOrder != null ? num(raw.rnOrder, 1) : undefined,
    location: str(raw.location),
    responsibleEngineerDefault: str(raw.defaultEngineer),
    montageLeadDefault: str(raw.defaultLead),
    deadline: ymdOrNull(raw.deadline),
    assemblyDrawingNo: str(raw.assemblyDrawingNo),
    phases: recArr(raw.phases).map(phase10),
  };
}

function project10(raw: Record<string, unknown>): PlanImportProject {
  return {
    id: idOrUndef(raw.id),
    projectCode: str(raw.code).trim(),
    projectName: str(raw.name).trim(),
    projectm: str(raw.projectM),
    projectDeadline: ymdOrNull(raw.deadline),
    pmEmail: str(raw.pmEmail),
    leadpmEmail: str(raw.leadPmEmail),
    status: str(raw.status).trim() || 'active',
    workPackages: recArr(raw.workPackages).map(wp10),
  };
}

// --- 2.0 izvoz ovog modula (MontazaProjectNode stablo) ---

function phase20(raw: Record<string, unknown>): PlanImportPhase {
  return {
    id: idOrUndef(raw.id),
    phaseName: str(raw.phaseName),
    location: str(raw.location),
    startDate: ymdOrNull(raw.startDate),
    endDate: ymdOrNull(raw.endDate),
    responsibleEngineer: str(raw.responsibleEngineer),
    montageLead: str(raw.montageLead),
    status: num(raw.status),
    pct: num(raw.pct),
    checks: checks8(raw.checks),
    blocker: str(raw.blocker),
    note: str(raw.note),
    phaseType: normalizePhaseType(str(raw.phaseType)),
    description: str(raw.description),
    linkedDrawings: strArr(raw.linkedDrawings),
    actualStartDate: ymdOrNull(raw.actualStartDate),
    actualEndDate: ymdOrNull(raw.actualEndDate),
  };
}

function wp20(raw: Record<string, unknown>): PlanImportWp {
  return {
    id: idOrUndef(raw.id),
    name: str(raw.name),
    rnCode: str(raw.rnCode),
    rnOrder: raw.rnOrder != null ? num(raw.rnOrder, 1) : undefined,
    location: str(raw.location),
    responsibleEngineerDefault: str(raw.responsibleEngineerDefault),
    montageLeadDefault: str(raw.montageLeadDefault),
    deadline: ymdOrNull(raw.deadline),
    assemblyDrawingNo: str(raw.assemblyDrawingNo),
    phases: recArr(raw.phases).map(phase20),
  };
}

function project20(raw: Record<string, unknown>): PlanImportProject {
  return {
    id: idOrUndef(raw.id),
    projectCode: str(raw.project_code).trim(),
    projectName: str(raw.project_name).trim(),
    projectm: str(raw.projectm),
    projectDeadline: ymdOrNull(raw.project_deadline),
    pmEmail: str(raw.pm_email),
    leadpmEmail: str(raw.leadpm_email),
    status: str(raw.status).trim() || 'active',
    workPackages: recArr(raw.workPackages).map(wp20),
  };
}

/**
 * Parsira JSON uvoz plana montaže (2.0 ili 1.0 format) u normalizovano stablo.
 * Baca Error sa jasnom srpskom porukom ako format nije prepoznat.
 */
export function parsePlanImport(json: unknown): PlanImportResult {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Neispravan JSON — očekuje se objekat izvoza plana montaže.');
  }
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.projects)) {
    throw new Error('Neprepoznat format — nedostaje niz „projects". Podržani su 2.0 izvoz ovog modula i 1.0 JSON snapshot.');
  }
  const version = typeof obj._version === 'string' ? obj._version : '';
  const rawProjects = recArr(obj.projects);
  const first = rawProjects[0];

  let kind: '2.0' | '1.0';
  if (version.startsWith('2.0')) kind = '2.0';
  else if (version.startsWith('5')) kind = '1.0';
  else if (first && ('project_code' in first || 'project_name' in first)) kind = '2.0';
  else if (first && 'code' in first && 'workPackages' in first) kind = '1.0';
  else {
    throw new Error(
      `Neprepoznat format plana (verzija „${version || 'nepoznata'}"). Podržani su 2.0 izvoz ovog modula i 1.0 snapshot (_version 5.x).`,
    );
  }

  const projects = rawProjects.map(kind === '2.0' ? project20 : project10);
  let wps = 0;
  let phaseCount = 0;
  for (const p of projects) {
    wps += p.workPackages.length;
    for (const w of p.workPackages) phaseCount += w.phases.length;
  }
  return {
    projects,
    counts: { projects: projects.length, wps, phases: phaseCount },
    sourceVersion: version || kind,
  };
}
