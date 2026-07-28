'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { formatDecimal, formatNumber } from '@/lib/format';
import { useArtikli, codeRefLabel, type ItemRow } from '@/api/masters';

/**
 * Matični podaci — Artikli (obrazac „Lista", DESIGN_SYSTEM §4.1): pretraga u
 * komandnoj traci + filter „Aktivan" + gusta tabela sa server-side paginacijom.
 *
 * Podatak je BigBit cache (`items`, ~91k redova). Unos i izmena imaju pun ekran
 * (`/artikli/nov`, `/artikli/detalj?id=N&rezim=izmena`), ali su ZAKLJUČANI dok
 * `items` ne uđe u zaštićeni skup sync-a — ekran to objašnjava i kaže šta da se uradi
 * (v. `_forma/pravila.ts`, `BRANA_ARTIKAL`). Detalj je STATIČKA ruta `?id=N` (nikad
 * `[id]` segment — static export ga ne izvozi, v. `artikli/detalj/page.tsx`).
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

  // Alt+N = nov zapis u aktivnom modulu (DESIGN_SYSTEM §8). Ne otima kucanje u polju.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      const cilj = e.target as HTMLElement | null;
      const tag = cilj?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      router.push('/artikli/nov');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

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
          <div className="flex items-center gap-2">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Naziv, kataloški broj, barkod…"
            />
            {/* Na 360 px ostaje samo ikona — naslov i pretraga imaju prednost (§11). */}
            <Button
              onClick={() => router.push('/artikli/nov')}
              title="Nov artikal (Alt+N)"
              aria-label="Nov artikal"
              className="max-sm:w-9 max-sm:px-0"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Nov artikal</span>
            </Button>
          </div>
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
            Podaci iz BigBit-a — unos i izmena su zaključani (ekran unosa objašnjava zašto)
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
