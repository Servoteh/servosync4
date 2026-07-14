'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { formatDate } from '@/lib/format';
import { useSalaryTerms, useSalaryPayroll, useDirectory, usePayrollRecompute, newClientEventId, type SalaryTerm } from '@/api/kadrovska';
import { SummaryChips, sv, cyrMonthLabel } from './common';

type ViewRow = Record<string, unknown>;
function pick(row: ViewRow, keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return '';
}

export function ZaradeTab() {
  const [sub, setSub] = useState<'terms' | 'payroll'>('terms');
  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
        <button onClick={() => setSub('terms')} className={`rounded-control px-3 py-1.5 text-sm font-medium ${sub === 'terms' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}>
          📜 Uslovi zarade
        </button>
        <button onClick={() => setSub('payroll')} className={`rounded-control px-3 py-1.5 text-sm font-medium ${sub === 'payroll' ? 'bg-accent text-accent-fg' : 'text-ink-secondary'}`}>
          🧾 Mesečni obračun
        </button>
      </div>
      <p className="text-xs text-ink-secondary">
        🔒 Zarade su vidljive isključivo administratoru (HR namerno nema pristup). Zaključan obračun je nepromenljiv.
      </p>
      {sub === 'terms' ? <TermsView /> : <PayrollView />}
    </div>
  );
}

function TermsView() {
  const q = useSalaryTerms({}, true);
  const dirQ = useDirectory();
  const nameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of dirQ.data?.data ?? []) m.set(sv(r, 'id'), sv(r, 'full_name'));
    return m;
  }, [dirQ.data]);
  const rows = q.data?.data ?? [];

  const cols: Column<SalaryTerm>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => nameMap.get(r.employeeId) || r.employeeId.slice(0, 8) },
    { key: 'type', header: 'Tip', render: (r) => r.salaryType },
    { key: 'neto', header: 'Neto (RSD)', align: 'right', numeric: true, render: (r) => r.netoRsd || '—' },
    { key: 'bruto', header: 'Bruto (RSD)', align: 'right', numeric: true, render: (r) => r.brutoRsd || '—' },
    { key: 'from', header: 'Važi od', render: (r) => formatDate(r.effectiveFrom) },
    { key: 'group', header: 'Grupa', render: (r) => r.payrollGroup || '—' },
  ];

  return (
    <div className="space-y-3">
      <SummaryChips items={[{ label: 'Aktivnih uslova', value: rows.length }]} />
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} loading={q.isLoading} empty={<EmptyState title="Nema unetih uslova zarade" />} />
    </div>
  );
}

function PayrollView() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const q = useSalaryPayroll({ year, month }, true);
  const recompute = usePayrollRecompute();
  const rows = q.data?.data ?? [];

  const cols: Column<ViewRow>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => pick(r, ['employee_name', 'full_name']) || '—' },
    { key: 'first', header: 'I deo', align: 'right', numeric: true, render: (r) => pick(r, ['prvi_deo', 'first_part_amount']) || '—' },
    { key: 'rest', header: 'II deo', align: 'right', numeric: true, render: (r) => pick(r, ['preostalo_za_isplatu', 'second_part']) || '—' },
    { key: 'total', header: 'Ukupno RSD', align: 'right', numeric: true, render: (r) => pick(r, ['ukupna_zarada', 'total_rsd', 'ukupno_rsd']) || '—' },
    { key: 'status', header: 'Status', render: (r) => pick(r, ['status', 'payroll_status']) || '—' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="month"
          value={`${year}-${String(month).padStart(2, '0')}`}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number);
            if (y && m) {
              setYear(y);
              setMonth(m);
            }
          }}
          className="h-9 rounded-control border border-line bg-surface px-3 text-sm"
        />
        <span className="text-sm text-ink-secondary">{cyrMonthLabel(year, month)}</span>
        <Button
          className="ml-auto"
          variant="secondary"
          loading={recompute.isPending}
          onClick={() => recompute.mutate({ year, month, persist: false, clientEventId: newClientEventId() })}
        >
          ↻ Obračunaj iz grida (preview)
        </Button>
      </div>
      <SummaryChips items={[{ label: 'Zaposlenih u obračunu', value: rows.length }]} />
      <DataTable columns={cols} rows={rows} rowKey={(r) => pick(r, ['id', 'employee_id']) || Math.random().toString()} loading={q.isLoading} empty={<EmptyState title="Nema obračuna za izabrani mesec" hint="Pripremite mesec ili obračunajte iz grida." />} />
    </div>
  );
}
