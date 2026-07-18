'use client';

// Tab „Izveštaji" (K3): agregati neusaglašenosti — broj izveštaja, komada i sati
// po izabranoj osi grupisanja. Bez chart biblioteke (tvrdo pravilo): 4 stat
// kartice + tabela sa horizontalnom CSS bar trakom u koloni „Komada". Izvor su
// NonconformityReport-i (§6 spec) — GET /v1/kvalitet/summary.

import { useState, type ReactNode } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDecimal, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';
import {
  NONCONFORMITY_TYPE,
  useQualitySummary,
  type NonconformityType,
  type QualityGroupBy,
  type QualitySummaryRow,
} from '@/api/kvalitet';

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

const GROUP_BY: { key: QualityGroupBy; label: string }[] = [
  { key: 'month', label: 'Mesec' },
  { key: 'day', label: 'Dan' },
  { key: 'week', label: 'Nedelja' },
  { key: 'year', label: 'Godina' },
  { key: 'worker', label: 'Radnik' },
  { key: 'workUnit', label: 'Radna jedinica' },
  { key: 'cause', label: 'Uzrok' },
  { key: 'customer', label: 'Kupac' },
];

/** '' = svi tipovi; inače škart / dorada. */
type TypeFilter = '' | '1' | '2';

function typeParam(t: TypeFilter): NonconformityType | undefined {
  if (t === '1') return NONCONFORMITY_TYPE.REWORK;
  if (t === '2') return NONCONFORMITY_TYPE.SCRAP;
  return undefined;
}

/** Mala KPI kartica (isti obrazac kao održavanje `StatCard`). */
function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'info' | 'warn' | 'accent';
}) {
  const color =
    tone === 'info'
      ? 'text-status-info'
      : tone === 'warn'
        ? 'text-status-warn'
        : tone === 'accent'
          ? 'text-accent'
          : 'text-ink';
  return (
    <div className="rounded-panel border border-line bg-surface p-4">
      <div className={cn('tnums text-2xl font-semibold', color)}>{value}</div>
      <div className="mt-1 text-xs uppercase tracking-wider text-ink-secondary">{label}</div>
    </div>
  );
}

export function IzvestajiTab() {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [type, setType] = useState<TypeFilter>('');
  const [groupBy, setGroupBy] = useState<QualityGroupBy>('month');

  const summary = useQualitySummary({
    type: typeParam(type),
    from: from || undefined,
    to: to || undefined,
    groupBy,
  });

  const rows = summary.data?.data ?? [];
  const draftCount = summary.data?.meta.draftCount ?? 0;

  // Kartice čitaju serverski negrupisan zbir — klijentska redukcija redova bi se
  // naduvala kod grupisanja po radniku (izveštaj se pripisuje SVAKOM krivcu).
  const totals = summary.data?.meta.totals ?? { count: 0, pieces: 0, hours: 0 };
  const maxPieces = Math.max(1, ...rows.map((r) => r.pieces));

  const columns: Column<QualitySummaryRow>[] = [
    { key: 'label', header: 'Grupa', render: (r) => <span className="text-ink">{r.label}</span> },
    {
      key: 'count',
      header: 'Broj neusaglašenosti',
      align: 'right',
      numeric: true,
      render: (r) => formatNumber(r.count),
    },
    {
      key: 'pieces',
      header: 'Komada',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="tnums w-16 shrink-0 text-right">{formatNumber(r.pieces)}</span>
          <div className="h-1.5 min-w-[3rem] flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent/60"
              style={{ width: `${(r.pieces / maxPieces) * 100}%` }}
            />
          </div>
        </div>
      ),
    },
    {
      key: 'hours',
      header: 'Utrošeno sati',
      align: 'right',
      numeric: true,
      render: (r) => `${formatDecimal(r.hours, 2)} h`,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-ink">
          Izveštaj o broju neusaglašenosti
        </h2>
        {type === '' && (
          <p className="text-xs text-ink-secondary">Uključuje škart i doradu</p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period od
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Period do
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Tip
          <select
            value={type}
            onChange={(e) => setType(e.target.value as TypeFilter)}
            className={filterInput}
          >
            <option value="">Svi</option>
            <option value="2">Škart</option>
            <option value="1">Dorada</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Grupisanje
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as QualityGroupBy)}
            className={filterInput}
          >
            {GROUP_BY.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {summary.error && (
        <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(summary.error as Error).message}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Broj neusaglašenosti" value={formatNumber(totals.count)} />
        <StatCard label="Komada" value={formatNumber(totals.pieces)} tone="accent" />
        <StatCard label="Utrošeno sati" value={`${formatDecimal(totals.hours, 2)} h`} tone="info" />
        <StatCard label="Nacrta na čekanju" value={formatNumber(draftCount)} tone="warn" />
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.key}
        loading={summary.isLoading}
        empty={
          <EmptyState
            title="Nema podataka za prikaz"
            hint="Promeni period, tip ili osu grupisanja."
          />
        }
      />
    </div>
  );
}
