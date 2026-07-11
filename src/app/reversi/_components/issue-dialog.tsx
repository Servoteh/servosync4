'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { SearchBox } from '@/components/ui-kit/search-box';
import { formatNumber } from '@/lib/format';
import { ScanLine } from 'lucide-react';
import {
  newClientEventId,
  useEmployeeLookup,
  useReversiIssue,
  useReversiTools,
  type ReversiTool,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';

type RecipientType = 'EMPLOYEE' | 'DEPARTMENT' | 'EXTERNAL_COMPANY';
type DocType = 'TOOL' | 'COOPERATION_GOODS';

interface DraftLine {
  key: string;
  tool: ReversiTool | null;
  partName?: string;
  quantity: number;
  unit: string;
}

/**
 * Izdaj alat/kooperaciju — mutacija rev_issue_reversal preko POST /reversi/issue.
 * Payload = isti jsonb kao 1.0 issueDialog; idempotency ključ se generiše JEDNOM
 * po otvaranju forme (retry ISTOG submita nosi isti ključ; svako novo otvaranje =
 * nov ključ i prazna forma). HID barkod čitač radi kroz polje pretrage (kuca kao
 * tastatura); kamera-skener kroz ScanOverlay.
 */
export function IssueDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [docType, setDocType] = useState<DocType>('TOOL');
  const [recipientType, setRecipientType] = useState<RecipientType>('EMPLOYEE');
  const [empQ, setEmpQ] = useState('');
  const [employee, setEmployee] = useState<{ id: string; name: string } | null>(null);
  const [department, setDepartment] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyPib, setCompanyPib] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [note, setNote] = useState('');
  const [toolQ, setToolQ] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [coopName, setCoopName] = useState('');
  const [coopQty, setCoopQty] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  // Jedan ključ po otvorenoj formi → retry ISTOG submita ne pravi dupli revers.
  const [clientEventId, setClientEventId] = useState(newClientEventId);

  const employees = useEmployeeLookup(empQ);
  const tools = useReversiTools({ status: 'active', q: toolQ || undefined, pageSize: 10 });
  const issue = useReversiIssue();

  const toolResults = useMemo(() => {
    const inDraft = new Set(lines.map((l) => l.tool?.id).filter(Boolean));
    return (tools.data?.data ?? []).filter((t) => !inDraft.has(t.id));
  }, [tools.data, lines]);

  function addTool(t: ReversiTool) {
    setLines((ls) => (ls.some((l) => l.tool?.id === t.id) ? ls : [
      ...ls,
      { key: t.id, tool: t, quantity: 1, unit: 'kom' },
    ]));
    setToolQ('');
  }

  function addCoopLine() {
    if (!coopName.trim()) return;
    // Stabilan jedinstven ključ — ime/indeks se ponavljaju (dodaj/ukloni/dodaj),
    // pa bi `coop-${len}-${name}` kolidirao i dirao pogrešnu stavku.
    const key = newClientEventId();
    setLines((ls) => [
      ...ls,
      { key, tool: null, partName: coopName.trim(), quantity: coopQty || 1, unit: 'kom' },
    ]);
    setCoopName('');
    setCoopQty(1);
  }

  // Svako otvaranje = prazna forma i NOV idempotency ključ. Dijalog ostaje
  // montiran (roditelj mu prosleđuje `open`), pa se stanje mora ručno očistiti —
  // inače „procuri" nedovršeni nacrt i stari ključ na sledeće izdavanje.
  const reset = useCallback(() => {
    setDocType('TOOL');
    setRecipientType('EMPLOYEE');
    setLines([]);
    setEmployee(null);
    setEmpQ('');
    setDepartment('');
    setCompanyName('');
    setCompanyPib('');
    setReturnDate('');
    setNote('');
    setToolQ('');
    setCoopName('');
    setCoopQty(1);
    setScanOpen(false);
    setError(null);
    setClientEventId(newClientEventId());
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  async function submit() {
    setError(null);
    if (recipientType === 'EMPLOYEE' && !employee) return setError('Izaberi radnika.');
    if (recipientType === 'DEPARTMENT' && !department.trim()) return setError('Upiši odeljenje.');
    if (recipientType === 'EXTERNAL_COMPANY' && !companyName.trim()) return setError('Upiši naziv firme.');
    if (!lines.length) return setError('Dodaj bar jednu stavku.');
    try {
      await issue.mutateAsync({
        clientEventId,
        payload: {
          doc_type: docType,
          recipient_type: recipientType,
          recipient_employee_id: employee?.id,
          recipient_employee_name: employee?.name,
          recipient_department: department.trim() || undefined,
          recipient_company_name: companyName.trim() || undefined,
          recipient_company_pib: companyPib.trim() || undefined,
          expected_return_date: returnDate || undefined,
          napomena: note.trim() || undefined,
          lines: lines.map((l, i) => ({
            line_type: l.tool ? 'TOOL' : 'PRODUCTION_PART',
            tool_id: l.tool?.id,
            part_name: l.partName,
            quantity: l.quantity,
            unit: l.unit,
            sort_order: i,
          })),
        },
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Izdavanje nije uspelo.');
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Izdaj alat / opremu"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Otkaži
          </Button>
          <Button onClick={() => void submit()} loading={issue.isPending}>
            Izdaj{lines.length ? ` (${lines.length})` : ''}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Tip dokumenta" required>
            <select
              className={INPUT}
              value={docType}
              onChange={(e) => {
                // Promena tipa čisti stavke — inače bi payload nosio TOOL linije
                // pod COOPERATION_GOODS (i obrnuto) → nekonzistentan dokument.
                setDocType(e.target.value as DocType);
                setLines([]);
                setToolQ('');
                setCoopName('');
              }}
            >
              <option value="TOOL">Alat / oprema</option>
              <option value="COOPERATION_GOODS">Kooperacija</option>
            </select>
          </FormField>
          <FormField label="Primalac" required>
            <select
              className={INPUT}
              value={recipientType}
              onChange={(e) => setRecipientType(e.target.value as RecipientType)}
            >
              <option value="EMPLOYEE">Radnik</option>
              <option value="DEPARTMENT">Odeljenje</option>
              <option value="EXTERNAL_COMPANY">Spoljna firma</option>
            </select>
          </FormField>
        </div>

        {recipientType === 'EMPLOYEE' && (
          <FormField label="Radnik" required>
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
                {empQ && (
                  <div className="max-h-40 overflow-auto rounded-control border border-line">
                    {(employees.data?.data ?? []).map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
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
        )}
        {recipientType === 'DEPARTMENT' && (
          <FormField label="Odeljenje" required>
            <input className={INPUT} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="npr. Mašinska obrada" />
          </FormField>
        )}
        {recipientType === 'EXTERNAL_COMPANY' && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Firma" required>
              <input className={INPUT} value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </FormField>
            <FormField label="PIB">
              <input className={INPUT} value={companyPib} onChange={(e) => setCompanyPib(e.target.value)} />
            </FormField>
          </div>
        )}

        {docType === 'TOOL' ? (
          <FormField label="Dodaj alat" hint="Kucaj oznaku/naziv, skeniraj kamerom ili HID čitačem.">
            <div className="space-y-1">
              <div className="flex gap-2">
                <div className="flex-1">
                  <SearchBox value={toolQ} onChange={setToolQ} placeholder="Oznaka, naziv, barkod…" />
                </div>
                <Button variant="secondary" onClick={() => setScanOpen(true)}>
                  <ScanLine className="mr-1 h-4 w-4" /> Skeniraj
                </Button>
              </div>
              {toolQ && (
                <div className="max-h-40 overflow-auto rounded-control border border-line">
                  {toolResults.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                      onClick={() => addTool(t)}
                    >
                      <span>
                        <span className="font-medium">{t.oznaka}</span>{' '}
                        <span className="text-ink-secondary">{t.naziv}</span>
                      </span>
                      <span className="text-xs text-ink-secondary">
                        {t.isQuantity ? `na stanju: ${formatNumber(t.totalQty)}` : (t.serijskiBroj ?? '')}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </FormField>
        ) : (
          <FormField label="Stavka kooperacije">
            <div className="flex gap-2">
              <input className={INPUT} value={coopName} onChange={(e) => setCoopName(e.target.value)} placeholder="Naziv dela / opis" />
              <input
                className={`${INPUT} w-24`}
                type="number"
                min={1}
                value={coopQty}
                onChange={(e) => setCoopQty(Number(e.target.value))}
              />
              <Button variant="secondary" onClick={addCoopLine}>
                Dodaj
              </Button>
            </div>
          </FormField>
        )}

        {lines.length > 0 && (
          <div className="space-y-1 rounded-control border border-line p-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2 text-sm">
                <span className="flex-1">
                  <span className="font-medium">{l.tool?.oznaka ?? l.partName}</span>{' '}
                  <span className="text-ink-secondary">{l.tool?.naziv ?? ''}</span>
                </span>
                {l.tool?.isQuantity || !l.tool ? (
                  <input
                    className={`${INPUT} w-20`}
                    type="number"
                    min={1}
                    value={l.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((x) => (x.key === l.key ? { ...x, quantity: Number(e.target.value) || 1 } : x)),
                      )
                    }
                  />
                ) : (
                  <span className="text-xs text-ink-secondary">1 kom (jedinica)</span>
                )}
                <button
                  type="button"
                  className="text-xs text-status-danger hover:underline"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                >
                  Ukloni
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Rok vraćanja">
            <input className={INPUT} type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
          </FormField>
          <FormField label="Napomena">
            <input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
        </div>

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      {scanOpen && (
        <ScanOverlay
          title="Skeniraj alat"
          accept={['HAND']}
          onResult={(r) => {
            if (r.kind === 'HAND' && r.record) addTool(r.record as ReversiTool);
          }}
          onClose={() => setScanOpen(false)}
        />
      )}
    </Dialog>
  );
}
