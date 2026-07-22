'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Star } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Button } from '@/components/ui-kit/button';
import { Select } from '@/components/ui-kit/select';
import { Tabs, KpiTile } from '@/components/ui-kit/tabs';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useZahtevi,
  useInboxMeta,
  ZAHTEV_STATUS,
  REQUEST_KIND_LABEL,
  type ChangeRequest,
  type RequestKind,
} from '@/api/zahtevi';
import { statusMeta } from './_lib/status';
import { moduleOptions, kindOptions } from './_lib/form';

const TAKE = 50;

/** Tekući mesec „YYYY-MM" (za „Moje nagrade ovog meseca"). */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** ★ prikaz ocene (0–5) — finalScore (admin potvrda) ima prednost nad aiScore (predlog). */
function ScoreCell({ r }: { r: ChangeRequest }) {
  const score = r.finalScore ?? r.aiScore;
  if (score == null) return <span className="text-ink-disabled">—</span>;
  return (
    <span
      className="inline-flex items-center gap-1 tnums text-ink"
      title={r.finalScore != null ? 'Potvrđena ocena' : 'AI predlog (nije potvrđen)'}
    >
      <Star
        className={r.finalScore != null ? 'h-3.5 w-3.5 text-status-warn' : 'h-3.5 w-3.5 text-ink-disabled'}
        aria-hidden
      />
      {score}
    </span>
  );
}

function kindLabel(kind: string | null): string {
  if (!kind) return '—';
  return REQUEST_KIND_LABEL[kind as RequestKind] ?? kind;
}

const baseColumns: Column<ChangeRequest>[] = [
  {
    key: 'reqNo',
    header: 'Broj',
    render: (r) => <span className="tnums font-semibold text-ink">{r.reqNo}</span>,
  },
  {
    key: 'title',
    header: 'Naslov',
    render: (r) => <span className="text-ink">{r.title}</span>,
  },
  {
    key: 'module',
    header: 'Modul',
    render: (r) => <span className="text-ink-secondary">{r.module ?? '—'}</span>,
  },
  {
    key: 'kind',
    header: 'Tip',
    render: (r) => <span className="text-ink-secondary">{kindLabel(r.kind)}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => {
      const s = statusMeta(r.status);
      return <StatusBadge tone={s.tone} label={s.label} />;
    },
  },
  {
    key: 'score',
    header: 'Ocena',
    align: 'right',
    render: (r) => <ScoreCell r={r} />,
  },
  {
    key: 'reward',
    header: 'Iznos',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.rewardAmount ? (
        <span className="tnums text-ink">{formatDecimal(r.rewardAmount)} RSD</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'createdAt',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.createdAt)}</span>,
  },
];

/** Admin lista ima i kolonu podnosioca (row-scope ne krije od admina). */
const adminColumns: Column<ChangeRequest>[] = [
  ...baseColumns.slice(0, 5),
  {
    key: 'author',
    header: 'Podnosilac',
    render: (r) => <span className="tnums text-ink-secondary">#{r.createdByUserId}</span>,
  },
  ...baseColumns.slice(5),
];

type AdminTab = 'inbox' | 'all' | 'archive';

const STATUS_FILTER_OPTIONS = ZAHTEV_STATUS.map((s) => ({
  value: s,
  label: statusMeta(s).label,
}));

export default function ZahteviPage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const isAdmin = can(PERMISSIONS.ZAHTEVI_ADMIN);

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
      <PageHeader
        title="Zahtevi"
        actions={
          <Button onClick={() => router.push('/zahtevi/novi')}>
            <Plus className="h-4 w-4" aria-hidden />
            Novi zahtev
          </Button>
        }
      />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        {isAdmin ? <AdminView /> : <MyRequestsView userId={user.id} />}
      </div>
    </AppShell>
  );
}

/* ────────────────────────────────────────────────────── korisnik: „Moji zahtevi" */

function MyRequestsView({ userId }: { userId: number }) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  // „Sve svoje" — bez filtera po statusu (korisnik ima malo zahteva); jednostavno.
  const list = useZahtevi({ page, pageSize: TAKE });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  // „Moje nagrade ovog meseca" — suma iz CONFIRMED/PAID redova tekućeg meseca.
  // BE lista nosi rewardAmount/rewardStatus/rewardMonth po redu, pa računamo klijentski.
  // Napomena: računa nad TRENUTNOM stranom — dovoljno za V1 (korisnik retko ima >50).
  const month = currentMonth();
  const mySum = useMemo(() => {
    return rows
      .filter(
        (r) =>
          r.rewardMonth === month &&
          (r.rewardStatus === 'CONFIRMED' || r.rewardStatus === 'PAID') &&
          r.rewardAmount != null,
      )
      .reduce((sum, r) => sum + Number(r.rewardAmount), 0);
  }, [rows, month]);

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-panel border border-line bg-surface px-4 py-3">
          <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
            Moje nagrade ovog meseca
          </p>
          <p className="mt-1 tnums text-2xl font-semibold text-ink">
            {formatDecimal(mySum)} <span className="text-sm text-ink-secondary">RSD</span>
          </p>
          <p className="mt-0.5 text-2xs text-ink-secondary">
            Potvrđene nagrade za {month}. Konačan obračun radi administrator.
          </p>
        </div>
      </div>

      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <DataTable
        columns={baseColumns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowActivate={(r) => router.push(`/zahtevi/${r.id}`)}
        loading={list.isLoading}
        empty={
          <EmptyState
            title="Nemate zahteva"
            hint={'Podnesite prvi zahtev — bug, dorada ili nova funkcija. Dugme „Novi zahtev" je gore desno.'}
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
      <p className="text-2xs text-ink-secondary">
        Ukupno {formatNumber(total)} vaših zahteva.
      </p>
    </>
  );
}

/* ────────────────────────────────────────────────────────────── admin: tabovi */

const INBOX_STATUSES = ['SUBMITTED', 'ANALYZED', 'TESTING'] as const;

function AdminView() {
  const router = useRouter();
  const [tab, setTab] = useState<AdminTab>('inbox');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [module, setModule] = useState('');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');

  const inboxMeta = useInboxMeta(true);

  const resetPage = () => setPage(1);

  // Filter po tabu: Inbox = statusi koji čekaju admina; Arhiva = ARCHIVED; Svi = filteri.
  const effectiveStatus =
    tab === 'inbox'
      ? status || undefined // inbox: bez izbora = svi „čekajući" (klijentski filter dole)
      : tab === 'archive'
        ? 'ARCHIVED'
        : status || undefined;

  const list = useZahtevi({
    page,
    pageSize: TAKE,
    status: effectiveStatus,
    module: module || undefined,
    kind: kind || undefined,
    q: q || undefined,
  });

  const allRows = list.data?.data ?? [];
  // Inbox bez izabranog statusa: prikaži samo redove u „čekajućim" statusima.
  const rows =
    tab === 'inbox' && !status
      ? allRows.filter((r) => (INBOX_STATUSES as readonly string[]).includes(r.status))
      : allRows;

  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  const counts = inboxMeta.data?.data.byStatus ?? {};
  const inboxTotal = inboxMeta.data?.data.total ?? 0;

  function applySearch() {
    setQ(qInput.trim());
    resetPage();
  }
  function clearFilters() {
    setStatus('');
    setModule('');
    setKind('');
    setQ('');
    setQInput('');
    resetPage();
  }

  return (
    <>
      <Tabs<AdminTab>
        ariaLabel="Prikaz zahteva"
        value={tab}
        onChange={(t) => {
          setTab(t);
          clearFilters();
        }}
        tabs={[
          { key: 'inbox', label: `Inbox${inboxTotal ? ` (${inboxTotal})` : ''}` },
          { key: 'all', label: 'Svi zahtevi' },
          { key: 'archive', label: 'Arhiva' },
        ]}
      />

      {tab === 'inbox' && (
        <div className="flex flex-wrap gap-3">
          <KpiTile
            value={counts.SUBMITTED ?? 0}
            label="Podneti — čeka pregled"
            tone="warn"
            onClick={() => {
              setStatus('SUBMITTED');
              resetPage();
            }}
            active={status === 'SUBMITTED'}
          />
          <KpiTile
            value={counts.ANALYZED ?? 0}
            label="AI obrađen — čeka odluku"
            tone="warn"
            onClick={() => {
              setStatus('ANALYZED');
              resetPage();
            }}
            active={status === 'ANALYZED'}
          />
          <KpiTile
            value={counts.TESTING ?? 0}
            label="Na testiranju"
            tone="info"
            onClick={() => {
              setStatus('TESTING');
              resetPage();
            }}
            active={status === 'TESTING'}
          />
          {status && (
            <button
              onClick={() => {
                setStatus('');
                resetPage();
              }}
              className="self-center rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Prikaži sve
            </button>
          )}
        </div>
      )}

      {tab === 'all' && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Status
            <div className="w-52">
              <Select
                placeholder="Svi"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  resetPage();
                }}
                options={STATUS_FILTER_OPTIONS}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Modul
            <div className="w-44">
              <Select
                placeholder="Svi"
                value={module}
                onChange={(e) => {
                  setModule(e.target.value);
                  resetPage();
                }}
                options={moduleOptions()}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Tip
            <div className="w-44">
              <Select
                placeholder="Svi"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  resetPage();
                }}
                options={kindOptions}
              />
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Pretraga
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applySearch();
              }}
              placeholder="Naslov, opis, broj…"
              className="h-9 w-56 rounded-control border border-line bg-surface px-3 text-sm text-ink placeholder:text-ink-disabled focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)]"
            />
          </label>
          {(status || module || kind || q) && (
            <button
              onClick={clearFilters}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>
      )}

      {list.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <DataTable
        columns={adminColumns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowActivate={(r) => router.push(`/zahtevi/${r.id}`)}
        loading={list.isLoading}
        empty={
          <EmptyState
            title={tab === 'inbox' ? 'Inbox je prazan' : tab === 'archive' ? 'Arhiva je prazna' : 'Nema zahteva'}
            hint={
              tab === 'inbox'
                ? 'Nema zahteva koji čekaju vašu odluku.'
                : 'Promenite filtere ili sačekajte nove zahteve.'
            }
          />
        }
      />

      {totalPages > 1 && tab !== 'inbox' && (
        <Pager
          page={page}
          totalPages={totalPages}
          onPrev={() => setPage((p) => Math.max(1, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages, p + 1))}
        />
      )}
      {tab !== 'inbox' && (
        <p className="text-2xs text-ink-secondary">Ukupno {formatNumber(total)} zahteva.</p>
      )}
    </>
  );
}
