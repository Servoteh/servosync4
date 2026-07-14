import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import {
  LOC_TYPE_LABEL,
  MOVEMENT_TYPE_LABEL,
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
