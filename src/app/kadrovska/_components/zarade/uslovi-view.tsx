'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { SearchBox } from '@/components/ui-kit/search-box';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { formatDate } from '@/lib/format';
import {
  useEmployees,
  useSalaryCurrent,
  type SalaryTerm,
} from '@/api/kadrovska';
import { SummaryChips } from '../common';
import {
  PAYROLL_GROUP_LETTER,
  fmtMoney,
  n,
  s,
  salaryTypeLabel,
  type ViewRow,
} from './calc';
import { TermModal, type EmployeeOption } from './term-modal';
import { HistoryModal } from './history-modal';
import { AccountantModal } from './accountant-modal';

/** v_employee_current_salary red (snake_case) → Partial<SalaryTerm> za TermModal prefill. */
function currentToTerm(c: ViewRow, withId: boolean): Partial<SalaryTerm> {
  return {
    ...(withId ? { id: s(c, 'salary_term_id') } : {}),
    employeeId: s(c, 'employee_id'),
    salaryType: s(c, 'salary_type') || 'ugovor',
    effectiveFrom: s(c, 'effective_from'),
    effectiveTo: s(c, 'effective_to') || null,
    amount: s(c, 'amount'),
    amountType: s(c, 'amount_type') || 'neto',
    currency: s(c, 'currency') || 'RSD',
    compensationModel: s(c, 'compensation_model') || null,
    netoRsd: s(c, 'neto_rsd') || null,
    brutoRsd: s(c, 'bruto_rsd') || null,
    transportAllowanceRsd: s(c, 'transport_allowance_rsd') || null,
    perDiemRsd: s(c, 'per_diem_rsd') || null,
    perDiemEur: s(c, 'per_diem_eur') || null,
    payrollGroup: s(c, 'payroll_group') || 'standard',
    approvedBy: s(c, 'approved_by') || null,
    approvedAt: s(c, 'approved_at') || null,
    note: s(c, 'note') || null,
    contractRef: s(c, 'contract_ref') || null,
    fixedAmount: s(c, 'fixed_amount') || null,
    fixedExtraHourRate: s(c, 'fixed_extra_hour_rate') || null,
    firstPartAmount: s(c, 'first_part_amount') || null,
    splitHourRate: s(c, 'split_hour_rate') || null,
    fixedNoExtraHours: !!c.fixed_no_extra_hours,
    paymentWindowOverride: s(c, 'payment_window_override') || null,
    cashAllowanceRsd: s(c, 'cash_allowance_rsd') || null,
  } as Partial<SalaryTerm>;
}

type ModalState =
  | { kind: 'none' }
  | { kind: 'term'; term: Partial<SalaryTerm> | null; presetEmployeeId?: string }
  | { kind: 'history'; employeeId: string; employeeName: string }
  | { kind: 'accountant' };

export function UsloviView() {
  const { can } = useAuth();
  const canSalary = can(PERMISSIONS.KADROVSKA_SALARY);
  const [q, setQ] = useState('');
  const [typeF, setTypeF] = useState('');
  const [statF, setStatF] = useState<'active' | 'all'>('active');
  const [groupF, setGroupF] = useState('');
  const [modal, setModal] = useState<ModalState>({ kind: 'none' });
  const [busyExport, setBusyExport] = useState(false);

  // Svi zaposleni (uklj. bez zarade) + aktuelna zarada. pageSize 200 = BE max
  // (pokriva ceo spisak firme u jednoj strani).
  const empQ = useEmployees({ active: statF === 'active' ? true : undefined, pageSize: 200 });
  const curQ = useSalaryCurrent({}, canSalary);

  const current = useMemo(() => (curQ.data?.data ?? []) as ViewRow[], [curQ.data]);
  const byEmp = useMemo(() => new Map(current.map((c) => [s(c, 'employee_id'), c])), [current]);

  const employees = useMemo(() => (empQ.data?.data ?? []) as ViewRow[], [empQ.data]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return employees.filter((e) => {
      if (needle) {
        const hay = [s(e, 'full_name'), s(e, 'position'), s(e, 'department')].join(' ').toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      const sal = byEmp.get(s(e, 'id'));
      if (typeF && (!sal || s(sal, 'salary_type') !== typeF)) return false;
      if (groupF && (!sal || (s(sal, 'payroll_group') || 'standard') !== groupF)) return false;
      return true;
    });
  }, [employees, byEmp, q, typeF, groupF]);

  const withSalary = filtered.filter((e) => byEmp.has(s(e, 'id')));
  const without = filtered.filter((e) => !byEmp.has(s(e, 'id')));

  const employeeOptions: EmployeeOption[] = useMemo(
    () => employees.map((e) => ({ id: s(e, 'id'), name: s(e, 'full_name'), position: s(e, 'position'), department: s(e, 'department') })),
    [employees],
  );
  const nameOf = (id: string) => employeeOptions.find((e) => e.id === id)?.name || id.slice(0, 8);

  async function exportXlsx() {
    setBusyExport(true);
    try {
      const XLSX = await import('xlsx');
      const aoa: (string | number)[][] = [[
        'Zaposleni', 'Pozicija', 'Odeljenje', 'Tip',
        'Iznos', 'Valuta', 'Neto/Bruto',
        'Prevoz (RSD)', 'Din. dnev. (RSD)', 'Dev. dnev. (EUR)',
        'Važi od', 'Važi do', 'Ugovor br.',
      ]];
      for (const e of employees) {
        const sal = byEmp.get(s(e, 'id'));
        if (!sal) continue;
        aoa.push([
          s(e, 'full_name'), s(e, 'position'), s(e, 'department'),
          salaryTypeLabel(s(sal, 'salary_type')),
          n(sal, 'amount'), s(sal, 'currency') || 'RSD', s(sal, 'amount_type') || 'neto',
          n(sal, 'transport_allowance_rsd'), n(sal, 'per_diem_rsd'), n(sal, 'per_diem_eur'),
          s(sal, 'effective_from').slice(0, 10), s(sal, 'effective_to').slice(0, 10), s(sal, 'contract_ref'),
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = [{ wch: 30 }, { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 18 }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Uslovi zarade');
      XLSX.writeFile(wb, `Zarade_uslovi_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } finally {
      setBusyExport(false);
    }
  }

  const loading = empQ.isLoading || curQ.isLoading;
  const selectCls = 'h-9 rounded-control border border-line bg-surface px-3 text-sm text-ink';

  return (
    <div className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Sa aktivnom zaradom', value: withSalary.length, tone: 'accent' },
          { label: 'Bez zarade', value: without.length, tone: without.length ? 'warn' : 'default' },
          { label: 'Ugovor', value: current.filter((c) => s(c, 'salary_type') === 'ugovor').length },
          { label: 'Dogovor', value: current.filter((c) => s(c, 'salary_type') === 'dogovor').length },
          { label: 'Satnica', value: current.filter((c) => s(c, 'salary_type') === 'satnica').length },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-64">
          <SearchBox value={q} onChange={setQ} placeholder="Pretraga po imenu, poziciji…" />
        </div>
        <select value={typeF} onChange={(e) => setTypeF(e.target.value)} className={selectCls} aria-label="Tip zarade">
          <option value="">Svi tipovi</option>
          <option value="ugovor">Ugovor</option>
          <option value="dogovor">Dogovor</option>
          <option value="satnica">Satnica</option>
        </select>
        <select value={statF} onChange={(e) => setStatF(e.target.value as 'active' | 'all')} className={selectCls} aria-label="Status zaposlenog">
          <option value="active">Samo aktivni</option>
          <option value="all">Svi</option>
        </select>
        <select value={groupF} onChange={(e) => setGroupF(e.target.value)} className={selectCls} title="Grupa za knjigovođu" aria-label="Grupa za knjigovođu">
          <option value="">Sve grupe</option>
          <option value="standard">Bez olakšica (standard)</option>
          <option value="olaksice">O — Stare olakšice</option>
          <option value="razvoj">R — Razvoj</option>
          <option value="stranci">S — Stranci</option>
          <option value="hapfluid">H — HAP Fluid</option>
          <option value="kes">K — Keš</option>
        </select>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={exportXlsx} loading={busyExport}>📊 Excel</Button>
          <Button variant="secondary" onClick={() => setModal({ kind: 'accountant' })} title="Mesečne PDF tabele zarada po grupama za knjigovođu">
            📤 Tabele za knjigovođu
          </Button>
          <Button onClick={() => setModal({ kind: 'term', term: null })}>+ Novi unos zarade</Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-panel border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-2xs uppercase tracking-[0.08em] text-ink-secondary">
              <th className="h-9 px-3 font-semibold">Zaposleni</th>
              <th className="h-9 px-3 font-semibold">Pozicija / Odeljenje</th>
              <th className="h-9 px-3 font-semibold">Tip</th>
              <th className="h-9 px-3 font-semibold text-right">Iznos / satnica</th>
              <th className="h-9 px-3 font-semibold text-right">Prevoz</th>
              <th className="h-9 px-3 font-semibold text-right">Dinarska dnev.</th>
              <th className="h-9 px-3 font-semibold text-right">Devizna dnev.</th>
              <th className="h-9 px-3 font-semibold">Važi od</th>
              <th className="h-9 px-3 text-right font-semibold">Akcije</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-10 text-center text-ink-disabled">Učitavanje…</td></tr>
            ) : !filtered.length ? (
              <tr><td colSpan={9} className="p-0"><EmptyState title="Nema upisanih zarada" hint="Klikni + Novi unos zarade da dodaš prvi zapis." /></td></tr>
            ) : (
              filtered.map((e) => {
                const id = s(e, 'id');
                const sal = byEmp.get(id);
                const posDept = [s(e, 'position'), s(e, 'department')].filter(Boolean).join(' / ');
                const grpLetter = sal ? PAYROLL_GROUP_LETTER[s(sal, 'payroll_group')] || '' : '';
                return (
                  <tr key={id} className="h-[var(--table-row-height)] border-b border-line-soft hover:bg-surface-2">
                    <td className="px-3 font-medium text-ink">
                      {s(e, 'full_name') || '—'}
                      {grpLetter && (
                        <sup className="ml-0.5 cursor-help text-2xs text-ink-secondary" title={`Grupa za knjigovođu: ${s(sal!, 'payroll_group')}`}>{grpLetter}</sup>
                      )}
                    </td>
                    <td className="px-3 text-ink-secondary">{posDept || '—'}</td>
                    <td className="px-3">{sal ? salaryTypeLabel(s(sal, 'salary_type')) : <span className="text-ink-disabled">—</span>}</td>
                    <td className="px-3 text-right tnums">
                      {sal ? (
                        <>
                          <strong>{fmtMoney(n(sal, 'amount'), s(sal, 'currency') || 'RSD')}</strong>
                          <span className="ml-1 text-xs text-ink-secondary">{s(sal, 'amount_type') || 'neto'}{s(sal, 'salary_type') === 'satnica' ? ' /h' : ''}</span>
                        </>
                      ) : (
                        <em className="text-ink-disabled">nema</em>
                      )}
                    </td>
                    <td className="px-3 text-right tnums">{sal && n(sal, 'transport_allowance_rsd') ? fmtMoney(n(sal, 'transport_allowance_rsd'), 'RSD') : <span className="text-ink-disabled">0</span>}</td>
                    <td className="px-3 text-right tnums">{sal && n(sal, 'per_diem_rsd') ? fmtMoney(n(sal, 'per_diem_rsd'), 'RSD') : <span className="text-ink-disabled">0</span>}</td>
                    <td className="px-3 text-right tnums">{sal && n(sal, 'per_diem_eur') ? `${n(sal, 'per_diem_eur')} EUR` : <span className="text-ink-disabled">0</span>}</td>
                    <td className="px-3">{sal && s(sal, 'effective_from') ? formatDate(s(sal, 'effective_from')) : '—'}</td>
                    <td className="px-3">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => setModal({ kind: 'history', employeeId: id, employeeName: s(e, 'full_name') })}
                          className="rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
                        >
                          📜 Istorija
                        </button>
                        <button
                          onClick={() => setModal({ kind: 'term', term: null, presetEmployeeId: id })}
                          className="rounded-control px-2 py-1 text-xs text-ink-secondary hover:bg-surface-2"
                        >
                          + Novi
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modal.kind === 'term' && (
        <TermModal
          open
          onClose={() => setModal({ kind: 'none' })}
          onSaved={() => { /* invalidacija ide kroz useKadrMutation */ }}
          employees={employeeOptions}
          term={modal.term}
          presetEmployeeId={modal.presetEmployeeId}
        />
      )}
      {modal.kind === 'history' && (
        <HistoryModal
          open
          onClose={() => setModal({ kind: 'none' })}
          employeeId={modal.employeeId}
          employeeName={modal.employeeName}
          onEditTerm={(t) => {
            if (!window.confirm('Ispravka menja ovaj istorijski red u mestu — koristi je za greške u unosu.\nZa povišicu ili novu zaradu koristi „Nova izmena zarade" (čuva istoriju rasta).')) return;
            setModal({ kind: 'term', term: t, presetEmployeeId: modal.employeeId });
          }}
          onNewChange={(t) => {
            // Kopija aktivnog reda BEZ id-a → nov istorijski red; trigger zatvara stari.
            setModal({
              kind: 'term',
              term: {
                ...t,
                id: undefined,
                effectiveFrom: new Date().toISOString().slice(0, 10),
                effectiveTo: null,
                approvedBy: null,
                approvedAt: null,
              } as Partial<SalaryTerm>,
              presetEmployeeId: modal.employeeId,
            });
          }}
          onNewBlank={() => setModal({ kind: 'term', term: null, presetEmployeeId: modal.employeeId })}
        />
      )}
      {modal.kind === 'accountant' && (
        <AccountantModal
          open
          onClose={() => setModal({ kind: 'none' })}
          employees={employees}
          current={current}
          nameOf={nameOf}
        />
      )}
    </div>
  );
}
