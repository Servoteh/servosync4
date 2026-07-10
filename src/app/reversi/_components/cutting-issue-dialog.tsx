'use client';

import { useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { newClientEventId, useCuttingIssue, type CuttingTool } from '@/api/reversi';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/**
 * Izdavanje reznog alata na mašinu (rev_issue_cutting_reversal). Mašina se bira
 * iz kompatibilnih šifri (ili slobodan unos), količina + opciona napomena;
 * idempotency ključ po formi.
 */
export function CuttingIssueDialog({ tool, onClose }: { tool: CuttingTool; onClose: () => void }) {
  const issue = useCuttingIssue();
  const [machine, setMachine] = useState(tool.compatibleMachineCodes[0] ?? '');
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [clientEventId] = useState(newClientEventId);

  async function submit() {
    setError(null);
    if (!machine.trim()) return setError('Unesi šifru mašine.');
    try {
      await issue.mutateAsync({
        clientEventId,
        payload: {
          recipient_machine_code: machine.trim(),
          napomena: note.trim() || undefined,
          lines: [{ catalog_id: tool.id, quantity: qty, sort_order: 0 }],
        },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Izdavanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Izdaj na mašinu — ${tool.oznaka}`}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={issue.isPending} onClick={() => void submit()}>Izdaj</Button>
        </div>
      }
    >
      <div className="space-y-3">
        <FormField label="Mašina (šifra)" required>
          {tool.compatibleMachineCodes.length > 0 ? (
            <select className={INPUT} value={machine} onChange={(e) => setMachine(e.target.value)}>
              {tool.compatibleMachineCodes.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input className={INPUT} value={machine} onChange={(e) => setMachine(e.target.value)} placeholder="npr. M12" />
          )}
        </FormField>
        <FormField label="Količina">
          <input className={`${INPUT} w-32`} type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} />
        </FormField>
        <FormField label="Napomena">
          <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>
    </Dialog>
  );
}
