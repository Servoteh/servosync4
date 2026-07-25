'use client';

// Tab „Aktivnost kontrole" (K4): poslednje što su ljudi iz kontrole radili —
// završne i međufazne kontrole + obično kucanje (npr. prijem kooperacije), sa
// policama i zbirom za period. Izvor je isti `tech_processes` log koji hrani
// „Evidenciju u proizvodnji" (GET /v1/tech-processes), sužen SERVERSKIM filterima
// `entryKind` / `controllersOnly` (kanon vrste unosa je na backendu, ne ovde).
//
// Prikaz je READ-ONLY: storno/ispravke ostaju u /production-log jer traže
// `tehnologija.write`, koji kontrolor nema.

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Pager } from '@/components/ui-kit/pager';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { Can } from '@/lib/can';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useWorkers, type Worker } from '@/api/structures';
import { usePartLocationCard } from '@/api/part-locations';
import {
  useProductionLog,
  type ProductionLogEntry,
  type TechProcessEntryKind,
} from '@/api/production-log';
import { StatCard, toDateInput } from './helpers';

const filterInput =
  'rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink';

/** Kvalitet dela (0/1/2) — ista mapa kao „Evidencija u proizvodnji". */
const QUALITY_META: Record<number, { tone: Tone; label: string }> = {
  0: { tone: 'success', label: 'Dobar' },
  1: { tone: 'warn', label: 'Dorada' },
  2: { tone: 'danger', label: 'Škart' },
};

/** Vrsta unosa (backend `entryKind`) → badge. */
const ENTRY_KIND_META: Record<TechProcessEntryKind, { tone: Tone; label: string }> = {
  'control-final': { tone: 'info', label: 'Završna kontrola' },
  'control-mid': { tone: 'neutral', label: 'Međufazna' },
  work: { tone: 'neutral', label: 'Kucanje' },
};

const ENTRY_KIND_OPTIONS: { value: '' | TechProcessEntryKind; label: string }[] = [
  { value: '', label: 'Sve' },
  { value: 'control-final', label: 'Završna kontrola' },
  { value: 'control-mid', label: 'Međufazna kontrola' },
  { value: 'work', label: 'Kucanje' },
];

/** Datum pre `n` dana kao yyyy-MM-dd (podrazumevani period = poslednjih 7 dana). */
function daysAgoInput(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateInput(d.toISOString());
}

/**
 * Detalj reda: napomena kontrolora + police na koje su komadi knjiženi (ledger
 * `part_locations` za CEO RN — ne samo za ovo kucanje) + skok na RN.
 */
function EntryDetail({ entry }: { entry: ProductionLogEntry }) {
  const hasWorkOrder = entry.workOrderId > 0;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {entry.entryKind && <StatusBadge {...ENTRY_KIND_META[entry.entryKind]} />}
        <StatusBadge {...(QUALITY_META[entry.qualityTypeId] ?? QUALITY_META[0])} />
        <span className="flex-1" />
        {hasWorkOrder && (
          <Link
            href={`/work-orders?open=${entry.workOrderId}`}
            className="inline-flex items-center gap-1.5 rounded-control border border-line px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:bg-surface-2"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            Otvori RN
          </Link>
        )}
      </div>

      <div>
        <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Napomena kontrolora
        </p>
        <p className="text-ink">{entry.note?.trim() || '—'}</p>
      </div>

      <Can
        permission={PERMISSIONS.LOKACIJE_READ}
        fallback={
          <p className="text-xs text-ink-disabled">
            Police se ne prikazuju — nemaš dozvolu za Lokacije delova.
          </p>
        }
      >
        {hasWorkOrder ? (
          <ShelvesBlock workOrderId={entry.workOrderId} />
        ) : (
          <p className="text-xs text-ink-disabled">
            Red nije vezan za radni nalog (legacy unos) — police se ne mogu prikazati.
          </p>
        )}
      </Can>
    </div>
  );
}

/** Neto stanje po policama za RN (SUM sa predznakom — ledger konvencija §3.1). */
function ShelvesBlock({ workOrderId }: { workOrderId: number }) {
  const card = usePartLocationCard(workOrderId);
  const totals = card.data?.data.totalsByPosition ?? [];

  return (
    <div>
      <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        Police (neto stanje RN-a)
      </p>
      {card.isLoading ? (
        <p className="text-xs text-ink-disabled">Učitavanje…</p>
      ) : card.error ? (
        <p className="text-xs text-status-danger" role="alert">
          Greška pri učitavanju lokacija.
        </p>
      ) : totals.length === 0 ? (
        <p className="text-xs text-ink-disabled">Nema knjiženih lokacija za ovaj nalog.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {totals.map((t) => (
            <li
              key={t.positionId}
              className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-ink"
            >
              <span className="font-semibold">{t.position?.positionCode ?? `#${t.positionId}`}</span>
              <span className="tnums text-ink-secondary">{formatNumber(t.quantity)} kom</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AktivnostTab() {
  const [q, setQ] = useState('');
  const [worker, setWorker] = useState<Worker | null>(null);
  const [entryKind, setEntryKind] = useState<'' | TechProcessEntryKind>('');
  const [qualityTypeId, setQualityTypeId] = useState<number | ''>('');
  // Podrazumevano: samo ovlašćeni kontrolori (tip radnika sa dodatnim ovlašćenjima).
  // Prekidač, ne tvrdo pravilo — legacy kolona zna da bude nepotpuna.
  const [controllersOnly, setControllersOnly] = useState(true);
  const [from, setFrom] = useState(daysAgoInput(7));
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const resetPage = () => setPage(1);

  const list = useProductionLog({
    page,
    q: q.trim() || undefined,
    workerId: worker?.id,
    entryKind: entryKind || undefined,
    qualityTypeId,
    controllersOnly,
    from: from || undefined,
    to: to ? `${to}T23:59:59` : undefined,
    withTotals: true,
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta.pagination;
  const totals = list.data?.meta.totals;
  const hasFilter =
    !!q || !!worker || !!entryKind || qualityTypeId !== '' || !controllersOnly || !!to ||
    from !== daysAgoInput(7);

  const columns: Column<ProductionLogEntry>[] = [
    {
      key: 'enteredAt',
      header: 'Evidentirano',
      render: (r) => (
        <span className="tnums text-ink-secondary">{formatDateTime(r.enteredAt)}</span>
      ),
    },
    {
      key: 'worker',
      header: 'Kontrolor',
      render: (r) => r.worker?.fullName ?? r.worker?.username ?? '—',
    },
    {
      key: 'entryKind',
      header: 'Vrsta',
      render: (r) =>
        r.entryKind ? <StatusBadge {...ENTRY_KIND_META[r.entryKind]} /> : '—',
    },
    {
      key: 'identNumber',
      header: 'RN / Ident',
      render: (r) => <span className="tnums font-semibold text-ink">{r.identNumber}</span>,
    },
    {
      key: 'drawingNumber',
      header: 'Crtež',
      render: (r) => <span className="tnums text-ink-secondary">{r.drawingNumber || '—'}</span>,
    },
    { key: 'partName', header: 'Naziv pozicije', render: (r) => r.partName || '—' },
    {
      key: 'operationNumber',
      header: 'Op.',
      align: 'right',
      numeric: true,
      render: (r) => <span className="tnums text-ink-secondary">{r.operationNumber}</span>,
    },
    {
      key: 'rc',
      header: 'Radni centar',
      render: (r) => r.operation?.workCenterName ?? r.workCenterCode,
    },
    {
      key: 'pieceCount',
      header: 'Kom',
      align: 'right',
      numeric: true,
      render: (r) => (
        // Storno kontra-red ima negativne komade — crveno, kao u Evidenciji.
        <span className={r.pieceCount < 0 ? 'tnums font-semibold text-status-danger' : 'tnums'}>
          {formatNumber(r.pieceCount)}
        </span>
      ),
    },
    {
      key: 'quality',
      header: 'Kvalitet',
      render: (r) => <StatusBadge {...(QUALITY_META[r.qualityTypeId] ?? QUALITY_META[0])} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.isProcessFinished ? (
          <StatusBadge tone="success" label="Završen" />
        ) : (
          <StatusBadge tone="info" label="Otvoren" />
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Unosa (kucanja)" value={formatNumber(totals?.entries ?? 0)} />
        <StatCard label="Σ komada" value={formatNumber(totals?.pieces ?? 0)} tone="accent" />
        <StatCard label="Dobar" value={formatNumber(totals?.good ?? 0)} tone="success" />
        <StatCard
          label="Dorada / škart"
          value={`${formatNumber(totals?.rework ?? 0)} / ${formatNumber(totals?.scrap ?? 0)}`}
          tone="warn"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Pretraga
          <SearchBox
            value={q}
            onChange={(v) => {
              setQ(v);
              resetPage();
            }}
            placeholder="RN / crtež / naziv…"
          />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Vrsta
          <select
            value={entryKind}
            onChange={(e) => {
              setEntryKind(e.target.value as '' | TechProcessEntryKind);
              resetPage();
            }}
            className={filterInput}
          >
            {ENTRY_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-1 text-xs text-ink-secondary">
          Kontrolor
          <div className="w-56">
            <ComboBox<Worker>
              value={worker}
              onChange={(w) => {
                setWorker(w);
                resetPage();
              }}
              // Picker nudi SAMO kontrolore dok je „Samo kontrolori" uključeno —
              // ceo imenik se otvara tek kad se prekidač isključi (isti kriterijum
              // kao filter liste, pa izbor ne može dati prazan rezultat).
              useSearch={(query) =>
                useWorkers({
                  q: query || undefined,
                  active: 'true',
                  pageSize: 20,
                  controllersOnly,
                })
              }
              getKey={(w) => w.id}
              getLabel={(w) => w.fullName ?? w.username}
              placeholder={controllersOnly ? 'Svi kontrolori…' : 'Svi radnici…'}
            />
          </div>
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Kvalitet
          <select
            value={qualityTypeId}
            onChange={(e) => {
              setQualityTypeId(e.target.value === '' ? '' : Number(e.target.value));
              resetPage();
            }}
            className={filterInput}
          >
            <option value="">Svi</option>
            <option value={0}>Dobar</option>
            <option value={1}>Dorada</option>
            <option value={2}>Škart</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Od
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              resetPage();
            }}
            className={filterInput}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Do
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              resetPage();
            }}
            className={filterInput}
          />
        </label>
        <label
          className="flex items-center gap-2 pb-1.5 text-sm text-ink-secondary"
          title="Vrsta posla sa kontrolorskim ovlašćenjima (legacy „Dodatna ovlašćenja“). Isključi ako neko iz kontrole nedostaje — tada i lista i picker pokazuju sve radnike."
        >
          <input
            type="checkbox"
            checked={controllersOnly}
            onChange={(e) => {
              setControllersOnly(e.target.checked);
              // Izabrani kontrolor ne mora postojati u širem/užem skupu — očisti
              // izbor da picker i lista ostanu saglasni.
              setWorker(null);
              resetPage();
            }}
            className="h-4 w-4 rounded border-line"
          />
          Samo kontrolori
        </label>
        {hasFilter && (
          <button
            onClick={() => {
              setQ('');
              setWorker(null);
              setEntryKind('');
              setQualityTypeId('');
              setControllersOnly(true);
              setFrom(daysAgoInput(7));
              setTo('');
              resetPage();
            }}
            className="rounded-control border border-line px-3 py-1.5 text-sm text-ink-secondary hover:bg-surface-2"
          >
            Očisti
          </button>
        )}
      </div>

      {list.error && (
        <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(list.error as Error).message}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        onRowActivate={(r) => setExpanded((e) => (e === r.id ? null : r.id))}
        expandedKey={expanded}
        renderExpanded={(r) => <EntryDetail entry={r} />}
        empty={
          <EmptyState
            title="Nema unosa kontrole"
            hint="Proširi period ili isključi „Samo kontrolori“ — kucanje se obavlja na pogonskom terminalu."
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
  );
}
