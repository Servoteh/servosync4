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
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useCashJournals,
  useCashEntries,
  type CashJournal,
  type CashEntry,
} from '@/api/blagajna';
import { NewJournalDialog } from './new-journal-dialog';
import { CashEntryDialog } from './cash-entry-dialog';

/**
 * Blagajna (gotovinski dnevnik). Obrazac „Master–detalj" (DESIGN_SYSTEM §4): leva
 * lista blagajni (sa saldom), desno stavke izabrane blagajne + dugmad Uplatnica/
 * Isplatnica. Data isključivo kroz `@/api/blagajna` hooks; kit komponente + tokeni.
 */
function entryStatusMeta(status: string): { tone: Tone; label: string } {
  return status === 'POSTED'
    ? { tone: 'success', label: 'Proknjiženo' }
    : { tone: 'neutral', label: 'Nacrt' };
}

const entryColumns: Column<CashEntry>[] = [
  {
    key: 'entryNumber',
    header: 'Broj',
    render: (e) => <span className="tnums text-ink">{e.entryNumber}</span>,
  },
  {
    key: 'direction',
    header: 'Vrsta',
    render: (e) => (
      <span className="text-ink">{e.direction === 'IN' ? 'Uplatnica' : 'Isplatnica'}</span>
    ),
  },
  {
    key: 'entryDate',
    header: 'Datum',
    render: (e) => <span className="text-ink-secondary">{formatDate(e.entryDate)}</span>,
  },
  {
    key: 'partner',
    header: 'Komitent',
    render: (e) => <span className="tnums text-ink-secondary">{e.partnerId ?? '—'}</span>,
  },
  {
    key: 'contraAccount',
    header: 'Protivkonto',
    render: (e) => <span className="tnums text-ink-secondary">{e.contraAccount}</span>,
  },
  {
    key: 'amount',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (e) => (
      <span className={`tnums ${e.direction === 'IN' ? 'text-status-success' : 'text-ink'}`}>
        {e.direction === 'OUT' ? '−' : ''}
        {formatDecimal(e.amount)}
      </span>
    ),
  },
  {
    key: 'status',
    header: 'Status',
    render: (e) => {
      const m = entryStatusMeta(e.status);
      return <StatusBadge tone={m.tone} label={m.label} />;
    },
  },
];

export default function BlagajnaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const journals = useCashJournals();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newJournalOpen, setNewJournalOpen] = useState(false);
  const [entryDir, setEntryDir] = useState<'IN' | 'OUT' | null>(null);

  const entries = useCashEntries(selectedId);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Prva blagajna se bira automatski.
  useEffect(() => {
    if (selectedId == null && journals.data?.data.length) {
      setSelectedId(journals.data.data[0].id);
    }
  }, [journals.data, selectedId]);

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const journalRows = journals.data?.data ?? [];
  const selected = journalRows.find((j) => j.id === selectedId) ?? null;

  return (
    <AppShell>
      <PageHeader
        title="Blagajna"
        actions={
          <Button variant="secondary" onClick={() => setNewJournalOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Nova blagajna
          </Button>
        }
      />

      <NewJournalDialog open={newJournalOpen} onClose={() => setNewJournalOpen(false)} />
      {selected && entryDir && (
        <CashEntryDialog
          journalId={selected.id}
          direction={entryDir}
          open={entryDir != null}
          onClose={() => setEntryDir(null)}
        />
      )}

      <div className="flex flex-1 gap-4 overflow-hidden p-6">
        {/* Leva lista blagajni */}
        <aside className="w-64 shrink-0 space-y-2 overflow-auto">
          <h2 className="text-sm font-semibold text-ink">Blagajne</h2>
          {journalRows.length === 0 ? (
            <EmptyState title="Nema blagajni" hint="Klikni dugme Nova blagajna gore desno." />
          ) : (
            journalRows.map((j) => (
              <button
                key={j.id}
                onClick={() => setSelectedId(j.id)}
                className={`w-full rounded-panel border px-3 py-2 text-left ${
                  j.id === selectedId
                    ? 'border-accent bg-surface-2'
                    : 'border-line hover:bg-surface-2'
                }`}
              >
                <div className="truncate text-sm text-ink">{j.name}</div>
                <div className="tnums text-2xs text-ink-secondary">
                  konto {j.accountCode} · {j.currency}
                </div>
                <div className="tnums text-sm font-semibold text-ink">
                  {formatDecimal(j.balance)} {j.currency}
                </div>
              </button>
            ))
          )}
        </aside>

        {/* Desno: stavke izabrane blagajne */}
        <div className="flex-1 space-y-3 overflow-auto">
          {selected ? (
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm text-ink-secondary">
                  Stanje:{' '}
                  <span className="tnums text-md font-semibold text-ink">
                    {formatDecimal(selected.balance)} {selected.currency}
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button onClick={() => setEntryDir('IN')}>Uplatnica</Button>
                  <Button variant="secondary" onClick={() => setEntryDir('OUT')}>
                    Isplatnica
                  </Button>
                </div>
              </div>

              <DataTable
                columns={entryColumns}
                rows={entries.data?.data ?? []}
                rowKey={(e) => e.id}
                loading={entries.isLoading}
                empty={
                  <EmptyState
                    title="Nema stavki"
                    hint="Unesi prvu uplatnicu ili isplatnicu — automatski se knjiži u glavnu knjigu."
                  />
                }
              />
            </>
          ) : (
            <EmptyState title="Izaberi blagajnu" hint="Sa liste levo." />
          )}
        </div>
      </div>
    </AppShell>
  );
}
