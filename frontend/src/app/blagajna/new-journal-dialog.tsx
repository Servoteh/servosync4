'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { FormField, Input } from '@/components/ui-kit/form-field';
import { Select } from '@/components/ui-kit/select';
import { Button } from '@/components/ui-kit/button';
import { useCreateCashJournal } from '@/api/blagajna';

/** Modal „Nova blagajna" — naziv + konto blagajne + valuta. */
export function NewJournalDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateCashJournal();
  const [name, setName] = useState('');
  const [accountCode, setAccountCode] = useState('2430');
  const [currency, setCurrency] = useState('RSD');

  const err = (create.error as Error | null)?.message ?? null;

  const submit = () => {
    if (name.trim() === '' || accountCode.trim() === '') return;
    create.mutate(
      { name: name.trim(), accountCode: accountCode.trim(), currency },
      {
        onSuccess: () => {
          setName('');
          onClose();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Nova blagajna"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>
            Otkaži
          </Button>
          <Button onClick={submit} loading={create.isPending}>
            Kreiraj
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
      >
        {err && (
          <div className="rounded-panel border border-status-danger/40 bg-status-danger-bg px-3 py-2 text-sm text-status-danger">
            {err}
          </div>
        )}
        <FormField label="Naziv blagajne" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Glavna blagajna" autoFocus />
        </FormField>
        <div className="flex gap-3">
          <div className="w-32">
            <FormField label="Konto" required hint="npr. 2430">
              <Input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} />
            </FormField>
          </div>
          <div className="w-24">
            <FormField label="Valuta">
              <Select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                options={[
                  { value: 'RSD', label: 'RSD' },
                  { value: 'EUR', label: 'EUR' },
                ]}
              />
            </FormField>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
