'use client';

import { useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { Pager } from '@/components/ui-kit/pager';
import { formatDateTime } from '@/lib/format';
import { useNotifications, useRetryNotification, type MaintMe, type NotificationLog } from '@/api/odrzavanje';
import { NotifStatusBadge, tableEmpty } from './common';

const STATUS_FILTERS = ['', 'queued', 'sent', 'failed', 'cancelled'] as const;

/** Prijateljski prikaz primaoca (paritet 1.0): in_app = „Korisnik aplikacije", prazno = „čeka dostavu". */
function friendlyRecipient(r: NotificationLog): string {
  if (r.channel === 'in_app') return 'Korisnik aplikacije';
  if (!r.recipient) return 'čeka dostavu';
  return r.recipient;
}
function attemptTime(iso: string | null): string {
  return iso ? formatDateTime(iso) : '—';
}

/** Notifikacije (outbox log + retry). Dispatch je MRTAV (F1) — samo log/retry. */
export function NotifikacijeTab({ me }: { me: MaintMe | undefined }) {
  const [status, setStatus] = useState('');
  const [machineDraft, setMachineDraft] = useState('');
  const [incidentDraft, setIncidentDraft] = useState('');
  const [machineCode, setMachineCode] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [page, setPage] = useState(1);
  const notifs = useNotifications({ status, machineCode: machineCode || undefined, incidentId: incidentId || undefined, page, pageSize: 40 });
  const retry = useRetryNotification();
  const rows = notifs.data?.data ?? [];
  const meta = notifs.data?.meta.pagination;

  // 1.0 canRetryMaintNotification: ERP adm/mgmt ILI maint chief/admin — NAMERNO ne 'management'
  // (inače RPC vrati 42501). management-maint-profil bez ERP kruga NE vidi dugme.
  const canRetry = (me?.erpAdminOrManagement ?? false) || me?.maintRole === 'chief' || me?.maintRole === 'admin';

  function applyFilters() {
    setMachineCode(machineDraft.trim());
    setIncidentId(incidentDraft.trim());
    setPage(1);
  }

  const cols: Column<NotificationLog>[] = [
    { key: 'machine', header: 'Mašina', render: (r) => (r.machineCode ? <span className="tnums text-ink">{r.machineCode}</span> : <span className="text-ink-disabled">—</span>) },
    {
      key: 'subject', header: 'Naslov', render: (r) => (
        <div>
          <span className="font-medium text-ink">{r.subject ?? r.body.slice(0, 40)}</span>
          {r.error && <div className="text-2xs text-status-danger">{r.error}</div>}
        </div>
      ),
    },
    { key: 'channel', header: 'Kanal', render: (r) => <span className="text-ink-secondary">{r.channel}</span> },
    { key: 'recipient', header: 'Primalac', render: (r) => <span className="text-ink-secondary">{friendlyRecipient(r)}</span> },
    {
      key: 'status', header: 'Status', render: (r) => (
        <div className="space-y-0.5">
          <NotifStatusBadge status={r.status} />
          {(r.lastAttemptAt || r.nextAttemptAt) && (
            <div className="text-2xs text-ink-secondary">
              {r.lastAttemptAt && <span>posl. {attemptTime(r.lastAttemptAt)}</span>}
              {r.status !== 'sent' && r.nextAttemptAt && <span className="ml-1">sled. {attemptTime(r.nextAttemptAt)}</span>}
            </div>
          )}
        </div>
      ),
    },
    { key: 'attempts', header: 'Pokušaji', align: 'right', render: (r) => <span className="tnums text-ink-secondary">{r.attempts}{r.escalationLevel ? ` · L${r.escalationLevel}` : ''}</span> },
    { key: 'created', header: 'Kreirano', render: (r) => <span className="tnums text-ink-secondary">{formatDateTime(r.createdAt)}</span> },
    {
      key: 'act', header: '', align: 'right',
      render: (r) => (r.status === 'failed' && canRetry ? <Button variant="ghost" disabled={retry.isPending} onClick={(e) => { e.stopPropagation(); retry.mutate({ id: r.id }); }}><RefreshCw className="h-3.5 w-3.5" aria-hidden /> Ponovi</Button> : null),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="h-9 rounded-control border border-line bg-surface px-2 text-sm text-ink">
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s || 'Svi statusi'}</option>)}
        </select>
        <Input value={machineDraft} onChange={(e) => setMachineDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }} placeholder="Šifra mašine…" className="h-9 w-40" />
        <Input value={incidentDraft} onChange={(e) => setIncidentDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }} placeholder="ID incidenta…" className="h-9 w-56" />
        <Button variant="secondary" onClick={applyFilters}><Search className="h-3.5 w-3.5" aria-hidden /> Primeni</Button>
        {(machineCode || incidentId) && <Button variant="ghost" onClick={() => { setMachineDraft(''); setIncidentDraft(''); setMachineCode(''); setIncidentId(''); setPage(1); }}>Očisti</Button>}
        <p className="ml-auto text-xs text-ink-disabled">Isporuka poruka je van pogona (paritet); dostupni su log i ponovno slanje.</p>
      </div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} loading={notifs.isLoading} empty={tableEmpty(notifs.isError, 'Nema notifikacija', 'Outbox je prazan za izabrani filter.')} />
      {meta && meta.totalPages > 1 && <Pager page={meta.page} totalPages={meta.totalPages} onPrev={() => setPage((p) => p - 1)} onNext={() => setPage((p) => p + 1)} />}
    </div>
  );
}
