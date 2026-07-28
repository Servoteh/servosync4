import type { JobPosition, OrgDepartment, OrgStructure, OrgSubDepartment } from '@/api/kadrovska';

// Deljeni model opisa radnog mesta — JEDAN izvor istine za 8 sekcija sistematizacije,
// laki markdown parser i grupisanje org strukture. Koriste ga `job-position.ts`
// (opis JEDNE pozicije), `sistematizacija.ts` (PDF cele sistematizacije) i
// `sistematizacija-doc.ts` (Word/.doc izvoz) — da preimenovanje sekcije ne mora da
// se radi na tri mesta.

/** 8 sekcija opisa pozicije (redosled = „Moj profil"). */
export const POSITION_SECTIONS: [keyof JobPosition, string][] = [
  ['summaryMd', 'Svrha radnog mesta'],
  ['responsibilitiesMd', 'Ključne odgovornosti'],
  ['authorityMd', 'Ovlašćenja'],
  ['dutiesMd', 'Odgovornost (accountability)'],
  ['kpiMd', 'KPI / merila uspeha'],
  ['qualificationsMd', 'Kvalifikacije i iskustvo'],
  ['collaborationMd', 'Ključna saradnja'],
  ['expectationsMd', 'Očekivanja'],
];

export function hasText(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export type Block = { kind: 'h' | 'li' | 'p' | 'gap'; text?: string };

/** Lagani markdown u blokove: skida bold/code markere, hvata # naslove i - liste. */
export function mdToBlocks(md: string): Block[] {
  const out: Block[] = [];
  for (const raw of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { out.push({ kind: 'gap' }); continue; }
    const h = trimmed.match(/^#{1,4}\s+(.*)$/);
    if (h) { out.push({ kind: 'h', text: h[1].trim() }); continue; }
    const li = trimmed.match(/^[-*•]\s+(.*)$/);
    if (li) { out.push({ kind: 'li', text: li[1].trim() }); continue; }
    const ol = trimmed.match(/^(\d+[.)])\s+(.*)$/);
    if (ol) { out.push({ kind: 'li', text: `${ol[1]} ${ol[2].trim()}` }); continue; }
    out.push({ kind: 'p', text: trimmed });
  }
  return out;
}

/** Pozicija ima bar jedno popunjeno opisno polje (ili „Linijski odgovara"). */
export function positionHasContent(p: Partial<JobPosition>): boolean {
  return hasText(p.reportsToLine) || POSITION_SECTIONS.some(([field]) => hasText(p[field]));
}

/* ── Grupisanje org strukture (odeljenje → pododeljenje → pozicije) ──────── */

export interface OrgTreeSub {
  /** null = pozicije koje vise direktno na odeljenju (bez pododeljenja). */
  subDepartment: OrgSubDepartment | null;
  positions: JobPosition[];
}
export interface OrgTreeDept {
  department: OrgDepartment;
  subs: OrgTreeSub[];
  /** Ukupno pozicija u odeljenju (svi nivoi). */
  positionCount: number;
}
export interface OrgTree {
  depts: OrgTreeDept[];
  positionCount: number;
  /** Pozicije sa bar jednim popunjenim opisnim poljem. */
  describedCount: number;
}

const byOrder = (a: { sortOrder: number; name: string }, b: { sortOrder: number; name: string }) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'sr');

/**
 * Sklapa stablo odeljenje → pododeljenje → pozicije, poštujući `sortOrder` (BE već
 * sortira, ali izvoz ne sme da zavisi od redosleda odgovora). Pozicije čije odeljenje
 * ne postoji u strukturi idu pod sintetičko „Neraspoređeno" — da se u pravilniku ne
 * izgubi nijedno radno mesto.
 */
export function buildOrgTree(org: OrgStructure): OrgTree {
  const departments = [...(org.departments ?? [])].sort(byOrder);
  const subDepartments = [...(org.subDepartments ?? [])].sort(byOrder);
  const positions = [...(org.jobPositions ?? [])].sort(byOrder);

  const knownDeptIds = new Set(departments.map((d) => d.id));
  const orphans = positions.filter((p) => !knownDeptIds.has(p.departmentId));
  const deptList: OrgDepartment[] = orphans.length
    ? [...departments, { id: -1, name: 'Neraspoređeno', sortOrder: Number.MAX_SAFE_INTEGER }]
    : departments;

  const depts: OrgTreeDept[] = [];
  for (const department of deptList) {
    const own =
      department.id === -1 ? orphans : positions.filter((p) => p.departmentId === department.id);
    if (!own.length) continue;

    const subs: OrgTreeSub[] = [];
    const direct = own.filter((p) => p.subDepartmentId == null);
    if (direct.length) subs.push({ subDepartment: null, positions: direct });
    for (const sd of subDepartments.filter((s) => s.departmentId === department.id)) {
      const inSub = own.filter((p) => p.subDepartmentId === sd.id);
      if (inSub.length) subs.push({ subDepartment: sd, positions: inSub });
    }
    // Pozicije sa sub_department_id koji ne postoji — ne smeju nestati.
    const placed = new Set(subs.flatMap((s) => s.positions.map((p) => p.id)));
    const rest = own.filter((p) => !placed.has(p.id));
    if (rest.length) {
      const loose = subs.find((s) => s.subDepartment == null);
      if (loose) loose.positions.push(...rest);
      else subs.unshift({ subDepartment: null, positions: rest });
    }

    depts.push({ department, subs, positionCount: own.length });
  }

  return {
    depts,
    positionCount: positions.length,
    describedCount: positions.filter(positionHasContent).length,
  };
}
