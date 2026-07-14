'use client';

import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import type {
  BookingStatus,
  IncidentSeverity,
  IncidentStatus,
  NotifStatus,
  OpStatus,
  WoGroup,
  WoPriority,
  WoStatus,
} from '@/api/odrzavanje';

/** Razlikuje grešku učitavanja od stvarno praznog skupa (globalni retry:false). */
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

/** Sigurno čitanje snake_case kolone view-reda (kolone variraju po view-u). */
export function f(row: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return null;
}
export function fnum(row: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

// ── Statusi mašine / operativni ────────────────────────────────────
const OP: Record<OpStatus, { tone: Tone; label: string }> = {
  running: { tone: 'success', label: 'U radu' },
  degraded: { tone: 'warn', label: 'Smetnja' },
  down: { tone: 'danger', label: 'Zastoj' },
  maintenance: { tone: 'info', label: 'Održavanje' },
};
export function OpStatusBadge({ status }: { status: OpStatus | string | null }) {
  const s = (status && OP[status as OpStatus]) || { tone: 'neutral' as Tone, label: status ?? 'Nepoznato' };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

// ── WO statusi / grupe / prioritet ─────────────────────────────────
export const WO_STATUS_LABEL: Record<WoStatus, string> = {
  novi: 'Novi',
  potvrden: 'Potvrđen',
  dodeljen: 'Dodeljen',
  u_radu: 'U radu',
  ceka_deo: 'Čeka deo',
  ceka_dobavljaca: 'Čeka dobavljača',
  ceka_korisnika: 'Čeka korisnika',
  kontrola: 'Kontrola',
  zavrsen: 'Završen',
  otkazan: 'Otkazan',
};
const WO_STATUS_TONE: Record<WoStatus, Tone> = {
  novi: 'info',
  potvrden: 'info',
  dodeljen: 'info',
  u_radu: 'warn',
  ceka_deo: 'warn',
  ceka_dobavljaca: 'warn',
  ceka_korisnika: 'warn',
  kontrola: 'warn',
  zavrsen: 'success',
  otkazan: 'neutral',
};
export function WoStatusBadge({ status }: { status: WoStatus }) {
  return <StatusBadge tone={WO_STATUS_TONE[status] ?? 'neutral'} label={WO_STATUS_LABEL[status] ?? status} />;
}
export const WO_GROUPS: { key: WoGroup; label: string }[] = [
  { key: 'novi', label: 'Novi' },
  { key: 'u_toku', label: 'U toku' },
  { key: 'ceka', label: 'Čeka' },
  { key: 'zavrseno', label: 'Završeno' },
];
export const WO_PRIORITY_LABEL: Record<WoPriority, string> = {
  p1_zastoj: 'P1 · Zastoj',
  p2_smetnja: 'P2 · Smetnja',
  p3_manje: 'P3 · Manje',
  p4_planirano: 'P4 · Planirano',
};
const WO_PRIORITY_TONE: Record<WoPriority, Tone> = {
  p1_zastoj: 'danger',
  p2_smetnja: 'warn',
  p3_manje: 'info',
  p4_planirano: 'neutral',
};
export function WoPriorityBadge({ priority }: { priority: WoPriority }) {
  return <StatusBadge tone={WO_PRIORITY_TONE[priority] ?? 'neutral'} label={WO_PRIORITY_LABEL[priority] ?? priority} />;
}
export const WO_TYPE_LABEL: Record<string, string> = {
  kvar: 'Kvar',
  preventiva: 'Preventiva',
  preventive: 'Preventiva',
  inspekcija: 'Inspekcija',
  servis: 'Servis',
  administrativni: 'Administrativni',
  incident: 'Incident',
};

// ── Incident status / severity ─────────────────────────────────────
export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  open: 'Otvoren',
  acknowledged: 'Primljen',
  in_progress: 'U radu',
  awaiting_parts: 'Čeka delove',
  resolved: 'Rešen',
  closed: 'Zatvoren',
};
const INCIDENT_STATUS_TONE: Record<IncidentStatus, Tone> = {
  open: 'danger',
  acknowledged: 'warn',
  in_progress: 'warn',
  awaiting_parts: 'warn',
  resolved: 'success',
  closed: 'neutral',
};
export function IncidentStatusBadge({ status }: { status: IncidentStatus }) {
  return <StatusBadge tone={INCIDENT_STATUS_TONE[status] ?? 'neutral'} label={INCIDENT_STATUS_LABEL[status] ?? status} />;
}
export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  minor: 'Manji',
  major: 'Ozbiljan',
  critical: 'Kritičan',
};
const SEVERITY_TONE: Record<IncidentSeverity, Tone> = {
  minor: 'info',
  major: 'warn',
  critical: 'danger',
};
export function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <StatusBadge tone={SEVERITY_TONE[severity] ?? 'neutral'} label={SEVERITY_LABEL[severity] ?? severity} />;
}

// ── Booking / notif statusi ────────────────────────────────────────
export const BOOKING_STATUS_LABEL: Record<BookingStatus, string> = {
  planirana: 'Planirana',
  u_toku: 'U toku',
  zavrsena: 'Završena',
  otkazana: 'Otkazana',
};
const NOTIF_TONE: Record<NotifStatus, Tone> = {
  queued: 'info',
  sent: 'success',
  failed: 'danger',
  cancelled: 'neutral',
};
const NOTIF_LABEL: Record<NotifStatus, string> = {
  queued: 'U redu',
  sent: 'Poslato',
  failed: 'Greška',
  cancelled: 'Otkazano',
};
export function NotifStatusBadge({ status }: { status: NotifStatus }) {
  return <StatusBadge tone={NOTIF_TONE[status] ?? 'neutral'} label={NOTIF_LABEL[status] ?? status} />;
}

export const ASSET_TYPE_LABEL: Record<string, string> = {
  machine: 'Mašina',
  vehicle: 'Vozilo',
  it: 'IT oprema',
  facility: 'Objekat',
};

/** Rok → ton po blizini isteka (crveno isteklo, žuto uskoro, zeleno ok). */
export function deadlineTone(iso: string | null | undefined): Tone {
  if (!iso) return 'neutral';
  const days = (new Date(iso).getTime() - Date.now()) / 86_400_000;
  if (days < 0) return 'danger';
  if (days < 30) return 'warn';
  return 'success';
}

/** Mala kartica statistike (KPI) za dashboard. */
export function StatCard({ label, value, tone = 'neutral' }: { label: string; value: React.ReactNode; tone?: Tone }) {
  const ring: Record<Tone, string> = {
    success: 'text-status-success',
    info: 'text-status-info',
    warn: 'text-status-warn',
    danger: 'text-status-danger',
    neutral: 'text-ink',
  };
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className={`tnums text-2xl font-semibold ${ring[tone]}`}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-ink-secondary">{label}</div>
    </div>
  );
}

/** Red „ključ: vrednost" u kartonima. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs uppercase tracking-wider text-ink-secondary">{label}</span>
      <span className="text-sm text-ink">{children ?? '—'}</span>
    </div>
  );
}
