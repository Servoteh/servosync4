'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { formatDateTime } from '@/lib/format';
import { ApiError } from '@/api/client';
import { PERMISSIONS } from '@/lib/permissions';
import {
  useSefOutbox,
  useSend,
  useRefresh,
  useCancel,
  canSend,
  canCancel,
  SEF_STATUS,
  type SefStatus,
  type SefOutbox,
} from '@/api/sef';

/**
 * SEF e-fakture (izlazne): lista outbox-a (Faza 5 §B). Obrazac „Lista"
 * (DESIGN_SYSTEM §4.1): filter bar (status) + gusta tabela sa akcijama po redu,
 * server-side skip/take paginacija. Data isključivo kroz `@/api/sef` hook-ove;
 * sve od kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) SEF domen — PENDING=warn, SENT=info,
 * DELIVERED=success, REJECTED=danger, CANCELLED=neutral.
 *
 * AKCIJE (guard-uslovljene): „Pošalji" (SEF_SEND, status≠CANCELLED), „Osveži status"
 * (SEF_READ, uvek), „Storno" (SEF_CANCEL, status∈PENDING/SENT/DELIVERED). Backend
 * presuđuje; ovde se afordanse samo kriju/gase.
 */

const PAGE_SIZE = 50;

/** SEF status → { tone, label } (kanonska mapa §7). */
function statusMeta(status: SefStatus): { tone: Tone; label: string } {
  switch (status) {
    case SEF_STATUS.PENDING:
      return { tone: 'warn', label: 'U redu' };
    case SEF_STATUS.SENT:
      return { tone: 'info', label: 'Poslato' };
    case SEF_STATUS.DELIVERED:
      return { tone: 'success', label: 'Isporučeno' };
    case SEF_STATUS.REJECTED:
      return { tone: 'danger', label: 'Odbijeno' };
    case SEF_STATUS.CANCELLED:
      return { tone: 'neutral', label: 'Stornirano' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const STATUS_OPTIONS: { value: SefStatus; label: string }[] = [
  { value: SEF_STATUS.PENDING, label: 'U redu' },
  { value: SEF_STATUS.SENT, label: 'Poslato' },
  { value: SEF_STATUS.DELIVERED, label: 'Isporučeno' },
  { value: SEF_STATUS.REJECTED, label: 'Odbijeno' },
  { value: SEF_STATUS.CANCELLED, label: 'Stornirano' },
];

export default function SefPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

  const [status, setStatus] = useState<SefStatus | ''>('');
  const [page, setPage] = useState(1);
  const [banner, setBanner] = useState<string | null>(null);
  /** id outbox reda čija akcija je u toku — da se gasi samo taj red. */
  const [busyId, setBusyId] = useState<number | null>(null);

  const resetPage = () => setPage(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const canSendPerm = can(PERMISSIONS.SEF_SEND);
  const canCancelPerm = can(PERMISSIONS.SEF_CANCEL);

  const skip = (page - 1) * PAGE_SIZE;
  const list = useSefOutbox({ status, take: PAGE_SIZE, skip });
  const rows = list.data?.data ?? [];
  // Bez `total` iz backenda: puna strana → verovatno postoji sledeća (Pager next).
  const hasNext = rows.length === PAGE_SIZE;

  const send = useSend();
  const refresh = useRefresh();
  const cancel = useCancel();

  async function run(action: 'send' | 'refresh' | 'cancel', row: SefOutbox): Promise<void> {
    setBanner(null);
    setBusyId(row.id);
    try {
      const mut = action === 'send' ? send : action === 'refresh' ? refresh : cancel;
      await mut.mutateAsync(row.id);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.message
          : 'Akcija nije uspela — pokušaj ponovo.';
      setBanner(msg);
    } finally {
      setBusyId(null);
    }
  }

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const columns: Column<SefOutbox>[] = [
    {
      key: 'invoiceId',
      header: 'Faktura',
      align: 'right',
      numeric: true,
      render: (o) => <span className="tnums font-semibold text-ink">{o.invoiceId}</span>,
    },
    {
      key: 'requestId',
      header: 'RequestID',
      render: (o) => (
        <span className="tnums text-ink-secondary" title={o.requestId}>
          {o.requestId.slice(0, 8)}…
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (o) => {
        const s = statusMeta(o.status);
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    {
      key: 'sefInvoiceId',
      header: 'SEF ID',
      render: (o) =>
        o.sefInvoiceId ? (
          <span className="tnums text-ink-secondary">{o.sefInvoiceId}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'sentAt',
      header: 'Poslato',
      render: (o) => <span className="text-ink-secondary">{formatDateTime(o.sentAt)}</span>,
    },
    {
      key: 'errorMessage',
      header: 'Greška',
      render: (o) =>
        o.errorMessage ? (
          <span className="text-status-danger" title={o.errorMessage}>
            {o.errorMessage.length > 48 ? `${o.errorMessage.slice(0, 48)}…` : o.errorMessage}
          </span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'actions',
      header: 'Akcije',
      align: 'right',
      render: (o) => {
        const busy = busyId === o.id;
        return (
          <div className="flex items-center justify-end gap-2">
            {canSendPerm && canSend(o.status) && (
              <Button
                variant="secondary"
                loading={busy && send.isPending}
                disabled={busy}
                onClick={() => run('send', o)}
                title="Pošalji UBL na SEF"
              >
                Pošalji
              </Button>
            )}
            <Button
              variant="ghost"
              loading={busy && refresh.isPending}
              disabled={busy}
              onClick={() => run('refresh', o)}
              title="Osveži status sa SEF-a"
            >
              Osveži status
            </Button>
            {canCancelPerm && canCancel(o.status) && (
              <Button
                variant="danger"
                loading={busy && cancel.isPending}
                disabled={busy}
                onClick={() => run('cancel', o)}
                title="Storniraj/otkaži na SEF-u"
              >
                Storno
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <AppShell>
      <PageHeader title="SEF e-fakture" count={list.data ? `${rows.length} u prikazu` : undefined} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as SefStatus | '');
                  resetPage();
                }}
                options={STATUS_OPTIONS}
              />
            </div>
          </label>

          {status !== '' && (
            <button
              onClick={() => {
                setStatus('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {banner && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {banner}
          </div>
        )}

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(o) => o.id}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema e-faktura u redu"
              hint="Promeni filter ili pošalji fakturu na SEF iz modula fakturisanja."
            />
          }
        />

        {(page > 1 || hasNext) && (
          <Pager
            page={page}
            totalPages={hasNext ? page + 1 : page}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        )}
      </div>
    </AppShell>
  );
}
