'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { Sastanak } from '@/api/sastanci';
import { formatVreme, SASTANAK_TIP_LABEL } from './common';

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function sameKey(s: Sastanak): string {
  return String(s.datum).slice(0, 10);
}

const DOW = ['Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub', 'Ned'];

/** Mesečni kalendar (paritet 1.0 sastanciCalendar). Klik na sastanak → onOpen. */
export function CalendarView({
  sastanci,
  onOpen,
}: {
  sastanci: Sastanak[];
  onOpen: (id: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const byDay = useMemo(() => {
    const m = new Map<string, Sastanak[]>();
    for (const s of sastanci) {
      const k = sameKey(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [sastanci]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();
  const first = new Date(year, month, 1);
  // Ponedeljak-prvi raspored.
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const todayKey = ymd(new Date());

  return (
    <div className="rounded-panel border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <button className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setCursor(new Date(year, month - 1, 1))} aria-label="Prethodni mesec">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="text-sm font-semibold text-ink">
          {first.toLocaleDateString('sr-RS', { month: 'long', year: 'numeric' })}
        </span>
        <button className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setCursor(new Date(year, month + 1, 1))} aria-label="Sledeći mesec">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px bg-line-soft p-px text-xs">
        {DOW.map((d) => (
          <div key={d} className="bg-surface-2 px-2 py-1 text-center font-semibold text-ink-secondary">{d}</div>
        ))}
        {cells.map((c, i) => {
          const key = c ? ymd(c) : `x${i}`;
          const items = c ? (byDay.get(ymd(c)) ?? []) : [];
          return (
            <div key={key} className={cn('min-h-20 bg-surface p-1', c && ymd(c) === todayKey && 'bg-accent-subtle')}>
              {c && <div className="mb-1 tnums text-ink-secondary">{c.getDate()}</div>}
              <div className="space-y-0.5">
                {items.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onOpen(s.id)}
                    className="block w-full truncate rounded bg-accent/10 px-1 py-0.5 text-left text-2xs text-accent hover:bg-accent/20"
                    title={s.naslov}
                  >
                    {formatVreme(s.vreme)} {s.naslov}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Nedeljni pregled (paritet 1.0 sastanciWeekView) — 7 dana tekuće nedelje. */
export function WeekView({
  sastanci,
  onOpen,
}: {
  sastanci: Sastanak[];
  onOpen: (id: string) => void;
}) {
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date();
    const off = (d.getDay() + 6) % 7;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - off);
  });

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    return d;
  });
  const byDay = useMemo(() => {
    const m = new Map<string, Sastanak[]>();
    for (const s of sastanci) {
      const k = sameKey(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(s);
    }
    return m;
  }, [sastanci]);

  return (
    <div className="rounded-panel border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-2">
        <button className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() - 7))} aria-label="Prethodna nedelja">
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <span className="text-sm font-semibold text-ink">
          {days[0].toLocaleDateString('sr-RS', { day: '2-digit', month: 'short' })} — {days[6].toLocaleDateString('sr-RS', { day: '2-digit', month: 'short' })}
        </span>
        <button className="rounded-control p-1 text-ink-secondary hover:bg-surface-2" onClick={() => setWeekStart(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7))} aria-label="Sledeća nedelja">
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="divide-y divide-line-soft">
        {days.map((d, i) => {
          const items = byDay.get(ymd(d)) ?? [];
          return (
            <div key={i} className="flex gap-3 px-4 py-2">
              <div className="w-16 shrink-0 text-xs">
                <div className="font-semibold text-ink">{DOW[i]}</div>
                <div className="tnums text-ink-secondary">{d.getDate()}.{d.getMonth() + 1}.</div>
              </div>
              <div className="flex-1 space-y-1">
                {items.length ? (
                  items.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => onOpen(s.id)}
                      className="flex w-full items-center gap-2 rounded-control border border-line px-2 py-1 text-left text-sm hover:bg-surface-2"
                    >
                      <span className="tnums text-ink-secondary">{formatVreme(s.vreme)}</span>
                      <span className="flex-1 truncate text-ink">{s.naslov}</span>
                      <span className="text-xs text-ink-disabled">{SASTANAK_TIP_LABEL[s.tip] ?? s.tip}</span>
                    </button>
                  ))
                ) : (
                  <span className="text-xs text-ink-disabled">—</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
