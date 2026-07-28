'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Select } from '@/components/ui-kit/select';
import { Pager } from '@/components/ui-kit/pager';
import { formatDecimal, formatNumber } from '@/lib/format';
import { useArtikli, codeRefLabel, type ItemRow } from '@/api/masters';

/**
 * Matični podaci — Artikli (obrazac „Lista", DESIGN_SYSTEM §4.1): pretraga u
 * komandnoj traci + filter „Aktivan" + gusta tabela sa server-side paginacijom.
 *
 * Podatak je BigBit cache (`items`, ~91k redova) — ekran je ČIST PREGLED: unos i
 * izmena artikla ostaju u BigBit-u (prelazni režim, BACKEND_RULES §3). Detalj se
 * otvara kao STATIČKA ruta `/artikli/detalj?id=N` (nikad `[id]` segment — static
 * export ga ne izvozi, v. `artikli/detalj/page.tsx`).
 */

const PAGE_SIZE = 50;

const ACTIVE_OPTIONS = [
  { value: 'true', label: 'Samo aktivni' },
  { value: 'false', label: 'Samo neaktivni' },
];

const columns: Column<ItemRow>[] = [
  {
    key: 'catalogNumber',
    header: 'Kataloški broj',
    render: (a) => <span className="tnums font-semibold text-ink">{a.catalogNumber}</span>,
  },
  {
    key: 'name',
    header: 'Naziv',
    render: (a) => <span className="text-ink">{a.name}</span>,
  },
  {
    key: 'unit',
    header: 'JM',
    render: (a) => <span className="text-ink-secondary">{a.unit || '—'}</span>,
  },
  {
    key: 'group',
    header: 'Grupa',
    render: (a) => (
      <span className="text-ink-secondary">{codeRefLabel(a.group) ?? a.groupCode}</span>
    ),
  },
  {
    key: 'wholesalePrice',
    header: 'VP cena',
    align: 'right',
    numeric: true,
    render: (a) => <span className="tnums text-ink">{formatDecimal(a.wholesalePrice)}</span>,
  },
  {
    key: 'active',
    header: 'Aktivan',
    render: (a) =>
      a.active ? (
        <StatusBadge tone="success" label="Da" />
      ) : (
        <span className="text-ink-disabled">Ne</span>
      ),
  },
];

export default function ArtikliPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [q, setQ] = useState('');
  const [active, setActive] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useArtikli({
    page,
    pageSize: PAGE_SIZE,
    q: q.trim() || undefined,
    active: active === '' ? undefined : active === 'true',
  });

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
        title="Artikli"
        count={meta ? `${formatNumber(meta.total)} artikala` : undefined}
        actions={
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              setPage(1);
            }}
            placeholder="Naziv, kataloški broj, barkod…"
          />
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Aktivan
            <div className="w-48">
              <Select
                placeholder="Svi"
                value={active}
                onChange={(e) => {
                  setActive(e.target.value as '' | 'true' | 'false');
                  setPage(1);
                }}
                options={ACTIVE_OPTIONS}
              />
            </div>
          </label>
          <p className="text-sm text-ink-disabled">
            Podaci iz BigBit-a — samo pregled (unos artikla ostaje u BigBit-u)
          </p>
        </div>

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(a) => a.id}
          loading={list.isLoading}
          onRowActivate={(a) => router.push(`/artikli/detalj?id=${a.id}`)}
          empty={
            <EmptyState
              title="Nema artikala"
              hint="Promeni pretragu ili proveri da je BigBit sync popunio šifarnik artikala."
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
