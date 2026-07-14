'use client';

// Deljeni helperi za Zaposleni/Imenik (P2) — port 1.0 employeesTab/contractsTab
// konstanti i logike (doktrina §C: iste vrednosti/labele). Snake_case polja
// dolaze iz v_employees_safe (BE maska presuđuje PII — FE samo prikazuje).

import type { Contract, EmployeeSafe } from '@/api/kadrovska';
import { sv } from './common';

/* Tip rada — prati VALID_WORK_TYPES u 1.0 payrollCalc.js. „ugovor" ima puna
   prava; ostali nemaju automatsko sabiranje praznika ni plaćena odsustva. */
export const WORK_TYPE_OPTIONS: [string, string][] = [
  ['ugovor', 'Ugovor (puna prava)'],
  ['dualno', 'Dualno obrazovanje'],
  ['praksa', 'Praksa'],
  ['penzioner', 'Penzioner'],
];

export const EDU_LEVEL_LABELS: Record<string, string> = {
  I: 'I stepen',
  II: 'II stepen',
  III: 'III stepen',
  IV: 'IV stepen (SSS)',
  V: 'V stepen (VKV)',
  VI: 'VI stepen (VŠ)',
  VII: 'VII stepen (VSS)',
  VIII: 'VIII stepen (Magistar)',
  IX: 'IX stepen (Doktor nauka)',
};

/** Vrste ugovora (1.0 CON_TYPE_OPTS) — filter po vrsti aktivnog ugovora. */
export const CON_TYPE_OPTS: { v: string; l: string }[] = [
  { v: 'neodredjeno', l: 'Neodređeno vreme' },
  { v: 'odredjeno', l: 'Određeno vreme' },
  { v: 'probni', l: 'Probni rad' },
  { v: 'privremeno', l: 'Privremeni' },
  { v: 'delo', l: 'Ugovor o delu' },
  { v: 'student', l: 'Student' },
  { v: 'praksa', l: 'Praksa' },
  { v: 'ostalo', l: 'Ostalo' },
];

export const EMERGENCY_RELATIONS = [
  'supruga', 'suprug', 'majka', 'otac', 'sin', 'ćerka', 'brat', 'sestra',
  'dete', 'partner/ka', 'komšija/nica', 'prijatelj/ica', 'drugi rođak', 'ostalo',
];

/** Status ugovora iz datuma (1.0 contractStatus) — aktivan / ističe / istekao. */
export function contractStatus(c: Contract): { key: 'inactive' | 'expired' | 'expiring' | 'active'; label: string; days?: number } {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (c.isActive === false) return { key: 'inactive', label: 'Neaktivan' };
  if (c.dateTo) {
    const to = String(c.dateTo).slice(0, 10);
    if (to < todayStr) return { key: 'expired', label: 'Istekao' };
    const diff = Math.round((new Date(to).getTime() - new Date(todayStr).getTime()) / 86400000);
    if (diff <= 30) return { key: 'expiring', label: `Ističe za ${diff} d`, days: diff };
  }
  return { key: 'active', label: 'Aktivan' };
}

/* ── Ime i sortiranje (1.0 employeeNames.js, sr kolacija „Prezime Ime") ── */

const COLLATOR = new Intl.Collator('sr', { sensitivity: 'base' });

export function empFirstName(e: EmployeeSafe): string {
  return sv(e, 'first_name').trim();
}
export function empLastName(e: EmployeeSafe): string {
  return sv(e, 'last_name').trim();
}
/** „Prezime Ime" ako postoje razdvojena polja, inače full_name. */
export function empDisplayName(e: EmployeeSafe): string {
  const first = empFirstName(e);
  const last = empLastName(e);
  if (last || first) return [last, first].filter(Boolean).join(' ');
  return (e.full_name || '').trim();
}
function fallbackSurname(e: EmployeeSafe): string {
  const last = empLastName(e);
  if (last) return last;
  const parts = empDisplayName(e).split(/\s+/).filter(Boolean);
  return parts[0] || '';
}
export function compareEmpByLastFirst(a: EmployeeSafe, b: EmployeeSafe): number {
  const last = COLLATOR.compare(fallbackSurname(a), fallbackSurname(b));
  if (last !== 0) return last;
  const first = COLLATOR.compare(empFirstName(a), empFirstName(b));
  if (first !== 0) return first;
  return COLLATOR.compare(empDisplayName(a), empDisplayName(b));
}

/* ── Rođendani / lekarski (30d prozori, wrap-around za Nova godina) ── */

/** Broj dana do sledećeg rođendana (0 = danas); bez datuma → 999999 (kraj sorta). */
export function daysUntilBirthday(iso: string | null | undefined): number {
  if (!iso || typeof iso !== 'string') return 999999;
  const parts = iso.slice(0, 10).split('-');
  const mm = Number(parts[1]);
  const dd = Number(parts[2]);
  if (!mm || !dd) return 999999;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), mm - 1, dd);
  if (next < today) next = new Date(today.getFullYear() + 1, mm - 1, dd);
  return Math.round((next.getTime() - today.getTime()) / 86400000);
}

/** Da li MM-DD rođendana pada u narednih 30 dana (wrap decembar→januar). */
export function birthdayInNext30(birthDate: string | null | undefined): boolean {
  if (!birthDate) return false;
  const md = String(birthDate).slice(5, 10);
  if (!md) return false;
  const todayIso = new Date().toISOString().slice(0, 10);
  const in30 = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const tNow = todayIso.slice(5);
  const tIn30 = in30.slice(5);
  return tNow <= tIn30 ? md >= tNow && md <= tIn30 : md >= tNow || md <= tIn30;
}

/** Dana do isteka lekarskog (negativno = istekao); null bez datuma. */
export function medicalDaysLeft(expires: string | null | undefined): number | null {
  if (!expires) return null;
  const to = new Date(String(expires).slice(0, 10));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((to.getTime() - today.getTime()) / 86400000);
}

/* ── Avatar od inicijala (1.0 lib/avatar.js) — stabilna boja iz imena ── */

function initials(name: string): string {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
}
function colorFromString(s: string): string {
  const str = String(s || '');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 52%, 45%)`;
}

/** Krug sa inicijalima — Imenik / rosteri. Boja je dinamička vrednost (hash imena). */
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold leading-none text-white"
      style={{ width: size, height: size, background: colorFromString(name), fontSize: Math.max(9, Math.round(size * 0.4)) }}
    >
      {initials(name)}
    </span>
  );
}

/** Srpski oblik broja: 1 kontakt · 2–4 kontakta · 5+ kontakata. */
export function kontaktRec(n: number): string {
  const c = Math.abs(n) % 100;
  const d = c % 10;
  if (d === 1 && c !== 11) return 'kontakt';
  if (d >= 2 && d <= 4 && (c < 12 || c > 14)) return 'kontakta';
  return 'kontakata';
}

/** „DD.MM." iz ISO datuma (prikaz rođendana u listi). */
export function ddMm(iso: string | null | undefined): string {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? `${p[2]}.${p[1]}.` : '';
}
