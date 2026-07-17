'use client';

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatNumber, formatDateTime } from '@/lib/format';
import { toast } from '@/lib/toast';
import {
  useIncidents,
  useMachines,
  useReportAttention,
  useReportIncidents,
  useReportWorkOrders,
  useWorkOrders,
  type IncidentRow,
  type WorkOrderRow,
} from '@/api/odrzavanje';
import {
  ASSET_TYPE_LABEL,
  deadlineTone,
  f,
  INCIDENT_STATUS_LABEL,
  SEVERITY_LABEL,
  StatCard,
  WO_PRIORITY_LABEL,
  WO_STATUS_LABEL,
  WO_TYPE_LABEL,
} from './common';

const PERIODS = [
  { key: '30', label: '30 dana', days: 30 },
  { key: '90', label: '90 dana', days: 90 },
  { key: '365', label: '12 meseci', days: 365 },
  { key: 'all', label: 'Sve', days: null as number | null },
];
/** Gornja granica reda za klijentsku analitiku (BE pageSize cap = 200). */
const ANALYTICS_PAGE = 200;

function countBy<T>(rows: T[], keyFn: (r: T) => string | null): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function sumBy<T>(rows: T[], keyFn: (r: T) => string | null, valFn: (r: T) => number): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + (valFn(r) || 0));
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function csvEsc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(headers: string[], rows: unknown[][], filename: string) {
  const body = rows.map((r) => r.map(csvEsc).join(',')).join('\n');
  const text = `﻿${headers.join(',')}\n${body}`;
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Izveštaji održavanja — headline brojevi iz BE agregacija (tačni, neograničeni),
 * a bar-liste/tabela/CSV se računaju klijentski iz incidenata + radnih naloga
 * (paritet 1.0 maintReportsPanel.js). Klijentska analitika je nad poslednjih
 * {@link ANALYTICS_PAGE} redova po periodu (BE pageSize cap).
 */
export function IzvestajiTab() {
  const [period, setPeriod] = useState('90');
  const periodDef = PERIODS.find((p) => p.key === period) ?? PERIODS[1];
  const sinceMs = periodDef.days ? Date.now() - periodDef.days * 86_400_000 : null;

  const incSummary = useReportIncidents(period);
  const woSummary = useReportWorkOrders(period);
  const attention = useReportAttention();
  const incidents = useIncidents({ pageSize: ANALYTICS_PAGE });
  const workOrders = useWorkOrders({ pageSize: ANALYTICS_PAGE, openOnly: false });
  const machines = useMachines({ pageSize: 1000 });

  const inc = incSummary.data?.data;
  const wo = woSummary.data?.data;
  const att = attention.data?.data;

  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of machines.data?.data ?? []) m.set(row.machineCode, row.name || row.machineCode);
    return m;
  }, [machines.data]);

  const incRows = useMemo<IncidentRow[]>(() => {
    const all = incidents.data?.data ?? [];
    return sinceMs ? all.filter((r) => new Date(r.reportedAt).getTime() >= sinceMs) : all;
  }, [incidents.data, sinceMs]);
  const woRows = useMemo<WorkOrderRow[]>(() => {
    const all = workOrders.data?.data ?? [];
    return sinceMs ? all.filter((r) => new Date(r.createdAt).getTime() >= sinceMs) : all;
  }, [workOrders.data, sinceMs]);

  const byMachine = useMemo(() => countBy(incRows, (i) => i.machineCode).slice(0, 10), [incRows]);
  const downtimeByMachine = useMemo(() => sumBy(incRows, (i) => i.machineCode, (i) => num(i.downtimeMinutes)).slice(0, 10), [incRows]);
  const woByStatus = useMemo(() => countBy(woRows, (w) => w.status), [woRows]);
  const woByPriority = useMemo(() => countBy(woRows, (w) => w.priority), [woRows]);
  const costByType = useMemo(() => Object.entries(wo?.costByAssetType ?? {}).sort((a, b) => b[1] - a[1]), [wo]);
  const incTable = useMemo(() => [...incRows].sort((a, b) => new Date(b.reportedAt).getTime() - new Date(a.reportedAt).getTime()).slice(0, 20), [incRows]);

  const truncated = (incidents.data?.meta.pagination.total ?? 0) > ANALYTICS_PAGE || (workOrders.data?.meta.pagination.total ?? 0) > ANALYTICS_PAGE;

  function exportIncidentsCsv() {
    const headers = ['machine_code', 'machine_name', 'title', 'severity', 'status', 'reported_at', 'downtime_minutes', 'work_order'];
    const rows = incRows.map((i) => [
      i.machineCode,
      nameByCode.get(i.machineCode) ?? '',
      i.title,
      SEVERITY_LABEL[i.severity] ?? i.severity,
      INCIDENT_STATUS_LABEL[i.status] ?? i.status,
      i.reportedAt,
      num(i.downtimeMinutes),
      i.workOrder?.woNumber ?? '',
    ]);
    downloadCsv(headers, rows, `odrzavanje_izvestaj_${period}_${new Date().toISOString().slice(0, 10)}.csv`);
    toast('CSV incidenata izvezen');
  }
  function exportCostsCsv() {
    // 1.0 izvozi po STAVCI dela; 2.0 nema all-parts endpoint pa je granularnost RADNI NALOG
    // (cost_total/labor_minutes iz WO reda + sredstvo). Vidi ZAVRŠNU PORUKU.
    const headers = ['wo_number', 'title', 'asset_code', 'asset_name', 'asset_type', 'type', 'priority', 'status', 'cost_total', 'labor_minutes'];
    const rows = woRows.map((w) => [
      w.woNumber ?? '',
      w.title,
      w.asset?.assetCode ?? '',
      w.asset?.name ?? '',
      w.asset?.assetType ?? w.assetType ?? '',
      WO_TYPE_LABEL[w.type] ?? w.type,
      WO_PRIORITY_LABEL[w.priority] ?? w.priority,
      WO_STATUS_LABEL[w.status] ?? w.status,
      num(w.costTotal),
      num(w.laborMinutes),
    ]);
    downloadCsv(headers, rows, `odrzavanje_troskovi_${period}_${new Date().toISOString().slice(0, 10)}.csv`);
    toast('CSV troškova izvezen');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-panel border border-line bg-surface p-1">
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)} className={`rounded-control px-3 py-1.5 text-sm font-medium ${period === p.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2'}`}>{p.label}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={exportIncidentsCsv}><Download className="h-4 w-4" aria-hidden /> CSV incidenti</Button>
          <Button variant="ghost" onClick={exportCostsCsv}><Download className="h-4 w-4" aria-hidden /> CSV troškovi</Button>
        </div>
      </div>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Kvarovi</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Ukupno kvarova" value={inc?.total ?? '—'} tone="info" />
          <StatCard label="Zastoj (min)" value={inc ? formatNumber(inc.downtimeMinutes) : '—'} tone="warn" />
          <StatCard label="Kritični" value={inc?.bySeverity?.critical ?? 0} tone="danger" />
          <StatCard label="Otvoreni" value={inc?.byStatus?.open ?? 0} tone="warn" />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Troškovi radnih naloga</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Radnih naloga" value={wo?.totalWorkOrders ?? '—'} />
          <StatCard label="Delovi (RSD)" value={wo ? formatNumber(Math.round(wo.partsCost)) : '—'} tone="info" />
          <StatCard label="Radni sati" value={wo ? formatNumber(Math.round(wo.laborMinutes / 60)) : '—'} tone="info" />
          <StatCard label="Vrste naloga" value={wo ? Object.keys(wo.byType).length : '—'} />
        </div>
      </section>

      {/* Bar-liste (klijentska analitika, paritet 1.0) */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BarCard title="Top mašine po kvarovima" hint={String(incRows.length)} entries={byMachine} total={incRows.length} labelFn={(c) => nameByCode.get(c) ?? c} loading={incidents.isLoading} />
        <BarCard title="Top downtime (min)" entries={downtimeByMachine} total={downtimeByMachine.reduce((a, e) => a + e[1], 0)} labelFn={(c) => nameByCode.get(c) ?? c} loading={incidents.isLoading} />
        <BarCard title="Kvarovi po ozbiljnosti" entries={inc ? Object.entries(inc.bySeverity).sort((a, b) => b[1] - a[1]) : []} total={inc?.total ?? 0} labelFn={(k) => SEVERITY_LABEL[k as never] ?? k} loading={incSummary.isLoading} />
        <BarCard title="Nalozi po statusu / prioritetu" entries={woByStatus} total={woRows.length} labelFn={(k) => WO_STATUS_LABEL[k as never] ?? k} loading={workOrders.isLoading}
          extra={<BarList entries={woByPriority} total={woRows.length} labelFn={(k) => WO_PRIORITY_LABEL[k as never] ?? k} />} />
        <BarCard title="Trošak po tipu sredstva (RSD)" hint={wo ? formatNumber(Math.round(wo.partsCost)) : ''} entries={costByType} total={wo?.partsCost ?? 0} labelFn={(k) => ASSET_TYPE_LABEL[k] ?? k} money loading={woSummary.isLoading} />
      </div>

      {truncated && (
        <p className="text-2xs text-ink-secondary">Bar-liste, tabela i CSV računaju se nad poslednjih {ANALYTICS_PAGE} redova u periodu; ukupni brojevi iznad su tačni (BE agregacija).</p>
      )}

      <section>
        <h2 className="mb-2 text-md font-semibold text-ink">Poslednji kvarovi u periodu <span className="text-ink-secondary">({incRows.length})</span></h2>
        <div className="overflow-x-auto rounded-panel border border-line">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-2xs uppercase tracking-wider text-ink-secondary">
                <th className="p-2">Mašina</th><th className="p-2">Naslov</th><th className="p-2">Ozbiljnost</th><th className="p-2">Status</th><th className="p-2">Prijava</th><th className="p-2">Zastoj (min)</th>
              </tr>
            </thead>
            <tbody>
              {incTable.length === 0 ? (
                <tr><td colSpan={6} className="p-4 text-center text-ink-secondary">Nema kvarova u periodu.</td></tr>
              ) : incTable.map((i) => (
                <tr key={i.id} className="border-b border-line-soft">
                  <td className="p-2"><span className="text-ink">{nameByCode.get(i.machineCode) ?? i.machineCode}</span><div className="tnums text-2xs text-ink-secondary">{i.machineCode}</div></td>
                  <td className="p-2 text-ink-secondary">{i.title}</td>
                  <td className="p-2 text-ink-secondary">{SEVERITY_LABEL[i.severity] ?? i.severity}</td>
                  <td className="p-2 text-ink-secondary">{INCIDENT_STATUS_LABEL[i.status] ?? i.status}</td>
                  <td className="p-2 tnums text-ink-secondary">{formatDateTime(i.reportedAt)}</td>
                  <td className="p-2 tnums text-ink-secondary">{formatNumber(num(i.downtimeMinutes))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

function BarCard({ title, hint, entries, total, labelFn, money, loading, extra }: {
  title: string; hint?: string; entries: [string, number][]; total: number;
  labelFn: (k: string) => string; money?: boolean; loading?: boolean; extra?: React.ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <span className="tnums text-2xs text-ink-secondary">{hint}</span>}
      </div>
      {loading ? (
        <p className="text-sm text-ink-secondary">Učitavanje…</p>
      ) : (
        <>
          <BarList entries={entries} total={total} labelFn={labelFn} money={money} />
          {extra && <div className="mt-2 border-t border-line-soft pt-2">{extra}</div>}
        </>
      )}
    </section>
  );
}
function BarList({ entries, total, labelFn, money }: { entries: [string, number][]; total: number; labelFn: (k: string) => string; money?: boolean }) {
  if (entries.length === 0) return <p className="text-sm text-ink-secondary">Nema podataka za izabrani period.</p>;
  const max = Math.max(...entries.map((e) => e[1]), 1);
  return (
    <ul className="space-y-1.5">
      {entries.map(([k, v]) => {
        const pct = Math.round((v / max) * 100);
        const share = total ? ` · ${Math.round((v / total) * 100)}%` : '';
        return (
          <li key={k}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate text-ink">{labelFn(k)}</span>
              <span className="tnums shrink-0 font-medium text-ink-secondary">{money ? formatNumber(Math.round(v)) : formatNumber(v)}{share}</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
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
