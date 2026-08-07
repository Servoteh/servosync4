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
import { useListQueryState, useZapamcenaPozicijaListe } from '@/lib/use-id-param';
import { parseIdParam } from '@/lib/deep-link';
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

  /**
   * IZABRAN POPIS ŽIVI U URL-u (`?popis=N`), ne u `useState`.
   *
   * Izbor je IDENTITET onoga što je na ekranu (panel detalja se crta ispod liste), a
   * kanon repoa je da identitet živi u adresi. Sa `useState` se gubio na sve tri strane:
   * na povratak sa robnog dokumenta (remount strane), na Nazad pregledača (unutar iste
   * rute nije radio NIŠTA) i na osvežavanje. Usput je `listState:/robno/popis` ostajao
   * prazan, pa `listHref('/robno/popis')` nije ni imao šta da vrati.
   *
   * `setValues` radi `router.replace` (ne `push`), pa izbor ne pravi unos u istoriji —
   * inače bi „Nazad" prolazio kroz svaki popis koji je korisnik usput otvorio.
   * `parseIdParam`, a ne goli `Number()`: `?popis=0x10` bi inače otvorio popis 16.
   */
  const { values, resolved, setValues } = useListQueryState({ popis: '' });
  const selectedId = parseIdParam(values.popis);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const list = useInventoryCounts();
  const rows = list.data?.data ?? [];
  const total = rows.length;

  /**
   * MESTO U LISTI. Panel detalja se crta ISPOD liste, pa je korisnik pri zaključivanju
   * popisa skrolovan nadole — povratak sa dokumenta viška ga je vraćao na vrh.
   *
   * `potpis` je NAMERNO konstantan: kad bi bio izabrani popis, klik na drugi red bi
   * obrisao zapis i trznuo skrol na vrh baš u trenutku kad se panel otvara ispod.
   * Skrol-okvir je STRANA (`DataTable` ovde nema `maxHeight`), pa `okvirRef` ide na `div` —
   * hook traži samo element sa `scrollTop`.
   */
  const { okvirRef } = useZapamcenaPozicijaListe({
    kljuc: '/robno/popis',
    potpis: '',
    spremno: resolved && rows.length > 0,
    straneUKesu: list.data ? 1 : 0,
    redova: rows.length,
  });

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
        onCreated={(id) => setValues({ popis: String(id) })}
      />

      <div ref={okvirRef} className="flex-1 space-y-4 overflow-auto p-6">
        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowActivate={(r) => setValues({ popis: String(r.id) })}
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
