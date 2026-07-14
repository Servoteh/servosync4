'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useBridgeStatus } from '@/api/plan-proizvodnje';
import { formatDateTime } from '@/lib/format';

const JOB_LABEL: Record<string, string> = {
  production_work_orders: 'RN',
  production_work_order_lines: 'Linije (TP)',
  production_tech_routing: 'Prijave',
};

/** Bridge sync banner — poslednji status 3 job-а (bridge_sync_log). Upozori ako je nešto zastarelo/palo. */
export function BridgeBanner() {
  const q = useBridgeStatus();
  const rows = q.data?.data ?? [];
  if (!rows.length) return null;
  const stale = rows.some((r) => r.status && r.status !== 'success');
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-panel border px-3 py-2 text-xs ${
        stale ? 'border-status-warn/40 bg-status-warn-bg text-status-warn' : 'border-line bg-surface-2 text-ink-secondary'
      }`}
    >
      {stale ? <AlertTriangle className="h-4 w-4" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
      <span className="font-medium">Bridge sync:</span>
      {rows.map((r) => (
        <span key={r.sync_job}>
          {JOB_LABEL[r.sync_job] ?? r.sync_job}: {r.status ?? '?'}
          {r.last_finished ? ` (${formatDateTime(r.last_finished)})` : ''}
        </span>
      ))}
    </div>
  );
}
