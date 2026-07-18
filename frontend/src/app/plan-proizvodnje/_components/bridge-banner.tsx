'use client';

import { AlertTriangle } from 'lucide-react';
import { useBridgeStatus } from '@/api/plan-proizvodnje';

const JOB_LABEL: Record<string, string> = {
  production_work_orders: 'RN',
  production_work_order_lines: 'Linije (TP)',
  production_tech_routing: 'Prijave',
};

const WARN_MS = 30 * 60 * 1000; // 30 min
const CRITICAL_MS = 2 * 60 * 60 * 1000; // 2 h

/**
 * Bridge sync banner sa pragovima ZASTARELOSTI (GAP-PM-11) — DOSLOVNI port 1.0
 * renderPpBridgeBanner (planProizvodnje/index.js:257): reaguje na STAROST poslednjeg
 * sync-a, ne na status polje. <30 min = SKRIVEN; 30 min–2 h = žuti „⚠ Bridge sync kasni";
 * >2 h = crveni „🔴 Bridge sync NE RADI — spremnost crteža i status u radu možda nisu
 * tačni". Starost formatirana „pre N min/h"; fail-silent (nema redova → null).
 */
export function BridgeBanner() {
  const q = useBridgeStatus();
  const rows = q.data?.data ?? [];
  if (!rows.length) return null;

  const now = Date.now();
  let worstAge = 0;
  const staleParts: { label: string; ageStr: string }[] = [];

  for (const it of rows) {
    const t = it.last_finished ? Date.parse(it.last_finished) : NaN;
    if (!Number.isFinite(t)) continue;
    const ageMs = now - t;
    if (ageMs <= WARN_MS) continue;
    worstAge = Math.max(worstAge, ageMs);
    const min = Math.round(ageMs / 60000);
    const hours = Math.round(ageMs / 3600000);
    const ageStr = min < 120 ? `${min} min` : `${hours} h`;
    staleParts.push({ label: JOB_LABEL[it.sync_job] ?? it.sync_job, ageStr });
  }

  // Sve sveže → banner skriven (paritet 1.0: <30 min = nema bannera).
  if (staleParts.length === 0) return null;

  const isCritical = worstAge > CRITICAL_MS;

  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-panel border px-3 py-2 text-xs ${
        isCritical
          ? 'border-status-danger/50 bg-status-danger-bg text-status-danger'
          : 'border-status-warn/40 bg-status-warn-bg text-status-warn'
      }`}
      role="status"
    >
      <span aria-hidden>{isCritical ? '🔴' : <AlertTriangle className="inline h-4 w-4" />}</span>
      <span className="font-semibold">Bridge sync {isCritical ? 'NE RADI' : 'kasni'}:</span>
      <span>
        {staleParts.map((p, i) => (
          <span key={p.label}>
            {i > 0 ? ' · ' : ''}
            <strong>{p.label}</strong> · pre {p.ageStr}
          </span>
        ))}
        .{' '}
        {isCritical ? 'Spremnost crteža i status u radu možda nisu tačni.' : 'Podaci možda nisu sveži.'}
      </span>
    </div>
  );
}
