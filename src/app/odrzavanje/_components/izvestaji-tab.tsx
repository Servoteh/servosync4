'use client';

import { useState } from 'react';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber } from '@/lib/format';
import { useReportAttention, useReportIncidents, useReportWorkOrders } from '@/api/odrzavanje';
import { deadlineTone, f, SEVERITY_LABEL, StatCard, WO_TYPE_LABEL } from './common';

const PERIODS = [
  { key: '30', label: '30 dana' },
  { key: '90', label: '90 dana' },
  { key: '365', label: '365 dana' },
  { key: 'all', label: 'Sve' },
];

/** Izveštaji: incidenti (severity/status/downtime), WO troškovi, pažnja. */
export function IzvestajiTab() {
  const [period, setPeriod] = useState('30');
  const incidents = useReportIncidents(period);
  const wos = useReportWorkOrders(period);
  const attention = useReportAttention();

  const inc = incidents.data?.data;
  const wo = wos.data?.data;
  const att = attention.data?.data;

  return (
    <div className="space-y-6">
      <div className="flex gap-1 rounded-panel border border-line bg-surface p-1">
        {PERIODS.map((p) => (
          <button key={p.key} onClick={() => setPeriod(p.key)} className={`rounded-control px-3 py-1.5 text-sm font-medium ${period === p.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2'}`}>{p.label}</button>
        ))}
      </div>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Kvarovi</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Ukupno kvarova" value={inc?.total ?? '—'} tone="info" />
          <StatCard label="Zastoj (min)" value={inc ? formatNumber(inc.downtimeMinutes) : '—'} tone="warn" />
          <StatCard label="Kritični" value={inc?.bySeverity?.critical ?? 0} tone="danger" />
          <StatCard label="Otvoreni" value={inc?.byStatus?.open ?? 0} tone="warn" />
        </div>
        {inc && (
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(inc.bySeverity).map(([k, v]) => (
              <span key={k} className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary">{SEVERITY_LABEL[k as never] ?? k}: <span className="tnums font-medium text-ink">{v}</span></span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Troškovi radnih naloga</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Radnih naloga" value={wo?.totalWorkOrders ?? '—'} />
          <StatCard label="Delovi (RSD)" value={wo ? formatNumber(Math.round(wo.partsCost)) : '—'} tone="info" />
          <StatCard label="Rad (min)" value={wo ? formatNumber(wo.laborMinutes) : '—'} tone="info" />
          <StatCard label="Vrste" value={wo ? Object.keys(wo.byType).length : '—'} />
        </div>
        {wo && Object.keys(wo.byType).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(wo.byType).map(([k, v]) => (
              <span key={k} className="rounded-control border border-line px-2 py-1 text-xs text-ink-secondary">{WO_TYPE_LABEL[k] ?? k}: <span className="tnums font-medium text-ink">{v}</span></span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Zahteva pažnju</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <AttentionCard title="IT oprema" rows={att?.itAssets ?? []} dateKeys={['license_expires_at', 'warranty_expires_at']} />
          <AttentionCard title="Objekti" rows={att?.facilities ?? []} dateKeys={['inspection_due_at', 'fire_safety_due_at']} />
        </div>
      </section>
    </div>
  );
}

function AttentionCard({ title, rows, dateKeys }: { title: string; rows: Record<string, unknown>[]; dateKeys: string[] }) {
  const flagged = rows.filter((r) => dateKeys.some((k) => f(r, k)));
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <h3 className="mb-1.5 text-sm font-semibold text-ink">{title} <span className="text-ink-secondary">({flagged.length})</span></h3>
      {flagged.length === 0 ? <p className="text-sm text-ink-secondary">—</p> : flagged.slice(0, 15).map((r, i) => {
        const date = f(r, ...dateKeys);
        return (
          <div key={i} className="flex items-center justify-between border-b border-line-soft py-1 text-sm">
            <span className="text-ink">{f(r, 'name', 'asset_code') ?? '—'}</span>
            {date && <StatusBadge tone={deadlineTone(date)} label={date.slice(0, 10)} />}
          </div>
        );
      })}
    </div>
  );
}
