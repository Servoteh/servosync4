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
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useInvoices,
  SALES_STATUS,
  SALES_DOCUMENT_TYPE,
  type SalesStatus,
  type SalesDocumentType,
  type Invoice,
} from '@/api/sales';
import { NewProformaDialog } from './new-proforma-dialog';

/**
 * Fakturisanje: radna lista računa i predračuna (Faza 5 §A). Obrazac „Lista"
 * (DESIGN_SYSTEM §4.1): filter bar (tip + status) + gusta tabela, server-side
 * paginacija (`skip`/`take`). Data isključivo kroz `@/api/sales` hook-ove; sve od
 * kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) SALES domen — DRAFT=neutral,
 * POSTED=success, SENT=info, PAID=success, CANCELLED=danger.
 */

const PAGE_SIZE = 50;

/** SALES status → { tone, label } (kanonska mapa §7). */
export function salesStatusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case SALES_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case SALES_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    case SALES_STATUS.SENT:
      return { tone: 'info', label: 'Poslat' };
    case SALES_STATUS.PAID:
      return { tone: 'success', label: 'Plaćen' };
    case SALES_STATUS.CANCELLED:
      return { tone: 'danger', label: 'Storniran' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Vrsta dokumenta → srpska labela. */
export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  [SALES_DOCUMENT_TYPE.PON]: 'Ponuda',
  [SALES_DOCUMENT_TYPE.PROF]: 'Predračun',
  [SALES_DOCUMENT_TYPE.IFR]: 'Račun — roba',
  [SALES_DOCUMENT_TYPE.IFGP]: 'Račun — gotov proizvod',
  [SALES_DOCUMENT_TYPE.IFUSL]: 'Račun — usluga',
  [SALES_DOCUMENT_TYPE.IZVRO]: 'Izvoz — roba',
  [SALES_DOCUMENT_TYPE.IZVGP]: 'Izvoz — gotov proizvod',
  [SALES_DOCUMENT_TYPE.IZVUS]: 'Izvoz — usluga',
  [SALES_DOCUMENT_TYPE.AVR]: 'Avansni',
  [SALES_DOCUMENT_TYPE.REV]: 'Revers',
};

const TYPE_OPTIONS: { value: SalesDocumentType; label: string }[] = [
  { value: SALES_DOCUMENT_TYPE.PON, label: 'Ponuda' },
  { value: SALES_DOCUMENT_TYPE.PROF, label: 'Predračun' },
  { value: SALES_DOCUMENT_TYPE.IFR, label: 'Račun — roba' },
  { value: SALES_DOCUMENT_TYPE.IFGP, label: 'Račun — gotov proizvod' },
  { value: SALES_DOCUMENT_TYPE.IFUSL, label: 'Račun — usluga' },
  { value: SALES_DOCUMENT_TYPE.IZVRO, label: 'Izvoz — roba' },
  { value: SALES_DOCUMENT_TYPE.IZVGP, label: 'Izvoz — gotov proizvod' },
  { value: SALES_DOCUMENT_TYPE.IZVUS, label: 'Izvoz — usluga' },
  { value: SALES_DOCUMENT_TYPE.AVR, label: 'Avansni' },
  { value: SALES_DOCUMENT_TYPE.REV, label: 'Revers' },
];

const STATUS_OPTIONS: { value: SalesStatus; label: string }[] = [
  { value: SALES_STATUS.DRAFT, label: 'U pripremi' },
  { value: SALES_STATUS.POSTED, label: 'Proknjižen' },
  { value: SALES_STATUS.SENT, label: 'Poslat' },
  { value: SALES_STATUS.PAID, label: 'Plaćen' },
  { value: SALES_STATUS.CANCELLED, label: 'Storniran' },
];

const columns: Column<Invoice>[] = [
  {
    key: 'documentNumber',
    header: 'Broj',
    render: (inv) => (
      <span className="tnums font-semibold text-ink">{inv.documentNumber}</span>
    ),
  },
  {
    key: 'documentType',
    header: 'Tip',
    render: (inv) => (
      <span className="text-ink">{DOCUMENT_TYPE_LABEL[inv.documentType] ?? inv.documentType}</span>
    ),
  },
  {
    key: 'customerId',
    header: 'Kupac',
    align: 'right',
    numeric: true,
    render: (inv) => (
      <span className="tnums text-ink-secondary">{inv.customerId ?? '—'}</span>
    ),
  },
  {
    key: 'documentDate',
    header: 'Datum',
    render: (inv) => <span className="text-ink-secondary">{formatDate(inv.documentDate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (inv) => {
      const s = salesStatusMeta(inv.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'grossTotal',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (inv) => (
      <span className="tnums text-ink">
        {formatDecimal(inv.grossTotal)} {inv.currency}
      </span>
    ),
  },
];

export default function FakturisanjePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [documentType, setDocumentType] = useState<SalesDocumentType | ''>('');
  const [status, setStatus] = useState<SalesStatus | ''>('');
  const [page, setPage] = useState(1);
  const [newProformaOpen, setNewProformaOpen] = useState(false);
  const resetPage = () => setPage(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useInvoices({ page, pageSize: PAGE_SIZE, documentType, status });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const hasFilter = documentType !== '' || status !== '';

  return (
    <AppShell>
      <PageHeader
        title="Fakturisanje"
        count={list.data ? `${formatNumber(total)} računa` : undefined}
        actions={
          <Button onClick={() => setNewProformaOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Novi predračun
          </Button>
        }
      />

      <NewProformaDialog
        open={newProformaOpen}
        onClose={() => setNewProformaOpen(false)}
        onCreated={(id) => router.push(`/fakturisanje/${id}`)}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Tip
            <div className="w-56">
              <Select
                placeholder="Svi"
                value={documentType}
                onChange={(e) => {
                  setDocumentType(e.target.value as SalesDocumentType | '');
                  resetPage();
                }}
                options={TYPE_OPTIONS}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as SalesStatus | '');
                  resetPage();
                }}
                options={STATUS_OPTIONS}
              />
            </div>
          </label>

          {hasFilter && (
            <button
              onClick={() => {
                setDocumentType('');
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
          rowKey={(inv) => inv.id}
          onRowActivate={(inv) => router.push(`/fakturisanje/${inv.id}`)}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema računa"
              hint="Promeni filter ili kreiraj predračun (PON/PROF) pa ga prepiši u račun."
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
      </div>
    </AppShell>
  );
}
