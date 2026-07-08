'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useProject, useProjects, type Project } from '@/api/directory';
import { useCustomersLookup, type CustomerLookup } from '@/api/lookups';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDate, formatNumber } from '@/lib/format';

const columns: Column<Project>[] = [
  {
    key: 'projectNumber',
    header: 'Broj predmeta',
    render: (r) => <span className="tnums font-semibold text-ink">{r.projectNumber}</span>,
  },
  { key: 'projectName', header: 'Naziv', render: (r) => r.projectName || '—' },
  {
    key: 'customer',
    header: 'Komitent',
    render: (r) => <span className="text-ink-secondary">{r.customer?.name ?? '—'}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) =>
      r.status ? (
        <StatusBadge tone="neutral" label={r.status} />
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'openedAt',
    header: 'Otvoren',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.openedAt)}</span>,
  },
  {
    key: 'deadline',
    header: 'Rok',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.deadline)}</span>,
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

function refLine(number: string | null, date: string | null): string {
  if (!number) return '—';
  return date ? `${number} · ${formatDate(date)}` : number;
}

function ProjectDetail({ id }: { id: number }) {
  const q = useProject(id);
  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;
  const p = q.data.data;

  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field label="Komitent" value={p.customer?.name ?? '—'} />
        <Field label="Status" value={p.status || '—'} />
        <Field label="Otvoren" value={formatDate(p.openedAt)} />
        <Field label="Zatvoren" value={formatDate(p.closedAt)} />
        <Field label="Rok" value={formatDate(p.deadline)} />
        <Field label="Ugovor" value={refLine(p.contractNumber, p.contractDate)} />
        <Field label="Porudžbenica" value={refLine(p.orderNumber, p.orderDate)} />
        <Field label="Broj RN-ova" value={<span className="tnums">{formatNumber(p.workOrdersCount)}</span>} />
      </dl>

      {p.description && <p className="text-ink-secondary">{p.description}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Naši kontakti
          </p>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-2">
            <Field label="Referenca" value={p.ourRef || '—'} />
            <Field
              label="Kontakt"
              value={[p.ourContact1, p.ourContact2].filter(Boolean).join(', ') || '—'}
            />
            <Field
              label="Telefon"
              value={[p.ourPhone1, p.ourPhone2].filter(Boolean).join(', ') || '—'}
            />
          </dl>
        </div>
        <div>
          <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Kontakti komitenta
          </p>
          <dl className="grid grid-cols-3 gap-x-6 gap-y-2">
            <Field label="Referenca" value={p.theirRef || '—'} />
            <Field
              label="Kontakt"
              value={[p.theirContact1, p.theirContact2].filter(Boolean).join(', ') || '—'}
            />
            <Field
              label="Telefon"
              value={[p.theirPhone1, p.theirPhone2].filter(Boolean).join(', ') || '—'}
            />
          </dl>
        </div>
      </div>

      {p.nextAction && <Field label="Sledeća akcija" value={p.nextAction} />}
      {p.memo && <p className="text-ink-secondary">{p.memo}</p>}
    </div>
  );
}

export default function ProjectsPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [customer, setCustomer] = useState<CustomerLookup | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const list = useProjects({
    page,
    q: q.trim() || undefined,
    customerId: customer?.id ?? '',
  });

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
  const resetPage = () => setPage(1);

  return (
    <AppShell>
      <PageHeader
        title="Predmeti"
        count={meta ? `${formatNumber(meta.total)} zapisa` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="Broj, naziv, opis…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <p className="text-sm text-ink-disabled">Podaci iz BigBit-a — samo pregled</p>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Komitent
            <div className="w-64">
              <ComboBox<CustomerLookup>
                value={customer}
                onChange={(c) => {
                  setCustomer(c);
                  resetPage();
                }}
                useSearch={useCustomersLookup}
                getKey={(c) => c.id}
                getLabel={(c) => c.name}
                getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
                placeholder="Naziv/PIB komitenta…"
              />
            </div>
          </label>
          {(customer || q) && (
            <button
              onClick={() => {
                setQ('');
                setCustomer(null);
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

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
          renderExpanded={(r) => <ProjectDetail id={r.id} />}
          empty={
            <EmptyState
              title="Nema predmeta"
              hint="Promeni pretragu/filter ili proveri da je BigBit sync popunio podatke."
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
