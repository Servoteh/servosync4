'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { useBoard, useCalendar, useTasksDue, type ViewRow } from '@/api/odrzavanje';
import { f, prevSeverityCalClasses, relDays, type DashNavTab } from './common';

/** Stavka kalendara (mašina preventiva ILI rok sredstva). */
interface CalItem {
  date: Date;
  name: string;
  title: string;
  severity: string | null;
  onClick: () => void;
  kind: 'machine' | 'asset';
}

function parseDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function monthTitle(d: Date): string {
  return d.toLocaleDateString('sr-Latn-RS', { month: 'long', year: 'numeric' });
}

const NAV_BY_TYPE: Record<string, DashNavTab> = { it: 'it', facility: 'objekti', vehicle: 'vozila' };

/**
 * Kalendar rokova (1.0 renderMaintCalendarPanel, maintPreventivePanel.js:289-421):
 * pun mesečni grid preventivnih rokova mašina (bojeno po ozbiljnosti) + zaseban grid
 * IT/objekti/planovi, uz bočne liste „U ovom mesecu" i „Kasni". Svaka stavka je link
 * na karton (mašina-ruta; IT/objekti/vozila → odgovarajući tab dok kartoni ne stignu u P3).
 */
export function KalendarTab({ onNavigate }: { onNavigate?: (tab: DashNavTab) => void }) {
  const router = useRouter();
  const due = useTasksDue();
  const board = useBoard();
  const calendar = useCalendar();
  const [month, setMonth] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of board.data?.data.machineNames ?? []) m.set(n.machineCode, n.name);
    return m;
  }, [board.data]);

  const openMachine = (code: string) => router.push(`/odrzavanje/masine?code=${encodeURIComponent(code)}&tab=zadaci`);

  // Preventivni rokovi mašina → CalItem[].
  const machineItems = useMemo<CalItem[]>(() => {
    const out: CalItem[] = [];
    for (const r of due.data?.data ?? []) {
      const date = parseDate(f(r, 'next_due_at', 'due_at'));
      if (!date) continue;
      const code = f(r, 'machine_code') ?? '';
      out.push({
        date,
        name: nameByCode.get(code) ?? code,
        title: f(r, 'title', 'task_title') ?? '',
        severity: f(r, 'severity'),
        kind: 'machine',
        onClick: () => openMachine(code),
      });
    }
    return out;
  }, [due.data, nameByCode]);

  // Rokovi IT/objekata/planova (calendar/deadlines) → CalItem[].
  const assetItems = useMemo<CalItem[]>(() => {
    const cal = calendar.data?.data;
    const out: CalItem[] = [];
    const push = (row: ViewRow, dateKey: string[], title: string, navType: string) => {
      const date = parseDate(f(row, ...dateKey));
      if (!date) return;
      const nav = NAV_BY_TYPE[navType] ?? 'it';
      out.push({
        date,
        name: f(row, 'asset_name', 'name', 'asset_code') ?? '—',
        title,
        severity: null,
        kind: 'asset',
        onClick: () => onNavigate?.(nav),
      });
    };
    for (const r of cal?.vehicleServiceDue ?? []) push(r, ['next_due_at', 'due_at'], f(r, 'name') ?? 'Servis vozila', 'vehicle');
    for (const r of cal?.assetServiceDue ?? []) push(r, ['next_due_at', 'due_at'], f(r, 'name') ?? 'Servis', f(r, 'asset_type') ?? 'it');
    for (const r of cal?.itAssets ?? []) {
      push(r, ['license_expires_at'], 'IT licenca', 'it');
      push(r, ['warranty_expires_at', 'warranty_until'], 'IT garancija', 'it');
    }
    for (const r of cal?.facilities ?? []) {
      push(r, ['inspection_due_at'], 'Inspekcija', 'facility');
      push(r, ['fire_safety_due_at'], 'PP zaštita', 'facility');
    }
    return out;
  }, [calendar.data, onNavigate]);

  // 42-dnevni grid (ponedeljak prvi).
  const days = useMemo(() => {
    const start = new Date(month);
    const weekday = (start.getDay() + 6) % 7;
    const gridStart = addDays(start, -weekday);
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [month]);

  const today0 = startOfDay(new Date());
  const monthMachine = machineItems.filter((it) => sameMonth(it.date, month)).sort((a, b) => a.date.getTime() - b.date.getTime());
  const monthAsset = assetItems.filter((it) => sameMonth(it.date, month)).sort((a, b) => a.date.getTime() - b.date.getTime());
  const lateMachine = machineItems.filter((it) => it.date < today0).sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 8);
  const lateAsset = assetItems.filter((it) => it.date < today0).sort((a, b) => a.date.getTime() - b.date.getTime()).slice(0, 8);

  if (due.isError && calendar.isError) {
    return <p className="py-8 text-center text-sm text-ink-secondary">Ne mogu da učitam kalendar rokova.</p>;
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
      <section className="min-w-0 space-y-4">
        {/* Glavni kalendar — preventiva mašina */}
        <div className="rounded-panel border border-line bg-surface p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Button variant="ghost" aria-label="Prethodni mesec" onClick={() => setMonth((m) => { const n = new Date(m); n.setMonth(n.getMonth() - 1); return n; })}><ChevronLeft className="h-4 w-4" aria-hidden /></Button>
            <h3 className="text-sm font-semibold capitalize text-ink">{monthTitle(month)}</h3>
            <Button variant="ghost" aria-label="Sledeći mesec" onClick={() => setMonth((m) => { const n = new Date(m); n.setMonth(n.getMonth() + 1); return n; })}><ChevronRight className="h-4 w-4" aria-hidden /></Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-2xs uppercase tracking-wider text-ink-secondary">
            {['Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub', 'Ned'].map((w) => <span key={w}>{w}</span>)}
          </div>
          <CalGrid days={days} month={month} items={machineItems} today0={today0} max={3} />
          <h4 className="mt-4 mb-1.5 text-xs font-semibold text-ink">IT + objekti <span className="text-ink-secondary">({monthAsset.length})</span></h4>
          <CalGrid days={days} month={month} items={assetItems} today0={today0} max={3} />
        </div>
      </section>

      <aside className="space-y-4">
        <SideList title="U ovom mesecu" count={monthMachine.length} items={monthMachine.slice(0, 12)} />
        <SideList title="IT + objekti (mesec)" count={monthAsset.length} items={monthAsset.slice(0, 12)} />
        <SideList title="Kasni" count={lateMachine.length + lateAsset.length} items={[...lateMachine, ...lateAsset]} emptyText="Nema kašnjenja." />
      </aside>
    </div>
  );
}

function CalGrid({ days, month, items, today0, max }: {
  days: Date[]; month: Date; items: CalItem[]; today0: Date; max: number;
}) {
  return (
    <div className="mt-1 grid grid-cols-7 gap-1">
      {days.map((day, i) => {
        const inMonth = day.getMonth() === month.getMonth();
        const isToday = sameDay(day, today0);
        const dayItems = items.filter((it) => sameDay(it.date, day));
        return (
          <div key={i} className={cn('min-h-16 rounded-control border p-1', inMonth ? 'border-line bg-surface' : 'border-line-soft bg-surface-2/30', isToday && 'ring-1 ring-accent')}>
            <div className={cn('text-2xs tnums', inMonth ? 'text-ink-secondary' : 'text-ink-disabled')}>{day.getDate()}</div>
            <div className="mt-0.5 space-y-0.5">
              {dayItems.slice(0, max).map((it, j) => (
                <button
                  key={j}
                  type="button"
                  onClick={it.onClick}
                  title={`${it.name} · ${it.title}`}
                  className={cn(
                    'block w-full truncate rounded border px-1 py-0.5 text-left text-2xs hover:bg-surface-2',
                    it.kind === 'machine' ? prevSeverityCalClasses(it.severity) : 'border-status-info/40 text-status-info',
                  )}
                >
                  {it.name}
                </button>
              ))}
              {dayItems.length > max && <span className="block px-1 text-2xs text-ink-disabled">+ još {dayItems.length - max}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SideList({ title, count, items, emptyText = 'Nema rokova.' }: {
  title: string; count: number; items: CalItem[]; emptyText?: string;
}) {
  return (
    <div className="rounded-panel border border-line bg-surface p-3">
      <h4 className="mb-1.5 text-sm font-semibold text-ink">{title} <span className="text-ink-secondary">({count})</span></h4>
      {items.length === 0 ? (
        <p className="text-sm text-ink-secondary">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i} className="flex items-center justify-between gap-2 border-b border-line-soft py-1 text-sm last:border-0">
              <button type="button" onClick={it.onClick} className="min-w-0 truncate text-left text-accent hover:underline">
                {it.name} <span className="text-ink-secondary">{it.title}</span>
              </button>
              <span className="shrink-0 text-2xs text-ink-secondary">{relDays(it.date.toISOString())}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
