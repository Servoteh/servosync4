'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { useCan } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { AppShell } from '@/components/ui-kit/app-shell';
import { PageHeader } from '@/components/ui-kit/page-header';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Pager } from '@/components/ui-kit/pager';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { formatDate, formatDecimal, formatNumber } from '@/lib/format';
import {
  useRezervacije,
  useOslobodiRezervaciju,
  useRezervisiPredracun,
  useRaspolozivo,
  REZERVACIJA_STATUS,
  REZERVACIJA_SOURCE,
  type RezervacijaRow,
  type RezervacijaStatus,
  type RezervacijaSource,
} from '@/api/robno';
import { useInvoices, type Invoice } from '@/api/sales';

/**
 * Rezervacije zaliha (C3). Obrazac „Lista" (DESIGN_SYSTEM §4.1): filter bar
 * (artikal / magacin / status / izvor) + gusta tabela, server-side paginacija
 * (`page`/`pageSize`). Akcije: „Rezerviši robu" (sa predračuna) u zaglavlju i
 * „Oslobodi" (uz razlog) po redu — vraća robu u raspoloživo.
 *
 * Predračun „drži" robu dok se ne izda ili otkaže: OPEN umanjuje raspoloživo na lageru,
 * RELEASED je vraća, CONSUMED znači da je izdatnica robu stvarno razdužila.
 *
 * ULAZ U TOK (review 25.07): rezervacija se ranije nije mogla napraviti NIGDE iz UI-ja —
 * ekran je umeo samo da lista i oslobađa, pa je „Rezerviši" postojalo samo kao API ruta.
 * Zato je ovde dugme „Rezerviši robu" (bira predračun PON/PROF u nacrtu) i provera
 * raspoloživog za (artikal, magacin) iz filtera.
 *
 * STATUSI: kanonska mapa (DESIGN_SYSTEM §7) domen „Robno — rezervacija":
 * OPEN=info, RELEASED=neutral, CONSUMED=success.
 *
 * Data isključivo kroz API hook-ove (`@/api/robno`, `@/api/sales`); sve od kit komponenti
 * i tokena. Statička ruta (bez `[id]` segmenta — static export).
 */

const PAGE_SIZE = 50;

/** Rezervacija status → { tone, label } (kanonska mapa §7). */
function rezervacijaStatusMeta(status: string): { tone: Tone; label: string } {
  switch (status) {
    case REZERVACIJA_STATUS.OPEN:
      return { tone: 'info', label: 'Rezervisano' };
    case REZERVACIJA_STATUS.RELEASED:
      return { tone: 'neutral', label: 'Oslobođeno' };
    case REZERVACIJA_STATUS.CONSUMED:
      return { tone: 'success', label: 'Potrošeno' };
    default:
      return { tone: 'neutral', label: status };
  }
}

/** Izvor rezervacije → srpska labela (terminologija 1.0/QBigTehn). */
const SOURCE_LABEL: Record<string, string> = {
  [REZERVACIJA_SOURCE.invoice]: 'Predračun',
  [REZERVACIJA_SOURCE.order]: 'Porudžbina',
  [REZERVACIJA_SOURCE.manual]: 'Ručno',
};

const STATUS_OPTIONS: { value: RezervacijaStatus; label: string }[] = [
  { value: REZERVACIJA_STATUS.OPEN, label: 'Rezervisano' },
  { value: REZERVACIJA_STATUS.RELEASED, label: 'Oslobođeno' },
  { value: REZERVACIJA_STATUS.CONSUMED, label: 'Potrošeno' },
];

const SOURCE_OPTIONS: { value: RezervacijaSource; label: string }[] = [
  { value: REZERVACIJA_SOURCE.invoice, label: 'Predračun' },
  { value: REZERVACIJA_SOURCE.order, label: 'Porudžbina' },
  { value: REZERVACIJA_SOURCE.manual, label: 'Ručno' },
];

export default function RezervacijePage() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const can = useCan();
  const canWrite = can(PERMISSIONS.ROBNO_WRITE);

  const [itemId, setItemId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [status, setStatus] = useState<RezervacijaStatus | ''>(REZERVACIJA_STATUS.OPEN);
  const [sourceType, setSourceType] = useState<RezervacijaSource | ''>('');
  const [page, setPage] = useState(1);
  const [releasing, setReleasing] = useState<RezervacijaRow | null>(null);
  const [reserveOpen, setReserveOpen] = useState(false);
  const resetPage = () => setPage(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const numeric = (v: string) => {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) || n <= 0 ? ('' as const) : n;
  };

  const list = useRezervacije({
    page,
    pageSize: PAGE_SIZE,
    itemId: numeric(itemId),
    warehouseId: numeric(warehouseId),
    status,
    sourceType,
  });
  const rows = list.data?.data ?? [];
  const total = list.data?.meta.pagination.total ?? 0;
  const totalPages = list.data?.meta.pagination.totalPages ?? 1;

  const columns: Column<RezervacijaRow>[] = [
    {
      key: 'item',
      header: 'Artikal',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{r.itemName ?? `#${r.itemId}`}</div>
          <div className="tnums text-2xs text-ink-secondary">{r.itemCode ?? '—'}</div>
        </div>
      ),
    },
    {
      key: 'warehouseId',
      header: 'Magacin',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">#{r.warehouseId}</span>,
    },
    {
      key: 'quantity',
      header: 'Količina',
      align: 'right',
      numeric: true,
      render: (r) => (
        <span className="tnums font-semibold text-ink">
          {formatDecimal(r.quantity)} {r.unit ?? ''}
        </span>
      ),
    },
    {
      key: 'source',
      header: 'Izvor',
      render: (r) => (
        <span className="text-ink-secondary">
          {SOURCE_LABEL[r.sourceType] ?? r.sourceType}
          {r.sourceId > 0 && <span className="tnums"> #{r.sourceId}</span>}
          {r.sourceLine != null && (
            <span className="tnums text-ink-disabled">/{r.sourceLine}</span>
          )}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const s = rezervacijaStatusMeta(r.status);
        return <StatusBadge tone={s.tone} label={s.label} />;
      },
    },
    {
      key: 'expiresAt',
      header: 'Važi do',
      render: (r) => (
        <span className="text-ink-secondary">{r.expiresAt ? formatDate(r.expiresAt) : '—'}</span>
      ),
    },
    {
      key: 'reason',
      header: 'Razlog / napomena',
      render: (r) => (
        <span className="text-ink-secondary">{r.releaseReason ?? r.note ?? '—'}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (r) =>
        canWrite && r.status === REZERVACIJA_STATUS.OPEN ? (
          <Button
            variant="secondary"
            className="h-7 px-2 text-sm"
            onClick={() => setReleasing(r)}
          >
            Oslobodi
          </Button>
        ) : null,
    },
  ];

  if (isLoading || !user) {
    return (
      <main className="grid flex-1 place-items-center text-sm text-ink-secondary">
        Učitavanje…
      </main>
    );
  }

  const hasFilter =
    itemId !== '' || warehouseId !== '' || status !== '' || sourceType !== '';

  return (
    <AppShell>
      <PageHeader
        title="Rezervacije zaliha"
        count={list.data ? `${formatNumber(total)} rezervacija` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {canWrite && (
              <Button onClick={() => setReserveOpen(true)}>Rezerviši robu</Button>
            )}
            <Button variant="secondary" onClick={() => router.push('/robno')}>
              Lager lista
            </Button>
          </div>
        }
      />

      <ReleaseDialog row={releasing} onClose={() => setReleasing(null)} />
      <ReserveDialog open={reserveOpen} onClose={() => setReserveOpen(false)} />

      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Artikal (šifra)
            <div className="w-32">
              <Input
                type="number"
                min="1"
                inputMode="numeric"
                placeholder="Svi"
                value={itemId}
                onChange={(e) => {
                  setItemId(e.target.value);
                  resetPage();
                }}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Magacin
            <div className="w-28">
              <Input
                type="number"
                min="1"
                inputMode="numeric"
                placeholder="Svi"
                value={warehouseId}
                onChange={(e) => {
                  setWarehouseId(e.target.value);
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
                  setStatus(e.target.value as RezervacijaStatus | '');
                  resetPage();
                }}
                options={STATUS_OPTIONS}
              />
            </div>
          </label>

          <label className="flex flex-col gap-1 text-xs text-ink-secondary">
            Izvor
            <div className="w-44">
              <Select
                placeholder="Svi"
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as RezervacijaSource | '');
                  resetPage();
                }}
                options={SOURCE_OPTIONS}
              />
            </div>
          </label>

          {hasFilter && (
            <button
              onClick={() => {
                setItemId('');
                setWarehouseId('');
                setStatus('');
                setSourceType('');
                resetPage();
              }}
              className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
            >
              Očisti
            </button>
          )}
        </div>

        <AvailabilityStrip
          itemId={numeric(itemId) === '' ? null : (numeric(itemId) as number)}
          warehouseId={
            numeric(warehouseId) === '' ? null : (numeric(warehouseId) as number)
          }
        />

        {list.error && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
            {(list.error as Error).message}
          </div>
        )}

        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={list.isLoading}
          empty={
            <EmptyState
              title="Nema rezervacija"
              hint="Rezervacija nastaje kad predračun zadrži robu za kupca. Promeni filter da vidiš i oslobođene/potrošene."
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
    </AppShell>
  );
}

/**
 * Provera raspoloživog za (artikal, magacin) iz filtera — `raspoloživo = stanje − rezervisano`.
 * Prikazuje se tek kad su oba filtera postavljena (bez njih pitanje nema smisla).
 */
function AvailabilityStrip({
  itemId,
  warehouseId,
}: {
  itemId: number | null;
  warehouseId: number | null;
}) {
  const availability = useRaspolozivo(itemId, warehouseId);
  if (itemId == null || warehouseId == null) return null;

  const row = availability.data?.data;
  const negative = row != null && Number(row.available) <= 0;

  return (
    <div className="flex flex-wrap items-center gap-6 rounded-panel border border-line bg-surface-2 px-4 py-3 text-sm">
      <span className="text-ink-secondary">
        Artikal <span className="tnums text-ink">#{itemId}</span>, magacin{' '}
        <span className="tnums text-ink">#{warehouseId}</span>
      </span>
      {availability.isLoading && <span className="text-ink-secondary">Učitavanje…</span>}
      {availability.error && (
        <span className="text-status-danger">
          {(availability.error as Error).message}
        </span>
      )}
      {row && (
        <>
          <span className="text-ink-secondary">
            Stanje <span className="tnums text-ink">{formatDecimal(row.onHand)}</span>
          </span>
          <span className="text-ink-secondary">
            Rezervisano{' '}
            <span className="tnums text-ink">{formatDecimal(row.reserved)}</span>
          </span>
          <span className="text-ink-secondary">
            Raspoloživo{' '}
            <span
              className={
                negative
                  ? 'tnums font-semibold text-status-danger'
                  : 'tnums font-semibold text-ink'
              }
            >
              {formatDecimal(row.available)}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Rezervacija robe sa predračuna (PON/PROF u nacrtu) — jedna rezervacija po stavci sa
 * artiklom. Idempotentno: ponovni poziv ne duplira, a izmenjenu količinu USKLAĐUJE.
 * Nedovoljno raspoloživo = poruka sa količinama (422 sa servera).
 * Tastatura: Enter/Ctrl+S rezerviše, Esc otkazuje.
 */
function ReserveDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reserve = useRezervisiPredracun();
  const [invoiceId, setInvoiceId] = useState('');
  const [warehouseId, setWarehouseId] = useState('1');
  const [done, setDone] = useState<string | null>(null);

  // Nacrti prodaje (level 250); ponude/predračuni su jedini izvor rezervacije.
  const proformas = useInvoices({ level: 250, pageSize: 100 });
  const options = (proformas.data?.data ?? [])
    .filter((inv: Invoice) => inv.documentType === 'PON' || inv.documentType === 'PROF')
    .map((inv: Invoice) => ({
      value: String(inv.id),
      label: `${inv.documentNumber} — ${formatDate(inv.documentDate)}`,
    }));

  useEffect(() => {
    if (open) {
      setInvoiceId('');
      setWarehouseId('1');
      setDone(null);
      reserve.reset();
    }
    // reserve je stabilan objekat mutacije; namerno zavisimo samo od `open`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const err = (reserve.error as Error | null)?.message ?? null;
  const submit = () => {
    const id = Number.parseInt(invoiceId, 10);
    if (!Number.isInteger(id) || id <= 0) return;
    const wh = Number.parseInt(warehouseId, 10);
    reserve.mutate(
      { invoiceId: id, warehouseId: Number.isInteger(wh) && wh > 0 ? wh : undefined },
      {
        onSuccess: (res) => {
          const d = res.data;
          setDone(
            `Rezervisano: ${d.created} novih, ${d.updated} usklađenih, ${d.skipped} nepromenjenih ` +
              `(magacin #${d.warehouseId}).`,
          );
        },
      },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Rezerviši robu sa predračuna"
      dismissable={!reserve.isPending}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={reserve.isPending}>
            {done ? 'Zatvori' : 'Otkaži'}
          </Button>
          <Button onClick={submit} loading={reserve.isPending} disabled={invoiceId === ''}>
            Rezerviši
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        {done && (
          <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-3 py-2 text-sm text-status-success">
            {done}
          </div>
        )}

        <FormField
          label="Predračun / ponuda"
          hint="Samo nacrti (PON/PROF) — knjižen račun više ne rezerviše, on razdužuje kroz izdatnicu."
        >
          <Select
            placeholder={proformas.isLoading ? 'Učitavanje…' : 'Izaberi dokument'}
            value={invoiceId}
            onChange={(e) => setInvoiceId(e.target.value)}
            options={options}
            autoFocus
          />
        </FormField>

        <FormField label="Magacin" hint="Magacin iz kog se roba drži (podrazumevano 1).">
          <Input
            type="number"
            min="1"
            inputMode="numeric"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          />
        </FormField>

        <p className="text-sm text-ink-secondary">
          Rezerviše se svaka stavka sa artiklom. Ponovni poziv ne duplira rezervaciju —
          izmenjena količina se usklađuje, a nepromenjena preskače.
        </p>
      </form>
    </Dialog>
  );
}

/**
 * Oslobađanje rezervacije uz razlog (upisuje se u `release_reason`, vidi se na listi).
 * Tastatura: Enter/Ctrl+S oslobađa, Esc otkazuje.
 */
function ReleaseDialog({
  row,
  onClose,
}: {
  row: RezervacijaRow | null;
  onClose: () => void;
}) {
  const release = useOslobodiRezervaciju();
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (row) setReason('');
  }, [row]);

  if (!row) return null;

  const err = (release.error as Error | null)?.message ?? null;
  const submit = () => {
    release.mutate(
      { id: row.id, reason: reason.trim() || undefined },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Oslobodi rezervaciju"
      dismissable={!release.isPending}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={release.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={release.isPending}>
            Oslobodi
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}

        <p className="text-sm text-ink-secondary">
          <span className="text-ink">{row.itemName ?? `#${row.itemId}`}</span> — količina{' '}
          <span className="tnums text-ink">
            {formatDecimal(row.quantity)} {row.unit ?? ''}
          </span>{' '}
          iz magacina <span className="tnums">#{row.warehouseId}</span> vraća se u raspoloživo.
        </p>

        <FormField
          label="Razlog"
          hint="Npr. otkazan predračun — ostaje zapisan uz rezervaciju."
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="otkazan predračun"
            autoFocus
          />
        </FormField>
      </form>
    </Dialog>
  );
}
