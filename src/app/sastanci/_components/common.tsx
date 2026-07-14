'use client';

import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';

// Zajednički mapiranja/labeli za Sastanci (paritet 1.0 rečnika). Domenske statuse
// prikazujemo isključivo kroz StatusBadge (DESIGN_SYSTEM §7).

export function tableEmpty(isError: boolean, title: string, hint: string) {
  if (isError) {
    return (
      <EmptyState
        title="Greška pri učitavanju"
        hint="Podaci trenutno nisu dostupni. Osveži stranicu ili pokušaj ponovo."
      />
    );
  }
  return <EmptyState title={title} hint={hint} />;
}

/** Vreme iz Prisma @db.Time (ISO ili HH:MM:SS) → „HH:MM". */
export function formatVreme(v: string | null | undefined): string {
  if (!v) return '—';
  const s = String(v);
  if (s.includes('T')) return s.slice(11, 16);
  return s.slice(0, 5);
}

/** Datum (YYYY-MM-DD ili ISO) → „dd.MM.yyyy." bez TZ pomaka. */
export function formatDatum(v: string | null | undefined): string {
  if (!v) return '—';
  const d = String(v).slice(0, 10);
  const parts = d.split('-');
  if (parts.length === 3) return `${parts[2]}.${parts[1]}.${parts[0]}.`;
  return d;
}

export const SASTANAK_TIP_LABEL: Record<string, string> = {
  sedmicni: 'Sedmični',
  projektni: 'Projektni',
  tematski: 'Tematski',
  dnevni: 'Dnevni',
};

const SASTANAK_STATUS: Record<string, { tone: Tone; label: string }> = {
  planiran: { tone: 'neutral', label: 'Planiran' },
  u_toku: { tone: 'info', label: 'U toku' },
  zavrsen: { tone: 'success', label: 'Završen' },
  zakljucan: { tone: 'warn', label: 'Zaključan' },
  otkazan: { tone: 'danger', label: 'Otkazan' },
};
export function SastanakStatusBadge({ status }: { status: string }) {
  const s = SASTANAK_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

// Akcije — effective_status (view) mapiranje.
export const AKCIJA_STATUS_LABEL: Record<string, string> = {
  otvoren: 'Otvoren',
  u_toku: 'U toku',
  zavrsen: 'Završen',
  kasni: 'Kasni',
  odlozen: 'Odložen',
  otkazan: 'Otkazan',
};
const AKCIJA_TONE: Record<string, Tone> = {
  otvoren: 'neutral',
  u_toku: 'info',
  zavrsen: 'success',
  kasni: 'danger',
  odlozen: 'neutral',
  otkazan: 'neutral',
};
export function AkcijaStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={AKCIJA_TONE[status] ?? 'neutral'} label={AKCIJA_STATUS_LABEL[status] ?? status} />;
}
/** Statusi koje sme da postavi UI (bez `kasni` — to je izvedeno, paritet EDIT_STATUSI). */
export const AKCIJA_SETTABLE_STATUSI = ['otvoren', 'u_toku', 'zavrsen', 'odlozen', 'otkazan'];

// PM teme.
export const TEMA_STATUS_LABEL: Record<string, string> = {
  predlog: 'Na čekanju',
  usvojeno: 'Usvojeno',
  odbijeno: 'Odbijeno',
  odlozeno: 'Odloženo',
  zatvoreno: 'Zatvoreno',
  draft: 'Nacrt',
};
const TEMA_TONE: Record<string, Tone> = {
  predlog: 'warn',
  usvojeno: 'success',
  odbijeno: 'danger',
  odlozeno: 'neutral',
  zatvoreno: 'neutral',
  draft: 'info',
};
export function TemaStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={TEMA_TONE[status] ?? 'neutral'} label={TEMA_STATUS_LABEL[status] ?? status} />;
}
export const TEMA_VRSTE: Record<string, string> = {
  tema: 'Tema',
  problem: 'Problem',
  predlog: 'Predlog',
  rizik: 'Rizik',
  pitanje: 'Pitanje',
};
export const TEMA_OBLASTI: Record<string, string> = {
  opste: 'Opšte',
  proizvodnja: 'Proizvodnja',
  montaza: 'Montaža',
  nabavka: 'Nabavka',
  kadrovi: 'Kadrovi',
  finansije: 'Finansije',
  kvalitet: 'Kvalitet',
  klijent: 'Klijent',
  ostalo: 'Ostalo',
};

export const PRIORITET_LABEL: Record<number, string> = { 1: 'Visok', 2: 'Srednji', 3: 'Nizak' };
export const PRIORITET_ICON: Record<number, string> = { 1: '●', 2: '●', 3: '●' };
export const PRIORITET_TONE: Record<number, Tone> = { 1: 'danger', 2: 'warn', 3: 'neutral' };

export const CADENCE_LABEL: Record<string, string> = {
  none: 'Bez ponavljanja',
  daily: 'Dnevno',
  weekly: 'Nedeljno',
  biweekly: 'Na dve nedelje',
  monthly: 'Mesečno',
};

export const INPUT_CLS =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';
