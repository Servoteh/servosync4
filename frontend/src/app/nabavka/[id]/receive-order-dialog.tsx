'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { formatDecimal } from '@/lib/format';
import {
  useReceiveOrder,
  type PurchaseOrder,
  type PurchaseOrderItem,
  type ReceiveOrderLineInput,
} from '@/api/nabavka';

/**
 * Prijem robe — minimalni 3-way match dijalog (naručeno vs primljeno,
 * default = naručeno). Po stavci se prikazuje naručena količina i editabilno
 * polje „primljeno" (prefilovano na naručeno, BigBit „IsporucenaKolicina").
 * Šalje POST /orders/:id/receive { lines }. Backend za izostavljenu liniju
 * uzima naručeno; mi ipak šaljemo sve linije eksplicitno radi jasnoće.
 *
 * Razlika (primljeno ≠ naručeno) se ističe kao upozorenje uz stavku — 3-way
 * match signal pre knjiženja. TASTATURA: Enter u polju = potvrdi prijem.
 */
export function ReceiveOrderDialog({
  open,
  onClose,
  order,
}: {
  open: boolean;
  onClose: () => void;
  order: PurchaseOrder;
}) {
  const receive = useReceiveOrder();

  // Uneseno „primljeno" po stavci, kao string (prazan = ostaje naručeno).
  const [received, setReceived] = useState<Record<number, string>>({});

  useEffect(() => {
    if (open) {
      // Default = naručena količina za svaku stavku.
      const seed: Record<number, string> = {};
      for (const it of order.items) seed[it.id] = normalizeDecimal(it.orderedQuantity);
      setReceived(seed);
      receive.reset();
    }
    // receive.reset stabilan; namerno van deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id]);

  const lines = useMemo<ReceiveOrderLineInput[]>(() => {
    return order.items.map((it) => {
      const raw = received[it.id];
      const parsed = parseQty(raw);
      // Prazno/neparsivo → izostavi količinu (backend uzima naručeno).
      return parsed == null ? { itemId: it.id } : { itemId: it.id, receivedQuantity: parsed };
    });
  }, [order.items, received]);

  const anyInvalid = order.items.some((it) => {
    const raw = received[it.id];
    return raw !== undefined && raw !== '' && parseQty(raw) == null;
  });

  const done = receive.isSuccess;
  const error = receive.error as Error | null;

  function handleReceive() {
    if (anyInvalid) return;
    receive.mutate({ orderId: order.id, lines });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Prijem robe — ${order.orderNumber}`}
      size="lg"
      dismissable={false}
      footer={
        done ? (
          <Button onClick={onClose}>Zatvori</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={handleReceive} loading={receive.isPending} disabled={anyInvalid}>
              Proknjiži prijem
            </Button>
          </>
        )
      }
    >
      {done ? (
        <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success">
          Prijem po narudžbenici {order.orderNumber} je proknjižen. Narudžbenica je primljena.
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-secondary">
            Primljena količina je prefilovana na naručenu. Izmeni gde je isporuka
            drugačija (3-way match).
          </p>

          <div className="overflow-x-auto rounded-panel border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="h-9 px-3 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                    Opis / artikal
                  </th>
                  <th className="h-9 px-3 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                    Naručeno
                  </th>
                  <th className="h-9 px-3 text-right text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                    Primljeno
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it) => (
                  <ReceiveRow
                    key={it.id}
                    item={it}
                    value={received[it.id] ?? ''}
                    onChange={(v) => setReceived((prev) => ({ ...prev, [it.id]: v }))}
                    onEnter={handleReceive}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {error && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {error.message}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function ReceiveRow({
  item,
  value,
  onChange,
  onEnter,
}: {
  item: PurchaseOrderItem;
  value: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const parsed = parseQty(value);
  const invalid = value !== '' && parsed == null;
  const ordered = Number(String(item.orderedQuantity).replace(',', '.'));
  const mismatch = parsed != null && Number.isFinite(ordered) && parsed !== ordered;

  return (
    <tr className="border-b border-line-soft">
      <td className="px-3 py-2 text-ink">
        {item.description ?? (item.articleId != null ? `Artikal #${item.articleId}` : '—')}
        {mismatch && (
          <span className="ml-2 text-xs text-status-warn">≠ naručeno</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <span className="tnums text-ink-secondary">
          {formatDecimal(item.orderedQuantity, 4)}
          {item.unit ? ` ${item.unit}` : ''}
        </span>
      </td>
      <td className="px-3 py-2 text-right">
        <div className="ml-auto w-32">
          <Input
            inputMode="decimal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onEnter();
              }
            }}
            className={
              invalid
                ? 'text-right border-status-danger focus-visible:border-status-danger'
                : 'text-right'
            }
            aria-invalid={invalid || undefined}
          />
        </div>
      </td>
    </tr>
  );
}

/** „12,5" | „12.5" → 12.5; prazno ili neparsivo → null. */
function parseQty(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Decimal-as-string sa tačkom → prikaz sa zarezom za edit polje. */
function normalizeDecimal(value: string): string {
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return '';
  return String(n).replace('.', ',');
}
