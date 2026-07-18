'use client';

import { useState } from 'react';
import { Plus } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { formatDateTime } from '@/lib/format';
import { useIncidents, type IncidentRow, type MaintMe } from '@/api/odrzavanje';
import { INCIDENT_STATUS_LABEL, IncidentStatusBadge, SeverityBadge, tableEmpty } from './common';
import { PrijavaKvaraDialog } from './prijava-kvara-dialog';
import { IncidentDetailDialog } from './incident-detail-dialog';

const STATUS_FILTERS = ['', 'open', 'acknowledged', 'in_progress', 'awaiting_parts', 'resolved', 'closed'] as const;
const SEVERITY_FILTERS = ['', 'minor', 'major', 'critical'] as const;

/** Kvarovi (incidenti) — lista + prijava (report) + detalj. */
export function KvaroviTab({ me, canReport }: { me: MaintMe | undefined; canReport: boolean }) {
  const [status, setStatus] = useState('');
  const [severity, setSeverity] = useState('');
  const [page, setPage] = useState(1);
  const [reporting, setReporting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const inc = useIncidents({ status, severity, page, pageSize: 30 });
  const rows = inc.data?.data ?? [];
  const meta = inc.data?.meta.pagination;

  const cols: Column<IncidentRow>[] = [
    { key: 'title', header: 'Naslov', render: (r) => <span className="font-medium">{r.title}</span> },
    { key: 'machine', header: 'Mašina', render: (r) => <span className="tnums text-ink-secondary">{r.machineCode}</span> },
    { key: 'sev', header: 'Ozbiljnost', render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'status', header: 'Status', render: (r) => <IncidentStatusBadge status={r.status} /> },
    { key: 'wo', header: 'Nalog', render: (r) => <span className="tnums text-ink-secondary">{r.workOrder?.woNumber ?? '—'}</span> },
    { key: 'at', header: 'Prijavljen', render: (r) => <span className="text-ink-secondary">{formatDateTime(r.reportedAt)}</span> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s ? INCIDENT_STATUS_LABEL[s] : 'Svi statusi'}</option>)}
        </select>
        <select value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {SEVERITY_FILTERS.map((s) => <option key={s} value={s}>{s ? s : 'Sve ozbiljnosti'}</option>)}
        </select>
        {canReport && (
          <div className="ml-auto">
            <Button onClick={() => setReporting(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Prijavi kvar
            </Button>
          </div>
        )}
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => r.id}
        loading={inc.isLoading}
        onRowActivate={(r) => setOpenId(r.id)}
        empty={tableEmpty(inc.isError, 'Nema kvarova', 'Nema prijavljenih kvarova za izabrane filtere.')}
      />
      {meta && meta.totalPages > 1 && (
        <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />
      )}

      {reporting && <PrijavaKvaraDialog me={me} onClose={() => setReporting(false)} />}
      <IncidentDetailDialog id={openId} me={me} onClose={() => setOpenId(null)} />
    </div>
  );
}
