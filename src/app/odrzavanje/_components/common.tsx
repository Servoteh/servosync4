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

/** Preset filtera operativne liste mašina kad dolazimo sa klik-KPI dashboarda. */
export interface MachineListFilter {
  status?: 'running' | 'degraded' | 'down' | 'maintenance';
  deadline?: 'overdue' | 'danas' | '7d';
  inc?: boolean;
}

/** Ciljni tab dashboard-navigacije (podskup TabKey iz page.tsx). */
export type DashNavTab =
  | 'masine' | 'nalozi' | 'izvestaji' | 'zalihe' | 'preventiva' | 'kalendar'
  | 'vozila' | 'vozaci' | 'it' | 'objekti' | 'board';

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
// Labele = 1.0 kanon (maintFormatters.js STATUS_LABELS): Radi/Smetnje/Zastoj/Održavanje.
const OP: Record<OpStatus, { tone: Tone; label: string }> = {
  running: { tone: 'success', label: 'Radi' },
  degraded: { tone: 'warn', label: 'Smetnje' },
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

// ── Vozila domen (labele = 1.0 kanon) ──────────────────────────────
export const VEHICLE_KIND_LABEL: Record<string, string> = {
  teretno: 'Teretno',
  putnicko: 'Putničko',
  kombi: 'Kombi',
  radno: 'Radno',
  prikolica: 'Prikolica',
};
export const USAGE_LABEL: Record<string, string> = {
  posao: 'Posao',
  posao_kuca: 'Posao-kuća',
  licne_potrebe: 'Lič. potrebe',
};
export const OWNER_TYPE_LABEL: Record<string, string> = {
  firma: 'Firma',
  leasing: 'Leasing',
  zaposleni: 'Zaposleni',
  spoljni: 'Spoljni',
};
export const GPS_PROVIDER_LABEL: Record<string, string> = {
  nema: 'Nema',
  smartivo: 'Smartivo',
  drugi: 'Drugi',
};
export const TIRE_SEASON_LABEL: Record<string, string> = {
  summer: 'Letnje',
  winter: 'Zimske',
  all_season: 'Celogodišnje',
};
export const TIRE_STATUS_LABEL: Record<string, string> = {
  nove: 'Nove',
  koriscene: 'Korišćene',
  dotrajale: 'Dotrajale',
  bacene: 'Bačene',
};
export const VEHICLE_SVC_CATEGORY_LABEL: Record<string, string> = {
  mali: 'Mali servis',
  veliki: 'Veliki servis',
  kocnice: 'Kočnice',
  elektrika: 'Elektrika',
  oslanjanje: 'Oslanjanje',
  motor_transmisija: 'Motor / transmisija',
  karoserija: 'Karoserija',
  odluka_zamene: 'Odluka o zameni',
  ostalo: 'Ostalo',
};
/** Polica rezervnih delova vozila — fiksni enum V1–V6 / U1–U6 (skriveno pravilo). */
export const SHELF_OPTIONS = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'U1', 'U2', 'U3', 'U4', 'U5', 'U6'];
/** Kategorije vozačke dozvole (1.0 LICENSE_CATEGORIES). */
export const LICENSE_CATEGORIES = ['AM', 'A1', 'A2', 'A', 'B1', 'B', 'BE', 'C1', 'C', 'CE', 'D1', 'D', 'DE', 'F', 'M', 'T'];

/**
 * Token-normalizacija imena za auto-detect vozač↔zaposleni. MORA da prati SQL
 * `maint_normalize_name` (lowercase, dj→d, skinute kvačice č/ć/ž/š/đ) — inače match tiho ne radi.
 */
export function normNameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  const norm = String(s).toLowerCase().trim()
    .replace(/dj/g, 'd')
    .replace(/č/g, 'c').replace(/ć/g, 'c').replace(/ž/g, 'z').replace(/š/g, 's').replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
  return [...new Set(norm.split(' ').filter(Boolean))].sort();
}
export function tokensEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x === b[i]);
}

/** ISO datum (YYYY-MM-DD) iz <input type=date>; prazno → null. */
export function dateInputToIso(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
/** ISO/date → vrednost za <input type=date> (YYYY-MM-DD). */
export function isoToDateInput(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v).slice(0, 10);
}
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

// ── IT oprema / objekti domen (labele = 1.0 kanon) ─────────────────
/** Predlozi za tip uređaja (1.0 DEVICE_TYPE_SUGGESTIONS, maintItAssetsPanel.js:24). */
export const DEVICE_TYPE_SUGGESTIONS = [
  'laptop', 'desktop', 'server', 'printer', 'switch', 'router', 'access point',
  'UPS', 'monitor', 'telefon', 'tablet', 'NAS', 'firewall',
];
/** Fallback lista tipova objekata kad lookup padne (1.0 FACILITY_TYPE_SUGGESTIONS). */
export const FACILITY_TYPE_SUGGESTIONS = [
  'hala', 'zgrada', 'instalacija', 'HVAC', 'elektro orman', 'kompresorska',
  'kotlovnica', 'magacin', 'rampe', 'lift', 'PP instalacija', 'solarni sistem',
];
/** Tipovi objekata za koje se skrivaju proizvođač/model/serijski (skriveno pravilo). */
export const FACILITY_TYPES_HIDE_TECH = new Set(['hala', 'zgrada', 'magacin', 'ostalo_objekat']);
export const CRITICALITY_LABEL: Record<string, string> = {
  low: 'Niska',
  medium: 'Srednja',
  high: 'Visoka',
  critical: 'Kritična',
};
export function criticalityTone(v: string | null | undefined): Tone {
  if (v === 'critical') return 'danger';
  if (v === 'high') return 'warn';
  if (v === 'medium') return 'info';
  if (v === 'low') return 'success';
  return 'neutral';
}

/** Broj dana do datuma (YYYY-MM-DD/ISO) u odnosu na danas (ponoć). null = bez datuma. */
export function daysUntil(v: unknown): number | null {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(d.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}
/** Rok kao kratka srpska labela (1.0 dueLabel): „kasni X d" / „danas" / „sutra" / „za X d". */
export function dueDaysLabel(v: unknown): string {
  const days = daysUntil(v);
  if (days === null) return '—';
  if (days < 0) return `kasni ${-days} d`;
  if (days === 0) return 'danas';
  if (days === 1) return 'sutra';
  return `za ${days} d`;
}

// ── Ozbiljnost preventivnog šablona (normal/important/critical) ─────
// Labele = 1.0 kanon (maintPreventivePanel.js:59-69): Kritično / Važno / Normalno.
export const PREV_SEVERITY_LABEL: Record<string, string> = {
  critical: 'Kritično',
  important: 'Važno',
  normal: 'Normalno',
};
export function prevSeverityTone(v: string | null | undefined): Tone {
  if (v === 'critical') return 'danger';
  if (v === 'important') return 'warn';
  return 'neutral';
}
/** Boja stavke preventive u kalendaru po ozbiljnosti (border+tekst tokeni, dark-safe). */
export function prevSeverityCalClasses(v: string | null | undefined): string {
  if (v === 'critical') return 'border-status-danger/50 text-status-danger';
  if (v === 'important') return 'border-status-warn/50 text-status-warn';
  return 'border-line text-ink-secondary';
}

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

/** Klikabilna KPI kartica (dashboard) — nav sa filterom. `value===null` = nepoznato („—"). */
export function KpiButton({
  label,
  value,
  tone = 'neutral',
  title,
  onClick,
}: {
  label: string;
  value: number | null;
  tone?: Tone;
  title?: string;
  onClick?: () => void;
}) {
  const unknown = value === null || value === undefined;
  const zero = !unknown && !value;
  const ring: Record<Tone, string> = {
    success: 'text-status-success',
    info: 'text-status-info',
    warn: 'text-status-warn',
    danger: 'text-status-danger',
    neutral: 'text-ink',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`${label}: ${unknown ? 'nepoznato' : value}`}
      className="rounded-panel border border-line bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <div className={`tnums text-2xl font-semibold ${zero || unknown ? 'text-ink-disabled' : ring[tone]}`}>
        {unknown ? '—' : value}
      </div>
      <div className="mt-1 text-xs uppercase tracking-wider text-ink-secondary">{label}</div>
    </button>
  );
}

/** Kategorija-tile (dashboard) — ukupno + „zahtevaju pažnju" linija + extra metrika. */
export function CategoryTile({
  icon,
  label,
  total,
  attention,
  extra,
  onClick,
}: {
  icon: string;
  label: string;
  total: number | null;
  attention: number | null;
  extra?: { txt: string; sev: 'down' | 'warn' | 'muted' }[];
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Otvori ${label}`}
      className="flex flex-col gap-1 rounded-panel border border-line bg-surface p-4 text-left transition-colors hover:border-accent/50 hover:bg-surface-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-lg" aria-hidden>{icon}</span>
        <span className="text-sm font-medium text-ink">{label}</span>
      </div>
      <div className="tnums text-2xl font-semibold text-ink">{total ?? '—'}</div>
      <div className="text-xs">
        {attention === null || attention === undefined ? (
          <span className="text-ink-secondary">—</span>
        ) : attention > 0 ? (
          <span className="text-status-warn">⚠ {attention} {attention === 1 ? 'zahteva pažnju' : 'zahtevaju pažnju'}</span>
        ) : (
          <span className="text-status-success">✓ Sve u redu</span>
        )}
      </div>
      {extra && extra.length > 0 && (
        <div className="space-y-0.5 text-2xs">
          {extra.map((e, i) => (
            <div key={i} className={e.sev === 'down' ? 'text-status-danger' : e.sev === 'warn' ? 'text-status-warn' : 'text-ink-secondary'}>{e.txt}</div>
          ))}
        </div>
      )}
      <span className="mt-1 text-2xs text-accent">Otvori →</span>
    </button>
  );
}

/** Kratki relativni datum (sr): „danas", „za 3 d", „pre 2 d", „—". */
export function relDays(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const d = Math.round((t - Date.now()) / 86_400_000);
  if (d === 0) return 'danas';
  if (d === 1) return 'sutra';
  if (d === -1) return 'juče';
  if (d < 0) return `pre ${-d} d`;
  return `za ${d} d`;
}

/**
 * Prioritet-rang mašine (operativni sort) — manji = hitnije (paritet 1.0
 * priorityDescriptor, index.js:120-168): 0 Zastoj (down ili otvoreni kvar),
 * 1 Smetnje, 2 Održavanje, 3 Kasni rok, 4 Danas, 5 ≤7d, 6 Radi, 9 Arhivirano.
 */
export function machinePriorityRank(info: {
  status: string | null;
  openInc: number;
  overdue: number;
  nextDueAt: string | null;
  archived: boolean;
}): number {
  if (info.archived) return 9;
  if (info.status === 'down' || info.openInc > 0) return 0;
  if (info.status === 'degraded') return 1;
  if (info.status === 'maintenance') return 2;
  if (info.overdue > 0) return 3;
  if (info.nextDueAt) {
    const t = new Date(info.nextDueAt).getTime();
    if (Number.isFinite(t)) {
      const now = Date.now();
      const eod = new Date(); eod.setHours(23, 59, 59, 999);
      if (t <= eod.getTime()) return 4;
      if ((t - now) / 86_400_000 <= 7) return 5;
    }
  }
  return 6;
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
