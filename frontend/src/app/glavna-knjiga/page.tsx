'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { Tabs, type TabItem } from '@/components/ui-kit/tabs';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useJournalEntries,
  useAccountCard,
  GL_STATUS,
  type GlStatus,
  type JournalEntry,
  type AccountCardLine,
} from '@/api/glavna-knjiga';

/**
 * Glavna knjiga: obrazac „Lista" (DESIGN_SYSTEM §4.1) sa dva pogleda kroz Tabs:
 *   • Dnevnik — nalozi (broj/vrsta/godina/datum/status), filter vrsta+godina,
 *     server-side paginacija (`skip`/`take`).
 *   • Kartica konta — unos konta (+ opcioni komitent) → tabela stavki sa tekućim
 *     saldom; zbir duguje/potražuje/saldo u zaglavlju.
 * Data isključivo kroz `@/api/glavna-knjiga` hook-ove; sve od kit komponenti i tokena.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) GK domen — draft=neutral (U pripremi),
 * posted=success (Proknjižen), locked=neutral (Zaključan).
 */

const PAGE_SIZE = 50;

type View = 'dnevnik' | 'kartica';

const VIEW_TABS: TabItem<View>[] = [
  { key: 'dnevnik', label: 'Dnevnik' },
  { key: 'kartica', label: 'Kartica konta' },
];

/** GK status → { tone, label } (kanonska mapa §7). */
export function glStatusMeta(status: GlStatus): { tone: Tone; label: string } {
  switch (status) {
    case GL_STATUS.DRAFT:
      return { tone: 'neutral', label: 'U pripremi' };
    case GL_STATUS.POSTED:
      return { tone: 'success', label: 'Proknjižen' };
    case GL_STATUS.LOCKED:
      return { tone: 'neutral', label: 'Zaključan' };
    default:
      return { tone: 'neutral', label: status };
  }
}

const STATUS_OPTIONS: { value: GlStatus; label: string }[] = [
  { value: GL_STATUS.DRAFT, label: 'U pripremi' },
  { value: GL_STATUS.POSTED, label: 'Proknjižen' },
  { value: GL_STATUS.LOCKED, label: 'Zaključan' },
];

export default function GlavnaKnjigaPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  const [view, setView] = useState<View>('dnevnik');

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

  return (
    <AppShell>
      <PageHeader title="Glavna knjiga" />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <Tabs tabs={VIEW_TABS} value={view} onChange={setView} ariaLabel="Pogled glavne knjige" />
        {view === 'dnevnik' ? (
          <DnevnikView onOpen={(id) => router.push(`/glavna-knjiga/${id}`)} />
        ) : (
          <KarticaKontaView />
        )}
      </div>
    </AppShell>
  );
}

// ───────────────────────────────────────────────────────────── Dnevnik

const journalColumns: Column<JournalEntry>[] = [
  {
    key: 'number',
    header: 'Broj',
    render: (n) => <span className="tnums font-semibold text-ink">{n.number}</span>,
  },
  {
    key: 'orderTypeCode',
    header: 'Vrsta',
    render: (n) => <span className="text-ink">{n.orderTypeCode}</span>,
  },
  {
    key: 'year',
    header: 'Godina',
    align: 'right',
    numeric: true,
    render: (n) => <span className="tnums text-ink-secondary">{n.year}</span>,
  },
  {
    key: 'documentDate',
    header: 'Datum',
    render: (n) => <span className="text-ink-secondary">{formatDate(n.documentDate)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (n) => {
      const s = glStatusMeta(n.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
];

function DnevnikView({ onOpen }: { onOpen: (id: number) => void }) {
  const [orderType, setOrderType] = useState('');
  const [year, setYear] = useState<number | ''>('');
  const [status, setStatus] = useState<GlStatus | ''>('');
  const [page, setPage] = useState(1);
  const resetPage = () => setPage(1);

  const list = useJournalEntries({ page, pageSize: PAGE_SIZE, orderType, year, status });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const hasFilter = orderType !== '' || year !== '' || status !== '';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Vrsta naloga
          <div className="w-40">
            <Input
              placeholder="Sve"
              value={orderType}
              onChange={(e) => {
                setOrderType(e.target.value);
                resetPage();
              }}
            />
          </div>
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Godina
          <div className="w-28">
            <Input
              type="number"
              inputMode="numeric"
              placeholder="Sve"
              value={year === '' ? '' : year}
              onChange={(e) => {
                const v = e.target.value.trim();
                setYear(v === '' ? '' : Number(v));
                resetPage();
              }}
            />
          </div>
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Status
          <div className="w-44">
            <Select
              placeholder="Svi"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as GlStatus | '');
                resetPage();
              }}
              options={STATUS_OPTIONS}
            />
          </div>
        </label>

        {hasFilter && (
          <button
            onClick={() => {
              setOrderType('');
              setYear('');
              setStatus('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}

        <span className="ml-auto self-center text-sm text-ink-secondary">
          {list.data ? `${formatNumber(total)} naloga` : ''}
        </span>
      </div>

      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <DataTable
        columns={journalColumns}
        rows={rows}
        rowKey={(n) => n.id}
        onRowActivate={(n) => onOpen(n.id)}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="Nema naloga"
            hint="Promeni filter vrste/godine/statusa ili proknjiži prvi dokument."
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
  );
}

// ───────────────────────────────────────────────────────────── Kartica konta

const cardColumns: Column<AccountCardLine>[] = [
  {
    key: 'journalNumber',
    header: 'Nalog',
    render: (r) => <span className="tnums font-semibold text-ink">{r.journalNumber}</span>,
  },
  {
    key: 'documentDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.documentDate)}</span>,
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => <span className="tnums text-ink">{r.documentNumber ?? '—'}</span>,
  },
  {
    key: 'analyticalCode',
    header: 'Komitent',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink-secondary">{r.analyticalCode ?? '—'}</span>,
  },
  {
    key: 'description',
    header: 'Opis',
    render: (r) => <span className="text-ink-secondary">{r.description ?? '—'}</span>,
  },
  {
    key: 'debit',
    header: 'Duguje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.debit)}</span>,
  },
  {
    key: 'credit',
    header: 'Potražuje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums text-ink">{formatDecimal(r.credit)}</span>,
  },
  {
    key: 'balance',
    header: 'Saldo',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.balance)}</span>,
  },
];

function KarticaKontaView() {
  // Uneti (draft) filteri vs primenjeni (submitted) — upit ide tek na „Prikaži"/Enter.
  const [accountInput, setAccountInput] = useState('');
  const [komitentInput, setKomitentInput] = useState('');
  const [applied, setApplied] = useState<{ account: string; komitent: number | '' }>({
    account: '',
    komitent: '',
  });

  const card = useAccountCard(applied.account, { analyticalCode: applied.komitent });
  const rows = card.data?.data ?? [];
  const meta = card.data?.meta;

  const canSubmit = accountInput.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    setApplied({
      account: accountInput.trim(),
      komitent: komitentInput.trim() === '' ? '' : Number(komitentInput.trim()),
    });
  };

  const summary = useMemo(() => {
    if (!meta) return null;
    return [
      { label: 'Duguje', value: formatDecimal(meta.totalDebit) },
      { label: 'Potražuje', value: formatDecimal(meta.totalCredit) },
      { label: 'Saldo', value: formatDecimal(meta.balance) },
    ];
  }, [meta]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Konto *
          <div className="w-40">
            <Input
              placeholder="npr. 2020"
              value={accountInput}
              onChange={(e) => setAccountInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </label>

        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Komitent
          <div className="w-36">
            <Input
              type="number"
              inputMode="numeric"
              placeholder="Svi"
              value={komitentInput}
              onChange={(e) => setKomitentInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
        </label>

        <Button onClick={submit} disabled={!canSubmit}>
          Prikaži
        </Button>

        {summary && (
          <div className="ml-auto flex flex-wrap items-end gap-6">
            {summary.map((s) => (
              <div key={s.label} className="text-right">
                <div className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                  {s.label}
                </div>
                <div className="tnums text-md font-semibold text-ink">{s.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {card.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(card.error as Error).message}
        </div>
      )}

      {applied.account === '' ? (
        <EmptyState
          title="Unesi konto"
          hint="Ukucaj šifru konta (npr. 2020) i po želji komitenta, pa „Prikaži”."
        />
      ) : (
        <DataTable
          columns={cardColumns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={card.isLoading}
          empty={
            <EmptyState
              title="Nema stavki"
              hint="Za dati konto (i komitenta) nema proknjiženih stavki u periodu."
            />
          }
        />
      )}
    </div>
  );
}
