'use client';

import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { StatusBadge, type Tone } from '@/components/ui-kit/status-badge';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS, type Permission } from '@/lib/permissions';
import { downloadBlob } from '@/lib/hr-pdf';
import { useReport, useTriggerWeeklyRisk } from '@/api/kadrovska';
import { Tabs, type TabItem } from './tabs';
import { SummaryChips, sv, svNum } from './common';
import { Select, DateField, useNameMap } from './razvoj/shared';

type Row = Record<string, unknown>;
type Kind = 'sick' | 'demo' | 'org' | 'vacation' | 'overtime' | 'field' | 'medical' | 'certs' | 'children' | 'risk' | 'audit';

const REPORTS: { kind: Kind; label: string; perm?: Permission }[] = [
  { kind: 'sick', label: '🩺 Bolovanja' },
  { kind: 'demo', label: '📈 Demografija' },
  { kind: 'org', label: '🏢 Organogram' },
  { kind: 'vacation', label: '🏖 Saldo GO' },
  { kind: 'overtime', label: '⏱ Prekovremeni' },
  { kind: 'field', label: '🚐 Terenski' },
  { kind: 'medical', label: '🩺 Lekarski', perm: PERMISSIONS.KADROVSKA_MANAGE },
  { kind: 'certs', label: '📜 Sertifikati', perm: PERMISSIONS.KADROVSKA_MANAGE },
  { kind: 'children', label: '👶 Deca', perm: PERMISSIONS.KADROVSKA_PII },
  { kind: 'risk', label: '🎯 Rizik', perm: PERMISSIONS.KADROVSKA_PII },
  { kind: 'audit', label: '📒 Audit log', perm: PERMISSIONS.KADROVSKA_ADMIN },
];

/* ── XLSX izvoz (postojeća `xlsx` zavisnost — paritet ostatka Kadrovske/Reversi) ── */
function exportXlsx(name: string, headers: string[], rows: (string | number)[][]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Izveštaj');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
}

export function IzvestajiTab() {
  const { can } = useAuth();
  const visible = REPORTS.filter((r) => !r.perm || can(r.perm));
  const [kind, setKind] = useState<Kind>(visible[0]?.kind ?? 'sick');
  const tabs: TabItem<Kind>[] = visible.map((r) => ({ key: r.kind, label: r.label }));

  return (
    <div className="space-y-4">
      <Tabs tabs={tabs} value={kind} onChange={setKind} ariaLabel="Izveštaj — vrsta" />
      {kind === 'sick' && <SickReport />}
      {kind === 'demo' && <DemoReport />}
      {kind === 'org' && <OrgReport />}
      {kind === 'vacation' && <VacationReport />}
      {kind === 'overtime' && <OvertimeReport />}
      {kind === 'field' && <FieldReport />}
      {kind === 'medical' && <ViewReport kind="medical" title="Lekarski pregledi — status isteka" />}
      {kind === 'certs' && <ViewReport kind="certs" title="Sertifikati — status isteka" />}
      {kind === 'children' && <ChildrenReport />}
      {kind === 'risk' && <RiskReport />}
      {kind === 'audit' && <ViewReport kind="audit" title="Audit log — promene" />}
    </div>
  );
}

/* ── Deljena traka perioda ── */
function PeriodBar({ from, to, setFrom, setTo, onExport }: { from: string; to: string; setFrom: (v: string) => void; setTo: (v: string) => void; onExport?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1.5 text-sm text-ink-secondary">Od <div className="w-40"><DateField value={from} onChange={setFrom} /></div></label>
      <label className="flex items-center gap-1.5 text-sm text-ink-secondary">Do <div className="w-40"><DateField value={to} onChange={setTo} /></div></label>
      <div className="flex-1" />
      {onExport && <Button variant="secondary" onClick={onExport}>⬇ Izvezi XLSX</Button>}
    </div>
  );
}

/* ── Bolovanja ── */
function SickReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { nm } = useNameMap();
  const q = useReport<Row[]>('sick', { from: from || undefined, to: to || undefined });
  const episodes = q.data?.data ?? [];
  const perEmp = useMemo(() => {
    const m = new Map<string, { name: string; episodes: number; days: number }>();
    for (const e of episodes) {
      const id = sv(e, 'employee_id');
      const cur = m.get(id) ?? { name: nm(id), episodes: 0, days: 0 };
      cur.episodes += 1;
      cur.days += svNum(e, 'days_count');
      m.set(id, cur);
    }
    return [...m.values()].sort((a, b) => b.days - a.days);
  }, [episodes, nm]);
  const totalDays = perEmp.reduce((s, r) => s + r.days, 0);

  const cols: Column<{ name: string; episodes: number; days: number }>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => r.name },
    { key: 'ep', header: 'Epizoda', align: 'right', render: (r) => r.episodes },
    { key: 'days', header: 'Ukupno dana', align: 'right', render: (r) => r.days },
  ];
  return (
    <div className="space-y-3">
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} onExport={() => exportXlsx('bolovanja.xlsx', ['Zaposleni', 'Epizoda', 'Dana'], perEmp.map((r) => [r.name, r.episodes, r.days]))} />
      <SummaryChips items={[{ label: 'Zaposlenih na BO', value: perEmp.length }, { label: 'Ukupno dana', value: totalDays }, { label: 'Epizoda', value: episodes.length }]} />
      <DataTable columns={cols} rows={perEmp} rowKey={(r) => r.name} loading={q.isLoading} empty={<EmptyState title="Nema bolovanja u periodu" />} />
    </div>
  );
}

/* ── Demografija ── */
function DemoReport() {
  const q = useReport<Row[]>('demo', {});
  const rows = q.data?.data ?? [];
  const dist = useMemo(() => {
    const gender: Record<string, number> = {};
    const edu: Record<string, number> = {};
    const dept: Record<string, number> = {};
    const age: Record<string, number> = { '<25': 0, '25–34': 0, '35–44': 0, '45–54': 0, '55+': 0 };
    const now = Date.now();
    for (const r of rows) {
      if (r['is_active'] === false) continue;
      gender[sv(r, 'gender') || '—'] = (gender[sv(r, 'gender') || '—'] ?? 0) + 1;
      edu[sv(r, 'education_level') || '—'] = (edu[sv(r, 'education_level') || '—'] ?? 0) + 1;
      dept[sv(r, 'department') || '—'] = (dept[sv(r, 'department') || '—'] ?? 0) + 1;
      const bd = sv(r, 'birth_date');
      if (bd) {
        const yrs = (now - new Date(bd).getTime()) / (365.25 * 864e5);
        const b = yrs < 25 ? '<25' : yrs < 35 ? '25–34' : yrs < 45 ? '35–44' : yrs < 55 ? '45–54' : '55+';
        age[b] += 1;
      }
    }
    return { gender, edu, dept, age };
  }, [rows]);
  const active = rows.filter((r) => r['is_active'] !== false).length;

  return (
    <div className="space-y-3">
      <SummaryChips items={[{ label: 'Aktivnih zaposlenih', value: active }, { label: 'Ukupno u bazi', value: rows.length }]} />
      {q.isLoading ? <p className="text-sm text-ink-disabled">Učitavanje…</p> : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <DistTable title="Po polu" data={dist.gender} />
          <DistTable title="Po starosti" data={dist.age} />
          <DistTable title="Po obrazovanju" data={dist.edu} />
          <DistTable title="Po odeljenju" data={dist.dept} />
        </div>
      )}
    </div>
  );
}
function DistTable({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <h4 className="mb-2 text-sm font-semibold text-ink">{title}</h4>
      <div className="space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 text-sm">
            <span className="w-32 truncate text-ink-secondary">{k}</span>
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${(v / total) * 100}%` }} /></div>
            <span className="w-8 text-right tabular-nums">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Organogram ── */
function OrgReport() {
  const q = useReport<{ departments: Row[]; subDepartments: Row[]; jobPositions: Row[]; employees: Row[] }>('org', {});
  const d = q.data?.data;
  const empByPos = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const e of d?.employees ?? []) {
      if (e['is_active'] === false) continue;
      const pid = sv(e, 'position_id') || `sd:${sv(e, 'sub_department_id')}`;
      (m.get(pid) ?? m.set(pid, []).get(pid)!).push(e);
    }
    return m;
  }, [d]);

  if (q.isLoading) return <p className="text-sm text-ink-disabled">Učitavanje…</p>;
  if (!d) return <EmptyState title="Nema podataka" />;
  const subsByDept = new Map<string, Row[]>();
  for (const s of d.subDepartments) (subsByDept.get(sv(s, 'department_id')) ?? subsByDept.set(sv(s, 'department_id'), []).get(sv(s, 'department_id'))!).push(s);
  const posBySub = new Map<string, Row[]>();
  for (const p of d.jobPositions) { const k = sv(p, 'sub_department_id') || `d:${sv(p, 'department_id')}`; (posBySub.get(k) ?? posBySub.set(k, []).get(k)!).push(p); }

  return (
    <div className="space-y-3">
      {d.departments.map((dep) => (
        <div key={sv(dep, 'id')} className="rounded-panel border border-line bg-surface p-3">
          <div className="text-sm font-semibold text-ink">🏢 {sv(dep, 'name')}</div>
          <div className="mt-2 space-y-2 pl-3">
            {(subsByDept.get(sv(dep, 'id')) ?? []).map((sub) => (
              <div key={sv(sub, 'id')}>
                <div className="text-sm font-medium text-ink-secondary">{sv(sub, 'name')}</div>
                <div className="mt-1 space-y-1 pl-3">
                  {(posBySub.get(sv(sub, 'id')) ?? []).map((pos) => {
                    const emps = empByPos.get(sv(pos, 'id')) ?? [];
                    return (
                      <div key={sv(pos, 'id')} className="text-sm">
                        <span className="text-ink">{sv(pos, 'name')}</span>
                        {emps.length > 0 && <span className="text-ink-secondary"> — {emps.map((e) => sv(e, 'full_name')).join(', ')}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Saldo GO ── */
function VacationReport() {
  const [year, setYear] = useState(new Date().getFullYear());
  const { nm } = useNameMap();
  const q = useReport<{ year: number; balances: Row[]; entitlements: Row[]; gridGoDays: Row[] }>('vacation', { year });
  const balances = q.data?.data?.balances ?? [];
  const rows = balances.map((b) => ({
    name: nm(sv(b, 'employee_id')),
    entitled: svNum(b, 'days_total') || svNum(b, 'days_earned'),
    used: svNum(b, 'days_used'),
    remaining: svNum(b, 'days_remaining_accrued') || svNum(b, 'days_remaining'),
  })).sort((a, b) => a.name.localeCompare(b.name, 'sr'));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => r.name },
    { key: 'ent', header: 'Pripada', align: 'right', render: (r) => r.entitled || '—' },
    { key: 'used', header: 'Iskorišćeno', align: 'right', render: (r) => r.used || '—' },
    { key: 'rem', header: 'Preostalo', align: 'right', render: (r) => <strong>{r.remaining || '—'}</strong> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-ink-secondary">Godina<input type="number" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} className="h-8 w-24 rounded-control border border-line bg-surface px-2 text-sm" /></label>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => exportXlsx(`saldo_go_${year}.xlsx`, ['Zaposleni', 'Pripada', 'Iskorišćeno', 'Preostalo'], rows.map((r) => [r.name, r.entitled, r.used, r.remaining]))}>⬇ Izvezi XLSX</Button>
      </div>
      <SummaryChips items={[{ label: 'Zaposlenih', value: rows.length }, { label: 'Ukupno preostalo', value: rows.reduce((s, r) => s + r.remaining, 0) }]} />
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.name} loading={q.isLoading} empty={<EmptyState title="Nema podataka o GO" />} />
    </div>
  );
}

/* ── Prekovremeni ── */
function OvertimeReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { nm } = useNameMap();
  const q = useReport<Row[]>('overtime', { from: from || undefined, to: to || undefined });
  const rows = (q.data?.data ?? []).map((r) => ({ name: nm(sv(r, 'employee_id')), ot: svNum(r, 'total_overtime'), tm: svNum(r, 'two_machine_hours'), days: svNum(r, 'days'), last: sv(r, 'last_date') }));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => r.name },
    { key: 'ot', header: 'Prekovremeni (h)', align: 'right', render: (r) => r.ot || '—' },
    { key: 'tm', header: '2 mašine (h)', align: 'right', render: (r) => r.tm || '—' },
    { key: 'days', header: 'Dana', align: 'right', render: (r) => r.days || '—' },
    { key: 'last', header: 'Poslednji', render: (r) => (r.last ? formatDate(r.last) : '—') },
  ];
  return (
    <div className="space-y-3">
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} onExport={() => exportXlsx('prekovremeni.xlsx', ['Zaposleni', 'Prekovremeni', '2 masine', 'Dana', 'Poslednji'], rows.map((r) => [r.name, r.ot, r.tm, r.days, r.last]))} />
      <SummaryChips items={[{ label: 'Zaposlenih', value: rows.length }, { label: 'Ukupno prekovremenih (h)', value: rows.reduce((s, r) => s + r.ot, 0) }]} />
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.name} loading={q.isLoading} empty={<EmptyState title="Nema prekovremenih u periodu" />} />
    </div>
  );
}

/* ── Terenski ── */
function FieldReport() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { nm } = useNameMap();
  const q = useReport<Row[]>('field', { from: from || undefined, to: to || undefined });
  const rows = (q.data?.data ?? []).map((r) => ({ name: nm(sv(r, 'employee_id')), dd: svNum(r, 'domestic_days'), dh: svNum(r, 'domestic_hours'), fd: svNum(r, 'foreign_days'), fh: svNum(r, 'foreign_hours'), last: sv(r, 'last_date') }));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => r.name },
    { key: 'dd', header: 'Domaći (dana)', align: 'right', render: (r) => r.dd || '—' },
    { key: 'dh', header: 'Domaći (h)', align: 'right', render: (r) => r.dh || '—' },
    { key: 'fd', header: 'Inostrani (dana)', align: 'right', render: (r) => r.fd || '—' },
    { key: 'fh', header: 'Inostrani (h)', align: 'right', render: (r) => r.fh || '—' },
    { key: 'last', header: 'Poslednji', render: (r) => (r.last ? formatDate(r.last) : '—') },
  ];
  return (
    <div className="space-y-3">
      <PeriodBar from={from} to={to} setFrom={setFrom} setTo={setTo} onExport={() => exportXlsx('terenski.xlsx', ['Zaposleni', 'Domaci dana', 'Domaci h', 'Inostrani dana', 'Inostrani h', 'Poslednji'], rows.map((r) => [r.name, r.dd, r.dh, r.fd, r.fh, r.last]))} />
      <SummaryChips items={[{ label: 'Zaposlenih na terenu', value: rows.length }, { label: 'Domaćih dana', value: rows.reduce((s, r) => s + r.dd, 0) }, { label: 'Inostranih dana', value: rows.reduce((s, r) => s + r.fd, 0) }]} />
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.name} loading={q.isLoading} empty={<EmptyState title="Nema terenskog rada u periodu" />} />
    </div>
  );
}

/* ── Deca zaposlenih ── */
function ChildrenReport() {
  const q = useReport<Row[]>('children', {});
  const rows = q.data?.data ?? [];
  const now = Date.now();
  const withAge = rows.map((r) => {
    const bd = sv(r, 'birth_date');
    const age = bd ? Math.floor((now - new Date(bd).getTime()) / (365.25 * 864e5)) : null;
    return { ...r, _age: age };
  });
  const cols: Column<Row & { _age: number | null }>[] = [
    { key: 'emp', header: 'Zaposleni', render: (r) => sv(r, 'employee_name') },
    { key: 'dep', header: 'Odeljenje', render: (r) => sv(r, 'department') || '—' },
    { key: 'child', header: 'Dete', render: (r) => sv(r, 'first_name') },
    { key: 'bd', header: 'Rođendan', render: (r) => (sv(r, 'birth_date') ? formatDate(sv(r, 'birth_date')) : '—') },
    { key: 'age', header: 'Uzrast', align: 'right', render: (r) => (r._age != null ? `${r._age} god.` : '—') },
  ];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => exportXlsx('deca.xlsx', ['Zaposleni', 'Odeljenje', 'Dete', 'Rodjendan', 'Uzrast'], withAge.map((r) => [sv(r, 'employee_name'), sv(r, 'department'), sv(r, 'first_name'), sv(r, 'birth_date'), r._age ?? '']))}>⬇ Izvezi XLSX</Button>
      </div>
      <SummaryChips items={[{ label: 'Dece', value: rows.length }, { label: 'Predškolski (<7)', value: withAge.filter((r) => r._age != null && r._age < 7).length }]} />
      <DataTable columns={cols} rows={withAge} rowKey={(r) => sv(r, 'id') || Math.random().toString()} loading={q.isLoading} empty={<EmptyState title="Nema evidentirane dece" />} />
    </div>
  );
}

/* ── Rizik ── */
function RiskReport() {
  const [months, setMonths] = useState(12);
  const q = useReport<{ months: number; periodStart: string; periodEnd: string; rows: Row[] }>('risk', { months });
  const riskRun = useTriggerWeeklyRisk();
  const today = new Date();
  const soon = new Date(today.getTime() + 30 * 864e5).toISOString().slice(0, 10);
  const iso = today.toISOString().slice(0, 10);

  function level(r: Row): { tone: Tone; label: string; sev: number; reasons: string[] } {
    const bo = svNum(r, 'bo_days');
    const med = sv(r, 'medical_exam_expires');
    const con = sv(r, 'contract_date_to');
    const reasons: string[] = [];
    let sev = 0;
    if (bo > 20) { sev = Math.max(sev, 2); reasons.push(`${bo} dana BO`); } else if (bo > 10) { sev = Math.max(sev, 1); reasons.push(`${bo} dana BO`); }
    if (med) { if (med < iso) { sev = Math.max(sev, 2); reasons.push('lekarski istekao'); } else if (med <= soon) { sev = Math.max(sev, 1); reasons.push('lekarski uskoro'); } }
    if (con) { if (con < iso) { sev = Math.max(sev, 2); reasons.push('ugovor istekao'); } else if (con <= soon) { sev = Math.max(sev, 1); reasons.push('ugovor uskoro'); } }
    return sev >= 2 ? { tone: 'danger', label: 'Visok', sev, reasons } : sev === 1 ? { tone: 'warn', label: 'Srednji', sev, reasons } : { tone: 'success', label: 'Nizak', sev, reasons };
  }

  const rows = (q.data?.data?.rows ?? []).map((r) => ({ r, lv: level(r) })).sort((a, b) => b.lv.sev - a.lv.sev || svNum(b.r, 'bo_days') - svNum(a.r, 'bo_days'));
  const counts = { high: rows.filter((x) => x.lv.sev >= 2).length, mid: rows.filter((x) => x.lv.sev === 1).length };
  const cols: Column<(typeof rows)[number]>[] = [
    { key: 'name', header: 'Zaposleni', render: (x) => sv(x.r, 'full_name') },
    { key: 'dep', header: 'Odeljenje', render: (x) => sv(x.r, 'department') || '—' },
    { key: 'bo', header: 'BO dana', align: 'right', render: (x) => svNum(x.r, 'bo_days') || '—' },
    { key: 'med', header: 'Lekarski do', render: (x) => (sv(x.r, 'medical_exam_expires') ? formatDate(sv(x.r, 'medical_exam_expires')) : '—') },
    { key: 'con', header: 'Ugovor do', render: (x) => (sv(x.r, 'contract_date_to') ? formatDate(sv(x.r, 'contract_date_to')) : '—') },
    { key: 'lv', header: 'Rizik', render: (x) => <StatusBadge tone={x.lv.tone} label={x.lv.label} /> },
    { key: 'why', header: 'Razlog', render: (x) => <span className="text-2xs text-ink-secondary">{x.lv.reasons.join(', ') || '—'}</span> },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm text-ink-secondary">Period bolovanja
          <Select value={String(months)} onChange={(v) => setMonths(Number(v))} className="h-8 w-auto">
            <option value="6">6 meseci</option>
            <option value="12">12 meseci</option>
            <option value="24">24 meseca</option>
          </Select>
        </label>
        <div className="flex-1" />
        <Button variant="secondary" loading={riskRun.isPending} onClick={() => riskRun.mutate(undefined, { onSuccess: () => toast('📧 Nedeljni risk rezime zakazan'), onError: () => toast('⚠ Nije uspelo') })}>🔔 Pošalji nedeljni risk rezime</Button>
      </div>
      <SummaryChips items={[{ label: 'Visok rizik', value: counts.high, tone: counts.high ? 'danger' : undefined }, { label: 'Srednji', value: counts.mid, tone: counts.mid ? 'warn' : undefined }, { label: 'Ukupno', value: rows.length }]} />
      <DataTable columns={cols} rows={rows} rowKey={(x) => sv(x.r, 'employee_id') || Math.random().toString()} loading={q.isLoading} empty={<EmptyState title="Nema podataka" />} />
    </div>
  );
}

/* ── View-bazirani izveštaji (medical/certs/audit) — dinamičke kolone ── */
const VIEW_HIDDEN = new Set(['id', 'employee_id', 'record_id']);
function ViewReport({ kind, title }: { kind: 'medical' | 'certs' | 'audit'; title: string }) {
  const q = useReport<Row[]>(kind, {});
  const rows = q.data?.data ?? [];
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!VIEW_HIDDEN.has(k)) keys.add(k);
    return [...keys];
  }, [rows]);
  const fmtVal = (v: unknown): string => {
    if (v == null) return '—';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(s)) return formatDate(s);
    return s;
  };
  const cols: Column<Row>[] = columns.map((k) => ({ key: k, header: k.replace(/_/g, ' '), render: (r: Row) => fmtVal(r[k]) }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => exportXlsx(`${kind}.xlsx`, columns, rows.map((r) => columns.map((k) => fmtVal(r[k]))))}>⬇ Izvezi XLSX</Button>
      </div>
      <SummaryChips items={[{ label: 'Zapisa', value: rows.length }]} />
      {cols.length === 0 ? (
        <EmptyState title="Nema zapisa" />
      ) : (
        <DataTable columns={cols} rows={rows} rowKey={(r) => sv(r, 'id') || sv(r, 'record_id') || Math.random().toString()} loading={q.isLoading} empty={<EmptyState title="Nema zapisa" />} />
      )}
    </div>
  );
}
