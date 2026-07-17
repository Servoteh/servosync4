'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { SearchBox } from '@/components/ui-kit/search-box';
import { ScanLine } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  newClientEventId,
  useCuttingIssue,
  useEmployeeLookup,
  useReversiMachines,
  type CuttingTool,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/**
 * Izdavanje reznog alata na mašinu (rev_issue_cutting_reversal). RB-36 — mašina se
 * bira iz PUNOG spiska `v_rev_machines` (kompatibilne su na vrhu), skener ZADU-M- i
 * validacija da mašina postoji u evidenciji (blokira izdavanje na fantomsku šifru).
 * OBAVEZAN potpisnik preuzimanja (radnik — DB fn to zahteva); idempotency ključ po formi.
 */
export function CuttingIssueDialog({ tool, onClose }: { tool: CuttingTool; onClose: () => void }) {
  const issue = useCuttingIssue();
  const machinesQ = useReversiMachines();
  const [machine, setMachine] = useState(tool.compatibleMachineCodes[0] ?? '');
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [empQ, setEmpQ] = useState('');
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(null);
  const [scanMachine, setScanMachine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientEventId] = useState(newClientEventId);
  const employees = useEmployeeLookup(empQ);

  const machines = useMemo(() => machinesQ.data?.data ?? [], [machinesQ.data]);
  // Kompatibilne šifre prve, pa ostale mašine (RB-36 pun spisak).
  const machineOptions = useMemo(() => {
    const compat = new Set(tool.compatibleMachineCodes);
    const rows = machines.map((m) => ({ code: m.machine_code, name: m.name, compat: compat.has(m.machine_code) }));
    return rows.sort((a, b) => Number(b.compat) - Number(a.compat) || a.code.localeCompare(b.code));
  }, [machines, tool.compatibleMachineCodes]);
  const machineValid = machines.some((m) => m.machine_code === machine.trim());

  function handleMachineScan(raw: string) {
    const code = raw.replace(/^ZADU-M-/i, '').trim();
    const hit = machines.find((m) => m.machine_code === code);
    if (hit) {
      setMachine(hit.machine_code);
      setError(null);
    } else {
      toast(`Mašina ${code} nije u listi — izaberi iz spiska`);
    }
  }

  async function submit() {
    setError(null);
    if (!machine.trim()) return setError('Izaberi mašinu.');
    if (!machineValid) return setError('Mašina nije u evidenciji — izaberi važeću šifru iz spiska.');
    if (!employee) return setError('Izaberi radnika (potpisnik preuzimanja).');
    try {
      await issue.mutateAsync({
        clientEventId,
        payload: {
          recipient_machine_code: machine.trim(),
          issued_to_employee_id: employee.id,
          issued_to_employee_name: employee.name,
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
          <div className="flex gap-2">
            <select className={INPUT} value={machine} onChange={(e) => setMachine(e.target.value)}>
              <option value="">— Izaberi mašinu —</option>
              {machineOptions.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.code} {m.name}
                  {m.compat ? ' · kompatibilna' : ''}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={() => setScanMachine(true)}>
              <ScanLine className="h-4 w-4" aria-hidden /> ZADU-M-
            </Button>
          </div>
          {machine.trim() && !machineValid && (
            <p className="mt-1 text-xs text-status-danger">Mašina nije u evidenciji.</p>
          )}
        </FormField>
        <FormField label="Radnik (potpisnik preuzimanja)" required>
          {employee ? (
            <div className="flex items-center justify-between rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
              <span className="font-medium">{employee.name}</span>
              <button type="button" className="text-xs text-ink-secondary hover:text-ink" onClick={() => setEmployee(null)}>Promeni</button>
            </div>
          ) : (
            <div className="space-y-1">
              <SearchBox value={empQ} onChange={setEmpQ} placeholder="Ime radnika ili odeljenje…" />
              {empQ && (
                <div className="max-h-40 overflow-auto rounded-control border border-line">
                  {(employees.data?.data ?? []).map((e) => (
                    <button key={e.id} type="button" className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2 ${e.is_active === false ? 'opacity-60' : ''}`} onClick={() => setEmployee({ id: e.id, name: e.full_name })}>
                      <span>{e.full_name}</span>
                      <span className="text-xs text-ink-secondary">{e.department ?? ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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

      {scanMachine && (
        <ScanOverlay
          title="Skeniraj mašinu"
          hint="Barkod ZADU-M-… sa nalepnice mašine"
          accept={[]}
          acceptUnknown
          onResult={(r) => handleMachineScan(r.barcode)}
          onClose={() => setScanMachine(false)}
        />
      )}
    </Dialog>
  );
}
