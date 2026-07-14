'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { DataTable, type Column } from '@/components/ui-kit/data-table';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useAttendanceShadow, useAttendanceVsGrid } from '@/api/kadrovska';
import { SummaryChips, sv, svNum } from '../common';
import { MESECI, fmt2, fmtDiff, diffTone, DIFF_TONE_CLASS, num, hhmm } from './helpers';

type ShadowRow = Record<string, unknown>;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
function lastDay(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function ShadowView() {
  const now = new Date();
  // Podrazumevano prethodni (kompletan) mesec — paritet 1.0 _defaultShadowMonth
  // (u januaru → decembar prethodne godine).
  const [year, setYear] = useState(now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() === 0 ? 12 : now.getMonth());
  const [expanded, setExpanded] = useState<string | null>(null);

  const q = useAttendanceShadow({ year, month }, true);

  // Sort po problem_dana desc pa radnih_dana desc (paritet 1.0; BE vraća po imenu);
  // filtrirani na redove sa merljivim podacima.
  const rows = useMemo(() => {
    const src = (q.data?.data ?? []) as ShadowRow[];
    return src
      .filter((r) => svNum(r, 'poredivih_dana') > 0 || svNum(r, 'teren_dana') > 0 || svNum(r, 'dana_bez_grida') > 0)
      .sort((a, b) => svNum(b, 'problem_dana') - svNum(a, 'problem_dana') || svNum(b, 'radnih_dana') - svNum(a, 'radnih_dana'));
  }, [q.data]);

  const totCompare = rows.reduce((s, r) => s + svNum(r, 'poredivih_dana'), 0);
  const totOk = rows.reduce((s, r) => s + svNum(r, 'ok_dana'), 0);
  const totProblem = rows.reduce((s, r) => s + svNum(r, 'problem_dana'), 0);
  const totMissed = rows.reduce((s, r) => s + svNum(r, 'zaborav_izlaza'), 0);

  function shift(delta: number) {
    setExpanded(null);
    let m = month + delta;
    let y = year;
    if (m < 1) {
      m = 12;
      y -= 1;
    } else if (m > 12) {
      m = 1;
      y += 1;
    }
    // Ne u budućnost.
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) return;
    setYear(y);
    setMonth(m);
  }

  const cols: Column<ShadowRow>[] = [
    { key: 'name', header: 'Zaposleni', render: (r) => sv(r, 'full_name') || '—' },
    { key: 'dep', header: 'Odeljenje', render: (r) => sv(r, 'department') || '—' },
    { key: 'cmp', header: 'Poredivih dana', align: 'right', numeric: true, render: (r) => svNum(r, 'poredivih_dana') || '—' },
    {
      key: 'tol',
      header: 'U toleranciji',
      align: 'right',
      numeric: true,
      render: (r) => {
        const cmp = svNum(r, 'poredivih_dana');
        return cmp ? `${Math.round((svNum(r, 'ok_dana') / cmp) * 100)}%` : '—';
      },
    },
    {
      key: 'dev',
      header: 'Odstupanja',
      align: 'right',
      numeric: true,
      // >2 problematična dana = zaposleni za razgovor (paritet 1.0 row highlight;
      // deljeni DataTable nema per-row stil pa signal ide kroz ćeliju).
      render: (r) => {
        const n = svNum(r, 'problem_dana');
        if (!n) return '';
        return n > 2 ? (
          <span className="rounded-full bg-status-warn-bg px-2 py-0.5 font-semibold text-status-warn">{n}</span>
        ) : (
          n
        );
      },
    },
    {
      key: 'avg',
      header: 'Ø razlika',
      align: 'right',
      numeric: true,
      render: (r) => {
        const v = num(r['prosek_diff']);
        return <span className={DIFF_TONE_CLASS[diffTone(v)]}>{fmtDiff(v)}</span>;
      },
    },
    { key: 'field', header: 'Teren', align: 'right', numeric: true, render: (r) => svNum(r, 'teren_dana') || '' },
    { key: 'missed', header: 'Zab. izlaz', align: 'right', numeric: true, render: (r) => svNum(r, 'zaborav_izlaza') || '' },
    { key: 'nogrid', header: 'Bez grida', align: 'right', numeric: true, render: (r) => svNum(r, 'dana_bez_grida') || '' },
  ];

  const from = `${year}-${pad2(month)}-01`;
  const to = `${year}-${pad2(month)}-${pad2(lastDay(year, month))}`;

  return (
    <div className="space-y-3">
      <SummaryChips
        items={[
          { label: 'Poredivih dana', value: totCompare },
          { label: 'U toleranciji ±30 min', value: totCompare ? `${Math.round((totOk / totCompare) * 100)}%` : '—', tone: 'accent' },
          { label: 'Odstupanja >1,5 h', value: totProblem, tone: totProblem ? 'warn' : 'default' },
          { label: 'Zaboravljeni izlazi', value: totMissed, tone: totMissed ? 'warn' : 'default' },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={() => shift(-1)} title="Prethodni mesec">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <strong className="min-w-[130px] text-center text-sm">
          {MESECI[month - 1]} {year}.
        </strong>
        <Button variant="ghost" onClick={() => shift(1)} title="Sledeći mesec">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <p className="max-w-xl text-xs text-ink-secondary">
          razlika = prisustvo sa čitača − (redovni + prekovremeni + teren); pauza se u gridu broji kao rad pa je ≈ −0,4 h
          normalno. Odstupanja se računaju samo nad standardnim (poredivim) danima — teren i zaboravljeni izlazi su odvojeni.
        </p>
        <span className="tnums ml-auto rounded-control bg-surface-2 px-2 py-1 text-sm text-ink-secondary">{rows.length}</span>
      </div>

      <DataTable
        columns={cols}
        rows={rows}
        rowKey={(r) => sv(r, 'employee_id')}
        loading={q.isLoading}
        onRowActivate={(r) => {
          const id = sv(r, 'employee_id');
          setExpanded((cur) => (cur === id ? null : id));
        }}
        expandedKey={expanded}
        renderExpanded={(r) => <ShadowDrill employeeId={sv(r, 'employee_id')} from={from} to={to} />}
        empty={
          <EmptyState
            title="Nema podataka za izabrani mesec"
            hint="Prolazi postoje od 2015, grid od uvođenja Kadrovske."
          />
        }
      />
    </div>
  );
}

/** Klik na red širi dnevnu tabelu (Dan / Prvi ulaz / Poslednji izlaz / Prisustvo /
 *  Grid / Razlika) iz v_attendance_vs_grid — lista za razgovor o disciplini kucanja. */
function ShadowDrill({ employeeId, from, to }: { employeeId: string; from: string; to: string }) {
  const q = useAttendanceVsGrid({ employeeId, from, to }, true);
  if (q.isLoading) return <p className="py-2 text-sm text-ink-secondary">Učitavam dane…</p>;

  const all = (q.data?.data ?? []) as Record<string, unknown>[];
  // Dani sa odsustvom se isključuju (paritet 1.0) — poredimo samo odrađene dane.
  const days = all.filter((d) => !sv(d, 'absence_code')).sort((a, b) => sv(a, 'day').localeCompare(sv(b, 'day')));
  if (!days.length) return <p className="py-2 text-sm text-ink-secondary">Nema dana za prikaz.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-2xs uppercase tracking-wider text-ink-secondary">
            <th className="py-1 pr-3 font-semibold">Dan</th>
            <th className="py-1 pr-3 font-semibold">Prvi ulaz</th>
            <th className="py-1 pr-3 font-semibold">Poslednji izlaz</th>
            <th className="py-1 pr-3 text-right font-semibold">Prisustvo</th>
            <th className="py-1 pr-3 text-right font-semibold">Grid</th>
            <th className="py-1 pr-3 text-right font-semibold">Razlika</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d, i) => (
            <DrillRow key={sv(d, 'day') || i} d={d} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrillRow({ d }: { d: Record<string, unknown> }) {
  const firstIn = sv(d, 'first_in') || null;
  const lastOut = sv(d, 'last_out') || null;
  const open = svNum(d, 'open_intervals');
  const presence = num(d['presence_hours']);
  const gridH = num(d['grid_hours']);
  const gridOt = num(d['grid_overtime']) ?? 0;
  const gridField = num(d['grid_field_hours']) ?? 0;
  const gridCovered = d['grid_covered'] === true;
  const diff = num(d['diff_hours']);

  // Smena preko ponoći: izlaz pre ulaza ili ulaz bez izlaza — badge lanac isečen
  // na dnevnoj granici, razlika je besmislena (paritet 1.0 _drillRow overnight).
  const overnight = (!!lastOut && !!firstIn && lastOut < firstIn) || (open > 0 && !lastOut);

  const grid = gridH == null && gridOt === 0 && gridField === 0 && !gridCovered ? null : (gridH ?? 0) + gridOt + gridField;

  const dayLabel = (() => {
    const day = sv(d, 'day');
    const m = day.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}.` : day;
  })();

  return (
    <tr className="border-b border-line-soft">
      <td className="py-1 pr-3">
        {dayLabel}
        {overnight && (
          <span
            className="ml-1 rounded-full bg-status-neutral-bg px-1.5 py-0.5 text-2xs text-status-neutral"
            title="Smena preko ponoći — prisustvo isečeno na dnevnoj granici"
          >
            preko ponoći
          </span>
        )}
      </td>
      <td className="py-1 pr-3">{firstIn ? hhmm(firstIn) : '—'}</td>
      <td className="py-1 pr-3">
        {lastOut ? hhmm(lastOut) : open ? <span className="text-status-danger">nije otkucan</span> : '—'}
      </td>
      <td className="tnums py-1 pr-3 text-right">{presence != null ? `${fmt2(presence)} h` : '—'}</td>
      <td className="tnums py-1 pr-3 text-right">
        {grid != null ? `${fmt2(grid)} h` : '—'}
        {gridField > 0 && <span className="text-ink-disabled"> (teren {fmt2(gridField)})</span>}
      </td>
      <td className="tnums py-1 pr-3 text-right">
        {overnight ? <span className="text-ink-disabled">n/d</span> : <span className={DIFF_TONE_CLASS[diffTone(diff)]}>{fmtDiff(diff)}</span>}
      </td>
    </tr>
  );
}
