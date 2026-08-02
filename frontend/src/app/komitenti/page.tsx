'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Button } from '@/components/ui-kit/button';
import { Pager } from '@/components/ui-kit/pager';
import { formatNumber } from '@/lib/format';
import { useKomitenti, codeRefLabel, salespersonLabel, type CustomerRow } from '@/api/masters';

/**
 * Matični podaci — Komitenti (obrazac „Lista", DESIGN_SYSTEM §4.1): pretraga u
 * komandnoj traci (naziv / PIB / mesto) + gusta tabela sa server-side paginacijom.
 *
 * Podatak je BigBit cache (`customers`). Unos i izmena imaju pun ekran
 * (`/komitenti/nov`, `/komitenti/detalj?id=N&rezim=izmena`), ali su ZAKLJUČANI
 * odlukom vlasnika od 26.07.2026 — backend na upis vraća 409 BIGBIT_OWNED_READ_ONLY.
 * Detalj je STATIČKA ruta `?id=N` (nikad `[id]` segment — static export).
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

  // Alt+N = nov zapis u aktivnom modulu (DESIGN_SYSTEM §8). Ne otima kucanje u polju.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.key.toLowerCase() !== 'n') return;
      const cilj = e.target as HTMLElement | null;
      const tag = cilj?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      router.push('/komitenti/nov');
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

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

  return (
    <AppShell>
      <PageHeader
        title="Komitenti"
        count={meta ? `${formatNumber(meta.total)} komitenata` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder="Naziv, PIB, mesto…"
            />
            {/* Na 360 px ostaje samo ikona — naslov i pretraga imaju prednost (§11). */}
            <Button
              onClick={() => router.push('/komitenti/nov')}
              title="Nov komitent (Alt+N)"
              aria-label="Nov komitent"
              className="max-sm:w-9 max-sm:px-0"
            >
              <Plus className="h-4 w-4" aria-hidden />
              <span className="max-sm:hidden">Nov komitent</span>
            </Button>
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <p className="text-sm text-ink-disabled">
          Podaci iz BigBit-a — unos i izmena su zaključani odlukom od 26.07.2026 (ekran unosa
          objašnjava šta uraditi)
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
