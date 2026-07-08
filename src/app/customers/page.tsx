'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCustomer, useCustomers, type Customer } from '@/api/directory';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { formatNumber } from '@/lib/format';

const columns: Column<Customer>[] = [
  {
    key: 'name',
    header: 'Naziv',
    render: (r) => <span className="font-semibold text-ink">{r.name}</span>,
  },
  {
    key: 'city',
    header: 'Mesto',
    render: (r) => <span className="text-ink-secondary">{r.city || '—'}</span>,
  },
  {
    key: 'taxId',
    header: 'PIB',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.taxId || '—'}</span>,
  },
  {
    key: 'registrationNumber',
    header: 'Matični broj',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.registrationNumber || '—'}</span>,
  },
  {
    key: 'phone',
    header: 'Telefon',
    render: (r) => <span className="text-ink-secondary">{r.phone || '—'}</span>,
  },
  {
    key: 'email',
    header: 'Email',
    render: (r) => <span className="text-ink-secondary">{r.email || '—'}</span>,
  },
];

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

function salespersonName(c: Customer): string {
  if (!c.salesperson) return '—';
  return [c.salesperson.firstName, c.salesperson.name].filter(Boolean).join(' ') || '—';
}

function CustomerDetail({ id }: { id: number }) {
  const q = useCustomer(id);
  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const c = q.data.data;
  const address =
    [c.address, [c.postalCode, c.city].filter(Boolean).join(' '), c.country]
      .filter(Boolean)
      .join(', ') || '—';

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
      <Field label="Adresa" value={address} />
      <Field label="Kontakt osoba" value={c.contact || '—'} />
      <Field label="Mobilni" value={c.mobile || '—'} />
      <Field label="Faks" value={c.fax || '—'} />
      <Field label="Web" value={c.webAddress || '—'} />
      <Field label="Skraćeni naziv" value={c.shortName || '—'} />
      <Field label="Filijala" value={c.branch || '—'} />
      <Field label="Komercijalista" value={salespersonName(c)} />
      {c.note && (
        <div className="col-span-2 sm:col-span-4">
          <Field label="Napomena" value={c.note} />
        </div>
      )}
    </dl>
  );
}

export default function CustomersPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = useCustomers({ page, q: q.trim() || undefined });

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;

  return (
    <AppShell>
      <PageHeader
        title="Komitenti"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Naziv, PIB, mesto…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <p className="text-sm text-ink-disabled">Podaci iz BigBit-a — samo pregled</p>

        {list.error && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
          expandedKey={expanded}
          renderExpanded={(r) => <CustomerDetail id={r.id} />}
          empty={
            <EmptyState
              title="Nema komitenata"
              hint="Promeni pretragu ili proveri da je BigBit sync popunio podatke."
            />
          }
        />

        {meta && meta.totalPages > 1 && (
          <Pager
            page={meta.page}
            totalPages={meta.totalPages}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
          />
        )}
      </div>
    </AppShell>
  );
}
