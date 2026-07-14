'use client';

import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { formatDateTime } from '@/lib/format';
import { useNotifications, useRetryNotification, type NotificationLog } from '@/api/odrzavanje';
import { NotifStatusBadge, tableEmpty } from './common';

const STATUS_FILTERS = ['', 'queued', 'sent', 'failed', 'cancelled'] as const;

/** Notifikacije (outbox log + retry). Dispatch je MRTAV (F1) — samo log/retry. */
export function NotifikacijeTab() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const notifs = useNotifications({ status, page, pageSize: 40 });
  const retry = useRetryNotification();
  const rows = notifs.data?.data ?? [];
  const meta = notifs.data?.meta.pagination;

  const cols: Column<NotificationLog>[] = [
    { key: 'subject', header: 'Naslov', render: (r) => <span className="font-medium">{r.subject ?? r.body.slice(0, 40)}</span> },
    { key: 'channel', header: 'Kanal', render: (r) => <span className="text-ink-secondary">{r.channel}</span> },
    { key: 'recipient', header: 'Primalac', render: (r) => <span className="text-ink-secondary">{r.recipient}</span> },
    { key: 'status', header: 'Status', render: (r) => <NotifStatusBadge status={r.status} /> },
    { key: 'created', header: 'Kreirano', render: (r) => <span className="text-ink-secondary">{formatDateTime(r.createdAt)}</span> },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (r) => (r.status === 'failed' ? <Button variant="ghost" disabled={retry.isPending} onClick={(e) => { e.stopPropagation(); retry.mutate({ id: r.id }); }}><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Ponovi</Button> : null),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s || 'Svi statusi'}</option>)}
        </select>
        <p className="ml-auto text-xs text-ink-disabled">Isporuka poruka je van pogona (paritet); dostupni su log i ponovno slanje.</p>
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} loading={notifs.isLoading} empty={tableEmpty(notifs.isError, 'Nema notifikacija', 'Outbox je prazan za izabrani filter.')} />
      {meta && meta.totalPages > 1 && <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />}
    </div>
  );
}
