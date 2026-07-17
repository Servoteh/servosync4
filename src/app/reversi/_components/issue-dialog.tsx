'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui-kit/dialog';
import { Button } from '@/components/ui-kit/button';
import { FormField } from '@/components/ui-kit/form-field';
import { SearchBox } from '@/components/ui-kit/search-box';
import { formatNumber } from '@/lib/format';
import { toast } from '@/lib/toast';
import { ScanLine, Trash2, BookOpen, ChevronRight, ChevronDown } from 'lucide-react';
import {
  fetchInventoryUnits,
  fetchOpenHandLine,
  newClientEventId,
  useCuttingIssue,
  useCuttingTools,
  useEmployeeLookup,
  useReversiIssue,
  useReversiMachines,
  useReversiTools,
  type CuttingTool,
  type EmployeeOption,
  type InventoryUnitRow,
  type ReversiTool,
} from '@/api/reversi';
import { ScanOverlay } from './scan-overlay';

const INPUT =
  'w-full rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent';
const SELECT = INPUT;

type RecipientKind = 'EMPLOYEE' | 'DEPARTMENT' | 'EXTERNAL_COMPANY';
type DocType = 'TOOL' | 'COOPERATION_GOODS';
type Mode = 'scanner' | 'manual';
type LineKind = 'HAND' | 'CUTTING';

interface LineTool {
  id: string;
  oznaka: string;
  naziv: string;
  barcode: string;
  isQuantity: boolean;
}
interface DraftLine {
  key: string;
  kind: LineKind;
  tool: LineTool;
  qty: number;
}
interface CoopLine {
  key: string;
  drawingNo: string;
  partName: string;
  quantity: number;
  unit: string;
  workOrderId: string;
  napomena: string;
}
interface Recipient {
  id: string;
  name: string;
  department: string;
  isActive: boolean;
}

/** Unifikovana stavka tool-pickera (RB-34) — HAND jedinice + rezni katalog. */
interface PickerItem {
  itemId: string;
  kind: LineKind;
  barcode: string;
  oznaka: string;
  naziv: string;
  groupCode: string;
  groupLabel: string;
  subKey: string;
  subLabel: string;
  isQuantity: boolean;
  isConsumable: boolean;
  availableQty: number | null;
}

const GROUP_ORDER: Record<string, number> = { REZNI: 1, RUCNI: 2, LZO: 3 };

function defaultReturnDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

function toLineTool(t: ReversiTool): LineTool {
  return { id: t.id, oznaka: t.oznaka, naziv: t.naziv, barcode: t.barcode, isQuantity: t.isQuantity };
}
function pickerToLineTool(p: PickerItem): LineTool {
  return { id: p.itemId, oznaka: p.oznaka, naziv: p.naziv, barcode: p.barcode, isQuantity: p.isQuantity };
}

/** Picker radnika sa neaktivnima (RB-35) — zasivljeni + badž „neaktivan"; pretraga i po poziciji. */
function EmployeePicker({
  empQ,
  setEmpQ,
  onPick,
}: {
  empQ: string;
  setEmpQ: (v: string) => void;
  onPick: (e: EmployeeOption) => void;
}) {
  const employees = useEmployeeLookup(empQ);
  return (
    <div className="space-y-1">
      <SearchBox value={empQ} onChange={setEmpQ} placeholder="Ime, odeljenje ili pozicija…" />
      {empQ && (
        <div className="max-h-44 overflow-auto rounded-control border border-line">
          {(employees.data?.data ?? []).map((e) => {
            const inactive = e.is_active === false;
            return (
              <button
                key={e.id}
                type="button"
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-2 ${inactive ? 'opacity-60' : ''}`}
                title={inactive ? 'Neaktivan zaposleni' : ''}
                onClick={() => onPick(e)}
              >
                <span className="truncate">
                  {e.full_name}
                  {e.department && <span className="text-ink-secondary"> · {e.department}</span>}
                </span>
                {inactive && (
                  <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-status-warn">
                    neaktivan
                  </span>
                )}
              </button>
            );
          })}
          {(employees.data?.data ?? []).length === 0 && (
            <div className="px-2.5 py-2 text-xs text-ink-secondary">Nema rezultata.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Izdaj alat / opremu (paritet 1.0 `openIssueDialog`) — Skener/Ručno toggle sa deljenim
 * stanjem (RB-31). Skener mod: čip stavke sa +/- stepperom (RB-32), skeniraj alat
 * HAND/CUTTING + „Iz baze alata" tree picker (RB-33/34), primalac ime/kartica sa
 * neaktivnima (RB-35), izbor+validacija mašine za rezni + skener ZADU-M- (RB-36), rok
 * povraćaja danas+14 (RB-37). Ručno mod: koraci Tip/Primalac → stavke (alat ili
 * kooperacija sa punim poljima, RB-40) → pregled + kreiraj (RB-41).
 *
 * Idempotency (doktrina R0): HAND stavke = JEDAN `POST /issue` sa stabilnim ključem;
 * svaka CUTTING stavka = zaseban `POST /cutting-issue` (jedan dokument) sa STABILNIM
 * ključem PO STAVCI — retry ne pravi dupli revers, a uspešno izdate se odmah uklone
 * iz liste da re-submit ne izda duplo.
 */
export function IssueDialog({
  open,
  onClose,
  initialTool,
  initialEmployee,
  initialMachine,
  defaultMode = 'scanner',
}: {
  open: boolean;
  onClose: () => void;
  /** Preselektovan alat (RA-17 „Izdaj na revers" iz reda „Alat i oprema"). */
  initialTool?: ReversiTool | null;
  /** Preselektovan radnik (RB-31 — npr. sken kartice na radnom stolu). */
  initialEmployee?: Recipient | null;
  /** Preselektovana mašina (RB-31/54 — „Izdaj na ovu mašinu"). */
  initialMachine?: { code: string; name?: string } | null;
  defaultMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(defaultMode);
  const [docType, setDocType] = useState<DocType>('TOOL');
  const [recipientKind, setRecipientKind] = useState<RecipientKind>('EMPLOYEE');
  const [empQ, setEmpQ] = useState('');
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [department, setDepartment] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyPib, setCompanyPib] = useState('');
  const [returnDate, setReturnDate] = useState(defaultReturnDate);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [coopLines, setCoopLines] = useState<CoopLine[]>([]);
  const [machineCode, setMachineCode] = useState('');
  const [manualStep, setManualStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Tool picker (RB-34)
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQ, setPickerQ] = useState('');
  const [pickerGroup, setPickerGroup] = useState('ALL');
  const [pickerSub, setPickerSub] = useState('ALL');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedSubs, setExpandedSubs] = useState<Set<string>>(new Set());
  const [invItems, setInvItems] = useState<InventoryUnitRow[]>([]);
  const [invLoaded, setInvLoaded] = useState(false);
  const [invLoading, setInvLoading] = useState(false);

  // Skeneri
  const [scanTool, setScanTool] = useState(false);
  const [scanCard, setScanCard] = useState(false);
  const [scanMachine, setScanMachine] = useState(false);

  // Koop unos (radni draft za „+ Dodaj stavku")
  const [coopDraft, setCoopDraft] = useState<Omit<CoopLine, 'key'>>({
    drawingNo: '',
    partName: '',
    quantity: 1,
    unit: 'kom',
    workOrderId: '',
    napomena: '',
  });

  // Manual TOOL search
  const [manualToolQ, setManualToolQ] = useState('');
  const manualTools = useReversiTools({
    status: 'active',
    q: manualToolQ || undefined,
    pageSize: 10,
  });

  const machines = useReversiMachines();
  const cutting = useCuttingTools('');

  // Stabilni idempotency ključevi po logičkoj operaciji (preživljavaju retry submita).
  const eventIds = useRef(new Map<string, string>());
  function eventIdFor(key: string): string {
    let id = eventIds.current.get(key);
    if (!id) {
      id = newClientEventId();
      eventIds.current.set(key, id);
    }
    return id;
  }

  const issue = useReversiIssue();
  const cuttingIssue = useCuttingIssue();

  const machineFixed = !!initialMachine?.code;
  const effectiveMachine = machineFixed ? initialMachine!.code : machineCode.trim();
  const machineValid =
    !!effectiveMachine && (machineFixed || (machines.data?.data ?? []).some((m) => m.machine_code === effectiveMachine));
  const hasCutting = lines.some((l) => l.kind === 'CUTTING');
  const showMachine = hasCutting || lines.length === 0;

  const reset = useCallback(() => {
    setMode(defaultMode);
    setDocType('TOOL');
    setRecipientKind('EMPLOYEE');
    setEmpQ('');
    setRecipient(initialEmployee ?? null);
    setDepartment('');
    setCompanyName('');
    setCompanyPib('');
    setReturnDate(defaultReturnDate());
    setNote('');
    setLines(
      initialTool
        ? [
            {
              key: initialTool.id,
              kind: /^RZN-/i.test(initialTool.barcode) ? 'CUTTING' : 'HAND',
              tool: toLineTool(initialTool),
              qty: 1,
            },
          ]
        : [],
    );
    setCoopLines([]);
    setMachineCode(initialMachine?.code ?? '');
    setManualStep(1);
    setError(null);
    setPending(false);
    setPickerOpen(false);
    setPickerQ('');
    setPickerGroup('ALL');
    setPickerSub('ALL');
    setExpandedGroups(new Set());
    setExpandedSubs(new Set());
    setScanTool(false);
    setScanCard(false);
    setScanMachine(false);
    setCoopDraft({ drawingNo: '', partName: '', quantity: 1, unit: 'kom', workOrderId: '', napomena: '' });
    setManualToolQ('');
    eventIds.current = new Map();
  }, [defaultMode, initialTool, initialEmployee, initialMachine]);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  async function loadInventory() {
    if (invLoaded || invLoading) return;
    setInvLoading(true);
    try {
      const res = await fetchInventoryUnits({
        status: 'active',
        sort: 'oznaka',
        dir: 'asc',
        page: 1,
        pageSize: 2000,
      });
      setInvItems(res.data);
      setInvLoaded(true);
    } catch {
      /* pretraga kroz picker ostaje prazna — search/typeahead je fallback */
    } finally {
      setInvLoading(false);
    }
  }

  // Unifikovane picker stavke (HAND jedinice + rezni katalog).
  const pickerItems = useMemo<PickerItem[]>(() => {
    const hand: PickerItem[] = invItems.map((u) => ({
      itemId: u.id,
      kind: 'HAND',
      barcode: u.barcode ?? '',
      oznaka: u.oznaka,
      naziv: u.naziv,
      groupCode: u.group?.code ?? '_NULL',
      groupLabel: u.group?.label ?? 'Nesvrstano',
      subKey: u.subgroup?.id ?? '_NULL',
      subLabel: u.subgroup?.label ?? 'Bez podgrupe',
      isQuantity: u.isQuantity,
      isConsumable: u.isConsumable,
      availableQty: u.totalQty,
    }));
    const cut: PickerItem[] = (cutting.data?.data ?? []).map((c: CuttingTool) => ({
      itemId: c.id,
      kind: 'CUTTING',
      barcode: c.barcode ?? '',
      oznaka: c.oznaka,
      naziv: c.naziv,
      groupCode: 'REZNI',
      groupLabel: 'Rezni alat',
      subKey: '_REZNI',
      subLabel: 'Rezni alat',
      isQuantity: false,
      isConsumable: false,
      availableQty: c.inWarehouseQty,
    }));
    return [...hand, ...cut];
  }, [invItems, cutting.data]);

  const filteredPicker = useMemo(() => {
    const q = pickerQ.trim().toLowerCase();
    return pickerItems.filter((it) => {
      if (pickerGroup !== 'ALL' && it.groupCode !== pickerGroup) return false;
      if (pickerSub !== 'ALL' && it.subKey !== pickerSub) return false;
      if (!q) return true;
      return [it.oznaka, it.naziv, it.barcode, it.subLabel, it.groupLabel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [pickerItems, pickerQ, pickerGroup, pickerSub]);

  const groupOptions = useMemo(() => {
    const counts = new Map<string, { label: string; n: number }>();
    for (const it of pickerItems) {
      const cur = counts.get(it.groupCode) ?? { label: it.groupLabel, n: 0 };
      cur.n += 1;
      counts.set(it.groupCode, cur);
    }
    return [...counts.entries()].sort(
      (a, b) => (GROUP_ORDER[a[0]] ?? 99) - (GROUP_ORDER[b[0]] ?? 99),
    );
  }, [pickerItems]);

  const subOptions = useMemo(() => {
    if (pickerGroup === 'ALL') return [] as [string, { label: string; n: number }][];
    const counts = new Map<string, { label: string; n: number }>();
    for (const it of pickerItems) {
      if (it.groupCode !== pickerGroup) continue;
      const cur = counts.get(it.subKey) ?? { label: it.subLabel, n: 0 };
      cur.n += 1;
      counts.set(it.subKey, cur);
    }
    return [...counts.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label, 'sr'));
  }, [pickerItems, pickerGroup]);

  const tree = useMemo(() => {
    const t = new Map<string, { label: string; subs: Map<string, { label: string; items: PickerItem[] }> }>();
    for (const it of filteredPicker) {
      if (!t.has(it.groupCode)) t.set(it.groupCode, { label: it.groupLabel, subs: new Map() });
      const g = t.get(it.groupCode)!;
      if (!g.subs.has(it.subKey)) g.subs.set(it.subKey, { label: it.subLabel, items: [] });
      g.subs.get(it.subKey)!.items.push(it);
    }
    return [...t.entries()].sort((a, b) => (GROUP_ORDER[a[0]] ?? 99) - (GROUP_ORDER[b[0]] ?? 99));
  }, [filteredPicker]);

  const inLines = useMemo(() => new Set(lines.map((l) => `${l.kind}:${l.tool.id}`)), [lines]);

  function pickRecipient(e: EmployeeOption) {
    setRecipient({ id: e.id, name: e.full_name, department: e.department ?? '', isActive: e.is_active !== false });
    setEmpQ('');
  }

  function addHandTool(tool: LineTool, opts?: { silent?: boolean }) {
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.kind === 'HAND' && l.tool.id === tool.id);
      if (idx >= 0) {
        if (tool.isQuantity) {
          const copy = [...ls];
          copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
          return copy;
        }
        if (!opts?.silent) toast('Alat je već na listi');
        return ls;
      }
      return [...ls, { key: `H-${tool.id}`, kind: 'HAND', tool, qty: 1 }];
    });
  }

  function addCuttingTool(tool: LineTool) {
    setLines((ls) => {
      const idx = ls.findIndex((l) => l.kind === 'CUTTING' && l.tool.id === tool.id);
      if (idx >= 0) {
        const copy = [...ls];
        copy[idx] = { ...copy[idx], qty: copy[idx].qty + 1 };
        return copy;
      }
      return [...ls, { key: `C-${tool.id}`, kind: 'CUTTING', tool, qty: 1 }];
    });
  }

  function addPickerItem(it: PickerItem) {
    if (it.kind === 'CUTTING') addCuttingTool(pickerToLineTool(it));
    else addHandTool(pickerToLineTool(it));
  }

  // RB-33 — sken alata: HAND/CUTTING; količinski/rezni uvek dodaj/uvećaj; za
  // običan HAND proveri da li je već zadužen (open-hand-line) pre dodavanja.
  async function handleToolScan(record: ReversiTool) {
    const tool = toLineTool(record);
    if (/^RZN-/i.test(tool.barcode) || record.isQuantity) {
      if (/^RZN-/i.test(tool.barcode)) addCuttingTool(tool);
      else addHandTool(tool);
      return;
    }
    if (lines.some((l) => l.kind === 'HAND' && l.tool.id === tool.id)) {
      toast('Alat je već na listi');
      return;
    }
    try {
      const { data } = await fetchOpenHandLine(tool.barcode);
      if (data) {
        toast(`Alat je već zadužen (revers ${data.docNumber})`);
        return;
      }
    } catch {
      /* provera nedostupna — dozvoli dodavanje, BE hvata duplo zaduženje */
    }
    addHandTool(tool);
  }

  function handleMachineScan(raw: string) {
    const code = raw.replace(/^ZADU-M-/i, '').trim();
    if (!code) {
      toast('Nepoznat format mašine');
      return;
    }
    const hit = (machines.data?.data ?? []).find((m) => m.machine_code === code);
    if (hit) {
      setMachineCode(hit.machine_code);
    } else {
      setMachineCode('');
      toast(`Mašina ${code} nije u listi — izaberi mašinu iz liste`);
    }
  }

  function setLineQty(key: string, qty: number) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, qty: Math.max(1, Math.floor(qty) || 1) } : l)));
  }
  function removeLine(key: string) {
    setLines((ls) => ls.filter((l) => l.key !== key));
  }

  function validateRecipient(): string | null {
    if (recipientKind === 'EMPLOYEE' && !recipient) return 'Izaberi radnika.';
    if (recipientKind === 'DEPARTMENT' && !department.trim()) return 'Upiši odeljenje.';
    if (recipientKind === 'EXTERNAL_COMPANY' && !companyName.trim()) return 'Upiši naziv firme.';
    return null;
  }

  function recipientPayload(): Record<string, unknown> {
    if (recipientKind === 'EMPLOYEE')
      return { recipient_type: 'EMPLOYEE', recipient_employee_id: recipient!.id, recipient_employee_name: recipient!.name };
    if (recipientKind === 'DEPARTMENT')
      return { recipient_type: 'DEPARTMENT', recipient_department: department.trim() };
    return {
      recipient_type: 'EXTERNAL_COMPANY',
      recipient_company_name: companyName.trim(),
      recipient_company_pib: companyPib.trim() || undefined,
    };
  }

  // Scanner submit — split HAND/CUTTING (RB-31/32/36).
  async function submitScanner() {
    setError(null);
    const rErr = validateRecipient();
    if (rErr) return setError(rErr);
    if (lines.length === 0) return setError('Dodaj bar jednu stavku.');
    if (hasCutting && !machineValid) return setError('Izaberi važeću mašinu za rezni alat.');

    setPending(true);
    const hand = lines.filter((l) => l.kind === 'HAND');
    const cut = lines.filter((l) => l.kind === 'CUTTING');
    let issued = 0;
    try {
      if (hand.length > 0) {
        await issue.mutateAsync({
          clientEventId: eventIdFor('hand'),
          payload: {
            doc_type: 'TOOL',
            ...recipientPayload(),
            expected_return_date: returnDate || undefined,
            napomena: note.trim() || undefined,
            lines: hand.map((l, i) => ({
              line_type: 'TOOL',
              tool_id: l.tool.id,
              quantity: l.tool.isQuantity ? l.qty : 1,
              unit: 'kom',
              sort_order: i + 1,
            })),
          },
        });
        issued += hand.length;
        // Uspešno izdato ODMAH ukloni — ako naredni RPC padne, re-submit ne izda duplo.
        setLines((ls) => ls.filter((l) => l.kind !== 'HAND'));
      }
      for (const ln of cut) {
        await cuttingIssue.mutateAsync({
          clientEventId: eventIdFor(`cut:${ln.tool.id}`),
          payload: {
            recipient_machine_code: effectiveMachine,
            issued_to_employee_id: recipient?.id,
            issued_to_employee_name: recipient?.name,
            expected_return_date: returnDate || undefined,
            lines: [{ catalog_id: ln.tool.id, quantity: ln.qty, sort_order: 0 }],
          },
        });
        issued += 1;
        setLines((ls) => ls.filter((l) => l.key !== ln.key));
      }
      setPending(false);
      toast(`Izdato ${issued} stavki`);
      onClose();
    } catch (e) {
      setPending(false);
      setError(
        `${e instanceof Error ? e.message : 'Izdavanje nije uspelo.'}${issued > 0 ? ` — ${issued} stavki već izdato; u listi su ostale neizdate.` : ''}`,
      );
    }
  }

  // Manual submit (RB-40/41) — TOOL ili COOPERATION_GOODS jednim POST /issue.
  async function submitManual() {
    setError(null);
    const rErr = validateRecipient();
    if (rErr) return setError(rErr);
    const handLines = lines.filter((l) => l.kind === 'HAND');
    if (docType === 'TOOL' && handLines.length === 0) return setError('Dodaj bar jedan alat.');
    if (docType === 'COOPERATION_GOODS' && coopLines.length === 0) return setError('Dodaj bar jednu stavku.');
    setPending(true);
    try {
      await issue.mutateAsync({
        clientEventId: eventIdFor('manual'),
        payload: {
          doc_type: docType,
          ...recipientPayload(),
          expected_return_date: returnDate || undefined,
          napomena: note.trim() || undefined,
          lines:
            docType === 'TOOL'
              ? handLines.map((l, i) => ({
                  line_type: 'TOOL',
                  tool_id: l.tool.id,
                  quantity: 1,
                  unit: 'kom',
                  sort_order: i + 1,
                }))
              : coopLines.map((l, i) => ({
                  line_type: 'PRODUCTION_PART',
                  drawing_no: l.drawingNo || undefined,
                  part_name: l.partName || undefined,
                  quantity: l.quantity,
                  unit: l.unit || 'kom',
                  work_order_id: l.workOrderId || undefined,
                  napomena: l.napomena || undefined,
                  sort_order: i + 1,
                })),
        },
      });
      setPending(false);
      toast('Dokument kreiran');
      onClose();
    } catch (e) {
      setPending(false);
      setError(e instanceof Error ? e.message : 'Kreiranje nije uspelo.');
    }
  }

  // ---- render helpers ----

  const recipientBlock = (
    <FormField label="Primalac" required>
      {recipient && recipientKind === 'EMPLOYEE' ? (
        <div className="flex items-center justify-between rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
          <span>
            <span className="font-medium">{recipient.name}</span>
            {!recipient.isActive && (
              <span className="ml-1.5 rounded-full bg-surface px-1.5 py-0.5 text-2xs text-status-warn">neaktivan</span>
            )}
            {recipient.department && <span className="text-ink-secondary"> · {recipient.department}</span>}
          </span>
          <button type="button" className="text-xs text-ink-secondary hover:text-ink" onClick={() => setRecipient(null)}>
            Promeni
          </button>
        </div>
      ) : recipientKind === 'EMPLOYEE' ? (
        <div className="space-y-2">
          <EmployeePicker empQ={empQ} setEmpQ={setEmpQ} onPick={pickRecipient} />
          <Button variant="secondary" onClick={() => setScanCard(true)}>
            <ScanLine className="mr-1 h-4 w-4" aria-hidden /> Skeniraj karticu
          </Button>
        </div>
      ) : recipientKind === 'DEPARTMENT' ? (
        <input className={INPUT} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="npr. Mašinska obrada" />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <input className={INPUT} value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Naziv firme" />
          <input className={INPUT} value={companyPib} onChange={(e) => setCompanyPib(e.target.value)} placeholder="PIB (opciono)" />
        </div>
      )}
    </FormField>
  );

  const machineBlock = showMachine && (
    <FormField label="Mašina (za rezni alat)" required={hasCutting}>
      {machineFixed ? (
        <div className="rounded-control border border-line bg-surface-2 px-2.5 py-1.5 text-sm">
          <span className="tnums font-medium">{initialMachine!.code}</span>{' '}
          <span className="text-ink-secondary">{initialMachine!.name ?? ''}</span>
        </div>
      ) : (
        <div className="flex gap-2">
          <select className={SELECT} value={machineCode} onChange={(e) => setMachineCode(e.target.value)}>
            <option value="">— Izaberi mašinu —</option>
            {(machines.data?.data ?? []).map((m) => (
              <option key={m.machine_code} value={m.machine_code}>
                {m.machine_code} {m.name}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={() => setScanMachine(true)}>
            <ScanLine className="h-4 w-4" aria-hidden /> ZADU-M-
          </Button>
        </div>
      )}
      {hasCutting && !machineValid && effectiveMachine && (
        <p className="mt-1 text-xs text-status-danger">Mašina nije u evidenciji — izaberi iz liste.</p>
      )}
    </FormField>
  );

  const toolPicker = pickerOpen && (
    <div className="space-y-2 rounded-panel border border-line bg-surface-2 p-2">
      <div className="flex flex-wrap gap-2">
        <div className="flex-1 min-w-40">
          <SearchBox value={pickerQ} onChange={setPickerQ} placeholder="Šifra, naziv, barkod, podgrupa…" />
        </div>
        <select
          className={`${SELECT} w-auto`}
          value={pickerGroup}
          onChange={(e) => {
            setPickerGroup(e.target.value);
            setPickerSub('ALL');
          }}
        >
          <option value="ALL">Sve grupe</option>
          {groupOptions.map(([code, g]) => (
            <option key={code} value={code}>
              {g.label} ({g.n})
            </option>
          ))}
        </select>
        <select
          className={`${SELECT} w-auto`}
          value={pickerSub}
          disabled={pickerGroup === 'ALL'}
          onChange={(e) => setPickerSub(e.target.value)}
        >
          <option value="ALL">Sve podgrupe</option>
          {subOptions.map(([key, s]) => (
            <option key={key} value={key}>
              {s.label} ({s.n})
            </option>
          ))}
        </select>
      </div>
      <div className="max-h-64 overflow-auto rounded-control border border-line bg-surface">
        {invLoading && pickerItems.length === 0 ? (
          <div className="px-3 py-4 text-sm text-ink-secondary">Učitavanje baze alata…</div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-4 text-sm text-ink-secondary">
            Nema rezultata{pickerQ ? ` za „${pickerQ}"` : ''}.
          </div>
        ) : (
          tree.map(([gCode, gNode]) => {
            const gExpanded = !!pickerQ.trim() || expandedGroups.has(gCode);
            const totalItems = [...gNode.subs.values()].reduce((n, s) => n + s.items.length, 0);
            return (
              <div key={gCode} className="border-b border-line last:border-0">
                <button
                  type="button"
                  className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                  onClick={() =>
                    setExpandedGroups((s) => {
                      const n = new Set(s);
                      if (n.has(gCode)) n.delete(gCode);
                      else n.add(gCode);
                      return n;
                    })
                  }
                >
                  {gExpanded ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                  <strong>{gNode.label}</strong>
                  <span className="text-2xs text-ink-secondary">{totalItems} stavki</span>
                </button>
                {gExpanded &&
                  [...gNode.subs.entries()]
                    .sort((a, b) => a[1].label.localeCompare(b[1].label, 'sr'))
                    .map(([sKey, sNode]) => {
                      const subKey = `${gCode}|${sKey}`;
                      const sExpanded = !!pickerQ.trim() || expandedSubs.has(subKey);
                      return (
                        <div key={subKey} className="pl-4">
                          <button
                            type="button"
                            className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-xs text-ink-secondary hover:bg-surface-2"
                            onClick={() =>
                              setExpandedSubs((s) => {
                                const n = new Set(s);
                                if (n.has(subKey)) n.delete(subKey);
                                else n.add(subKey);
                                return n;
                              })
                            }
                          >
                            {sExpanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                            {sNode.label} <span className="text-ink-disabled">({sNode.items.length})</span>
                          </button>
                          {sExpanded &&
                            sNode.items.map((it) => {
                              const already = inLines.has(`${it.kind}:${it.itemId}`) && !it.isQuantity;
                              return (
                                <button
                                  key={`${it.kind}:${it.itemId}`}
                                  type="button"
                                  disabled={already}
                                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 pl-8 text-left text-sm hover:bg-surface-2 ${already ? 'opacity-50' : ''}`}
                                  onClick={() => addPickerItem(it)}
                                >
                                  <span className="tnums text-ink-secondary">{it.barcode || it.oznaka}</span>
                                  <span className="flex-1 truncate">{it.naziv}</span>
                                  {it.kind === 'CUTTING' && (
                                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">Rezni</span>
                                  )}
                                  {it.isConsumable && (
                                    <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">Potrošno</span>
                                  )}
                                  {it.isQuantity && it.availableQty != null && (
                                    <span className="tnums text-2xs text-ink-secondary">{formatNumber(it.availableQty)} kom</span>
                                  )}
                                  {already && <span className="text-2xs text-ink-disabled">· na listi</span>}
                                </button>
                              );
                            })}
                        </div>
                      );
                    })}
              </div>
            );
          })
        )}
      </div>
      <div className="text-2xs text-ink-secondary">
        {filteredPicker.length} od {pickerItems.length} stavki
      </div>
    </div>
  );

  const chipList = (
    <div className="space-y-1 rounded-control border border-line p-2">
      {lines.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nema stavki — skeniraj alat ili otvori „Iz baze alata".</p>
      ) : (
        lines.map((l) => (
          <div key={l.key} className="flex items-center gap-2 text-sm">
            <span className="flex-1 truncate">
              <span className="tnums text-ink-secondary">{l.tool.barcode || l.tool.oznaka}</span>{' '}
              <span>{l.tool.naziv}</span>
              {l.kind === 'CUTTING' && (
                <span className="ml-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-2xs text-ink-secondary">Rezni</span>
              )}
            </span>
            {l.kind === 'CUTTING' || l.tool.isQuantity ? (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Smanji"
                  className="rounded-control border border-line px-1.5 text-ink-secondary hover:bg-surface-2"
                  onClick={() => setLineQty(l.key, l.qty - 1)}
                >
                  −
                </button>
                <input
                  className={`${INPUT} w-14 text-center`}
                  type="number"
                  min={1}
                  value={l.qty}
                  onChange={(e) => setLineQty(l.key, Number(e.target.value))}
                />
                <button
                  type="button"
                  aria-label="Povećaj"
                  className="rounded-control border border-line px-1.5 text-ink-secondary hover:bg-surface-2"
                  onClick={() => setLineQty(l.key, l.qty + 1)}
                >
                  +
                </button>
              </span>
            ) : (
              <span className="text-2xs text-ink-secondary">1 kom</span>
            )}
            <button type="button" aria-label="Ukloni" className="text-ink-secondary hover:text-status-danger" onClick={() => removeLine(l.key)}>
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))
      )}
    </div>
  );

  const modeToggle = (
    <div className="inline-flex rounded-control border border-line p-0.5">
      {(['scanner', 'manual'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          className={
            mode === m
              ? 'rounded-control bg-accent px-3 py-1 text-xs font-medium text-accent-fg'
              : 'rounded-control px-3 py-1 text-xs text-ink-secondary hover:bg-surface-2'
          }
          onClick={() => {
            setMode(m);
            setManualStep(1);
            setError(null);
          }}
        >
          {m === 'scanner' ? 'Skener' : 'Ručno'}
        </button>
      ))}
    </div>
  );

  const returnDateField = (
    <FormField label="Rok povraćaja" hint="Podrazumevano danas + 14 dana.">
      <input className={INPUT} type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} />
    </FormField>
  );

  // ---- footers ----
  let footer: React.ReactNode;
  if (mode === 'scanner') {
    const total = lines.reduce((n, l) => n + (l.tool.isQuantity || l.kind === 'CUTTING' ? l.qty : 1), 0);
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button loading={pending} onClick={() => void submitScanner()} disabled={lines.length === 0}>
          Izdaj{total ? ` (${total})` : ''}
        </Button>
      </div>
    );
  } else if (manualStep === 1) {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Otkaži</Button>
        <Button
          onClick={() => {
            const rErr = validateRecipient();
            if (rErr) return setError(rErr);
            setError(null);
            setManualStep(2);
          }}
        >
          Sledeće →
        </Button>
      </div>
    );
  } else if (manualStep === 2) {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setManualStep(1)}>← Nazad</Button>
        <Button
          onClick={() => {
            const ok = docType === 'TOOL' ? lines.some((l) => l.kind === 'HAND') : coopLines.length > 0;
            if (!ok) return setError(docType === 'TOOL' ? 'Dodaj bar jedan alat.' : 'Dodaj bar jednu stavku.');
            setError(null);
            setManualStep(3);
          }}
        >
          Sledeće →
        </Button>
      </div>
    );
  } else {
    footer = (
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setManualStep(2)}>← Nazad</Button>
        <Button loading={pending} onClick={() => void submitManual()}>Kreiraj dokument</Button>
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Izdaj alat / opremu" size="lg" footer={footer}>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          {modeToggle}
          {mode === 'manual' && <span className="text-xs text-ink-secondary">Korak {manualStep} / 3</span>}
        </div>

        {mode === 'scanner' ? (
          <>
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Alati</h3>
              {chipList}
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setScanTool(true)}>
                  <ScanLine className="mr-1 h-4 w-4" aria-hidden /> Skeniraj alat
                </Button>
                <Button
                  onClick={() => {
                    const next = !pickerOpen;
                    setPickerOpen(next);
                    if (next) void loadInventory();
                  }}
                >
                  <BookOpen className="mr-1 h-4 w-4" aria-hidden /> Iz baze alata
                </Button>
              </div>
              {toolPicker}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Primalac</h3>
              {recipientBlock}
            </section>

            {machineBlock}
            {returnDateField}
          </>
        ) : manualStep === 1 ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Tip dokumenta" required>
                <select
                  className={SELECT}
                  value={docType}
                  onChange={(e) => {
                    setDocType(e.target.value as DocType);
                    setError(null);
                  }}
                >
                  <option value="TOOL">Alat / oprema</option>
                  <option value="COOPERATION_GOODS">Kooperaciona roba</option>
                </select>
              </FormField>
              <FormField label="Vrsta primaoca" required>
                <select
                  className={SELECT}
                  value={recipientKind}
                  onChange={(e) => setRecipientKind(e.target.value as RecipientKind)}
                >
                  <option value="EMPLOYEE">Radnik</option>
                  <option value="DEPARTMENT">Odeljenje</option>
                  <option value="EXTERNAL_COMPANY">Eksterna firma</option>
                </select>
              </FormField>
            </div>
            {recipientBlock}
            {returnDateField}
            <FormField label="Napomena dokumenta">
              <textarea className={INPUT} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </FormField>
          </>
        ) : manualStep === 2 ? (
          docType === 'TOOL' ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Alati</h3>
              <div className="space-y-1">
                <SearchBox value={manualToolQ} onChange={setManualToolQ} placeholder="Oznaka, naziv, barkod…" />
                {manualToolQ && (
                  <div className="max-h-40 overflow-auto rounded-control border border-line">
                    {(manualTools.data?.data ?? [])
                      .filter((t) => !lines.some((l) => l.kind === 'HAND' && l.tool.id === t.id))
                      .map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                          onClick={() => {
                            addHandTool(toLineTool(t), { silent: true });
                            setManualToolQ('');
                          }}
                        >
                          <span>
                            <span className="font-medium">{t.oznaka}</span>{' '}
                            <span className="text-ink-secondary">{t.naziv}</span>
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <div className="space-y-1 rounded-control border border-line p-2">
                {lines.filter((l) => l.kind === 'HAND').length === 0 ? (
                  <p className="text-sm text-ink-secondary">Nema dodatih alata.</p>
                ) : (
                  lines
                    .filter((l) => l.kind === 'HAND')
                    .map((l) => (
                      <div key={l.key} className="flex items-center gap-2 text-sm">
                        <span className="flex-1">
                          <span className="font-medium">{l.tool.oznaka}</span>{' '}
                          <span className="text-ink-secondary">{l.tool.naziv}</span>
                        </span>
                        <button type="button" aria-label="Ukloni" className="text-ink-secondary hover:text-status-danger" onClick={() => removeLine(l.key)}>
                          <Trash2 className="h-4 w-4" aria-hidden />
                        </button>
                      </div>
                    ))
                )}
              </div>
            </section>
          ) : (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-ink">Kooperaciona roba</h3>
              <div className="grid grid-cols-2 gap-2">
                <input className={INPUT} value={coopDraft.drawingNo} onChange={(e) => setCoopDraft((d) => ({ ...d, drawingNo: e.target.value }))} placeholder="Broj crteža" />
                <input className={INPUT} value={coopDraft.partName} onChange={(e) => setCoopDraft((d) => ({ ...d, partName: e.target.value }))} placeholder="Naziv dela" />
                <input className={INPUT} type="number" step="0.001" min={0} value={coopDraft.quantity} onChange={(e) => setCoopDraft((d) => ({ ...d, quantity: Number(e.target.value) || 1 }))} placeholder="Količina" />
                <input className={INPUT} value={coopDraft.unit} onChange={(e) => setCoopDraft((d) => ({ ...d, unit: e.target.value }))} placeholder="Jedinica" />
                <input className={INPUT} value={coopDraft.workOrderId} onChange={(e) => setCoopDraft((d) => ({ ...d, workOrderId: e.target.value }))} placeholder="Radni nalog (opciono)" />
                <input className={INPUT} value={coopDraft.napomena} onChange={(e) => setCoopDraft((d) => ({ ...d, napomena: e.target.value }))} placeholder="Napomena" />
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  if (!coopDraft.drawingNo.trim() && !coopDraft.partName.trim()) {
                    setError('Unesi broj crteža ili naziv dela.');
                    return;
                  }
                  setError(null);
                  setCoopLines((cs) => [...cs, { key: newClientEventId(), ...coopDraft, quantity: coopDraft.quantity || 1, unit: coopDraft.unit || 'kom' }]);
                  setCoopDraft({ drawingNo: '', partName: '', quantity: 1, unit: 'kom', workOrderId: '', napomena: '' });
                }}
              >
                + Dodaj stavku
              </Button>
              <div className="space-y-1 rounded-control border border-line p-2">
                {coopLines.length === 0 ? (
                  <p className="text-sm text-ink-secondary">Nema dodatih stavki.</p>
                ) : (
                  coopLines.map((l) => (
                    <div key={l.key} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate">
                        <span className="font-medium">{l.drawingNo || '—'}</span>{' '}
                        <span className="text-ink-secondary">{l.partName}</span>{' '}
                        <span className="tnums text-ink-secondary">
                          {formatNumber(l.quantity)} {l.unit}
                        </span>
                        {l.napomena && <span className="text-2xs text-ink-disabled"> · {l.napomena}</span>}
                      </span>
                      <button type="button" aria-label="Ukloni" className="text-ink-secondary hover:text-status-danger" onClick={() => setCoopLines((cs) => cs.filter((x) => x.key !== l.key))}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </section>
          )
        ) : (
          // manualStep === 3 — pregled (RB-41)
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Pregled reversal dokumenta</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-ink-secondary">Primalac</dt>
              <dd>
                {recipientKind === 'EMPLOYEE' ? recipient?.name ?? '—' : recipientKind === 'DEPARTMENT' ? department : companyName}
              </dd>
              <dt className="text-ink-secondary">Tip</dt>
              <dd>{docType === 'TOOL' ? 'Alat / oprema' : 'Kooperaciona roba'}</dd>
              <dt className="text-ink-secondary">Rok povraćaja</dt>
              <dd className="tnums">{returnDate || '—'}</dd>
            </dl>
            <ol className="list-decimal space-y-0.5 pl-5 text-sm">
              {docType === 'TOOL'
                ? lines
                    .filter((l) => l.kind === 'HAND')
                    .map((l) => (
                      <li key={l.key}>
                        {l.tool.naziv} <span className="text-ink-secondary">(oznaka: {l.tool.oznaka})</span>
                      </li>
                    ))
                : coopLines.map((l) => (
                    <li key={l.key}>
                      {l.drawingNo || '—'} — {l.partName} — {formatNumber(l.quantity)} {l.unit}
                    </li>
                  ))}
            </ol>
          </section>
        )}

        {error && (
          <p className="text-sm text-status-danger" role="alert">
            {error}
          </p>
        )}
      </div>

      {scanTool && (
        <ScanOverlay
          title="Skeniraj alat"
          hint="ALAT-… (ručni) ili RZN-… (rezni)"
          accept={['HAND', 'CUTTING']}
          onResult={(r) => {
            if (r.record) void handleToolScan(r.record as ReversiTool);
          }}
          onClose={() => setScanTool(false)}
        />
      )}
      {scanCard && (
        <ScanOverlay
          title="Skeniraj karticu"
          hint="ID kartica radnika"
          accept={['EMPLOYEE']}
          onResult={(r) => {
            const rec = r.record as { id: string; full_name: string; department: string | null } | null;
            if (rec?.id) setRecipient({ id: rec.id, name: rec.full_name, department: rec.department ?? '', isActive: true });
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
