'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useNabavkaRequests,
  NABAVKA_REQUEST_STATUS,
  type NabavkaStatus,
  type PurchaseRequest,
} from '@/api/nabavka';
import { NewRequestDialog } from './new-request-dialog';
import { PurchaseOrdersPanel } from './purchase-orders-panel';

/**
 * Nabavka: radna lista zahteva (Traka B §B). Obrazac „Lista"
 * (DESIGN_SYSTEM §4.1): filter bar + gusta tabela, server-side paginacija.
 * Data isključivo kroz `@/api/nabavka` hook-ove; sve od kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) NABAVKA domen dodat 19.07;
 * status se renderuje lokalnim `statusMeta` nad postojećim tonovima koji
 * mapira NABAVKA status na POSTOJEĆI `Tone` iz kanonske mape (bez novih boja).
 */

const TAKE = 50;

/**
 * NABAVKA status → { tone, label } nad POSTOJEĆIM tonovima kanonske mape (§7).
 * Privremeno lokalno dok se NABAVKA domen ne unese u DESIGN_SYSTEM §7 i (po želji)
 * u `StatusBadge`. Tonovi prate semantiku toka: pripremа=neutral, čekanje=warn,
 * odobreno/primljeno=success, poslato=info.
 */
function statusMeta(status: NabavkaStatus): { tone: Tone; label: string } {
  switch (status) {
    case NABAVKA_REQUEST_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case NABAVKA_REQUEST_STATUS.SUBMITTED:
      return { tone: 'warn', label: 'Predat' };
    case NABAVKA_REQUEST_STATUS.APPROVED:
      return { tone: 'success', label: 'Odobren' };
    case NABAVKA_REQUEST_STATUS.SENT:
      return { tone: 'info', label: 'Upit poslat' };
    case NABAVKA_REQUEST_STATUS.RECEIVED:
      return { tone: 'success', label: 'Primljeno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const STATUS_OPTIONS: { value: NabavkaStatus; label: string }[] = [
  { value: NABAVKA_REQUEST_STATUS.DRAFT, label: 'U pripremi' },
  { value: NABAVKA_REQUEST_STATUS.SUBMITTED, label: 'Predat' },
  { value: NABAVKA_REQUEST_STATUS.APPROVED, label: 'Odobren' },
  { value: NABAVKA_REQUEST_STATUS.SENT, label: 'Upit poslat' },
  { value: NABAVKA_REQUEST_STATUS.RECEIVED, label: 'Primljeno' },
];

const columns: Column<PurchaseRequest>[] = [
  {
    key: 'requestNumber',
    header: 'Broj zahteva',
    render: (r) => <span className="tnums font-semibold text-ink">{r.requestNumber}</span>,
  },
  {
    // Predmet = kičma zahteva (projectId). Naziv/broj predmeta stiže enrich-om u
    // punijem redu; za sada prikazujemo šifru predmeta iz `projectId`.
    key: 'project',
    header: 'Predmet',
    render: (r) => <span className="tnums text-ink">{r.projectId}</span>,
  },
  {
    key: 'items',
    header: 'Stavke',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.items.length}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = statusMeta(r.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'createdAt',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.createdAt)}</span>,
  },
  {
    key: 'initiator',
    header: 'Inicijator',
    render: (r) => <span className="tnums text-ink-secondary">{r.initiatorUserId}</span>,
  },
];

export default function NabavkaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [status, setStatus] = useState<NabavkaStatus | ''>('');
  const [page, setPage] = useState(1);
  const [newOpen, setNewOpen] = useState(false);
  const resetPage = () => setPage(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useNabavkaRequests({ page, take: TAKE, status });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / TAKE));

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title="Nabavka"
        count={list.data ? `${formatNumber(total)} zahteva` : undefined}
        actions={
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Novi zahtev
          </Button>
        }
      />

      <NewRequestDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => router.push(`/nabavka/${id}`)}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as NabavkaStatus | '');
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

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => router.push(`/nabavka/${r.id}`)}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema zahteva za nabavku"
              hint="Promeni filter ili kreiraj prvi zahtev iz potrebe (MRP) ili radnog naloga."
            />
          }
        />

        {totalPages > 1 && (
          <Pager
            page={page}
            totalPages={totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
          />
        )}

        <PurchaseOrdersPanel />
      </div>
    </AppShell>
  );
}
