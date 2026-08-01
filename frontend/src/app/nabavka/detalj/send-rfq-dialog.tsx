'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { ComboBox } from '@/components/ui-kit/combo-box';
import { formatDecimal } from '@/lib/format';
import { useCustomersLookup, type CustomerLookup } from '@/api/lookups';
import type { useSendRfq, PurchaseRequest } from '@/api/nabavka';

/**
 * Dijalog „Pošalji upit dobavljaču" (send-rfq). Bira dobavljača (komitent iz
 * šifarnika — `useCustomersLookup`) + unosi email, pa POST /requests/:id/send-rfq
 * { supplierId, supplierEmail }. Backend uzima SAMO stavke sa `createRfq=true`;
 * ovde ih prikazujemo kao pregled šta ide u upit. Auto-mail NE obara radnju
 * (DRY-RUN bez RESEND_API_KEY → `emailSent=false`), pa poruku o ishodu
 * prikazujemo prema `emailSent`.
 *
 * TASTATURA: dijalog je `dismissable=false` (unos) — zatvara se samo X/Otkaži;
 * Enter u email polju šalje kad je forma validna.
 */
export function SendRfqDialog({
  open,
  onClose,
  request,
  sendRfq,
}: {
  open: boolean;
  onClose: () => void;
  request: PurchaseRequest;
  sendRfq: ReturnType<typeof useSendRfq>;
}) {
  const [supplier, setSupplier] = useState<CustomerLookup | null>(null);
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);

  const rfqItems = useMemo(() => request.items.filter((it) => it.createRfq), [request.items]);

  // Reset pri (re)otvaranju.
  useEffect(() => {
    if (open) {
      setSupplier(null);
      setEmail('');
      setEmailTouched(false);
      sendRfq.reset();
    }
    // sendRfq.reset je stabilan; namerno ne ulazi u deps da ne re-triggeruje.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSend = supplier != null && emailValid && !sendRfq.isPending;

  const result = sendRfq.data?.data;
  const error = sendRfq.error as Error | null;

  function handleSend() {
    if (!supplier || !emailValid) {
      setEmailTouched(true);
      return;
    }
    sendRfq.mutate(
      { id: request.id, supplierId: supplier.id, supplierEmail: email.trim() },
      { onSuccess: undefined },
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pošalji upit dobavljaču"
      size="lg"
      dismissable={false}
      footer={
        result ? (
          <Button onClick={onClose}>Zatvori</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Otkaži
            </Button>
            <Button onClick={handleSend} loading={sendRfq.isPending} disabled={!canSend}>
              Pošalji upit
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <div
            className={
              result.emailSent
                ? 'rounded-panel border border-status-success/40 bg-status-success-bg px-4 py-3 text-sm text-status-success'
                : 'rounded-panel border border-status-warn/40 bg-status-warn-bg px-4 py-3 text-sm text-status-warn'
            }
          >
            {result.emailSent
              ? `Upit ${result.rfq.rfqNumber} je poslat dobavljaču na mejl.`
              : `Upit ${result.rfq.rfqNumber} je kreiran, ali mejl NIJE poslat (slanje isključeno). Upit ostaje u pripremi — može se poslati ponovo.`}
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <FormField label="Dobavljač" required hint="Komitent iz šifarnika kome ide upit.">
            <ComboBox<CustomerLookup>
              value={supplier}
              onChange={setSupplier}
              useSearch={useCustomersLookup}
              getKey={(c) => c.id}
              getLabel={(c) => c.name}
              getSublabel={(c) => [c.city, c.taxId].filter(Boolean).join(' · ')}
              placeholder="Pretraži dobavljača…"
            />
          </FormField>

          <FormField
            label="Email dobavljača"
            required
            error={emailTouched && !emailValid ? 'Unesi ispravnu email adresu.' : undefined}
          >
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setEmailTouched(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="nabavka@dobavljac.rs"
            />
          </FormField>

          <div className="space-y-2">
            <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              Stavke u upitu ({rfqItems.length})
            </h3>
            {rfqItems.length === 0 ? (
              <p className="text-sm text-ink-secondary">
                Nijedna stavka nije označena za upit (KreirajUpit). Označi stavke pre slanja.
              </p>
            ) : (
              <ul className="divide-y divide-line-soft rounded-control border border-line">
                {rfqItems.map((it) => (
                  <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate text-ink">
                      {it.description ??
                        (it.articleId != null ? `Artikal #${it.articleId}` : '—')}
                    </span>
                    <span className="tnums shrink-0 text-ink-secondary">
                      {formatDecimal(it.quantity, 4)}
                      {it.unit ? ` ${it.unit}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
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
