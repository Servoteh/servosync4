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

/* ── Bolovanja (paritet 1.0 sickReport.js: filteri zaposleni/odeljenje/mesec/
     godina/od-do + reset; kolone Br. evid./Σ dana/Prosek/Poslednje/Trenutno?;
     KPI Prosek dana/radnik + Trenutno na bolovanju; XLSX 2 sheeta + CSV) ── */
interface SickRow {
  id: string;
  name: string;
  dept: string;
  count: number;
  days: number;
  avg: number;
  lastTo: string;
  current: boolean;
}
function SickReport() {
  const curYear = String(new Date().getFullYear());
  const [emp, setEmp] = useState('');
  const [dept, setDept] = useState('');
  const [month, setMonth] = useState('');
  const [year, setYear] = useState(curYear);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /* Efektivni period (1.0 _readPeriodFor): Od/Do → Mesec → Godina → sva vremena. */
  const period = useMemo(() => {
    if (from || to) return { from: from || undefined, to: to || undefined };
    if (month) {
      const [y, m] = month.split('-').map(Number);
      return { from: `${month}-01`, to: `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}` };
    }
    if (year) return { from: `${year}-01-01`, to: `${year}-12-31` };
    return {} as { from?: string; to?: string };
  }, [from, to, month, year]);
  const periodLabel = period.from || period.to ? `${period.from ? formatDate(period.from) : '…'} – ${period.to ? formatDate(period.to) : '…'}` : 'sva vremena';

  /* Roster za dropdown-e i odeljenja — 'demo' izveštaj (kadrovska.read, kao i sick). */
  const rosterQ = useReport<Row[]>('demo', {});
  const roster = rosterQ.data?.data ?? [];
  const empById = useMemo(() => new Map(roster.map((r) => [sv(r, 'id'), r])), [roster]);
  const rosterSorted = useMemo(() => [...roster].sort((a, b) => sv(a, 'full_name').localeCompare(sv(b, 'full_name'), 'sr')), [roster]);
  const departments = useMemo(
    () => [...new Set(roster.map((r) => sv(r, 'department')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'sr')),
    [roster],
  );

  const q = useReport<Row[]>('sick', period);
  const episodes = q.data?.data ?? [];
  const today = new Date().toISOString().slice(0, 10);

  const { rows, kept, sumDays, currentNow } = useMemo(() => {
    const m = new Map<string, { r: SickRow; durations: number[] }>();
    let kept = 0;
    for (const e of episodes) {
      const id = sv(e, 'employee_id');
      if (!id || (emp && id !== emp)) continue;
      const er = empById.get(id);
      if (dept && sv(er ?? {}, 'department') !== dept) continue;
      kept++;
      const df = sv(e, 'date_from').slice(0, 10);
      const dt = sv(e, 'date_to').slice(0, 10);
      const days = svNum(e, 'days_count');
      let cur = m.get(id);
      if (!cur) {
        cur = { r: { id, name: er ? sv(er, 'full_name') : '(obrisan)', dept: sv(er ?? {}, 'department'), count: 0, days: 0, avg: 0, lastTo: '', current: false }, durations: [] };
        m.set(id, cur);
      }
      cur.r.count += 1;
      cur.r.days += days;
      cur.durations.push(days);
      if (df && dt && df <= today && dt >= today) cur.r.current = true;
      if (dt && (!cur.r.lastTo || dt > cur.r.lastTo)) cur.r.lastTo = dt;
    }
    let sumDays = 0;
    let currentNow = 0;
    const rows = [...m.values()].map(({ r, durations }) => {
      r.avg = durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : 0;
      sumDays += r.days;
      if (r.current) currentNow++;
      return r;
    });
    rows.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name, 'sr'));
    return { rows, kept, sumDays, currentNow };
  }, [episodes, emp, dept, empById, today]);
  const avgPerEmp = rows.length ? Math.round((sumDays / rows.length) * 10) / 10 : 0;

  function reset() {
    setEmp('');
    setDept('');
    setMonth('');
    setYear(curYear);
    setFrom('');
    setTo('');
  }
  /* 1.0 pravila: mesec briše range; range briše mesec; godina briše mesec+range. */
  const onMonth = (v: string) => { setMonth(v); setFrom(''); setTo(''); };
  const onYear = (v: string) => { setYear(v); setMonth(''); setFrom(''); setTo(''); };
  const onFrom = (v: string) => { setFrom(v); setMonth(''); };
  const onTo = (v: string) => { setTo(v); setMonth(''); };

  const detailRows = useMemo(() => {
    const out: (string | number)[][] = [];
    for (const e of episodes) {
      const id = sv(e, 'employee_id');
      if (!id || (emp && id !== emp)) continue;
      const er = empById.get(id);
      if (dept && sv(er ?? {}, 'department') !== dept) continue;
      out.push([
        er ? sv(er, 'full_name') : '(obrisan)',
        sv(er ?? {}, 'department'),
        sv(e, 'date_from').slice(0, 10),
        sv(e, 'date_to').slice(0, 10),
        svNum(e, 'days_count'),
        sv(e, 'absence_subtype') || 'obicno',
      ]);
    }
    return out.sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'sr'));
  }, [episodes, emp, dept, empById]);

  function exportSickXlsx() {
    if (!rows.length) { toast('⚠ Nema podataka za izvoz'); return; }
    const summary: (string | number)[][] = [
      ['IZVEŠTAJ O BOLOVANJIMA'],
      ['Period', periodLabel],
      ['Filter — zaposleni', emp ? sv(empById.get(emp) ?? {}, 'full_name') || emp : 'Svi'],
      ['Filter — odeljenje', dept || 'Sva'],
      [],
      ['Zaposleni', 'Odeljenje', 'Broj evid.', 'Σ dana (u periodu)', 'Prosek (d) po evid.', 'Poslednje bolovanje', 'Trenutno?'],
      ...rows.map((r) => [r.name, r.dept, r.count, r.days, r.avg, r.lastTo, r.current ? 'DA' : 'ne']),
    ];
    const detail: (string | number)[][] = [['Zaposleni', 'Odeljenje', 'Od', 'Do', 'Dana u periodu', 'Podtip'], ...detailRows];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Bolovanja - sažetak');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detail), 'Bolovanja - detalji');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const tag = (period.from || '') + (period.to ? '_' + period.to : '') || 'all';
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `Bolovanja_${tag}.xlsx`);
  }
  function exportSickCsv() {
    if (!detailRows.length) { toast('⚠ Nema podataka za izvoz'); return; }
    const esc = (v: string | number) => { const s = String(v); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [['Zaposleni', 'Odeljenje', 'Od', 'Do', 'Dana u periodu', 'Podtip'], ...detailRows].map((r) => r.map(esc).join(';')).join('\r\n');
    const tag = (period.from || '') + (period.to ? '_' + period.to : '') || 'all';
    downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `Bolovanja_${tag}.csv`);
  }

  const cols: Column<SickRow>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => <span className="font-medium text-ink">{r.name}</span> },
    { key: 'dept', header: 'Odeljenje', render: (r) => r.dept || '—' },
    { key: 'ep', header: 'Br. evid.', align: 'right', render: (r) => r.count },
    { key: 'days', header: 'Σ dana (period)', align: 'right', render: (r) => <b>{r.days}</b> },
    { key: 'avg', header: 'Prosek (d)', align: 'right', render: (r) => r.avg },
    { key: 'last', header: 'Poslednje', render: (r) => (r.lastTo ? formatDate(r.lastTo) : '—') },
    { key: 'cur', header: 'Trenutno?', render: (r) => <StatusBadge tone={r.current ? 'warn' : 'neutral'} label={r.current ? 'DA' : 'ne'} /> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Zaposleni
          <Select value={emp} onChange={setEmp} className="w-52">
            <option value="">Svi zaposleni</option>
            {rosterSorted.map((r) => (
              <option key={sv(r, 'id')} value={sv(r, 'id')}>{sv(r, 'full_name')}{r['is_active'] === false ? ' (neaktivan)' : ''}</option>
            ))}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Odeljenje / firma
          <Select value={dept} onChange={setDept} className="w-44">
            <option value="">Sva odeljenja</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Mesec
          <input type="month" value={month} onChange={(e) => onMonth(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Godina
          <input type="number" min={2000} max={2100} value={year} onChange={(e) => onYear(e.target.value)} className="h-9 w-24 rounded-control border border-line bg-surface px-2 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Od
          <div className="w-40"><DateField value={from} onChange={onFrom} /></div>
        </label>
        <label className="flex flex-col gap-1 text-2xs uppercase text-ink-secondary">Do
          <div className="w-40"><DateField value={to} onChange={onTo} /></div>
        </label>
        <Button variant="ghost" onClick={reset}>Resetuj filtere</Button>
        <div className="flex-1" />
        <span className="text-2xs text-ink-secondary">{kept} evidencija · {rows.length} zaposlenih</span>
        <Button variant="secondary" onClick={exportSickXlsx}>📊 Excel</Button>
        <Button variant="secondary" onClick={exportSickCsv}>📑 CSV</Button>
      </div>
      <SummaryChips
        items={[
          { label: 'Period', value: periodLabel },
          { label: 'Zaposlenih sa bolovanjem', value: rows.length, tone: rows.length ? 'accent' : 'default' },
          { label: 'Σ Dana', value: sumDays, tone: sumDays ? 'warn' : 'default' },
          { label: 'Prosek dana / radnik', value: avgPerEmp },
          { label: 'Trenutno na bolovanju', value: currentNow, tone: currentNow ? 'warn' : 'default' },
        ]}
      />
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} loading={q.isLoading || rosterQ.isLoading} empty={<EmptyState title="Nema bolovanja u izabranom periodu" />} />
      {rows.length > 0 && (
        <p className="text-xs font-semibold text-ink">UKUPNO: {rows.reduce((s, r) => s + r.count, 0)} evidencija · {sumDays} dana</p>
      )}
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
/* Redundantne kolone view-a po izveštaju (ime je već u employee_name). */
const VIEW_KIND_HIDDEN: Record<string, Set<string>> = {
  medical: new Set(['employee_first_name', 'employee_last_name', 'employee_active']),
};
/* Srpske labele kolona; nepoznati ključevi padaju na snake_case → razmaci. */
const VIEW_LABELS: Record<string, string> = {
  employee_name: 'Zaposleni',
  employee_position: 'Pozicija',
  employee_department: 'Odeljenje',
  medical_exam_date: 'Datum pregleda',
  medical_exam_expires: 'Važi do',
  days_to_expiry: 'Dana do isteka',
  status: 'Status',
  cert_type: 'Tip',
  cert_name: 'Sertifikat',
  issued_on: 'Izdat',
  expires_on: 'Važi do',
};
/* Prevod status vrednosti view-a (v_kadr_medical_exam_status / certificate_status). */
const VIEW_STATUS_SR: Record<string, { label: string; tone: Tone }> = {
  never: { label: 'nije evidentiran', tone: 'neutral' },
  unknown_expiry: { label: 'bez datuma isteka', tone: 'warn' },
  expired: { label: 'istekao', tone: 'danger' },
  expiring_soon: { label: 'ističe uskoro', tone: 'warn' },
  ok: { label: 'važi', tone: 'success' },
};
function ViewReport({ kind, title }: { kind: 'medical' | 'certs' | 'audit'; title: string }) {
  const q = useReport<Row[]>(kind, {});
  const rows = q.data?.data ?? [];
  const kindHidden = VIEW_KIND_HIDDEN[kind];
  const columns = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows.slice(0, 20)) for (const k of Object.keys(r)) if (!VIEW_HIDDEN.has(k) && !kindHidden?.has(k)) keys.add(k);
    return [...keys];
  }, [rows, kindHidden]);
  const fmtVal = (v: unknown): string => {
    if (v == null) return '—';
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}(T|$)/.test(s)) return formatDate(s);
    return VIEW_STATUS_SR[s]?.label ?? s;
  };
  const cols: Column<Row>[] = columns.map((k) => ({
    key: k,
    header: VIEW_LABELS[k] ?? k.replace(/_/g, ' '),
    render: (r: Row) => {
      const st = k === 'status' ? VIEW_STATUS_SR[String(r[k])] : undefined;
      return st ? <StatusBadge tone={st.tone} label={st.label} /> : fmtVal(r[k]);
    },
  }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        <div className="flex-1" />
        <Button variant="secondary" onClick={() => exportXlsx(`${kind}.xlsx`, columns.map((k) => VIEW_LABELS[k] ?? k.replace(/_/g, ' ')), rows.map((r) => columns.map((k) => fmtVal(r[k]))))}>⬇ Izvezi XLSX</Button>
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
