'use client';

import { AlertTriangle, Info } from 'lucide-react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useOrderMatch,
  MATCH_FINDING_LABEL,
  type MatchFinding,
  type MatchFindingLevel,
  type ThreeWayMatchLine,
  type ThreeWayMatchResult,
} from '@/api/nabavka';

/**
 * 3-WAY MATCH panel — naručeno ↔ primljeno ↔ fakturisano po stavci narudžbenice.
 *
 * ⚠️ POSLOVNO PRAVILO (odluka korisnika): odstupanje se PRIJAVLJUJE, ali NIKAD ne
 * blokira. Ovaj panel je čist prikaz — nema nijedne akcije, ne onemogućava nijedno
 * dugme na ekranu i ne menja tok prijema ni plaćanja.
 *
 * Prikaz: traka nalaza (StatusBadge pilule, kanonski tonovi §7 — WARNING=warn,
 * INFO=info) + gusta tabela po stavci sa `tabular-nums` brojevima i decimalnim
 * zarezom (§6). Data isključivo kroz `@/api/nabavka` hook (frontend/CLAUDE.md §8).
 */

/** Nivo nalaza → kanonski ton (DESIGN_SYSTEM §7): upozorenje = warn, info = info. */
export function findingTone(level: MatchFindingLevel): Tone {
  return level === 'WARNING' ? 'warn' : 'info';
}

/** Pilula jednog nalaza — kratka oznaka + pun tekst u tooltip-u. */
export function FindingBadge({ finding }: { finding: MatchFinding }) {
  return (
    <span title={finding.message} className="inline-flex">
      <StatusBadge
        tone={findingTone(finding.level)}
        label={MATCH_FINDING_LABEL[finding.code] ?? finding.code}
      />
    </span>
  );
}

function Qty({ value, unit }: { value: string; unit: string | null }) {
  return (
    <span className="tnums text-ink">
      {formatDecimal(value, 4)}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

const lineColumns: Column<ThreeWayMatchLine>[] = [
  {
    key: 'lineNo',
    header: 'R.br.',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink-secondary">{l.lineNo}</span>,
  },
  {
    key: 'description',
    header: 'Opis / artikal',
    render: (l) => (
      <span className="text-ink">
        {l.description ?? (l.articleId != null ? `Artikal #${l.articleId}` : '—')}
        {!l.matchable && (
          <span className="ml-2 text-2xs text-ink-secondary">(bez artikla — ne uparuje se)</span>
        )}
      </span>
    ),
  },
  {
    key: 'orderedQty',
    header: 'Naručeno',
    align: 'right',
    numeric: true,
    render: (l) => <Qty value={l.orderedQty} unit={l.unit} />,
  },
  {
    key: 'receivedQty',
    header: 'Primljeno',
    align: 'right',
    numeric: true,
    render: (l) => <Qty value={l.receivedQty} unit={l.unit} />,
  },
  {
    key: 'invoicedQty',
    header: 'Fakturisano',
    align: 'right',
    numeric: true,
    render: (l) => <Qty value={l.invoicedQty} unit={l.unit} />,
  },
  {
    key: 'orderedUnitPrice',
    header: 'Cena naručeno',
    align: 'right',
    numeric: true,
    render: (l) => (
      <span className="tnums text-ink-secondary">{formatDecimal(l.orderedUnitPrice, 2)}</span>
    ),
  },
  {
    key: 'invoicedUnitPrice',
    header: 'Cena faktura',
    align: 'right',
    numeric: true,
    render: (l) => (
      <span className="tnums text-ink-secondary">{formatDecimal(l.invoicedUnitPrice, 2)}</span>
    ),
  },
  {
    key: 'orderedAmount',
    header: 'Iznos naručeno',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.orderedAmount, 2)}</span>,
  },
  {
    key: 'invoicedAmount',
    header: 'Iznos faktura',
    align: 'right',
    numeric: true,
    render: (l) => <span className="tnums text-ink">{formatDecimal(l.invoicedAmount, 2)}</span>,
  },
  {
    key: 'findings',
    header: 'Odstupanje',
    render: (l) =>
      l.findings.length === 0 ? (
        <span className="text-ink-disabled">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {l.findings.map((f, i) => (
            <FindingBadge key={`${f.code}-${i}`} finding={f} />
          ))}
        </div>
      ),
  },
];

export function OrderMatchPanel({ orderId }: { orderId: number }) {
  const query = useOrderMatch(orderId);
  const match = query.data?.data ?? null;

  if (query.isLoading) {
    return (
      <div className="px-4 py-6 text-sm text-ink-secondary">Učitavanje poređenja…</div>
    );
  }
  if (query.error) {
    return (
      <div className="m-4 rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
        {(query.error as Error).message}
      </div>
    );
  }
  if (!match) {
    return (
      <div className="p-4">
        <EmptyState
          title="Nema podataka za poređenje"
          hint="Narudžbenica nije pronađena ili nema stavki."
        />
      </div>
    );
  }

  return (
    <div className="space-y-3 p-4">
      <MatchSummaryHeader match={match} />
      <MatchFindingsBanner match={match} />

      <DataTable
        columns={lineColumns}
        rows={match.lines}
        rowKey={(l) => l.orderItemId}
        empty={
          <EmptyState
            title="Narudžbenica nema stavki"
            hint="Bez stavki nema šta da se poredi."
          />
        }
      />

      <MatchSources match={match} />
    </div>
  );
}

/** Zbir naručeno / fakturisano / razlika — label–vrednost, bez akcija. */
function MatchSummaryHeader({ match }: { match: ThreeWayMatchResult }) {
  const variance = Number(match.totals.varianceAmount);
  const varianceTone =
    !Number.isFinite(variance) || variance === 0
      ? 'text-ink'
      : variance > 0
        ? 'text-status-warn'
        : 'text-ink-secondary';
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-panel border border-line bg-surface-2 px-4 py-3 sm:grid-cols-4">
      <div>
        <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Naručeno (iznos)
        </dt>
        <dd className="mt-1 tnums text-sm text-ink">
          {formatDecimal(match.totals.orderedAmount, 2)} {match.currency}
        </dd>
      </div>
      <div>
        <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Fakturisano (iznos)
        </dt>
        <dd className="mt-1 tnums text-sm text-ink">
          {formatDecimal(match.totals.invoicedAmount, 2)} {match.currency}
        </dd>
      </div>
      <div>
        <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Razlika
        </dt>
        <dd className={`mt-1 tnums text-sm font-semibold ${varianceTone}`}>
          {formatDecimal(match.totals.varianceAmount, 2)} {match.currency}
        </dd>
      </div>
      <div>
        <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Dobavljač
        </dt>
        <dd className="mt-1 text-sm text-ink">
          {match.supplierName ?? `#${match.supplierId}`}
        </dd>
      </div>
    </dl>
  );
}

/**
 * Traka nalaza — nabraja sva odstupanja punim tekstom. Namerno je „obaveštenje",
 * ne greška: ne koristi danger paletu i ne nudi nijednu akciju.
 */
function MatchFindingsBanner({ match }: { match: ThreeWayMatchResult }) {
  if (!match.hasFindings) {
    return (
      <p className="flex items-center gap-2 rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-2 text-sm text-status-success">
        <Info className="h-4 w-4 shrink-0" aria-hidden />
        Naručeno, primljeno i fakturisano se slažu — nema odstupanja.
      </p>
    );
  }
  const tone = match.hasWarnings ? 'warn' : 'info';
  return (
    <div
      className={
        tone === 'warn'
          ? 'rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3'
          : 'rounded-panel border border-status-info/40 bg-status-info-bg px-4 py-3'
      }
    >
      <p
        className={`flex items-center gap-2 text-sm font-medium ${
          tone === 'warn' ? 'text-status-warn' : 'text-status-info'
        }`}
      >
        {tone === 'warn' ? (
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Info className="h-4 w-4 shrink-0" aria-hidden />
        )}
        Odstupanja ({match.findings.length}) — obaveštenje, ne blokira plaćanje.
      </p>
      <ul className="mt-2 space-y-1 text-sm text-ink">
        {match.findings.map((f, i) => (
          <li key={`${f.code}-${f.orderItemId ?? 'doc'}-${i}`} className="flex gap-2">
            <span className="shrink-0 tnums text-ink-secondary">
              {f.lineNo != null ? `${f.lineNo}.` : '—'}
            </span>
            <span>{f.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Izvori poređenja — koji robni ulaz i koja KUF stavka su korišćeni. */
function MatchSources({ match }: { match: ThreeWayMatchResult }) {
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2 px-1 text-2xs text-ink-secondary">
      <span>
        Prijem / faktura:{' '}
        {match.stockDocuments.length === 0
          ? 'nema robnog ulaza'
          : match.stockDocuments
              .map((d) => `${d.documentNumber} (${formatDate(d.documentDate)})`)
              .join(', ')}
      </span>
      <span>
        KUF (ulazna faktura):{' '}
        {match.vatLedger
          ? `${match.vatLedger.documentNumbers.join(', ')} — osnovica ${formatDecimal(
              match.vatLedger.vatBase,
              2,
            )}`
          : 'nije proknjižena'}
      </span>
    </div>
  );
}
