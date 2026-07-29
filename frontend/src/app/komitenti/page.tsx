'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { Pager } from '@/components/ui-kit/pager';
import { formatNumber } from '@/lib/format';
import { useKomitenti, codeRefLabel, salespersonLabel, type CustomerRow } from '@/api/masters';

/**
 * Matični podaci — Komitenti (obrazac „Lista", DESIGN_SYSTEM §4.1): pretraga u
 * komandnoj traci (naziv / PIB / mesto) + gusta tabela sa server-side paginacijom.
 *
 * Podatak je BigBit cache (`customers`) — ekran je ČIST PREGLED: unos i izmena
 * komitenta ostaju u BigBit-u (prelazni režim, BACKEND_RULES §3). Detalj se otvara
 * kao STATIČKA ruta `/komitenti/detalj?id=N` (nikad `[id]` segment — static export).
 *
 * JEDINI ekran za komitente od 29.07.2026 — stariji `/customers` je ugašen i
 * preusmeren ovamo. Lista sama ne nosi komercijalne kolone; širina KARTONA zavisi od
 * `masters.read` (backend redakcija), pa zaglavlje samo nagoveštava sloj.
 */

const PAGE_SIZE = 50;

const columns: Column<CustomerRow>[] = [
  {
    key: 'id',
    header: 'Šifra',
    align: 'right',
    numeric: true,
    render: (k) => <span className="tnums font-semibold text-ink">{k.id}</span>,
  },
  {
    key: 'name',
    header: 'Naziv',
    render: (k) => <span className="text-ink">{k.name}</span>,
  },
  {
    key: 'city',
    header: 'Mesto',
    render: (k) => <span className="text-ink-secondary">{k.city || '—'}</span>,
  },
  {
    key: 'taxId',
    header: 'PIB',
    align: 'right',
    numeric: true,
    render: (k) => <span className="tnums text-ink-secondary">{k.taxId || '—'}</span>,
  },
  {
    key: 'codeType',
    header: 'Vrsta šifre',
    render: (k) => (
      <span className="text-ink-secondary">{codeRefLabel(k.codeType) ?? k.codeTypeCode ?? '—'}</span>
    ),
  },
  {
    key: 'salesperson',
    header: 'Prodavac',
    render: (k) => (
      <span className="text-ink-secondary">{salespersonLabel(k.salesperson) ?? '—'}</span>
    ),
  },
];

export default function KomitentiPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useKomitenti({ page, pageSize: PAGE_SIZE, q: q.trim() || undefined });

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const restricted = list.data?.meta.restricted ?? true;

  return (
    <AppShell>
      <PageHeader
        title="Komitenti"
        count={meta ? `${formatNumber(meta.total)} komitenata` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {restricted && (
              <span title="Računi, rabati, provizija, limit i uslovi plaćanja traže dozvolu „masters.read“.">
                <StatusBadge tone="neutral" label="Ograničen prikaz" />
              </span>
            )}
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Naziv, PIB, mesto…"
            />
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a — samo pregled (unos komitenta ostaje u BigBit-u)
        </p>

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(k) => k.id}
          loading={list.isLoading}
          onRowActivate={(k) => router.push(`/komitenti/detalj?id=${k.id}`)}
          empty={
            <EmptyState
              title="Nema komitenata"
              hint="Promeni pretragu ili proveri da je BigBit sync popunio šifarnik komitenata."
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
