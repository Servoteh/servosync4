'use client';

import { useMrpDemand, type MrpDemandItem } from '@/api/mrp';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { StatusBadge } from '@/components/ui-kit/status-badge';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate } from '@/lib/format';
import { coverageMeta, explosionLabel, planMeta, qtyLabel, sourceLabel } from './common';

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-[0.08em] text-ink-disabled">{label}</dt>
      <dd className="text-ink">{value}</dd>
    </div>
  );
}

const itemColumns: Column<MrpDemandItem>[] = [
  {
    key: 'itemCatalogNumber',
    header: 'Kat. broj',
    render: (r) => <span className="tnums font-semibold text-ink">{r.itemCatalogNumber}</span>,
  },
  { key: 'itemName', header: 'Naziv', render: (r) => r.itemName },
  {
    key: 'required',
    header: 'Potrebno',
    align: 'right',
    numeric: true,
    render: (r) => qtyLabel(r.requiredQuantity, r.itemUnit),
  },
  {
    key: 'reserved',
    header: 'Rezervisano',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="text-ink-secondary">{qtyLabel(r.reservedQuantity, r.itemUnit)}</span>
    ),
  },
  {
    key: 'toProcure',
    header: 'Za nabavku',
    align: 'right',
    numeric: true,
    render: (r) => (
      <span className="text-ink-secondary">{qtyLabel(r.toProcureQuantity, r.itemUnit)}</span>
    ),
  },
  {
    key: 'freeStock',
    header: 'Slobodno / pokrivenost',
    render: (r) => {
      const c = coverageMeta(r.freeStock, r.requiredQuantity);
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="tnums text-ink">{qtyLabel(r.freeStock, r.itemUnit)}</span>
          <StatusBadge tone={c.tone} label={c.label} />
        </span>
      );
    },
  },
  {
    key: 'supplier',
    header: 'Dobavljač',
    render: (r) => <span className="text-ink-secondary">{r.supplier?.name ?? '—'}</span>,
  },
  {
    key: 'procurementDate',
    header: 'Rok nabavke',
    render: (r) => (
      <span className="tnums text-ink-secondary">{formatDate(r.procurementDate)}</span>
    ),
  },
];

/** Detalj MRP potrebe (expand red) — zaglavlje + stavke sa slobodnim zalihama. */
export function DemandDetail({ id }: { id: number }) {
  const q = useMrpDemand(id);

  if (q.isLoading) return <span className="text-sm text-ink-disabled">Učitavanje…</span>;
  if (q.error || !q.data)
    return <span className="text-sm text-status-danger">Greška pri učitavanju detalja.</span>;

  const d = q.data.data;
  const plan = planMeta(d.planId);

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={plan.tone} label={plan.label} />
        <span className="tnums text-2xs text-ink-disabled">šifra statusa {d.status}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        <Field
          label="Predmet"
          value={d.project ? `${d.project.projectNumber} — ${d.project.projectName ?? ''}` : `#${d.projectId}`}
        />
        <Field label="Koren crteža" value={d.rootDrawing?.drawingNumber ?? '—'} />
        <Field label="Datum potrebe" value={formatDate(d.demandDate)} />
        <Field label="Izvor" value={sourceLabel(d.source)} />
        <Field label="Nivo eksplozije" value={explosionLabel(d.explosionType)} />
        <Field label="Radnik" value={d.worker?.fullName ?? d.worker?.username ?? '—'} />
        <Field label="Planirana količina" value={qtyLabel(d.plannedQuantity)} />
        <Field label="Napomena" value={d.note || '—'} />
      </dl>

      <div>
        <p className="mb-1.5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
          Stavke ({d.items.length})
        </p>
        {d.items.length === 0 ? (
          <EmptyState title="Potreba nema stavki" />
        ) : (
          <DataTable columns={itemColumns} rows={d.items} rowKey={(r) => r.id} />
        )}
      </div>
    </div>
  );
}
