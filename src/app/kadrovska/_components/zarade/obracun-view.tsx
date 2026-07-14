'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { ApiError } from '@/api/client';
import {
  useSalaryPayroll,
  useGrid,
  usePayrollInit,
  usePayrollRecompute,
  usePayrollUpsert,
  usePayrollLock,
  usePayrollUnlock,
  useUploadDocument,
  newClientEventId,
} from '@/api/kadrovska';
import { generateKarnetPdf, downloadBlob, openBlob, type KarnetEmployee } from '@/lib/hr-pdf';
import { generatePayslipPdf, generateBulkPayslipsPdf, payslipTotals, type PayslipRow } from '@/lib/hr-pdf/payslip';
import { SummaryChips, cyrMonthLabel, dayLetterCyr, monthDays } from '../common';
import {
  MONTHS_SR_UPPER,
  computeLiveTotals,
  deriveCompensationModel,
  fmtNum,
  fmtRsd,
  isDateInPaymentWindow,
  n,
  s,
  paymentWindowsForModel,
  PAYMENT_WINDOW_LABELS,
  type ViewRow,
} from './calc';

/* ── Status ──────────────────────────────────────────────────── */

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  draft: { label: '📝 Draft', tone: 'neutral' },
  advance_paid: { label: '💰 I deo isplaćen', tone: 'info' },
  finalized: { label: '✅ Finalizovano', tone: 'success' },
  paid: { label: '🔒 Isplaćeno', tone: 'warn' },
};
function statusLabel(st: string): string {
  return STATUS_META[st]?.label ?? (st || '—');
}
function nextStatus(cur: string): string | null {
  if (cur === 'draft') return 'advance_paid';
  if (cur === 'advance_paid') return 'finalized';
  if (cur === 'finalized') return 'paid';
  return null;
}

/* ── Editabilna polja reda ───────────────────────────────────── */

interface RowEdits {
  advance_amount?: number;
  advance_paid_on?: string;
  hours_worked?: number;
  hourly_rate?: number;
  fixed_salary?: number;
  transport_rsd?: number;
  domestic_days?: number;
  per_diem_rsd?: number;
  foreign_days?: number;
  per_diem_eur?: number;
  final_paid_on?: string;
}
const NUM_FIELDS = new Set([
  'advance_amount', 'hours_worked', 'hourly_rate', 'fixed_salary', 'transport_rsd',
  'domestic_days', 'per_diem_rsd', 'foreign_days', 'per_diem_eur',
]);

/** Spojen prikazni red (view red + lokalne izmene). */
function merged(row: ViewRow, e: RowEdits | undefined): ViewRow {
  return e ? { ...row, ...e } : row;
}

/** Prikazni totali: dirty → mirror trigera; K3.3 snimljen → ukupna_zarada; inače trigger polja. */
function displayTotals(row: ViewRow, dirty: boolean): { totalRsd: number; totalEur: number; secondPartRsd: number } {
  if (!dirty) {
    const t = payslipTotals(row);
    return { totalRsd: t.totRsd, totalEur: t.totEur, secondPartRsd: t.secRsd };
  }
  const live = computeLiveTotals({
    salaryType: s(row, 'salary_type'),
    hoursWorked: n(row, 'hours_worked'),
    hourlyRate: n(row, 'hourly_rate'),
    fixedSalary: n(row, 'fixed_salary'),
    transportRsd: n(row, 'transport_rsd'),
    domesticDays: n(row, 'domestic_days'),
    perDiemRsd: n(row, 'per_diem_rsd'),
    foreignDays: n(row, 'foreign_days'),
    perDiemEur: n(row, 'per_diem_eur'),
    advanceAmount: n(row, 'advance_amount'),
  });
  return { totalRsd: live.totalRsd, totalEur: live.totalEur, secondPartRsd: live.secondPartRsd };
}

/** Upozorenja (ne blokada) kad datumi isplate padaju van prozora modela. */
function paymentWindowWarnings(row: ViewRow): string[] {
  const model = s(row, 'compensation_model') || deriveCompensationModel(s(row, 'salary_type'));
  const ws = paymentWindowsForModel(model);
  if (!ws.length) return [];
  const out: string[] = [];
  const firstW = ws[0];
  const lastW = ws[ws.length - 1];
  const adv = s(row, 'advance_paid_on').slice(0, 10);
  const fin = s(row, 'final_paid_on').slice(0, 10);
  if (adv && !isDateInPaymentWindow(adv, firstW)) out.push(`Prvi deo/avans isplaćen van prozora (${PAYMENT_WINDOW_LABELS[firstW]})`);
  if (fin && !isDateInPaymentWindow(fin, lastW)) out.push(`Konačna isplata van prozora (${PAYMENT_WINDOW_LABELS[lastW]})`);
  return out;
}

/** Iz ApiError 409 poruke izvuci reason (BE: "… (stale)" / "(locked)" / "(row_exists)"). */
function conflictReason(e: unknown): string {
  if (e instanceof ApiError && e.status === 409) {
    const m = /\((stale|locked|row_exists)\)/.exec(e.message);
    return m?.[1] ?? 'conflict';
  }
  if (e instanceof ApiError && e.status === 403) return 'permission_denied';
  return 'error';
}

/* ── Glavna komponenta ───────────────────────────────────────── */

export function ObracunView() {
  const { can } = useAuth();
  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const canPii = can(PERMISSIONS.KADROVSKA_PII);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [q, setQ] = useState('');
  const [edits, setEdits] = useState<Record<string, RowEdits>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busyAction, setBusyAction] = useState<'' | 'init' | 'recompute' | 'lock' | 'pdf' | 'excel'>('');

  const payrollQ = useSalaryPayroll({ year, month }, canSalary);
  // Grid meseca — za auto-karnet posle zaključavanja (rows po zaposlenom + praznici).
  const gridQ = useGrid({ year, month });
  const init = usePayrollInit();
  const recompute = usePayrollRecompute();
  const upsert = usePayrollUpsert();
  const lock = usePayrollLock();
  const unlock = usePayrollUnlock();
  const uploadDoc = useUploadDocument();

  const rows = useMemo(() => (payrollQ.data?.data ?? []) as ViewRow[], [payrollQ.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => [s(r, 'employee_name'), s(r, 'employee_position'), s(r, 'employee_department')].join(' ').toLowerCase().includes(needle));
  }, [rows, q]);

  const rowId = (r: ViewRow) => s(r, 'id');

  /* Chips — K3.3-svesno (payslipTotals bira ukupna_zarada kad postoji). */
  const sums = useMemo(() => {
    let adv = 0, sec = 0, rsd = 0, eur = 0, draft = 0, fin = 0;
    for (const r of rows) {
      const m = merged(r, edits[rowId(r)]);
      const t = displayTotals(m, !!edits[rowId(r)]);
      adv += n(m, 'advance_amount');
      sec += t.secondPartRsd;
      rsd += t.totalRsd;
      eur += t.totalEur;
      const st = s(r, 'status');
      if (st === 'draft') draft += 1;
      if (st === 'finalized' || st === 'paid') fin += 1;
    }
    return { adv, sec, rsd, eur, draft, fin };
  }, [rows, edits]);

  function shiftMonth(delta: number) {
    let y = year, m = month + delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    setYear(y); setMonth(m); setEdits({});
  }

  function setField(id: string, field: keyof RowEdits, raw: string) {
    setEdits((prev) => ({
      ...prev,
      [id]: {
        ...prev[id],
        [field]: NUM_FIELDS.has(field) ? (raw === '' ? 0 : Number(raw)) : raw,
      },
    }));
  }

  /* ── Akcije ── */

  async function onInit() {
    setBusyAction('init');
    setMsg('');
    try {
      const res = await init.mutateAsync({ year, month, clientEventId: newClientEventId() });
      const created = Number((res as { data?: unknown })?.data ?? 0);
      setMsg(created > 0 ? `✅ Kreirano ${created} novih redova` : 'ℹ Svi aktivni zaposleni već imaju red za ovaj mesec');
    } catch (e) {
      setMsg(e instanceof ApiError ? `⚠ ${e.message}` : '⚠ Greška pri pripremi meseca');
    } finally {
      setBusyAction('');
    }
  }

  async function onRecompute() {
    if (!rows.length) { setMsg('Nema redova — prvo pripremi mesec'); return; }
    if (!window.confirm(`Obračun iz grida — ${MONTHS_SR_UPPER[month - 1]} ${year}\n\nSati, teren i K3.3 totali biće učitani iz mesečnog grida i UPISANI u sve redove koji NISU isplaćeni (paid). Ručne izmene sati na redu mogu biti prepisane.`)) return;
    setBusyAction('recompute');
    setMsg('⏳ Obračun iz grida…');
    try {
      const res = await recompute.mutateAsync({ year, month, persist: true, clientEventId: newClientEventId() });
      const out = res.data;
      const list = (out?.rows ?? []) as Record<string, unknown>[];
      const updated = list.filter((r) => r.persisted === true).length;
      const locked = list.filter((r) => r.reason === 'locked').length;
      const failed = list.filter((r) => r.persisted === false && r.reason !== 'locked').length;
      const parts = [`✅ ${updated} ažurirano`];
      if (locked) parts.push(`${locked} preskočeno (paid)`);
      if (failed) parts.push(`${failed} greška`);
      setMsg(parts.join(' · '));
      setEdits({});
    } catch (e) {
      setMsg(e instanceof ApiError ? `⚠ ${e.message}` : '⚠ Greška pri obračunu iz grida');
    } finally {
      setBusyAction('');
    }
  }

  /** p_row za hr_upsert_salary_payroll — snake_case + expected_updated_at (BE usklađuje µs). */
  function buildRowPayload(m: ViewRow, statusOverride?: string): Record<string, unknown> {
    return {
      id: s(m, 'id'),
      employee_id: s(m, 'employee_id'),
      period_year: n(m, 'period_year'),
      period_month: n(m, 'period_month'),
      salary_type: s(m, 'salary_type') || 'ugovor',
      ...(s(m, 'compensation_model') ? { compensation_model: s(m, 'compensation_model') } : {}),
      advance_amount: n(m, 'advance_amount'),
      advance_paid_on: s(m, 'advance_paid_on').slice(0, 10) || null,
      fixed_salary: n(m, 'fixed_salary'),
      hours_worked: n(m, 'hours_worked'),
      hourly_rate: n(m, 'hourly_rate'),
      transport_rsd: n(m, 'transport_rsd'),
      domestic_days: n(m, 'domestic_days'),
      per_diem_rsd: n(m, 'per_diem_rsd'),
      foreign_days: n(m, 'foreign_days'),
      per_diem_eur: n(m, 'per_diem_eur'),
      final_paid_on: s(m, 'final_paid_on').slice(0, 10) || null,
      status: statusOverride ?? (s(m, 'status') || 'draft'),
      note: s(m, 'note'),
      expected_updated_at: s(m, 'updated_at') || null,
    };
  }

  async function saveRow(r: ViewRow) {
    const id = rowId(r);
    const m = merged(r, edits[id]);
    setRowBusy(id);
    try {
      await upsert.mutateAsync({ row: buildRowPayload(m), clientEventId: newClientEventId() });
      setEdits((prev) => { const cp = { ...prev }; delete cp[id]; return cp; });
      const warns = paymentWindowWarnings(m);
      setMsg(warns.length ? `💾 Sačuvano · ⚠ ${warns.join('; ')}` : '💾 Sačuvano');
    } catch (e) {
      const reason = conflictReason(e);
      if (reason === 'locked') setMsg('⚠ Red je zaključan (status=paid). Klikni na status da otključaš pre izmene.');
      else if (reason === 'stale') { setMsg('⚠ Red je izmenjen u međuvremenu — osvežavam'); payrollQ.refetch(); }
      else if (reason === 'row_exists') { setMsg('⚠ Drugi admin je upravo kreirao ovaj red — osvežavam'); payrollQ.refetch(); }
      else if (reason === 'permission_denied') setMsg('⚠ Niste admin');
      else setMsg('⚠ Čuvanje nije uspelo');
    } finally {
      setRowBusy(null);
    }
  }

  async function cycleStatus(r: ViewRow) {
    const id = rowId(r);
    const cur = s(r, 'status');

    // paid → ponudi otključavanje (unlock RPC, audit trag)
    if (cur === 'paid') {
      if (!window.confirm('Ovaj red je markiran kao ISPLAĆENO. Otključavanjem se vraća u status FINALIZOVANO i ponovo se može menjati. Akcija ostavlja audit trag.\n\nOtključati?')) return;
      setRowBusy(id);
      try {
        await unlock.mutateAsync({ id, clientEventId: newClientEventId() });
        setMsg('🔓 Red otključan — status: FINALIZOVANO');
      } catch (e) {
        setMsg(e instanceof ApiError && e.status === 403 ? '⚠ Samo admin može da otključa' : '⚠ Otključavanje nije uspelo');
      } finally {
        setRowBusy(null);
      }
      return;
    }

    const next = nextStatus(cur);
    if (!next) { setMsg('ℹ Već je u krajnjem statusu'); return; }
    if (next === 'paid' && !window.confirm('Obeležiti kao ISPLAĆENO? Nakon toga se red više ne može menjati bez eksplicitnog otključavanja.')) return;

    const m = merged(r, edits[id]);
    setRowBusy(id);
    try {
      await upsert.mutateAsync({ row: buildRowPayload(m, next), clientEventId: newClientEventId() });
      setEdits((prev) => { const cp = { ...prev }; delete cp[id]; return cp; });
      setMsg(`→ ${statusLabel(next)}`);
    } catch (e) {
      const reason = conflictReason(e);
      if (reason === 'locked') setMsg('⚠ Red je zaključan — admin mora prvo otključati');
      else if (reason === 'stale') { setMsg('⚠ Red je izmenjen u međuvremenu — osvežavam'); payrollQ.refetch(); }
      else if (reason === 'permission_denied') setMsg('⚠ Niste admin');
      else setMsg('⚠ Nije sačuvano');
    } finally {
      setRowBusy(null);
    }
  }

  async function lockMonthBulk() {
    const candidates = rows.filter((r) => s(r, 'status') === 'finalized');
    if (!candidates.length) {
      const draftCount = rows.filter((r) => ['draft', 'advance_paid'].includes(s(r, 'status'))).length;
      setMsg(draftCount ? `ℹ Nema finalizovanih redova. ${draftCount} red(ova) još nisu finalizovani.` : 'ℹ Nema redova za zaključavanje');
      return;
    }
    const typed = window.prompt(
      `Zaključavanje meseca ${MONTHS_SR_UPPER[month - 1]} ${year}\n\n${candidates.length} red(ova) će biti markirano kao ISPLAĆENO. Nakon toga se ti redovi VIŠE NE MOGU menjati ni brisati.\n\nZa potvrdu upiši: ZAKLJUČAJ`,
    );
    if (typed !== 'ZAKLJUČAJ') { if (typed !== null) setMsg('ℹ Zaključavanje otkazano (tekst se ne poklapa)'); return; }

    setBusyAction('lock');
    let okCount = 0, staleCount = 0, failCount = 0;
    const lockedEmpIds: string[] = [];
    for (const r of candidates) {
      try {
        await lock.mutateAsync({ id: rowId(r), expectedUpdatedAt: s(r, 'updated_at'), clientEventId: newClientEventId() });
        okCount += 1;
        lockedEmpIds.push(s(r, 'employee_id'));
      } catch (e) {
        if (conflictReason(e) === 'stale') staleCount += 1;
        else failCount += 1;
      }
    }
    if (failCount === 0 && staleCount === 0) setMsg(`🔒 Zaključano ${okCount} red(ova)`);
    else if (staleCount > 0 && failCount === 0) setMsg(`🔒 Zaključano ${okCount}, ${staleCount} red(ova) je u međuvremenu izmenjeno — osveži i probaj ponovo`);
    else setMsg(`⚠ Zaključano ${okCount}, neuspešno ${failCount}, stale ${staleCount}`);

    // Auto-karnet: generiši radne listove za zaključane i snimi u dokumenta
    // (docType 'karnet'). Greška ovde NE poništava zaključavanje.
    if (okCount > 0 && lockedEmpIds.length) {
      if (!canPii) {
        setMsg((p) => `${p} · ℹ Karneti preskočeni (nema kadrovska.pii za upis dokumenata)`);
      } else {
        try {
          await generateKarnete(lockedEmpIds);
        } catch (e) {
          console.error('[zarade] auto-karnet', e);
          setMsg((p) => `${p} · ⚠ Mesec je zaključan, ali karneti nisu generisani`);
        }
      }
    }
    setBusyAction('');
  }

  /** Po zaključavanju: karnet PDF po zaposlenom → employee_documents (docType karnet). */
  async function generateKarnete(employeeIds: string[]) {
    const grid = gridQ.data?.data;
    if (!grid) { setMsg((p) => `${p} · ⚠ Karneti: grid meseca nije učitan`); return; }
    const holidaySet = new Set<string>();
    for (const h of grid.holidays ?? []) if (!h.isWorkday) holidaySet.add(String(h.holidayDate).slice(0, 10));
    const days = monthDays(year, month).map((d) => ({ ...d, letter: dayLetterCyr(d.ymd) }));
    const monthLabel = cyrMonthLabel(year, month);
    const byEmp = new Map<string, Map<string, (typeof grid.rows)[number]>>();
    for (const r of grid.rows ?? []) {
      if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, new Map());
      byEmp.get(r.employeeId)!.set(String(r.workDate).slice(0, 10), r);
    }
    let generated = 0, failed = 0;
    for (let i = 0; i < employeeIds.length; i++) {
      const empId = employeeIds[i];
      const row = rows.find((r) => s(r, 'employee_id') === empId);
      const name = row ? s(row, 'employee_name') : empId.slice(0, 8);
      setMsg(`⏳ Karnet ${i + 1}/${employeeIds.length}: ${name}…`);
      try {
        const empRows = byEmp.get(empId) ?? new Map();
        const employees: KarnetEmployee[] = [{
          name,
          position: row ? s(row, 'employee_position') : '',
          rows: empRows,
        }];
        const { blob, fileName } = await generateKarnetPdf({
          title: `КАРНЕТ — ${monthLabel}`,
          monthLabel,
          days,
          holidayYmdSet: holidaySet,
          employees,
        });
        const file = new File([blob], fileName, { type: 'application/pdf' });
        await uploadDoc.mutateAsync({
          employeeId: empId,
          file,
          docType: 'karnet',
          description: `Karnet ${MONTHS_SR_UPPER[month - 1]} ${year} (auto uz zaključavanje meseca)`,
          clientEventId: newClientEventId(),
        });
        generated += 1;
      } catch (e) {
        console.error('[zarade] karnet', empId, e);
        failed += 1;
      }
    }
    setMsg(`📄 Karneti: ${generated} sačuvano u dokumenta${failed ? `, ${failed} neuspešno` : ''}`);
  }

  async function exportXlsx() {
    setBusyAction('excel');
    try {
      const XLSX = await import('xlsx');
      const aoa: (string | number)[][] = [[
        'Zaposleni', 'Pozicija', 'Odeljenje', 'Tip',
        'I deo (RSD)', 'I deo datum',
        'Sati', 'Satnica', 'Fiksna plata',
        'Prevoz (RSD)', 'Domaći tereni', 'Dinarska dnev.',
        'Ino tereni', 'Devizna dnev. (EUR)',
        'Ukupno RSD', 'Ukupno EUR', 'II deo (RSD)',
        'II deo datum', 'Status', 'Napomena',
      ]];
      const list = rows.map((r) => merged(r, edits[rowId(r)]));
      for (const m of list) {
        const t = displayTotals(m, false);
        aoa.push([
          s(m, 'employee_name'), s(m, 'employee_position'), s(m, 'employee_department'), s(m, 'salary_type'),
          n(m, 'advance_amount'), s(m, 'advance_paid_on').slice(0, 10),
          n(m, 'hours_worked'), n(m, 'hourly_rate'), n(m, 'fixed_salary'),
          n(m, 'transport_rsd'), n(m, 'domestic_days'), n(m, 'per_diem_rsd'),
          n(m, 'foreign_days'), n(m, 'per_diem_eur'),
          t.totalRsd, t.totalEur, t.secondPartRsd,
          s(m, 'final_paid_on').slice(0, 10), statusLabel(s(m, 'status')), s(m, 'note'),
        ]);
      }
      const sum = (ci: number) => list.reduce((a, m, i) => a + (Number(aoa[i + 1][ci]) || 0), 0);
      aoa.push([]);
      aoa.push(['UKUPNO', '', '', '', sum(4), '', '', '', '', sum(9), '', '', '', '', sum(14), sum(15), sum(16), '', '', '']);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [
        { wch: 28 }, { wch: 20 }, { wch: 16 }, { wch: 10 },
        { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
        { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
        { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 24 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, `${MONTHS_SR_UPPER[month - 1]} ${year}`);
      XLSX.writeFile(wb, `Zarade_obracun_${year}-${String(month).padStart(2, '0')}.xlsx`);
      setMsg('📊 Izvezeno');
    } finally {
      setBusyAction('');
    }
  }

  async function pdfOne(r: ViewRow) {
    const m = merged(r, edits[rowId(r)]);
    const { blob, fileName } = await generatePayslipPdf({ row: m, employeeName: s(m, 'employee_name') });
    openBlob(blob);
    downloadBlob(blob, fileName);
  }

  async function pdfAll() {
    if (!filtered.length) { setMsg('Nema zaposlenih u trenutnom filteru'); return; }
    setBusyAction('pdf');
    try {
      const inputs: PayslipRow[] = filtered
        .map((r) => merged(r, edits[rowId(r)]))
        .sort((a, b) => s(a, 'employee_name').localeCompare(s(b, 'employee_name'), 'sr'))
        .map((m) => ({ row: m, employeeName: s(m, 'employee_name') }));
      const { blob, fileName } = await generateBulkPayslipsPdf(inputs);
      openBlob(blob);
      downloadBlob(blob, fileName);
      setMsg(`📄 Generisano ${inputs.length} obračuna u jednom PDF-u`);
    } finally {
      setBusyAction('');
    }
  }

  /* ── Render ── */

  const numCls = 'h-7 w-full rounded-control border border-line bg-surface px-1.5 text-right text-xs text-ink tnums focus-visible:outline-none focus-visible:border-accent disabled:opacity-50';
  const dateCls = 'h-7 rounded-control border border-line bg-surface px-1 text-xs text-ink focus-visible:outline-none focus-visible:border-accent disabled:opacity-50';

  return (
    <div className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Zaposlenih', value: rows.length, tone: 'accent' },
          { label: 'Draft', value: sums.draft, tone: sums.draft ? 'warn' : 'default' },
          { label: 'Finalizovano / isplaćeno', value: sums.fin },
          { label: 'I deo (akontacija)', value: fmtRsd(sums.adv) },
          { label: 'II deo (konačno)', value: fmtRsd(sums.sec) },
          { label: 'Ukupno RSD', value: fmtRsd(sums.rsd), tone: 'accent' },
          { label: 'Ukupno EUR', value: `${fmtNum(sums.eur)} EUR`, tone: 'accent' },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => shiftMonth(-1)} title="Prethodni mesec">‹</Button>
        <input
          type="month"
          value={`${year}-${String(month).padStart(2, '0')}`}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number);
            if (y && m) { setYear(y); setMonth(m); setEdits({}); }
          }}
          className="h-9 rounded-control border border-line bg-surface px-3 text-sm"
        />
        <Button variant="ghost" onClick={() => shiftMonth(1)} title="Sledeći mesec">›</Button>
        <div className="w-56">
          <SearchBox value={q} onChange={setQ} placeholder="Pretraga zaposlenih…" />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => payrollQ.refetch()} title="Prisilni reload perioda iz baze (multi-admin)">🔄 Osveži</Button>
          <Button variant="secondary" onClick={exportXlsx} loading={busyAction === 'excel'}>📊 Excel</Button>
          <Button variant="secondary" onClick={pdfAll} loading={busyAction === 'pdf'} title="Svi filtrirani obračuni meseca u jednom PDF dokumentu">📄 PDF svi</Button>
          <Button onClick={onInit} loading={busyAction === 'init'} title="Kreiraj draft redove za sve aktivne zaposlene za izabrani mesec">+ Pripremi mesec</Button>
          <Button onClick={onRecompute} loading={busyAction === 'recompute'} title="Učitaj sate i teren iz mesečnog grida i preračunaj K3.3 totale (upis u sve ne-paid redove)">↻ Obračunaj iz grida</Button>
          <Button variant="danger" onClick={lockMonthBulk} loading={busyAction === 'lock'} title="Markiraj sve finalizovane redove kao isplaćene — više ne mogu da se menjaju">🔒 Zaključaj mesec</Button>
        </div>
      </div>

      <p className="text-xs text-ink-secondary">
        <strong>Prvi deo</strong> = akontacija (do 5. u mesecu). <strong>Drugi deo</strong> = ukupno − prvi deo (15–20. u mesecu).
        Za aktivne uslove K3.3 ukupno se računa iz <strong>mesečnog grida</strong> (GO i državni praznici = 8h radnog dana,
        bol.: bo 0,65× / bop 1×) + ova polja za prevoz i dnevnice.
      </p>

      {msg && <div className="rounded-control border border-line bg-surface-2 px-3 py-2 text-sm text-ink" aria-live="polite">{msg}</div>}

      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full min-w-[1280px] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
              <th className="sticky left-0 z-10 h-9 bg-surface-2 px-3 font-semibold">Zaposleni</th>
              <th className="h-9 px-2 font-semibold">Tip</th>
              <th className="h-9 px-2 font-semibold" title="Akontacija (prvi deo)">I deo</th>
              <th className="h-9 px-2 font-semibold" title="Datum isplate I dela">I deo – datum</th>
              <th className="h-9 px-2 font-semibold" title="Satnica × sati ili fiksna plata">Sati / Fiksno</th>
              <th className="h-9 px-2 font-semibold">Prevoz</th>
              <th className="h-9 px-2 font-semibold" title="Broj domaćih terena × dinarska dnevnica">Dom. tereni</th>
              <th className="h-9 px-2 font-semibold" title="Broj ino terena × devizna dnevnica">Ino tereni</th>
              <th className="h-9 px-2 text-right font-semibold" title="Ukupno RSD = baza + prevoz + dinarske dnevnice">Ukupno RSD</th>
              <th className="h-9 px-2 text-right font-semibold" title="Devizne dnevnice zasebno">Ukupno EUR</th>
              <th className="h-9 px-2 text-right font-semibold" title="II deo = UKUPNO RSD − I deo">II deo</th>
              <th className="h-9 px-2 font-semibold">II deo – datum</th>
              <th className="h-9 px-2 font-semibold">Status</th>
              <th className="h-9 px-2 text-right font-semibold">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {payrollQ.isLoading ? (
              <tr><td colSpan={14} className="px-4 py-10 text-center text-ink-disabled">Učitavanje…</td></tr>
            ) : !filtered.length ? (
              <tr>
                <td colSpan={14} className="p-0">
                  <EmptyState title={`Nema obračuna za ${MONTHS_SR_UPPER[month - 1]} ${year}.`} hint="Klikni + Pripremi mesec da se kreiraju draft redovi za sve aktivne zaposlene." />
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const id = rowId(r);
                const e = edits[id];
                const m = merged(r, e);
                const dirty = !!e;
                const isHourly = s(m, 'salary_type') === 'satnica';
                const locked = s(r, 'status') === 'paid';
                const t = displayTotals(m, dirty);
                const busy = rowBusy === id;
                return (
                  <tr key={id} className={`border-b border-line-soft ${dirty ? 'bg-status-warn-bg/40' : ''} ${locked ? 'opacity-70' : ''}`}>
                    <td className="sticky left-0 z-10 bg-surface px-3 py-1.5">
                      <div className="font-medium text-ink">{s(m, 'employee_name') || '—'}</div>
                      <div className="text-2xs text-ink-secondary">{[s(m, 'employee_position'), s(m, 'employee_department')].filter(Boolean).join(' / ')}</div>
                    </td>
                    <td className="px-2 py-1.5 text-xs">{s(m, 'salary_type')}</td>
                    <td className="w-24 px-2 py-1.5">
                      <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'advance_amount') || ''} placeholder="0" disabled={locked} onChange={(ev) => setField(id, 'advance_amount', ev.target.value)} />
                    </td>
                    <td className="w-32 px-2 py-1.5">
                      <input type="date" className={dateCls} value={s(m, 'advance_paid_on').slice(0, 10)} disabled={locked} onChange={(ev) => setField(id, 'advance_paid_on', ev.target.value)} />
                    </td>
                    <td className="w-36 px-2 py-1.5">
                      {isHourly ? (
                        <div className="flex items-center gap-1">
                          <input type="number" min={0} step="0.25" className={numCls} value={n(m, 'hours_worked') || ''} placeholder="0" title="Sati" disabled={locked} onChange={(ev) => setField(id, 'hours_worked', ev.target.value)} />
                          <span className="text-2xs text-ink-secondary">×</span>
                          <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'hourly_rate') || ''} placeholder="0" title="Satnica" disabled={locked} onChange={(ev) => setField(id, 'hourly_rate', ev.target.value)} />
                        </div>
                      ) : (
                        <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'fixed_salary') || ''} placeholder="0" title="Fiksna plata" disabled={locked} onChange={(ev) => setField(id, 'fixed_salary', ev.target.value)} />
                      )}
                    </td>
                    <td className="w-24 px-2 py-1.5">
                      <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'transport_rsd') || ''} placeholder="0" disabled={locked} onChange={(ev) => setField(id, 'transport_rsd', ev.target.value)} />
                    </td>
                    <td className="w-32 px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} step="1" className={numCls} value={n(m, 'domestic_days') || ''} placeholder="0" title="Broj domaćih terena" disabled={locked} onChange={(ev) => setField(id, 'domestic_days', ev.target.value)} />
                        <span className="text-2xs text-ink-secondary">×</span>
                        <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'per_diem_rsd') || ''} placeholder="0" title="Dinarska dnevnica" disabled={locked} onChange={(ev) => setField(id, 'per_diem_rsd', ev.target.value)} />
                      </div>
                    </td>
                    <td className="w-32 px-2 py-1.5">
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} step="1" className={numCls} value={n(m, 'foreign_days') || ''} placeholder="0" title="Broj ino terena" disabled={locked} onChange={(ev) => setField(id, 'foreign_days', ev.target.value)} />
                        <span className="text-2xs text-ink-secondary">×</span>
                        <input type="number" min={0} step="0.01" className={numCls} value={n(m, 'per_diem_eur') || ''} placeholder="0" title="Devizna dnevnica EUR" disabled={locked} onChange={(ev) => setField(id, 'per_diem_eur', ev.target.value)} />
                      </div>
                    </td>
                    <td className="px-2 py-1.5 text-right font-semibold tnums">{fmtRsd(t.totalRsd)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold tnums">{fmtNum(t.totalEur)} EUR</td>
                    <td className="px-2 py-1.5 text-right font-semibold tnums">{fmtRsd(t.secondPartRsd)}</td>
                    <td className="w-32 px-2 py-1.5">
                      <input type="date" className={dateCls} value={s(m, 'final_paid_on').slice(0, 10)} disabled={locked} onChange={(ev) => setField(id, 'final_paid_on', ev.target.value)} />
                    </td>
                    <td className="px-2 py-1.5">
                      <StatusBadge tone={STATUS_META[s(r, 'status')]?.tone ?? 'neutral'} label={statusLabel(s(r, 'status'))} />
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="flex justify-end gap-1 whitespace-nowrap">
                        <button
                          onClick={() => saveRow(r)}
                          disabled={locked || busy}
                          className="rounded-control bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
                          title="Sačuvaj red (optimistic lock)"
                        >
                          💾 {dirty ? 'Sačuvaj *' : 'Sačuvaj'}
                        </button>
                        <button onClick={() => cycleStatus(r)} disabled={busy} className="rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2 disabled:opacity-50" title="Promeni status (paid = otključavanje)">↑ Status</button>
                        <button onClick={() => pdfOne(r)} className="rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2" title="Generiši PDF obračun za zaposlenog">📄 PDF</button>
                        {/* TODO(P1a): DELETE /salary/payroll/:id ne postoji na BE — dugme se
                            aktivira kad P1a doda endpoint (uz guard da paid ne sme). */}
                        <button disabled className="rounded-control px-2 py-1 text-xs text-status-danger opacity-40" title="Čeka P1a: BE DELETE /salary/payroll/:id endpoint">🗑</button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
