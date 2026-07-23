'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Button } from '@/components/ui-kit/button';
import { useCreateCashEntry, type CashDirection } from '@/api/blagajna';

/**
 * Modal uplatnica (IN) / isplatnica (OUT). Iznos + protivkonto + komitent + opis;
 * knjiži se automatski u GK (blagajna ↔ protivkonto). Isplatnica ne sme u minus
 * (backend odbija). TASTATURA: Ctrl+S sačuvaj, Esc otkaži.
 */
export function CashEntryDialog({
  journalId,
  direction,
  open,
  onClose,
}: {
  journalId: number;
  direction: CashDirection;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateCashEntry();
  const [amount, setAmount] = useState('');
  const [contraAccount, setContraAccount] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [description, setDescription] = useState('');
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));

  const isIn = direction === 'IN';
  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    const amt = Number(amount);
    if (!(amt > 0) || contraAccount.trim() === '') return;
    create.mutate(
      {
        journalId,
        input: {
          direction,
          amount: amt,
          entryDate,
          contraAccount: contraAccount.trim(),
          partnerId: partnerId ? Number(partnerId) : null,
          description: description.trim() || null,
        },
      },
      {
        onSuccess: () => {
          setAmount('');
          setContraAccount('');
          setPartnerId('');
          setDescription('');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={isIn ? 'Uplatnica (uplata u blagajnu)' : 'Isplatnica (isplata iz blagajne)'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Knjiži
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            submit();
          }
        }}
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        <div className="flex gap-3">
          <div className="flex-1">
            <FormField label="Iznos" required>
              <Input type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </FormField>
          </div>
          <div className="w-40">
            <FormField label="Datum" required>
              <Input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
            </FormField>
          </div>
        </div>
        <FormField
          label="Protivkonto"
          required
          hint={isIn ? 'odakle gotovina (npr. 2040 kupci)' : 'za šta se isplaćuje (npr. 5xx trošak, 4350 dobavljači)'}
        >
          <Input value={contraAccount} onChange={(e) => setContraAccount(e.target.value)} placeholder="konto" />
        </FormField>
        <FormField label="Komitent (#)">
          <Input type="number" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} placeholder="komitent #" />
        </FormField>
        <FormField label="Opis / svrha">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
      </form>
    </Dialog>
  );
}
