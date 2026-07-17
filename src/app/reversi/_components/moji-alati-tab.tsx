'use client';

import { useMemo } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { formatDate, formatNumber } from '@/lib/format';
import {
  useMyConsumed,
  useMyCuttingOpenLines,
  useMyIssuedTools,
  useMyMachinesCutting,
  type CuttingOpenLine,
  type MyConsumedRow,
  type MyIssuedRow,
  type MyMachineCuttingRow,
} from '@/api/reversi';
import { DocStatusBadge, tableEmpty } from './common';

/** Prekoračen rok (RB-29) — `expected_return_date < danas`. */
function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) < new Date().toISOString().slice(0, 10);
}

/** Normalizovana kartica reznog alata (spoj 2 izvora — mašine + potpisano). */
interface CuttingCardRow {
  lineId: string;
  machineCode: string;
  barcode: string | null;
  naziv: string;
  klasa: string | null;
  remaining: number;
  returned: number;
  unit: string;
  signedBy: string | null;
  issuedAt: string | null;
  docNumber: string | null;
}

function fromMachineRow(r: MyMachineCuttingRow): CuttingCardRow {
  return {
    lineId: String(r.line_id),
    machineCode: r.recipient_machine_code || '—',
    barcode: r.barcode,
    naziv: r.naziv || r.oznaka || '',
    klasa: r.klasa,
    remaining: Number(r.remaining_quantity ?? r.quantity ?? 0),
    returned: Number(r.returned_quantity ?? 0),
    unit: r.unit || 'kom',
    signedBy: r.issued_to_employee_name,
    issuedAt: r.issued_at,
    docNumber: r.doc_number,
  };
}

function fromOpenLine(r: CuttingOpenLine): CuttingCardRow {
  return {
    lineId: r.lineId,
    machineCode: r.machineCode || '—',
    barcode: r.barcode,
    naziv: r.naziv || r.oznaka || '',
    klasa: null,
    remaining: Number(r.remainingQty ?? 0),
    returned: Number(r.returnedQty ?? 0),
    unit: r.unit || 'kom',
    signedBy: null,
    issuedAt: r.issuedAt,
    docNumber: r.docNumber,
  };
}

function CuttingCard({ r }: { r: CuttingCardRow }) {
  return (
    <article className="rounded-panel border border-line bg-surface p-3">
      <header className="flex items-center justify-between gap-2">
        <span className="tnums text-sm font-semibold text-ink">{r.barcode || '—'}</span>
        <span className="tnums rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">
          {r.machineCode}
        </span>
      </header>
      <div className="mt-1 space-y-0.5">
        <div className="text-sm text-ink">{r.naziv}</div>
        {r.klasa && <div className="text-2xs text-ink-secondary">Klasa: {r.klasa}</div>}
        <div className="text-2xs text-ink-secondary">
          Količina: <strong className="tnums text-ink">{formatNumber(r.remaining)}</strong> {r.unit}
          {r.returned > 0 && <span className="text-ink-disabled"> (vraćeno {formatNumber(r.returned)})</span>}
        </div>
        {r.signedBy && <div className="text-2xs text-ink-secondary">Potpisao: {r.signedBy}</div>}
      </div>
      <footer className="mt-2 flex items-center justify-between text-2xs text-ink-secondary">
        <span>Zadužen {formatDate(r.issuedAt)}</span>
        <span className="tnums text-ink-disabled">{r.docNumber || ''}</span>
      </footer>
    </article>
  );
}

/**
 * Self-service „Moji alati" (paritet 1.0 `mojaZaduzenja`). Tri prikaza:
 *  - Rezni alat na mašinama (RB-27): spoj `v_rev_my_machines_cutting_tools` +
 *    mojih otvorenih reznih linija, dedup po `line_id`, grupisano po mašini,
 *  - Ručni alat na meni (RB-29): + Klasifikacija / Pribor / Rok sa „!" i crvenim
 *    isticanjem kad je istekao (MyIssuedRow već nosi ta polja),
 *  - Potrošeno (potrošni materijal).
 */
export function MojiAlatiTab() {
  const issued = useMyIssuedTools();
  const consumed = useMyConsumed();
  const machinesCutting = useMyMachinesCutting();
  const openLines = useMyCuttingOpenLines();

  // RB-27 — spoj 2 rezna izvora (mašine + potpisano), dedup po line_id, grupa/mašina.
  const cuttingByMachine = useMemo(() => {
    const seen = new Set<string>();
    const rows: CuttingCardRow[] = [];
    for (const r of (machinesCutting.data?.data ?? []).map(fromMachineRow)) {
      if (seen.has(r.lineId)) continue;
      seen.add(r.lineId);
      rows.push(r);
    }
    for (const r of (openLines.data?.data ?? []).map(fromOpenLine)) {
      if (seen.has(r.lineId)) continue;
      seen.add(r.lineId);
      rows.push(r);
    }
    const byMachine = new Map<string, CuttingCardRow[]>();
    for (const r of rows) {
      const list = byMachine.get(r.machineCode) ?? [];
      list.push(r);
      byMachine.set(r.machineCode, list);
    }
    return { total: rows.length, keys: [...byMachine.keys()].sort(), byMachine };
  }, [machinesCutting.data, openLines.data]);

  const cuttingError = machinesCutting.isError || openLines.isError;
  const cuttingLoading = machinesCutting.isLoading || openLines.isLoading;

  const issuedCols: Column<MyIssuedRow>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    {
      key: 'klas',
      header: 'Klasifikacija',
      render: (r) => <span className="text-ink-secondary">{r.subgroup_label ?? r.group_label ?? '—'}</span>,
    },
    { key: 'sn', header: 'Ser. broj', render: (r) => <span className="text-ink-secondary">{r.serijski_broj ?? '—'}</span> },
    { key: 'pribor', header: 'Pribor', render: (r) => <span className="text-ink-secondary">{r.pribor ?? '—'}</span> },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => `${formatNumber(Number(r.quantity))} ${r.unit}` },
    { key: 'doc', header: 'Revers', render: (r) => <span className="tnums text-ink-secondary">{r.doc_number}</span> },
    { key: 'issued', header: 'Izdato', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.issued_at)}</span> },
    {
      key: 'due',
      header: 'Rok',
      render: (r) => {
        const od = isOverdue(r.expected_return_date);
        if (!r.expected_return_date) return <span className="text-ink-disabled">—</span>;
        return (
          <span className={od ? 'tnums font-medium text-status-danger' : 'tnums text-ink-secondary'}>
            {formatDate(r.expected_return_date)}
            {od && (
              <span className="ml-1" title="Prekoračen rok" aria-label="Prekoračen rok">
                !
              </span>
            )}
          </span>
        );
      },
    },
    { key: 'status', header: 'Status', render: (r) => <DocStatusBadge status={r.document_status} /> },
  ];

  const consumedCols: Column<MyConsumedRow>[] = [
    { key: 'oznaka', header: 'Oznaka', render: (r) => <span className="font-medium">{r.oznaka}</span> },
    { key: 'naziv', header: 'Naziv', render: (r) => r.naziv },
    { key: 'qty', header: 'Kol.', align: 'right', numeric: true, render: (r) => formatNumber(Math.abs(Number(r.quantity))) },
    { key: 'at', header: 'Potrošeno', render: (r) => <span className="tnums text-ink-secondary">{formatDate(r.consumed_at)}</span> },
    { key: 'doc', header: 'Revers', render: (r) => <span className="tnums text-ink-secondary">{r.doc_number ?? '—'}</span> },
  ];

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Rezni alat na mašinama</h2>
          <span className="tnums rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">
            {cuttingByMachine.total}
          </span>
        </div>
        {cuttingError && (
          <div className="rounded-panel border border-status-danger/30 bg-status-danger-bg px-3 py-2 text-xs text-status-danger">
            ⚠ Deo zaduženja nije učitan — prikaz može biti nepotpun.
          </div>
        )}
        {cuttingLoading ? (
          <div className="rounded-panel border border-line bg-surface p-4 text-sm text-ink-secondary">
            Učitavanje…
          </div>
        ) : cuttingByMachine.total === 0 ? (
          <div className="rounded-panel border border-line bg-surface p-4 text-sm text-ink-secondary">
            Nema reznog alata na tvojim mašinama.
          </div>
        ) : (
          <div className="space-y-3">
            {cuttingByMachine.keys.map((mk) => {
              const list = cuttingByMachine.byMachine.get(mk) ?? [];
              return (
                <div key={mk} className="space-y-2">
                  <h3 className="text-xs text-ink-secondary">
                    Mašina <span className="tnums font-medium text-ink">{mk}</span> ({list.length})
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {list.map((r) => (
                      <CuttingCard key={r.lineId} r={r} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Zaduženo na mene</h2>
        <DataTable
          columns={issuedCols}
          rows={issued.data?.data ?? []}
          rowKey={(r) => `${r.document_id}-${r.oznaka}-${r.serijski_broj ?? ''}`}
          loading={issued.isLoading}
          rowClassName={(r) => (isOverdue(r.expected_return_date) ? 'bg-status-danger-bg' : undefined)}
          empty={tableEmpty(issued.isError, 'Nema zaduženja', 'Trenutno nemaš zadužen alat ni opremu.')}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">Potrošeno (potrošni materijal)</h2>
        <DataTable
          columns={consumedCols}
          rows={consumed.data?.data ?? []}
          rowKey={(r) => r.ledger_id}
          loading={consumed.isLoading}
          empty={tableEmpty(consumed.isError, 'Nema potrošnje', 'Nema evidentirane potrošnje na tvoje ime.')}
        />
      </section>
    </div>
  );
}
