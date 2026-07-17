'use client';

import { useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { SearchBox } from '@/components/ui-kit/search-box';
import { Camera, ScanLine, IdCard, X, Minus, Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  newClientEventId,
  lookupBarcode,
  useCuttingIssue,
  useCuttingTools,
  useEmployeeLookup,
  useReversiMachines,
  type CuttingTool,
  type ReversiTool,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

/** Podrazumevani rok povraćaja = danas + 14 dana (yyyy-mm-dd), paritet 1.0. */
function defaultReturnDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

/** Jedna stavka zaduženja. `compatible` je prazan kad ga skenirani zapis ne nosi. */
interface Line {
  catalogId: string;
  barcode: string | null;
  oznaka: string;
  naziv: string;
  unit: string;
  compatible: string[];
  quantity: number;
}

function lineFromCatalog(t: CuttingTool): Line {
  return {
    catalogId: t.id,
    barcode: t.barcode,
    oznaka: t.oznaka,
    naziv: t.naziv,
    unit: t.unit || 'kom',
    compatible: t.compatibleMachineCodes ?? [],
    quantity: 1,
  };
}

/**
 * Skenirani CUTTING zapis = pun red `rev_cutting_tool_catalog` (BE lookupBarcode CUTTING),
 * pa nosi `compatibleMachineCodes` i `unit` — RC-29 paritet: upozorenje kompatibilnosti radi i za skenirane.
 */
function lineFromScanned(t: ReversiTool & { compatibleMachineCodes?: string[]; unit?: string }): Line {
  return {
    catalogId: t.id,
    barcode: t.barcode,
    oznaka: t.oznaka,
    naziv: t.naziv,
    unit: t.unit ?? 'kom',
    compatible: t.compatibleMachineCodes ?? [],
    quantity: 1,
  };
}

/**
 * Skenirano zaduženje reznog alata (RZ-3, paritet 1.0 `openCuttingToolIssueScannerModal`).
 * Pet ulaza: (1) SKENIRAJ ALAT — kontinualni kamera-skener CUTTING; (2) UNESI ALAT —
 * pretraga kataloga; (3) KARTICA OPERATERA — skener EMPLOYEE; (4) UNESI OPERATERA —
 * pretraga radnika; (5) UNESI MAŠINU — spisak `v_rev_machines` + ZADU-M- skener.
 * Multi-line tabela (količina uredljiva). Submit traži mašinu + operatera + ≥1 stavku;
 * upozorenje kompatibilnosti ne blokira. Idempotency ključ je stabilan po otvaranju.
 */
export function CuttingIssueScannerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const issue = useCuttingIssue();
  const machinesQ = useReversiMachines();
  const [lines, setLines] = useState<Line[]>([]);
  const [machine, setMachine] = useState('');
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(null);
  const [toolQ, setToolQ] = useState('');
  const [empQ, setEmpQ] = useState('');
  const [note, setNote] = useState('');
  const [expectedReturnDate, setExpectedReturnDate] = useState(defaultReturnDate);
  const [hidInput, setHidInput] = useState('');
  const [scanTool, setScanTool] = useState(false);
  const [scanCard, setScanCard] = useState(false);
  const [scanMachine, setScanMachine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientEventId] = useState(newClientEventId);

  const machines = useMemo(() => machinesQ.data?.data ?? [], [machinesQ.data]);
  const toolsQ = useCuttingTools(toolQ);
  const employees = useEmployeeLookup(empQ);

  const machineValid = machines.some((m) => m.machine_code === machine.trim());
  const selectedMachine = machines.find((m) => m.machine_code === machine.trim()) ?? null;

  // Upozorenje kompatibilnosti (ne blokira): stavke sa poznatim spiskom koji ne
  // sadrži izabranu mašinu (paritet 1.0 compatibleWarning).
  const incompatOznake = useMemo(() => {
    if (!machineValid) return [] as string[];
    return lines
      .filter((ln) => ln.compatible.length > 0 && !ln.compatible.includes(machine.trim()))
      .map((ln) => ln.oznaka);
  }, [lines, machine, machineValid]);

  function addLine(next: Line) {
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.catalogId === next.catalogId);
      if (idx >= 0) {
        const copy = [...ls];
        copy[idx] = { ...copy[idx], quantity: copy[idx].quantity + next.quantity };
        return copy;
      }
      return [...ls, next];
    });
  }

  function setQty(idx: number, q: number) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, quantity: Math.max(1, Math.floor(q) || 1) } : l)));
  }

  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }

  function pickMachine(code: string) {
    setMachine(code);
    setError(null);
  }

  function handleMachineScan(raw: string) {
    const code = raw.replace(/^ZADU-M-/i, '').replace(/_/g, '.').trim();
    const hit = machines.find((m) => m.machine_code === code);
    if (hit) {
      pickMachine(hit.machine_code);
      toast(`Mašina: ${hit.machine_code} ${hit.name ?? ''}`.trim());
    } else {
      toast(`Mašina ${code} nije u listi — izaberi iz spiska`);
    }
  }

  // Manuelni / HID unos: prefiks-routing (paritet 1.0 handleScannedInput).
  //   ZADU-M-  → mašina (skini prefiks, '_'→'.')
  //   ostalo   → lookupBarcode: CUTTING = stavka, EMPLOYEE = operater; fallback mašina.
  async function handleScannedInput(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (/^ZADU-M-/i.test(v)) {
      handleMachineScan(v);
      return;
    }
    try {
      const { data } = await lookupBarcode(v);
      if (data.kind === 'CUTTING' && data.record) {
        addLine(lineFromScanned(data.record as ReversiTool));
        return;
      }
      if (data.kind === 'EMPLOYEE' && data.record) {
        const rec = data.record as { id: string; full_name: string };
        setEmployee({ id: rec.id, name: rec.full_name });
        toast(`Operater: ${rec.full_name}`);
        return;
      }
      const m2 = machines.find((mm) => mm.machine_code === v);
      if (m2) {
        pickMachine(m2.machine_code);
        toast(`Mašina: ${m2.machine_code} ${m2.name ?? ''}`.trim());
        return;
      }
      toast(`Nepoznat barkod: ${v}`);
    } catch {
      toast(`Nepoznat barkod: ${v}`);
    }
  }

  async function submit() {
    setError(null);
    if (!machine.trim() || !machineValid) return setError('Izaberi važeću mašinu iz spiska.');
    if (!employee) return setError('Izaberi operatera (potpisnik preuzimanja).');
    if (lines.length === 0) return setError('Dodaj bar jednu stavku.');
    try {
      const res = await issue.mutateAsync({
        clientEventId,
        payload: {
          recipient_machine_code: machine.trim(),
          issued_to_employee_id: employee.id,
          issued_to_employee_name: employee.name,
          expected_return_date: expectedReturnDate || null,
          napomena: note.trim() || null,
          lines: lines.map((ln, i) => ({ catalog_id: ln.catalogId, quantity: ln.quantity, sort_order: i })),
        },
      });
      const docNumber = (res.data as { doc_number?: string } | null)?.doc_number;
      toast(docNumber ? `Zaduženje kreirano: ${docNumber}` : 'Zaduženje kreirano');
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Izdavanje nije uspelo.');
    }
  }

  const totalLines = lines.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Skenirano zaduženje reznog alata"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Otkaži</Button>
          <Button loading={issue.isPending} disabled={!machineValid || !employee || totalLines === 0} onClick={() => void submit()}>
            Potvrdi zaduženje{totalLines ? ` (${totalLines})` : ''}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {incompatOznake.length > 0 && (
          <div className="rounded-control border border-status-warn/40 bg-status-warn-bg px-3 py-2 text-xs text-status-warn">
            Upozorenje: alat <strong>{incompatOznake.join(', ')}</strong> nije označen kao kompatibilan sa mašinom{' '}
            <strong>{machine.trim()}</strong>. Možeš da nastaviš ako je realna potreba (rezerva / privremeno).
          </div>
        )}

        {/* (1) SKENIRAJ ALAT + (3) KARTICA OPERATERA */}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button variant="secondary" className="h-auto justify-start py-2" onClick={() => setScanTool(true)}>
            <Camera className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex flex-col items-start text-left">
              <span className="text-sm font-semibold">Skeniraj alat</span>
              <span className="text-2xs text-ink-secondary">Barkod RZN-… (skener radi u seriji)</span>
            </span>
          </Button>
          <Button variant="secondary" className="h-auto justify-start py-2" onClick={() => setScanCard(true)}>
            <IdCard className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex flex-col items-start text-left">
              <span className="text-sm font-semibold">Kartica operatera</span>
              <span className="text-2xs text-ink-secondary">{employee ? employee.name : 'Skeniraj ID karticu'}</span>
            </span>
          </Button>
        </div>

        {/* (2) UNESI ALAT — pretraga kataloga */}
        <FormField label="Unesi alat (pretraga po oznaci / nazivu)">
          <SearchBox value={toolQ} onChange={setToolQ} placeholder="Oznaka, naziv, barkod…" />
          {toolQ.trim() && (
            <div className="mt-1 max-h-44 overflow-auto rounded-control border border-line">
              {(toolsQ.data?.data ?? []).slice(0, 30).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() => {
                    addLine(lineFromCatalog(t));
                    toast(`Dodato: ${t.oznaka}`);
                  }}
                >
                  <span className="font-medium">{t.oznaka}</span>
                  <span className="truncate pl-2 text-xs text-ink-secondary">{t.naziv}</span>
                </button>
              ))}
              {(toolsQ.data?.data ?? []).length === 0 && (
                <p className="px-2.5 py-2 text-xs text-ink-secondary">Nema rezultata</p>
              )}
            </div>
          )}
        </FormField>

        {/* Stavke za zaduženje */}
        <div>
          <div className="mb-1 text-base font-medium text-ink">Stavke za zaduženje</div>
          {lines.length === 0 ? (
            <p className="rounded-control border border-dashed border-line px-3 py-3 text-sm text-ink-secondary">
              Nema stavki. Skeniraj barkod reznog alata ili ga pronađi u pretrazi.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-control border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-secondary">
                    <th className="px-2.5 py-1.5 font-medium">Oznaka</th>
                    <th className="px-2.5 py-1.5 font-medium">Naziv</th>
                    <th className="px-2.5 py-1.5 font-medium">Količina</th>
                    <th className="px-2.5 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((ln, idx) => (
                    <tr key={ln.catalogId} className="border-b border-line last:border-0">
                      <td className="px-2.5 py-1.5 font-medium">{ln.oznaka}</td>
                      <td className="px-2.5 py-1.5 text-ink-secondary">{ln.naziv}</td>
                      <td className="px-2.5 py-1.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            aria-label="Smanji"
                            className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2"
                            onClick={() => setQty(idx, ln.quantity - 1)}
                          >
                            <Minus className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={ln.quantity}
                            onChange={(e) => setQty(idx, Number(e.target.value) || 1)}
                            className={`${INPUT} w-16 text-center`}
                          />
                          <button
                            type="button"
                            aria-label="Povećaj"
                            className="rounded-control border border-line p-1 text-ink-secondary hover:bg-surface-2"
                            onClick={() => setQty(idx, ln.quantity + 1)}
                          >
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          </button>
                          <span className="pl-1 text-xs text-ink-secondary">{ln.unit}</span>
                        </div>
                      </td>
                      <td className="px-2.5 py-1.5 text-right">
                        <button
                          type="button"
                          aria-label="Ukloni"
                          className="rounded-control p-1 text-ink-secondary hover:bg-surface-2 hover:text-status-danger"
                          onClick={() => removeLine(idx)}
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* (5) UNESI MAŠINU */}
        <FormField label="Mašina (šifra)" required error={machine.trim() && !machineValid ? 'Mašina nije u evidenciji.' : undefined}>
          <div className="flex gap-2">
            <select className={INPUT} value={machine} onChange={(e) => pickMachine(e.target.value)}>
              <option value="">— Izaberi mašinu —</option>
              {machines.map((m) => (
                <option key={m.machine_code} value={m.machine_code}>
                  {m.machine_code} {m.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={() => setScanMachine(true)}>
              <ScanLine className="h-4 w-4" aria-hidden /> ZADU-M-
            </Button>
          </div>
        </FormField>

        {/* (4) UNESI OPERATERA */}
        <FormField label="Operater (potpisnik preuzimanja)" required>
          {employee ? (
            <div className="flex items-center justify-between rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
              <span className="font-medium">{employee.name}</span>
              <button type="button" className="text-xs text-ink-secondary hover:text-ink" onClick={() => setEmployee(null)}>
                Promeni
              </button>
            </div>
          ) : (
            <div className="space-y-1">
              <SearchBox value={empQ} onChange={setEmpQ} placeholder="Ime radnika ili odeljenje…" />
              {empQ.trim() && (
                <div className="max-h-40 overflow-auto rounded-control border border-line">
                  {(employees.data?.data ?? []).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2 ${e.is_active === false ? 'opacity-60' : ''}`}
                      onClick={() => setEmployee({ id: e.id, name: e.full_name })}
                    >
                      <span>{e.full_name}</span>
                      <span className="text-xs text-ink-secondary">{e.department ?? ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </FormField>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Rok povraćaja (opciono)">
            <input
              type="date"
              className={INPUT}
              value={expectedReturnDate}
              onChange={(e) => setExpectedReturnDate(e.target.value)}
            />
          </FormField>
          <FormField label="Napomena (opciono)">
            <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>

        {/* Manuelni / HID unos (USB skener, klavijatura) */}
        <details className="rounded-control border border-line px-3 py-2">
          <summary className="cursor-pointer text-sm text-ink-secondary">Manuelni / HID unos (USB skener, klavijatura)</summary>
          <div className="mt-2 space-y-1">
            <input
              className={INPUT}
              value={hidInput}
              onChange={(e) => setHidInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  const v = hidInput.trim();
                  setHidInput('');
                  if (v) void handleScannedInput(v);
                }
              }}
              placeholder="Skeniraj ili otkucaj kod… (Enter za potvrdu)"
              autoComplete="off"
            />
            <p className="text-2xs text-ink-secondary">
              Prefiksi: <code>RZN-</code> = alat, <code>ZADU-M-</code> = mašina, ostalo = ID kartica radnika.
            </p>
          </div>
        </details>

        {error && <p className="text-sm text-status-danger">{error}</p>}
      </div>

      {scanTool && (
        <ScanOverlay
          title="Skeniraj rezni alat"
          hint="Barkod RZN-… sa pločice — skener ostaje otvoren za seriju"
          accept={['CUTTING']}
          continuous
          onResult={(r) => {
            if (r.record) addLine(lineFromScanned(r.record as ReversiTool));
          }}
          onClose={() => setScanTool(false)}
        />
      )}
      {scanCard && (
        <ScanOverlay
          title="Skeniraj karticu operatera"
          hint="ID kartica zaposlenog"
          accept={['EMPLOYEE']}
          onResult={(r) => {
            const rec = r.record as { id: string; full_name: string } | null;
            if (rec?.id) setEmployee({ id: rec.id, name: rec.full_name });
            else toast('Kartica nije prepoznata');
          }}
          onClose={() => setScanCard(false)}
        />
      )}
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
