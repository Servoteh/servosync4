import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import {
  HALL_TYPES,
  LOC_TYPE_LABEL,
  MOVEMENT_TYPE_LABEL,
  SHELF_TYPES,
  type LocLocation,
} from '@/api/lokacije';

/** Greška vs prazno (isti obrazac kao Reversi `tableEmpty`). */
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

const PLACEMENT_STATUS: Record<string, { tone: Tone; label: string }> = {
  ACTIVE: { tone: 'success', label: 'Aktivno' },
  IN_TRANSIT: { tone: 'info', label: 'U tranzitu' },
  PENDING_CONFIRMATION: { tone: 'warn', label: 'Čeka potvrdu' },
  UNKNOWN: { tone: 'neutral', label: 'Nepoznato' },
};

export function PlacementStatusBadge({ status }: { status: string }) {
  const s = PLACEMENT_STATUS[status] ?? { tone: 'neutral' as Tone, label: status };
  return <StatusBadge tone={s.tone} label={s.label} />;
}

const LOC_TYPE_TONE: Record<string, Tone> = {
  MACHINE: 'info',
  CAGE: 'warn',
  SCRAPPED: 'danger',
};

/** Tip lokacije → pilula (magacin/polica/mašina/kavez…). */
export function LocTypeBadge({ type }: { type: string }) {
  return (
    <StatusBadge tone={LOC_TYPE_TONE[type] ?? 'neutral'} label={LOC_TYPE_LABEL[type] ?? type} />
  );
}

export function movementLabel(type: string): string {
  return MOVEMENT_TYPE_LABEL[type] ?? type;
}

// ------------------------------------------------------------------ CSV

/** ISO timestamp → „YYYY-MM-DD HH:MM:SS" za CSV ćelije (paritet 1.0 exporta). */
export function csvTimestamp(iso: string | null | undefined): string {
  return String(iso ?? '').replace('T', ' ').slice(0, 19);
}

/**
 * Ime CSV fajla sa timestampom (paritet 1.0: `<prefix>_YYYY-MM-DD_HHMM[_search].csv`).
 * @param prefix npr. `lokacije_pregled_po_lokacijama`
 * @param search opciono — sanitizovan sufiks iz pretrage (Stavke)
 */
export function buildCsvFilename(prefix: string, search?: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const q = (search ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 32);
  return `${prefix}_${ts}${q ? `_${q}` : ''}.csv`;
}

/** Preuzmi CSV (BOM + ; separator — paritet 1.0 izveštaja za Excel/sr-RS). */
export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const esc = (v: string | number | null | undefined) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------ location index

export interface LocIndex {
  byId: Map<string, LocLocation>;
  /** Najbliži predak tipa HALA (WAREHOUSE/PRODUCTION/ASSEMBLY/FIELD/TEMP). */
  hallOf: (id: string | null | undefined) => LocLocation | null;
  /** Čitljiva putanja „Hala / Polica" za lokaciju. */
  labelOf: (id: string | null | undefined) => string;
}

const HALL_SET = new Set(['WAREHOUSE', 'PRODUCTION', 'ASSEMBLY', 'FIELD', 'TEMP']);

export function buildLocIndex(locs: LocLocation[]): LocIndex {
  const byId = new Map(locs.map((l) => [l.id, l]));
  const hallOf = (id: string | null | undefined): LocLocation | null => {
    let cur = id ? byId.get(id) : undefined;
    const seen = new Set<string>();
    for (let i = 0; i < 64 && cur; i++) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      if (HALL_SET.has(cur.locationType)) return cur;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return null;
  };
  const labelOf = (id: string | null | undefined): string => {
    if (!id) return '—';
    const loc = byId.get(id);
    if (!loc) return id.slice(0, 8);
    const hall = hallOf(id);
    if (hall && hall.id !== loc.id) return `${hall.locationCode} / ${loc.locationCode}`;
    return loc.locationCode;
  };
  return { byId, hallOf, labelOf };
}

// ------------------------------------------------------------------ „Korisnik" prikaz

/**
 * „Korisnik" prikaz (paritet 1.0 kolone): prvo ime iz BE `*_name` polja
 * (`movedByName` / `actor_name` — grana fix/locations-energetika), fallback na
 * skraćeni UUID (prvih 8 znakova + …). Dok BE grane nisu spojene, ime je
 * null/undefined pa se pada na UUID → zero-loss, bez praznih ćelija.
 */
export function userDisplay(name: string | null | undefined, uid: string | null | undefined): string {
  const n = String(name ?? '').trim();
  if (n) return n;
  const id = String(uid ?? '').trim();
  return id ? `${id.slice(0, 8)}…` : '—';
}

// ------------------------------------------------------------------ rows-per-page

/** Ponuđene veličine strane (paritet 1.0 „Po stranici" — 25/50/100/250). */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;

/** Izbor broja redova po strani (report / istorija / stavke). */
export function PageSizeSelect({
  value,
  onChange,
  className = '',
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-1.5 text-xs text-ink-secondary ${className}`}>
      <span className="whitespace-nowrap">Po strani</span>
      <select
        className="h-8 rounded-control border border-line bg-surface px-2 text-xs text-ink outline-none focus:border-accent"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Broj redova po strani"
      >
        {PAGE_SIZE_OPTIONS.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

// ------------------------------------------------------------------ klasifikacija lokacija (paritet lib/lokacijeTypes.js)

const HALL_KIND_SET = new Set<string>(HALL_TYPES);
const SHELF_KIND_SET = new Set<string>(SHELF_TYPES);

export type LocKind = 'hall' | 'shelf' | 'cage' | 'machine' | 'other';

function normType(t: string | null | undefined): string {
  return String(t ?? '').trim().toUpperCase();
}

/** Globalna šifra kaveza „KV N" (npr. „KV 7") — paritet 1.0 isKvLocationCode. */
export function isKvLocationCode(code: string | null | undefined): boolean {
  return /^KV \d+$/i.test(String(code ?? '').trim());
}

/** Enum → poslovni „kind" (hall/shelf/cage/machine/other) — paritet getLocationKind. */
export function locationKind(type: string | null | undefined): LocKind {
  const t = normType(type);
  if (HALL_KIND_SET.has(t)) return 'hall';
  if (SHELF_KIND_SET.has(t)) return 'shelf';
  if (t === 'CAGE') return 'cage';
  if (t === 'MACHINE') return 'machine';
  return 'other';
}

/** Kavez u podacima = tip CAGE ILI legacy red sa „KV N" šifrom (paritet isCageLocation). */
export function isCageLoc(loc: Pick<LocLocation, 'locationType' | 'locationCode'>): boolean {
  return normType(loc.locationType) === 'CAGE' || isKvLocationCode(loc.locationCode);
}

/** Poslovni „kind" reda — koristi KV šifru, ne samo enum (paritet getLocationKindFromLoc). */
export function locationKindFromLoc(loc: Pick<LocLocation, 'locationType' | 'locationCode'>): LocKind {
  if (isCageLoc(loc)) return 'cage';
  return locationKind(loc.locationType);
}

/** „kind" → labela (HALA/POLICA/KAVEZ/MAŠINA/OSTALO) — paritet getLocationKindLabel. */
export function locationKindLabel(type: string | null | undefined): string {
  const k = locationKind(type);
  return k === 'hall' ? 'HALA' : k === 'shelf' ? 'POLICA' : k === 'cage' ? 'KAVEZ' : k === 'machine' ? 'MAŠINA' : 'OSTALO';
}

// ------------------------------------------------------------------ prirodni sort (paritet lib/lokacijeSort.js)

/** A-Z natural sort po `locationCode` („A.10" posle „A.9"; locale sr, numeric). */
export function compareLocationCodeNatural(a: LocLocation, b: LocLocation): number {
  return String(a.locationCode ?? '').localeCompare(String(b.locationCode ?? ''), 'sr', {
    numeric: true,
    sensitivity: 'base',
  });
}

function cageCodeNumber(code: string | null | undefined): number {
  const m = String(code ?? '').trim().match(/^KV (\d+)$/i);
  return m ? Number(m[1]) : Number.NaN;
}

/** „KV 1"…„KV 12" po broju, ne leksikografski (paritet compareCageCode). */
export function compareCageCode(a: LocLocation, b: LocLocation): number {
  const na = cageCodeNumber(a.locationCode);
  const nb = cageCodeNumber(b.locationCode);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return compareLocationCodeNatural(a, b);
}
