'use client';

import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { FormField } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate, formatDecimal } from '@/lib/format';
import { useCustomersLookup, type CustomerLookup } from '@/api/lookups';
import { useOpenItems, type OpenItem } from '@/api/saldakonti';
import {
  useLinkStatementLine,
  LINE_DIRECTION,
  type BankStatementLine,
} from '@/api/izvodi';

/**
 * Modal za RUČNO povezivanje stavke izvoda sa otvorenom stavkom saldakonta
 * (BigBit „Poveži po BrDok" — fallback kad auto-uparivanje ne pogodi dokument).
 * Tok: izbor komitenta (default = komitent sa stavke ako je uparen) → lista njegovih
 * otvorenih stavki (glavna knjiga) → „Poveži" → POST /izvodi/:id/lines/:lineId/link
 * postavlja matchedCustomerId + matchedLedgerEntryId + referenceNumber → stavka MATCHED.
 *
 * Otvorene stavke se čitaju POSTOJEĆIM saldakonti hook-om `useOpenItems`, filtrirane
 * po komitentu. Backend link ruta traži `ledgerEntryId` (id konkretnog reda glavne
 * knjige); open-items ga izlaže kao `ledgerEntryIds` po dokumentu (id-evi grupe) —
 * povezujemo prvi id grupe (reprezentativna stavka dokumenta).
 *
 * TASTATURA: Esc/klik na pozadinu zatvara (Dialog default).
 */
export function LinkLineDialog({
  statementId,
  line,
  open,
  onClose,
}: {
  statementId: number;
  line: BankStatementLine | null;
  open: boolean;
  onClose: () => void;
}) {
  const link = useLinkStatementLine();
  // Izbor komitenta (override); default filter = komitent sa stavke (matchedCustomerId).
  const [picked, setPicked] = useState<CustomerLookup | null>(null);

  useEffect(() => {
    if (open) setPicked(null);
  }, [open, line?.id]);

  const partnerId = picked?.id ?? line?.matchedCustomerId ?? null;
  const err = (link.error as Error | null)?.message ?? null;

  const doLink = (ledgerEntryId: number) => {
    if (!line) return;
    link.mutate(
      { id: statementId, lineId: line.id, ledgerEntryId },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Poveži stavku sa otvorenom stavkom"
      size="xl"
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose} disabled={link.isPending}>
            Zatvori
          </Button>
        </div>
      }
    >
      {line && (
        <div className="space-y-4">
          <div className="rounded-panel border border-line bg-surface-2 px-3 py-2 text-sm">
            <span className="text-ink-secondary">Stavka izvoda: </span>
            <span className="text-ink">{line.partnerName ?? '—'}</span>
            <span className="tnums text-ink"> · {formatDecimal(line.amount)}</span>
            <span className="text-ink-secondary">
              {' · '}
              {line.direction === LINE_DIRECTION.CREDIT ? 'Priliv' : 'Odliv'}
            </span>
          </div>

          {err && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
              {err}
            </div>
          )}

          <FormField
            label="Komitent"
            hint="Otvorene stavke se filtriraju po izabranom komitentu."
          >
            <ComboBox
              value={picked}
              onChange={setPicked}
              useSearch={useCustomersLookup}
              getKey={(c) => c.id}
              getLabel={(c) => c.name}
              getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
              placeholder="Kucaj naziv komitenta…"
            />
          </FormField>

          {line.matchedCustomerId != null && picked == null && (
            <p className="text-xs text-ink-secondary">
              Prikazane su otvorene stavke uparenog komitenta #{line.matchedCustomerId}.
              Izaberi drugog komitenta iznad da promeniš filter.
            </p>
          )}

          {partnerId != null ? (
            <OpenItemsPicker
              partnerId={partnerId}
              pending={link.isPending}
              onPick={doLink}
            />
          ) : (
            <EmptyState
              title="Izaberi komitenta"
              hint="Kucaj naziv komitenta da se prikažu njegove otvorene stavke."
            />
          )}
        </div>
      )}
    </Dialog>
  );
}

/**
 * OpenItem prošireno sa `ledgerEntryIds` — open-items izlaže id-eve reda glavne
 * knjige po dokumentu (id-evi grupe). Polje je opciono radi kompatibilnosti dok
 * ta ekspozicija ne stigne; kad ga nema, povezivanje reda je onemogućeno.
 */
type OpenItemRow = OpenItem & { ledgerEntryIds?: number[] };

/**
 * Tabela otvorenih stavki jednog komitenta (izveden pogled saldakonta). Izdvojena
 * u pod-komponentu da se `useOpenItems` upit montira TEK kad je komitent poznat
 * (bez filtera bi povukao sve otvorene stavke svih konta).
 */
function OpenItemsPicker({
  partnerId,
  pending,
  onPick,
}: {
  partnerId: number;
  pending: boolean;
  onPick: (ledgerEntryId: number) => void;
}) {
  const q = useOpenItems({ partnerId });
  const items: OpenItemRow[] = q.data?.data ?? [];

  const columns: Column<OpenItemRow>[] = [
    {
      key: 'documentNumber',
      header: 'Dokument',
      render: (it) => <span className="tnums text-ink">{it.documentNumber ?? '—'}</span>,
    },
    {
      key: 'side',
      header: 'Strana',
      render: (it) => (
        <span className="text-ink">
          {it.side === 'receivable' ? 'Potraživanje' : 'Obaveza'}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Otvoreno',
      align: 'right',
      numeric: true,
      render: (it) => <span className="tnums text-ink">{formatDecimal(it.balance)}</span>,
    },
    {
      key: 'dueDate',
      header: 'Dospeće',
      render: (it) => (
        <span className="tnums text-ink-secondary">
          {it.dueDate ? formatDate(it.dueDate) : '—'}
        </span>
      ),
    },
    {
      key: 'akcija',
      header: '',
      align: 'right',
      render: (it) => {
        const ledgerEntryId = it.ledgerEntryIds?.[0] ?? null;
        return (
          <Button
            variant="secondary"
            disabled={pending || ledgerEntryId == null}
            onClick={() => ledgerEntryId != null && onPick(ledgerEntryId)}
            aria-label="Poveži sa ovom stavkom"
          >
            Poveži
          </Button>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={items}
      rowKey={(it) =>
        it.ledgerEntryIds?.[0] ??
        `${it.accountCode}:${it.analyticalCode ?? ''}:${it.documentNumber ?? ''}`
      }
      loading={q.isLoading}
      empty={
        <EmptyState
          title="Nema otvorenih stavki"
          hint="Za izabranog komitenta nema otvorenih (nezatvorenih) stavki u glavnoj knjizi."
        />
      }
    />
  );
}
