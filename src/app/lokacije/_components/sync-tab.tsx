'use client';

import { useState } from 'react';
import { Play, Power } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';
import { useSyncArm, useSyncOutbound, useSyncRunNow, useSyncStatus } from '@/api/lokacije';

/** Sync tab (admin) — ingest status/health/heartbeat + arm/run-now + outbound queue. */
export function SyncTab() {
  const status = useSyncStatus();
  const outbound = useSyncOutbound(80);
  const arm = useSyncArm();
  const runNow = useSyncRunNow();
  const [msg, setMsg] = useState<string | null>(null);

  const data = status.data?.data;
  const ingest = (data?.ingest ?? {}) as Record<string, unknown>;
  const armed = ingest.armed === true || ingest.is_armed === true;

  async function doArm(next: boolean) {
    setMsg(null);
    try {
      await arm.mutateAsync(next);
      setMsg(next ? 'Ingest worker armiran.' : 'Ingest worker deaktiviran.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Greška.');
    }
  }

  async function doRun() {
    setMsg(null);
    try {
      await runNow.mutateAsync();
      setMsg('Ručno okidanje ingest-a poslato.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Greška.');
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-panel border border-line bg-surface p-3">
        <span className="text-sm text-ink">Ingest worker:</span>
        <StatusBadge tone={armed ? 'success' : 'neutral'} label={armed ? 'Armiran' : 'Neaktivan'} />
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" loading={arm.isPending} onClick={() => void doArm(!armed)}>
            <Power className="h-4 w-4" /> {armed ? 'Deaktiviraj' : 'Armiraj'}
          </Button>
          <Button loading={runNow.isPending} onClick={() => void doRun()}>
            <Play className="h-4 w-4" /> Okini sada
          </Button>
        </div>
      </div>
      {msg && <p className="text-sm text-ink-secondary">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Ingest status">
          <pre className="max-h-64 overflow-auto text-xs text-ink-secondary">{JSON.stringify(data?.ingest ?? {}, null, 2)}</pre>
        </Panel>
        <Panel title="Health">
          <pre className="max-h-64 overflow-auto text-xs text-ink-secondary">{JSON.stringify(data?.health ?? {}, null, 2)}</pre>
        </Panel>
      </div>

      <Panel title="Poslednji bridge sync (po jobu)">
        {(data?.bridge ?? []).length === 0 ? (
          <p className="text-sm text-ink-secondary">Nema zapisa.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="py-1.5">Job</th>
                <th>Status</th>
                <th>Poslednji završetak</th>
              </tr>
            </thead>
            <tbody>
              {(data?.bridge ?? []).map((b) => (
                <tr key={b.sync_job} className="border-b border-line-soft">
                  <td className="py-1.5">{b.sync_job}</td>
                  <td><StatusBadge status={b.status ?? 'unknown'} /></td>
                  <td className="tnums text-ink-secondary">{formatDateTime(b.last_finished)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Outbound queue (MSSQL write-back) — ${outbound.data?.data.length ?? 0}`}>
        {outbound.isLoading ? (
          <p className="text-sm text-ink-secondary">Učitavanje…</p>
        ) : (outbound.data?.data.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-secondary">Queue je prazan.</p>
        ) : (
          <pre className="max-h-72 overflow-auto text-xs text-ink-secondary">{JSON.stringify(outbound.data?.data ?? [], null, 2)}</pre>
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <div className="mb-2 text-sm font-semibold text-ink">{title}</div>
      {children}
    </div>
  );
}
