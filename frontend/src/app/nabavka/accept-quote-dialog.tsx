'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { Input } from '@/components/ui-kit/form-field';
import { formatDecimal } from '@/lib/format';
import {
  useAcceptQuote,
  useCreateOrder,
  type SupplierRfqDetail,
} from '@/api/nabavka';

/**
 * Dijalog Prihvati ponudu (accept-quote). Po stavci upita unosi ponudjenu cenu i
 * rok isporuke, pa POST /nabavka/rfqs/:id/accept. Cena se NE cuva na upitu (sema
 * je nema — BigBit pravilo), vec se vraca u `createOrderDraft`. Posle prihvatanja
 * nudi Napravi narudzbenicu (postojeci createOrder tok, prefill iz drafta) — ne
 * kreira PO automatski. Backend vraca 409 ako je ponuda vec prihvacena.
 *
 * TASTATURA: dijalog je dismissable=false (unos) — zatvara se samo X/Otkazi.
 */
interface LineState {
  rfqItemId: number;
  price: string;
  lead: string;
}

export function AcceptQuoteDialog({
  rfq,
  onClose,
}: {
  rfq: SupplierRfqDetail;
  onClose: () => void;
}) {
  const accept = useAcceptQuote();
  const createOrder = useCreateOrder();

  const [lines, setLines] = useState<LineState[]>(() =>
    rfq.items.map((it) => ({ rfqItemId: it.id, price: '', lead: '' })),
  );
  const setLine = (idx: number, patch: Partial<LineState>) =>
    setLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const result = accept.data?.data ?? null;
  const draft = result?.createOrderDraft ?? null;
  const ordered = createOrder.isSuccess;

  const acceptError = accept.error as Error | null;
  const orderError = createOrder.error as Error | null;

  const handleAccept = () => {
    const items = lines.map((l) => {
      const price = Number(l.price.replace(',', '.'));
      const lead = Number(l.lead);
      return {
        rfqItemId: l.rfqItemId,
        ...(l.price.trim() !== '' && Number.isFinite(price) && price >= 0
          ? { offeredPrice: price }
          : {}),
        ...(l.lead.trim() !== '' && Number.isInteger(lead) && lead >= 0
          ? { offeredLeadTimeDays: lead }
          : {}),
      };
    });
    accept.mutate({ id: rfq.id, items });
  };

  const handleCreateOrder = () => {
    if (!draft) return;
    createOrder.mutate(draft);
  };

  // Preview zbir (samo prikaz — precizna aritmetika je na serveru/Decimal).
  const previewTotal = rfq.items.reduce((sum, it, i) => {
    const price = Number(lines[i]?.price.replace(',', '.'));
    const qty = Number(String(it.quantity).replace(',', '.'));
    return sum + (Number.isFinite(price) ? price * qty : 0);
  }, 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Prihvati ponudu — upit ${rfq.rfqNumber}`}
      size="xl"
      dismissable={false}
      footer={
        ordered ? (
          <Button onClick={onClose}>Zatvori</Button>
        ) : result ? (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Zatvori
            </Button>
            <Button onClick={handleCreateOrder} loading={createOrder.isPending}>
              Napravi narudzbenicu
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={accept.isPending}>
              Otkazi
            </Button>
            <Button onClick={handleAccept} loading={accept.isPending}>
              Prihvati ponudu
            </Button>
          </div>
        )
      }
    >
      {ordered ? (
        <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success">
          Narudzbenica je napravljena iz prihvacene ponude. Vidljiva je u sekciji
          Narudzbenice ispod, gde se potpisuje i prima.
        </div>
      ) : result ? (
        <div className="space-y-4">
          <div className="rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success">
            Ponuda za upit {result.rfq.rfqNumber} je prihvacena. Napravi
            narudzbenicu za dobavljaca ili zatvori (moze i kasnije direktnim
            unosom narudzbenice).
          </div>

          {draft && (
            <div className="space-y-2">
              <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
                Narudzbenica (pregled)
              </h3>
              <ul className="divide-y divide-line-soft rounded-control border border-line">
                {draft.items.map((it, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                  >
                    <span className="min-w-0 truncate text-ink">
                      {it.description ??
                        (it.articleId != null ? `Artikal #${it.articleId}` : '—')}
                    </span>
                    <span className="tnums shrink-0 text-ink-secondary">
                      {formatDecimal(it.orderedQuantity, 4)}
                      {it.unit ? ` ${it.unit}` : ''}
                      {it.unitPrice != null
                        ? ` × ${formatDecimal(it.unitPrice, 2)}`
                        : ' × (bez cene)'}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {orderError && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {orderError.message}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-secondary">
            Unesi ponudjenu cenu i rok isporuke po stavci. Cena ide u narudzbenicu
            (na upitu se ne cuva); prazna polja se preskacu.
          </p>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
                  <th className="py-2 pr-3 font-semibold">Opis / artikal</th>
                  <th className="py-2 px-2 text-right font-semibold">Kolicina</th>
                  <th className="py-2 px-2 text-right font-semibold">Cena</th>
                  <th className="py-2 pl-2 text-right font-semibold">Rok (dana)</th>
                </tr>
              </thead>
              <tbody>
                {rfq.items.map((it, idx) => (
                  <tr key={it.id} className="border-b border-line-soft">
                    <td className="py-2 pr-3 text-ink">
                      {it.description ??
                        (it.articleId != null ? `Artikal #${it.articleId}` : '—')}
                    </td>
                    <td className="py-2 px-2 text-right tnums text-ink-secondary">
                      {formatDecimal(it.quantity, 4)}
                      {it.unit ? ` ${it.unit}` : ''}
                    </td>
                    <td className="py-2 px-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={lines[idx]?.price ?? ''}
                        onChange={(e) => setLine(idx, { price: e.target.value })}
                        placeholder="0,00"
                      />
                    </td>
                    <td className="py-2 pl-2">
                      <Input
                        type="number"
                        step="1"
                        min="0"
                        value={lines[idx]?.lead ?? ''}
                        onChange={(e) => setLine(idx, { lead: e.target.value })}
                        placeholder="—"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
            <span className="text-ink-secondary">Procenjena vrednost</span>
            <span className="tnums font-semibold text-ink">
              {previewTotal > 0 ? `${formatDecimal(previewTotal, 2)} RSD` : '—'}
            </span>
          </div>

          {acceptError && (
            <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-4 py-3 text-sm text-status-danger">
              {acceptError.message}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
