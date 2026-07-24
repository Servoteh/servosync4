'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatNumber } from '@/lib/format';
import { useInventoryCounts, type InventoryCountRow } from '@/api/inventory';
import { NewCountDialog } from './new-count-dialog';
import { CountDetail, popisStatusMeta } from './count-detail';

/**
 * Popis / inventura (Talas E2). Obrazac Master-detalj (DESIGN_SYSTEM 4.2): master
 * lista popisa (broj, datum, magacin, status) + dugme Novi popis; selekcija otvara
 * detalj-panel ISPOD liste (NE [id] ruta -- statican export). Detalj: stavke sa
 * editabilnim Popisano poljem i tab Razlike sa zbirovima, plus Zakljuci popis.
 *
 * Data iskljucivo kroz `@/api/inventory` hook-ove; sve od kit komponenti i tokena.
 * STATUSI: kanonska mapa (DESIGN_SYSTEM 7) POPIS domen -- DRAFT=neutral,
 * COUNTING=info, POSTED=success (popisStatusMeta u count-detail).
 */
export default function PopisPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const canWrite = can(PERMISSIONS.ROBNO_WRITE);

  const [newOpen, setNewOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useInventoryCounts();
  const rows = list.data?.data ?? [];
  const total = rows.length;

  const columns: Column<InventoryCountRow>[] = [
    {
      key: 'countNumber',
      header: 'Broj',
      render: (r) => <span className="tnums font-semibold text-ink">{r.countNumber}</span>,
    },
    {
      key: 'countDate',
      header: 'Datum',
      render: (r) => <span className="text-ink-secondary">{formatDate(r.countDate)}</span>,
    },
    {
      key: 'warehouseId',
      header: 'Magacin',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">#{r.warehouseId}</span>,
    },
    {
      key: 'itemCount',
      header: 'Stavki',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums text-ink-secondary">
          {r.itemCount != null ? formatNumber(r.itemCount) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = popisStatusMeta(r.status);
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
  ];

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
        title="Popis / inventura"
        count={list.data ? `${formatNumber(total)} popisa` : undefined}
        actions={
          canWrite ? (
            <Button onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              Novi popis
            </Button>
          ) : undefined
        }
      />

      <NewCountDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => setSelectedId(id)}
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => setSelectedId(r.id)}
          loading={list.isLoading}
          rowClassName={(r) =>
            r.id === selectedId ? 'bg-accent-subtle shadow-[inset_3px_0_0_var(--accent)]' : undefined
          }
          empty={
            <EmptyState
              title="Nema popisa"
              hint="Kreiraj prvi popis dugmetom Novi popis -- stavke se predpunjavaju stanjem magacina."
            />
          }
        />

        {selectedId != null && <CountDetail countId={selectedId} />}
      </div>
    </AppShell>
  );
}
