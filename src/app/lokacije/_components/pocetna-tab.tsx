'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, MapPin, ScanLine, Tag } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { Can, useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  useAllLocations,
  useLocations,
  useLocationsSummary,
  useMovements,
  usePlacements,
  useSyncHealth,
  useSyncStatus,
  type SyncHealthSummary,
  type SyncStatus,
} from '@/api/lokacije';
import { buildLocIndex, movementLabel, userDisplay } from './common';
import { MovementDialog, type MovementPreset } from './movement-dialog';
import { LocationFormDialog } from './location-form-dialog';
import { ScanOverlay } from './scan-overlay';

// ------------------------------------------------------------------ health banneri (paritet 1.0)

/** Pragovi zastarelosti BigTehn cache-a (paritet renderBridgeStaleBanner). */
const BRIDGE_THRESHOLDS: Record<string, number> = {
  production_work_orders: 6 * 3600_000,
  production_work_order_lines: 6 * 3600_000,
  production_tech_routing: 6 * 3600_000,
  catalog_items: 36 * 3600_000,
  production_bigtehn_drawings: 7 * 24 * 3600_000,
};
const BRIDGE_LABELS: Record<string, string> = {
  production_work_orders: 'Radni nalozi',
  production_work_order_lines: 'Linije RN',
  production_tech_routing: 'Tehnološki postupci',
  catalog_items: 'Predmeti',
  production_bigtehn_drawings: 'Crteži (PDF)',
};

function ageLabel(ms: number): string {
  const days = Math.round(ms / (24 * 3600_000));
  const hours = Math.round(ms / 3600_000);
  return days >= 1 ? `${days} dan${days === 1 ? '' : 'a'}` : `${hours} h`;
}

/** BigTehn cache zastareo (paritet renderBridgeStaleBanner). */
function bridgeStale(bridge: SyncStatus['bridge'] | undefined): string[] {
  if (!Array.isArray(bridge)) return [];
  const now = Date.now();
  const out: string[] = [];
  for (const it of bridge) {
    const limit = BRIDGE_THRESHOLDS[it.sync_job];
    if (!limit) continue;
    const t = it.last_finished ? Date.parse(it.last_finished) : NaN;
    if (!Number.isFinite(t)) continue;
    const age = now - t;
    if (age > limit) out.push(`${BRIDGE_LABELS[it.sync_job]} — poslednji sync pre ${ageLabel(age)}`);
  }
  return out;
}

interface SyncHealth {
  dead_letter_count?: number;
  workers?: { worker_id?: string; age_seconds?: number; is_alive?: boolean }[];
}

/** Sync worker down + dead-letter (paritet renderSyncWorkerBanner). */
function syncWorkerAlerts(health: unknown): { down: string[]; dead: number } {
  const h = (health && typeof health === 'object' ? health : {}) as SyncHealth;
  const dead = Number(h.dead_letter_count) || 0;
  const down = (Array.isArray(h.workers) ? h.workers : [])
    .filter((w) => w && w.is_alive === false)
    .map((w) => {
      const min = Math.round(Number(w.age_seconds) / 60);
      const ageStr = min >= 60 ? `${Math.round(min / 60)} h` : `${min} min`;
      return `${String(w.worker_id ?? 'worker')} — heartbeat pre ${ageStr}`;
    });
  return { down, dead };
}

/**
 * Labele kategorija keša za NE-admin sažetak (`sync/health.cacheStale`) — verbatim
 * 1.0 BRIDGE_LABELS (index.js:265-271). Redosled kao 1.0 (RN → linije → TP →
 * predmeti → crteži). Ne-admin nema tačnu starost (nije u health contract-u), pa
 * prikazuje samo koja kategorija je zastarela — poruka baner-a je ista.
 */
const CACHE_STALE_LABEL: [keyof SyncHealthSummary['cacheStale'], string][] = [
  ['rn', 'Radni nalozi'],
  ['linije', 'Linije RN'],
  ['tp', 'Tehnološki postupci'],
  ['predmeti', 'Predmeti'],
  ['crtezi', 'Crteži (PDF)'],
];

/** Zastareo keš → linije baner-a iz per-kategorija boolean sažetka (ne-admin). */
function cacheStaleLines(health: SyncHealthSummary | undefined): string[] {
  if (!health?.cacheStale) return [];
  return CACHE_STALE_LABEL.filter(([k]) => health.cacheStale[k] === true).map(([, label]) => `${label} — poslednji sync zastareo`);
}

function HealthBanner({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="flex gap-2.5 rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-2.5 text-sm text-ink" role="status" aria-live="polite">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-warn" aria-hidden />
      <div>
        <div className="font-semibold">{title}</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-secondary">
          {lines.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      </div>
    </div>
  );
}

/** Početna — KPI (24h/7d) + brze akcije + health banneri + poslednjih 12 pokreta. */
export function PocetnaTab({ onGoStavke, onGoLabels }: { onGoStavke: (q: string) => void; onGoLabels?: () => void }) {
  const can = useCan();
  const locs = useLocations({ active: 'true', pageSize: 1 });
  const placements = usePlacements({ pageSize: 1 });
  const recent = useMovements({ pageSize: 12 });
  const summary = useLocationsSummary();
  const locFull = useAllLocations('all');
  const locIndex = useMemo(() => buildLocIndex(locFull.data ?? []), [locFull.data]);

  // Health banneri: admin dobija PUN detalj (sync/status, sa starošću); ne-admin
  // dobija read-only sažetak (sync/health) da magacioner/cnc VIDI zastareo keš i
  // pali worker (L-06/L-07 — ranije gejtovano samo za admina).
  const isAdmin = can(PERMISSIONS.LOKACIJE_ADMIN);
  const sync = useSyncStatus(isAdmin);
  const health = useSyncHealth(!isAdmin);

  const [move, setMove] = useState<MovementPreset | null>(null);
  const [scan, setScan] = useState(false);
  const [newLoc, setNewLoc] = useState(false);

  const locTotal = locs.data?.meta.pagination.total;
  const placementTotal = placements.data?.meta.pagination.total;
  const movementsTotal = recent.data?.meta.pagination.total;

  // KPI 24h/7d iz BE summary; dok BE grane nisu spojene ruta 404 → fallback na „ukupno".
  const s = summary.data?.data;
  const kpi24h = s ? s.movements24h : movementsTotal;
  const kpi7d = s ? s.movements7d : movementsTotal;
  const kpi7dSub = s ? 'poslednjih 7 dana' : 'ukupno u bazi';
  const kpi24hSub = s ? 'poslednja 24h' : 'ukupno u bazi';

  const firstRun =
    (locTotal ?? -1) === 0 && (placementTotal ?? -1) === 0 && !locs.isLoading && !placements.isLoading;
  const showStats = !firstRun;

  // Admin → detaljne linije sa starošću (sync/status); ne-admin → sažetak (sync/health).
  const hs = health.data?.data;
  const bridgeLines = isAdmin ? bridgeStale(sync.data?.data.bridge) : cacheStaleLines(hs);
  const worker = syncWorkerAlerts(sync.data?.data.health);
  const workerLines = isAdmin
    ? [
        ...worker.down,
        ...(worker.dead > 0 ? [`DEAD_LETTER: ${worker.dead} sync događaja nije stiglo do MSSQL-a posle 10 pokušaja.`] : []),
      ]
    : hs && hs.workerHealthy === false
      ? ['Premeštanja se beleže u Supabase, ali NE idu MSSQL strani dok worker ne bude restartovan.']
      : [];

  const kpis = [
    { label: 'Aktivne lokacije', value: locTotal, sub: 'definisanih mesta' },
    { label: 'Smeštene stavke', value: placementTotal, sub: 'stavki sa lokacijom' },
    { label: 'Premeštanja danas', value: kpi24h, sub: kpi24hSub },
    { label: 'Aktivnost (7 dana)', value: kpi7d, sub: kpi7dSub },
  ];

  return (
    <div className="space-y-5">
      {/* Brze akcije */}
      <div className="flex flex-wrap gap-2">
        <Can permission={PERMISSIONS.LOKACIJE_MOVE}>
          <Button onClick={() => setMove({})}><ArrowRightLeft className="h-4 w-4" /> Brzo premeštanje</Button>
        </Can>
        <Button variant="secondary" onClick={() => setScan(true)}><ScanLine className="h-4 w-4" /> Skeniraj</Button>
        <Can permission={PERMISSIONS.LOKACIJE_MANAGE}>
          <Button variant="secondary" onClick={() => setNewLoc(true)}><MapPin className="h-4 w-4" /> Nova lokacija</Button>
        </Can>
        {onGoLabels && (
          <Can permission={PERMISSIONS.LOKACIJE_LABELS}>
            <Button variant="secondary" onClick={onGoLabels}><Tag className="h-4 w-4" /> Nalepnica</Button>
          </Can>
        )}
      </div>

      {/* Health banneri (admin) */}
      {bridgeLines.length > 0 && <HealthBanner title="BRIDGE sync upozorenje — BigTehn cache nije svež" lines={bridgeLines} />}
      {workerLines.length > 0 && <HealthBanner title="Sync worker upozorenje" lines={workerLines} />}

      {/* First-run CTA */}
      {firstRun && (
        <div className="rounded-panel border border-line bg-surface p-4" role="note">
          <div className="text-sm font-semibold text-ink">Dobrodošao u Lokacije delova</div>
          <p className="mt-1 text-sm text-ink-secondary">Baza je trenutno prazna. Da bi modul zaživeo:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-ink-secondary">
            <li>Klikni <strong className="text-ink">Nova lokacija</strong> i dodaj bar jednu master lokaciju (npr. MAG-1 — Centralni magacin).</li>
            <li>Otvori karticu <strong className="text-ink">Lokacije</strong> da pregledaš i doteraš hijerarhiju.</li>
            <li>Klikni <strong className="text-ink">Brzo premeštanje</strong> da evidentiraš prvu stavku.</li>
          </ol>
        </div>
      )}

      {showStats && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {kpis.map((k) => (
              <div key={k.label} className="rounded-panel border border-line bg-surface p-4">
                <div className="text-2xs uppercase tracking-wider text-ink-secondary">{k.label}</div>
                <div className="tnums mt-1 text-2xl font-semibold text-ink">
                  {k.value != null ? formatNumber(k.value) : '—'}
                </div>
                <div className="mt-0.5 text-2xs text-ink-disabled">{k.sub}</div>
              </div>
            ))}
          </div>

          <div className="rounded-panel border border-line bg-surface">
            <div className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">Poslednja premeštanja</div>
            {recent.isLoading ? (
              <p className="px-4 py-6 text-center text-sm text-ink-secondary">Učitavanje…</p>
            ) : (recent.data?.data.length ?? 0) === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-secondary">Nema zabeleženih pokreta. Skeniraj barkod ili klikni „Brzo premeštanje".</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {(recent.data?.data ?? []).map((m) => (
                  <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-sm">
                    <span className="w-36 shrink-0 tnums text-xs text-ink-secondary">{formatDateTime(m.movedAt)}</span>
                    <span className="w-36 shrink-0 truncate">{movementLabel(m.movementType)}</span>
                    <button className="truncate text-left text-accent hover:underline" onClick={() => onGoStavke(m.itemRefId)}>
                      {m.orderNo ? `${m.orderNo} · ` : ''}{m.itemRefId}
                    </button>
                    <span className="shrink-0 text-xs text-ink-secondary">
                      {locIndex.labelOf(m.fromLocationId)} → {locIndex.labelOf(m.toLocationId)}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-ink-disabled" title={m.movedBy}>
                      {userDisplay(m.movedByName, m.movedBy)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {move && <MovementDialog preset={move} onClose={() => setMove(null)} />}
      {newLoc && <LocationFormDialog edit={null} onClose={() => setNewLoc(false)} />}
      {scan && (
        <ScanOverlay
          title="Skeniraj"
          accept={['ITEM', 'SHELF']}
          onResult={(r) => {
            if (r.kind === 'ITEM') onGoStavke(r.parsed.itemRefId);
          }}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}
