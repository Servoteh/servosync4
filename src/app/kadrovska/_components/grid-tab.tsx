'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { useGrid, useDirectory, type WorkHours } from '@/api/kadrovska';
import { generateKarnetPdf, openBlob, downloadBlob, type KarnetEmployee } from '@/lib/hr-pdf';
import { SummaryChips, sv, cyrMonthLabel, dayLetterCyr, monthDays, h1 } from './common';

interface EmpAgg {
  employeeId: string;
  name: string;
  position: string;
  reg: number;
  ot: number;
  field: number;
  tm: number;
  absDays: number;
  rows: Map<string, WorkHours>;
}

export function GridTab() {
  const { can } = useAuth();
  const canGridEdit = can(PERMISSIONS.KADROVSKA_GRID_EDIT);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [busy, setBusy] = useState(false);

  const gridQ = useGrid({ year, month });
  const dirQ = useDirectory();
  const grid = gridQ.data?.data;

  const nameMap = useMemo(() => {
    const m = new Map<string, { name: string; position: string }>();
    for (const r of dirQ.data?.data ?? []) m.set(sv(r, 'id'), { name: sv(r, 'full_name'), position: sv(r, 'position') });
    return m;
  }, [dirQ.data]);

  const holidaySet = useMemo(() => {
    const s = new Set<string>();
    for (const h of grid?.holidays ?? []) if (!h.isWorkday) s.add(String(h.holidayDate).slice(0, 10));
    return s;
  }, [grid?.holidays]);

  const aggs = useMemo(() => {
    const map = new Map<string, EmpAgg>();
    for (const r of grid?.rows ?? []) {
      let a = map.get(r.employeeId);
      if (!a) {
        const nm = nameMap.get(r.employeeId);
        a = { employeeId: r.employeeId, name: nm?.name || r.employeeId.slice(0, 8), position: nm?.position || '', reg: 0, ot: 0, field: 0, tm: 0, absDays: 0, rows: new Map() };
        map.set(r.employeeId, a);
      }
      a.rows.set(String(r.workDate).slice(0, 10), r);
      a.reg += Number(r.hours || 0);
      a.ot += Number(r.overtimeHours || 0);
      a.field += Number(r.fieldHours || 0);
      a.tm += Number(r.twoMachineHours || 0);
      if (r.absenceCode) a.absDays += 1;
    }
    return Array.from(map.values()).sort((x, y) => x.name.localeCompare(y.name, 'sr'));
  }, [grid?.rows, nameMap]);

  async function exportKarnet() {
    setBusy(true);
    try {
      const days = monthDays(year, month).map((d) => ({ ...d, letter: dayLetterCyr(d.ymd) }));
      const employees: KarnetEmployee[] = aggs.map((a) => ({
        name: a.name,
        position: a.position,
        rows: a.rows,
        fieldHours: a.field,
        totals: {
          redovanRadSati: a.reg,
          prekovremeniSati: a.ot,
          dveMasineSati: a.tm,
        },
      }));
      const monthLabel = cyrMonthLabel(year, month);
      const { blob, fileName } = await generateKarnetPdf({
        title: `КАРНЕТ — ${monthLabel}`,
        monthLabel,
        days,
        holidayYmdSet: holidaySet,
        employees,
      });
      openBlob(blob);
      downloadBlob(blob, fileName);
    } finally {
      setBusy(false);
    }
  }

  const cols: Column<EmpAgg>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'reg', header: 'Redovni', align: 'right', numeric: true, render: (r) => h1(r.reg) || '—' },
    { key: 'ot', header: 'Prekovr.', align: 'right', numeric: true, render: (r) => h1(r.ot) || '—' },
    { key: 'field', header: 'Teren', align: 'right', numeric: true, render: (r) => h1(r.field) || '—' },
    { key: 'tm', header: '2-maš.', align: 'right', numeric: true, render: (r) => h1(r.tm) || '—' },
    { key: 'abs', header: 'Dana odsustva', align: 'right', numeric: true, render: (r) => r.absDays || '—' },
  ];

  const totalReg = aggs.reduce((a, r) => a + r.reg, 0);
  const totalOt = aggs.reduce((a, r) => a + r.ot, 0);
  const remarksOpen = (grid?.remarks ?? []).filter((r) => r.status !== 'resolved').length;

  return (
    <div className="space-y-4">
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
        <Button className="ml-auto" variant="secondary" onClick={exportKarnet} loading={busy} disabled={aggs.length === 0}>
          <FileText className="h-4 w-4" aria-hidden /> Karnet (PDF)
        </Button>
      </div>

      <SummaryChips
        items={[
          { label: 'Aktivnih radnika', value: aggs.length },
          { label: 'Σ Redovni (h)', value: h1(totalReg) || '0' },
          { label: 'Σ Prekovremeni (h)', value: h1(totalOt) || '0' },
          { label: 'Primedbe (otvorene)', value: remarksOpen, tone: remarksOpen ? 'warn' : 'default' },
        ]}
      />

      <DataTable
        columns={cols}
        rows={aggs}
        rowKey={(r) => r.employeeId}
        loading={gridQ.isLoading}
        empty={<EmptyState title="Nema evidencije sati za izabrani mesec" />}
      />

      {!canGridEdit && (
        <p className="text-xs text-ink-secondary">
          Pregled je informativan. Izmena grida (unos sati, GO opseg, primedbe) traži pravo uređivanja grida
          (allowlist / poslovni admin) — presuđuje sy15 RLS.
        </p>
      )}
    </div>
  );
}
