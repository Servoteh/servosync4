'use client';

import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { formatDecimal } from '@/lib/format';
import {
  useCompensationProposal,
  useCreateCompensation,
  type CompensationProposalLine,
} from '@/api/saldakonti';

/**
 * Kompenzacije (BigBit GRK paritet — FE nad postojećim backendom). Izbor partnera →
 * predlog prebijanja iz otvorenih stavki (potraživanja × obaveze, bilateralni min) →
 * korisnik koriguje iznose → „Kreiraj i knjiži" (KMP nalog kroz PostingEngine).
 * Data kroz `@/api/saldakonti` hooks; kit komponente + tokeni.
 */
export function CompensationPanel() {
  const [partnerInput, setPartnerInput] = useState('');
  const [partnerId, setPartnerId] = useState<number | null>(null);
  const proposal = useCompensationProposal(partnerId);
  const create = useCreateCompensation();

  // Korigovani iznosi po ledgerEntryId (default = suggestedOffset).
  const [amounts, setAmounts] = useState<Record<number, string>>({});

  const data = proposal.data?.data ?? null;
  const lines = data?.lines ?? [];

  const loadProposal = () => {
    const id = Number(partnerInput);
    if (Number.isInteger(id) && id > 0) {
      setPartnerId(id);
      setAmounts({});
    }
  };

  const amountFor = (l: CompensationProposalLine): string =>
    l.ledgerEntryId != null && amounts[l.ledgerEntryId] !== undefined
      ? amounts[l.ledgerEntryId]
      : l.suggestedOffset;

  const totals = useMemo(() => {
    let r = 0;
    let p = 0;
    for (const l of lines) {
      const a = Number(amountFor(l)) || 0;
      if (l.side === 'receivable') r += a;
      else p += a;
    }
    return { r, p, balanced: Math.abs(r - p) < 0.005 && r > 0 };
  }, [lines, amounts]);

  const columns: Column<CompensationProposalLine>[] = [
    {
      key: 'side',
      header: 'Strana',
      render: (l) => (
        <span className="text-ink">{l.side === 'receivable' ? 'Potraživanje' : 'Obaveza'}</span>
      ),
    },
    {
      key: 'documentNumber',
      header: 'Dokument',
      render: (l) => <span className="tnums text-ink-secondary">{l.documentNumber ?? '—'}</span>,
    },
    {
      key: 'openAmount',
      header: 'Otvoreno',
      align: 'right',
      numeric: true,
      render: (l) => <span className="tnums text-ink-secondary">{formatDecimal(l.openAmount)}</span>,
    },
    {
      key: 'offset',
      header: 'Prebija se',
      align: 'right',
      numeric: true,
      render: (l) => (
        <div className="w-28">
          <Input
            type="number"
            step="0.01"
            value={amountFor(l)}
            disabled={l.ledgerEntryId == null}
            onChange={(e) =>
              l.ledgerEntryId != null &&
              setAmounts((a) => ({ ...a, [l.ledgerEntryId as number]: e.target.value }))
            }
          />
        </div>
      ),
    },
  ];

  const submit = () => {
    if (!data || !totals.balanced) return;
    const inputLines = lines
      .filter((l) => l.ledgerEntryId != null && Number(amountFor(l)) > 0)
      .map((l) => ({
        ledgerEntryId: l.ledgerEntryId as number,
        side: l.side,
        amount: String(amountFor(l)),
      }));
    if (inputLines.length === 0) return;
    create.mutate(
      { partnerId: data.partnerId, lines: inputLines, post: true },
      { onSuccess: () => setPartnerId(null) },
    );
  };

  const err =
    (proposal.data?.meta?.error ?? null) ?? (create.error as Error | null)?.message ?? null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-secondary">
          Partner (komitent #)
          <div className="w-40">
            <Input
              type="number"
              value={partnerInput}
              onChange={(e) => setPartnerInput(e.target.value)}
              placeholder="komitent #"
              onKeyDown={(e) => e.key === 'Enter' && loadProposal()}
            />
          </div>
        </label>
        <Button variant="secondary" onClick={loadProposal} disabled={!partnerInput}>
          Predlog kompenzacije
        </Button>
        <div className="ml-auto">
          <Button
            onClick={submit}
            loading={create.isPending}
            disabled={!totals.balanced}
          >
            Kreiraj i knjiži
          </Button>
        </div>
      </div>

      {err && (
        <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-2 text-sm text-status-danger">
          {err}
        </div>
      )}

      {data && (
        <div className="flex gap-6 text-sm">
          <span className="tnums text-ink-secondary">
            Σ potraživanja: <span className="text-ink">{formatDecimal(totals.r)}</span>
          </span>
          <span className="tnums text-ink-secondary">
            Σ obaveze: <span className="text-ink">{formatDecimal(totals.p)}</span>
          </span>
          <span className={`tnums ${totals.balanced ? 'text-status-success' : 'text-status-danger'}`}>
            {totals.balanced ? 'balansirano' : `razlika ${formatDecimal(totals.r - totals.p)}`}
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={lines}
        rowKey={(l) => l.ledgerEntryId ?? `${l.side}:${l.documentNumber ?? l.accountCode}`}
        loading={proposal.isLoading}
        empty={
          <EmptyState
            title={partnerId ? 'Nema stavki za prebijanje' : 'Izaberi partnera'}
            hint="Unesi šifru komitenta pa klikni dugme Predlog kompenzacije — prikazaće se otvorena potraživanja i obaveze."
          />
        }
      />
    </section>
  );
}
