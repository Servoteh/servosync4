'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Link2, Plus, Wallet } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useAdvances,
  ADVANCE_DIRECTION,
  ADVANCE_DIRECTION_LABEL,
  type Advance,
  type AdvanceDirection,
} from '@/api/avansi';
import { salesStatusMeta } from '../page';
import {
  IncomingAdvanceDialog,
  LinkFinalDialog,
  MarkPaidDialog,
  type Banner,
} from './advance-dialogs';

/**
 * AVANSNI RAČUNI — lista za oba smera (obrazac „Lista", DESIGN_SYSTEM §4.1):
 * filter bar (smer + „samo nenaplaćeni") + gusta tabela sa server-side paginacijom.
 *
 * DOMEN: avans je `Invoice` sa `documentType = 'AVR'`. Poreski efekat nastaje
 * NAPLATOM (izlazni → PDV obaveza u KIF-u; ulazni → pretporez u KUF-u), pa je
 * „Označi naplatu" ključna akcija, a „Veži na konačni račun" zatvara ciklus
 * (umanjenje na konačnom računu + storno PDV-a avansa).
 *
 * Statusi idu kroz kanonsku mapu fakturisanja (`salesStatusMeta`, DESIGN_SYSTEM §7) —
 * naplaćenost se čita iz kolone „Naplaćeno", ne iz novog badge-a.
 *
 * TASTATURA: Esc = nazad na fakturisanje; ↑/↓ + Enter u tabeli (DataTable).
 */

const PAGE_SIZE = 50;

const DIRECTION_OPTIONS: { value: AdvanceDirection; label: string }[] = [
  { value: ADVANCE_DIRECTION.OUT, label: 'Izdat kupcu' },
  { value: ADVANCE_DIRECTION.IN, label: 'Primljen od dobavljača' },
];

/** Smer → StatusBadge (info = izlazni/naša obaveza, neutral = ulazni/pretporez). */
function directionBadge(direction: string | null) {
  if (direction === ADVANCE_DIRECTION.OUT) {
    return <StatusBadge tone="info" label={ADVANCE_DIRECTION_LABEL[direction]} />;
  }
  if (direction === ADVANCE_DIRECTION.IN) {
    return <StatusBadge tone="neutral" label={ADVANCE_DIRECTION_LABEL[direction]} />;
  }
  return <span className="text-ink-disabled">—</span>;
}

export default function AvansiPage() {
  const { user, isLoading, can } = useAuth();
  const router = useRouter();

  const [direction, setDirection] = useState<AdvanceDirection | ''>('');
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [page, setPage] = useState(1);
  const resetPage = () => setPage(1);

  const [markPaidFor, setMarkPaidFor] = useState<Advance | null>(null);
  const [linkFinalFor, setLinkFinalFor] = useState<Advance | null>(null);
  const [incomingOpen, setIncomingOpen] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Esc = nazad na radnu listu fakturisanja (dok nijedan dijalog nije otvoren —
  // Dialog sam guta Esc za zatvaranje).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (markPaidFor || linkFinalFor || incomingOpen) return;
      e.preventDefault();
      router.push('/fakturisanje');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router, markPaidFor, linkFinalFor, incomingOpen]);

  const list = useAdvances({ page, pageSize: PAGE_SIZE, direction, unpaidOnly });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Naplata/vezivanje su knjigovodstvene radnje: izlazni avans traži SALES_POST,
  // ulazni PDV_COMPUTE. Dugme se nudi samo kad korisnik ima pravo za taj smer.
  const canPostSales = can(PERMISSIONS.SALES_POST);
  const canComputePdv = can(PERMISSIONS.PDV_COMPUTE);
  const canActOn = (adv: Advance) =>
    adv.direction === ADVANCE_DIRECTION.IN ? canComputePdv : canPostSales;

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const columns: Column<Advance>[] = [
    {
      key: 'documentNumber',
      header: 'Broj',
      render: (a) => (
        <span className="tnums font-semibold text-ink">{a.documentNumber}</span>
      ),
    },
    {
      key: 'documentDate',
      header: 'Datum',
      render: (a) => <span className="text-ink-secondary">{formatDate(a.documentDate)}</span>,
    },
    {
      key: 'partner',
      header: 'Komitent',
      render: (a) => (
        <span className="text-ink">
          {a.partnerName ?? (a.partnerId != null ? `#${a.partnerId}` : '—')}
        </span>
      ),
    },
    {
      key: 'direction',
      header: 'Smer',
      render: (a) => directionBadge(a.direction),
    },
    {
      key: 'grossTotal',
      header: 'Bruto',
      align: 'right',
      numeric: true,
      render: (a) => (
        <span className="tnums text-ink">
          {formatDecimal(a.grossTotal)} {a.currency}
        </span>
      ),
    },
    {
      key: 'paidAmount',
      header: 'Naplaćeno',
      align: 'right',
      numeric: true,
      render: (a) =>
        a.paidAt ? (
          <span className="tnums text-ink">
            {formatDecimal(a.paidAmount)}
            <span className="ml-2 text-xs text-ink-secondary">{formatDate(a.paidAt)}</span>
          </span>
        ) : (
          <span className="text-ink-disabled">nenaplaćen</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (a) => {
        const s = salesStatusMeta(a.status);
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    {
      key: 'linked',
      header: 'Vezan za',
      render: (a) =>
        a.linkedFinalDocumentNumber ? (
          <span className="tnums text-ink-secondary">{a.linkedFinalDocumentNumber}</span>
        ) : (
          <span className="text-ink-disabled">—</span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => (
        <div className="flex justify-end gap-2">
          {!a.paidAt && canActOn(a) && (
            <Button
              variant="secondary"
              onClick={() => {
                setBanner(null);
                setMarkPaidFor(a);
              }}
            >
              <Wallet className="h-4 w-4" aria-hidden />
              Označi naplatu
            </Button>
          )}
          {/* Samo IZLAZNI avans može da se odbije na konačnom računu. Tabela
              računa sadrži isključivo naša izlazna dokumenta, pa bi vezivanje
              ulaznog (dobavljačevog) avansa umanjilo iznos za uplatu na NAŠEM
              računu kupcu — i to bi otišlo na SEF. Za ulazni smer veza čeka
              evidenciju ulaznih faktura. */}
          {a.linkedFinalInvoiceId == null &&
            a.direction !== ADVANCE_DIRECTION.IN &&
            canActOn(a) && (
              <Button
                variant="ghost"
                onClick={() => {
                  setBanner(null);
                  setLinkFinalFor(a);
                }}
              >
                <Link2 className="h-4 w-4" aria-hidden />
                Veži na konačni račun
              </Button>
            )}
        </div>
      ),
    },
  ];

  const hasFilter = direction !== '' || unpaidOnly;

  return (
    <AppShell>
      <PageHeader
        title="Avansni računi"
        count={list.data ? `${formatNumber(total)} avansa` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => router.push('/fakturisanje')}>
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Fakturisanje
            </Button>
            {canComputePdv && (
              <Button
                onClick={() => {
                  setBanner(null);
                  setIncomingOpen(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Ulazni avans
              </Button>
            )}
          </div>
        }
      />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Smer
            <div className="w-56">
              <Select
                placeholder="Svi"
                value={direction}
                onChange={(e) => {
                  setDirection(e.target.value as AdvanceDirection | '');
                  resetPage();
                }}
                options={DIRECTION_OPTIONS}
              />
            </div>
          </label>

          <label className="inline-flex items-center gap-2 pb-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={unpaidOnly}
              onChange={(e) => {
                setUnpaidOnly(e.target.checked);
                resetPage();
              }}
              className="h-4 w-4 rounded border-line"
            />
            Samo nenaplaćeni
          </label>

          {hasFilter && (
            <button
              onClick={() => {
                setDirection('');
                setUnpaidOnly(false);
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        {banner && (
          <div
            className={`rounded-panel border px-4 py-3 text-sm ${
              banner.tone === 'success'
                ? 'border-status-success/40 bg-status-success-bg text-status-success'
                : banner.tone === 'warn'
                  ? 'border-status-warn/40 bg-status-warn-bg text-status-warn'
                  : 'border-status-danger/40 bg-status-danger-bg text-status-danger'
            }`}
          >
            {banner.msg}
          </div>
        )}

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
          empty={
            <EmptyState
              title="Nema avansnih računa"
              hint={
                'Izdati avans se pravi sa predračuna (dugme „Napravi avansni račun”), ' +
                'a primljeni se evidentira dugmetom „Ulazni avans”.'
              }
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

      {markPaidFor && (
        <MarkPaidDialog
          advance={markPaidFor}
          onClose={() => setMarkPaidFor(null)}
          onDone={setBanner}
        />
      )}

      {linkFinalFor && (
        <LinkFinalDialog
          advance={linkFinalFor}
          onClose={() => setLinkFinalFor(null)}
          onDone={setBanner}
        />
      )}

      {incomingOpen && (
        <IncomingAdvanceDialog
          onClose={() => setIncomingOpen(false)}
          onDone={setBanner}
        />
      )}
    </AppShell>
  );
}
