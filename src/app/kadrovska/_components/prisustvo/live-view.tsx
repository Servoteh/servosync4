'use client';

import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { formatDateTime } from '@/lib/format';
import { useAttendanceNow, useAttendanceEvents, useDirectory, type AttendanceEventRow } from '@/api/kadrovska';
import { SummaryChips, sv } from '../common';
import { DIRECTION_LABEL, STATUS_META } from './helpers';

type StatusFilter = 'svi' | 'prisutan' | 'pauza' | 'odsutan';

/** Jedan red UŽIVO liste = zaposleni (iz imenika) + poslednji prolaz (ako ga ima). */
interface LiveRow {
  employeeId: string;
  fullName: string;
  department: string;
  status: StatusFilter;
  noPunch24h: boolean;
  eventTs: string | null;
  direction: string | null;
  terminalName: string;
}

const SEG: { key: StatusFilter; label: string }[] = [
  { key: 'svi', label: 'Svi' },
  { key: 'prisutan', label: 'Prisutni' },
  { key: 'pauza', label: 'Pauza' },
  { key: 'odsutan', label: 'Odsutni' },
];

export function LiveView() {
  const dirQ = useDirectory();
  const nowQ = useAttendanceNow(true);
  const feedQ = useAttendanceEvents(40, true);

  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('svi');

  // Merge: SVI aktivni zaposleni (imenik) ⨝ v_attendance_now — ko nema prolaz u
  // 24 h prikazan je kao „Odsutan / bez prolaza u 24 h" (paritet 1.0 _rows()).
  const rows: LiveRow[] = useMemo(() => {
    const dir = dirQ.data?.data ?? [];
    const now = nowQ.data?.data ?? [];
    const byEmp = new Map(now.map((r) => [sv(r, 'employee_id'), r]));
    return dir
      .map((e): LiveRow => {
        const id = sv(e, 'id');
        const r = byEmp.get(id);
        const status = (r ? sv(r, 'status') : 'odsutan') as StatusFilter;
        return {
          employeeId: id,
          fullName: sv(e, 'full_name'),
          department: sv(e, 'department'),
          status: STATUS_META[status] ? status : 'odsutan',
          noPunch24h: !r,
          eventTs: r ? sv(r, 'event_ts') || null : null,
          direction: r ? sv(r, 'direction') || null : null,
          terminalName: r ? sv(r, 'terminal_name') : '',
        };
      })
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'sr'));
  }, [dirQ.data, nowQ.data]);

  const nPrisutan = rows.filter((r) => r.status === 'prisutan').length;
  const nPauza = rows.filter((r) => r.status === 'pauza').length;
  const nOdsutan = rows.length - nPrisutan - nPauza;
  const unknownToday = feedQ.data?.data.unknownToday ?? 0;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== 'svi' && r.status !== statusFilter) return false;
      if (q && !r.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, query, statusFilter]);

  const chips: { label: string; value: number; tone?: 'default' | 'warn' | 'danger' | 'accent' }[] = [
    { label: 'Prisutno', value: nPrisutan, tone: 'accent' },
    { label: 'Na pauzi', value: nPauza, tone: 'warn' },
    { label: 'Odsutno', value: nOdsutan },
  ];
  if (unknownToday > 0) chips.push({ label: 'Nepoznata kartica danas', value: unknownToday, tone: 'warn' });

  const cols: Column<LiveRow>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => r.fullName || '—' },
    { key: 'dep', header: 'Odeljenje', render: (r) => r.department || '—' },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const meta = STATUS_META[r.status] ?? STATUS_META.odsutan;
        return (
          <span title={r.noPunch24h ? 'Nema prolaza u poslednja 24 h' : undefined}>
            <StatusBadge tone={meta.tone} label={meta.label} />
          </span>
        );
      },
    },
    {
      key: 'event',
      header: 'Poslednji događaj',
      render: (r) =>
        r.eventTs ? (
          <span>
            {formatDateTime(r.eventTs)} · {DIRECTION_LABEL[r.direction ?? 'unknown'] ?? '—'}
          </span>
        ) : (
          <span className="text-ink-disabled">bez prolaza u 24 h</span>
        ),
    },
    { key: 'terminal', header: 'Terminal', render: (r) => r.terminalName || '—' },
  ];

  function reload() {
    void dirQ.refetch();
    void nowQ.refetch();
    void feedQ.refetch();
  }

  return (
    <div className="space-y-3">
      <SummaryChips items={chips} />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={query} onChange={setQuery} placeholder="Pretraga po imenu i prezimenu…" />
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
          {SEG.map((s) => (
            <button
              key={s.key}
              onClick={() => setStatusFilter(s.key)}
              className={`rounded-control px-3 py-1.5 text-sm font-medium ${
                statusFilter === s.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={reload} title="Ponovo učitaj iz baze" loading={nowQ.isFetching}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Osveži
          </Button>
          <span className="tnums rounded-control bg-surface-2 px-2 py-1 text-sm text-ink-secondary">{filtered.length}</span>
        </div>
      </div>

      <DataTable
        columns={cols}
        rows={filtered}
        rowKey={(r) => r.employeeId || r.fullName}
        loading={dirQ.isLoading || nowQ.isLoading}
        empty={<EmptyState title="Nema rezultata" hint="Promeni pretragu ili filter statusa." />}
      />

      <div>
        <h3 className="mb-2 mt-6 text-sm font-medium text-ink-secondary">Poslednji prolazi</h3>
        <FeedTable events={feedQ.data?.data.events ?? []} loading={feedQ.isLoading} />
      </div>
    </div>
  );
}

/** Feed sirovih prolaza sa kapije — nepoznata kartica istaknuta (badge_code). */
function FeedTable({ events, loading }: { events: AttendanceEventRow[]; loading: boolean }) {
  const cols: Column<AttendanceEventRow>[] = [
    { key: 'ts', header: 'Vreme', render: (e) => formatDateTime(e.event_ts) },
    {
      key: 'who',
      header: 'Zaposleni',
      render: (e) =>
        e.employee_name ? (
          e.employee_name
        ) : (
          <span className="text-status-warn" title="Kartica nije spojena ni sa jednim zaposlenim">
            nepoznata kartica {e.badge_code || ''}
          </span>
        ),
    },
    { key: 'dir', header: 'Smer', render: (e) => DIRECTION_LABEL[e.direction ?? 'unknown'] ?? '—' },
    {
      key: 'terminal',
      header: 'Terminal',
      render: (e) => (
        <span>
          {e.terminal_name || '—'}
          {e.source === 'katze_manual' && <span className="text-ink-disabled"> (ručno)</span>}
        </span>
      ),
    },
  ];
  return (
    <DataTable
      columns={cols}
      rows={events}
      rowKey={(e) => e.id}
      loading={loading}
      empty={<EmptyState title="Još nema prolaza" hint="Feed prikazuje poslednjih 40 događaja sa kapije." />}
    />
  );
}
