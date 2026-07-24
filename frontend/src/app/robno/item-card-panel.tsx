'use client';

import { useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { formatDate, formatDecimal } from '@/lib/format';
import {
  useItemCard,
  ROBNO_KIND,
  type ItemCardLine,
  type RobnoKind,
} from '@/api/robno';

/**
 * Kartica artikla (BigBit paritet) — hronološko kretanje artikla po magacinu sa
 * running stanjem (ulaz/izlaz/stanje). Picker: artikal (#) + magacin (#) + period
 * (od/do). Krajnje stanje = stateAsOf (costing) → kontrolna vrednost u zaglavlju.
 * Kit komponente + tokeni; data isključivo kroz `@/api/robno`.
 */

const KIND_LABEL: Record<RobnoKind, string> = {
  [ROBNO_KIND.UL]: 'Ulaz',
  [ROBNO_KIND.IZ]: 'Izlaz',
  [ROBNO_KIND.NIV]: 'Nivelacija',
  [ROBNO_KIND.PRENOS]: 'Prenos',
  [ROBNO_KIND.VISAK]: 'Višak',
  [ROBNO_KIND.MANJAK]: 'Manjak',
};

const columns: Column<ItemCardLine>[] = [
  {
    key: 'documentDate',
    header: 'Datum',
    render: (r) => <span className="text-ink-secondary">{formatDate(r.documentDate)}</span>,
  },
  {
    key: 'documentNumber',
    header: 'Dokument',
    render: (r) => <span className="tnums font-semibold text-ink">{r.documentNumber}</span>,
  },
  {
    key: 'kind',
    header: 'Vrsta',
    render: (r) => (
      <span className="text-ink">
        {KIND_LABEL[r.kind] ?? r.kind}{' '}
        <span className="tnums text-2xs text-ink-secondary">{r.documentTypeCode}</span>
      </span>
    ),
  },
  {
    key: 'in',
    header: 'Ulaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.direction === 'IN' ? (
        <span className="tnums text-ink">{formatDecimal(r.in, 3)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'out',
    header: 'Izlaz',
    align: 'right',
    numeric: true,
    render: (r) =>
      r.direction === 'OUT' ? (
        <span className="tnums text-ink">{formatDecimal(r.out, 3)}</span>
      ) : (
        <span className="text-ink-disabled">—</span>
      ),
  },
  {
    key: 'balance',
    header: 'Stanje',
    align: 'right',
    numeric: true,
    render: (r) => <span className="tnums font-semibold text-ink">{formatDecimal(r.balance, 3)}</span>,
  },
];

export function ItemCardPanel() {
  // Odvojeno „uneto" (input) od „primenjeno" (query) — upit kreće tek na Prikaži.
  const [itemInput, setItemInput] = useState('');
  const [warehouseInput, setWarehouseInput] = useState('1');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState<{
    itemId: number | null;
    warehouseId: number | null;
    from?: string;
    to?: string;
  }>({ itemId: null, warehouseId: null });

  const query = useItemCard(applied);
  const card = query.data?.data ?? null;

  const apply = () => {
    const itemId = Number(itemInput);
    const warehouseId = Number(warehouseInput);
    setApplied({
      itemId: Number.isInteger(itemId) && itemId > 0 ? itemId : null,
      warehouseId: Number.isInteger(warehouseId) && warehouseId > 0 ? warehouseId : null,
      from: from || undefined,
      to: to || undefined,
    });
  };

  const rows = card?.lines ?? [];

  return (
    <section className="space-y-3">
      <h2 className="text-md font-semibold text-ink">Kartica artikla</h2>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <div className="w-28">
          <FormField label="Artikal (#)">
            <Input
              type="number"
              value={itemInput}
              onChange={(e) => setItemInput(e.target.value)}
              placeholder="item #"
            />
          </FormField>
        </div>
        <div className="w-24">
          <FormField label="Magacin (#)">
            <Input
              type="number"
              value={warehouseInput}
              onChange={(e) => setWarehouseInput(e.target.value)}
            />
          </FormField>
        </div>
        <div className="w-40">
          <FormField label="Od datuma">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
        </div>
        <div className="w-40">
          <FormField label="Do datuma">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </div>
        <Button type="submit">Prikaži</Button>
      </form>

      {query.error && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
          {(query.error as Error).message}
        </div>
      )}

      {card && (
        <div className="rounded-panel border border-line bg-surface p-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <Summary label="Artikal">
              <span className="text-ink">
                {card.item?.name ?? `#${card.itemId}`}
                {card.item?.code ? (
                  <span className="tnums text-2xs text-ink-secondary"> {card.item.code}</span>
                ) : null}
              </span>
            </Summary>
            <Summary label="Početno stanje">
              <span className="tnums text-ink">{formatDecimal(card.openingBalance, 3)}</span>
            </Summary>
            <Summary label="Ukupan ulaz">
              <span className="tnums text-ink">{formatDecimal(card.totalIn, 3)}</span>
            </Summary>
            <Summary label="Ukupan izlaz">
              <span className="tnums text-ink">{formatDecimal(card.totalOut, 3)}</span>
            </Summary>
            <Summary label="Krajnje stanje">
              <span className="tnums font-semibold text-ink">
                {formatDecimal(card.closingBalance, 3)} {card.item?.unit ?? ''}
              </span>
            </Summary>
          </dl>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.itemLineId}
        loading={query.isLoading}
        empty={
          <EmptyState
            title="Nema kretanja"
            hint="Izaberi artikal i magacin, pa klikni Prikaži. Kartica prati ulaze, izlaze i stanje po magacinu."
          />
        }
      />
    </section>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}
