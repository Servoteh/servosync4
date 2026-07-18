'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/ui-kit/empty-state';
import { useTasks, useUpdateTask, type PbTask } from '@/api/projektni-biro';
import { ApiError } from '@/api/client';
import { useAuth } from '@/lib/auth-context';
import { PERMISSIONS } from '@/lib/permissions';
import { statusTone, shortDate, workDaysBetween } from './shared';
import type { PlanFilters } from './plan-tab';

const TONE_BG: Record<string, string> = {
  success: 'bg-status-success',
  warn: 'bg-status-warn',
  danger: 'bg-status-danger',
  info: 'bg-status-info',
  neutral: 'bg-status-neutral',
};

const WINDOWS = [
  { key: '1', label: 'Mesec', months: 1 },
  { key: '3', label: 'Kvartal', months: 3 },
  { key: '6', label: '6 meseci', months: 6 },
] as const;

const MS_PER_DAY = 86_400_000;
/** Prag (px) da razlikuje pravi drag od klika. */
const DRAG_THRESHOLD_PX = 4;

/** YYYY-MM-DD pomeren za `n` dana (paritet 1.0 addDays; UTC-podne → TZ-neutralno). */
function shiftYmd(iso: string, n: number): string | null {
  const d = new Date(String(iso).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Interno stanje jednog drag-a plan-trake (živi u ref-u, van React re-rendera). */
type GanttDragState = {
  id: string;
  startX: number;
  pxPerDay: number;
  moved: boolean;
  origStart: string;
  origEnd: string;
  updatedAt: string;
};

export function GanttTab({ filters, onOpenTask }: { filters: PlanFilters; onOpenTask: (id: string | null) => void }) {
  const { can } = useAuth();
  const canEdit = can(PERMISSIONS.PB_EDIT);
  const tasksQ = useTasks({ ...filters, pageSize: 500 });
  const updateM = useUpdateTask();
  const [win, setWin] = useState<'1' | '3' | '6'>('3');
  const [anchor, setAnchor] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  // „danas" fiksiran na mount (izbegava hydration mismatch / re-render drift).
  const [todayMs] = useState(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t.getTime();
  });

  const months = WINDOWS.find((w) => w.key === win)!.months;
  const start = anchor;
  const end = useMemo(() => {
    const e = new Date(anchor);
    e.setMonth(e.getMonth() + months);
    return e;
  }, [anchor, months]);
  const spanMs = end.getTime() - start.getTime();

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; rows: PbTask[] }>();
    for (const t of tasksQ.data?.data ?? []) {
      if (t.deleted_at) continue;
      const key = t.employee_id ?? '—';
      const name = t.employee_name ?? 'Bez inženjera';
      if (!map.has(key)) map.set(key, { name, rows: [] });
      map.get(key)!.rows.push(t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'sr'));
  }, [tasksQ.data]);

  function barStyle(from: string | null, to: string | null): { left: string; width: string } | null {
    if (!from || !to) return null;
    const s = new Date(from).getTime();
    const e = new Date(to).getTime();
    if (Number.isNaN(s) || Number.isNaN(e)) return null;
    const cs = Math.max(s, start.getTime());
    const ce = Math.min(e, end.getTime());
    if (ce < start.getTime() || cs > end.getTime()) return null;
    const left = ((cs - start.getTime()) / spanMs) * 100;
    const width = Math.max(1.5, ((ce - cs) / spanMs) * 100);
    return { left: `${left}%`, width: `${width}%` };
  }

  const monthLabel = start.toLocaleDateString('sr-Latn', { month: 'long', year: 'numeric' });

  // Pozicija „danas" (%) u prozoru — null ako je van [start, end).
  const todayPct = useMemo(() => {
    if (todayMs < start.getTime() || todayMs >= end.getTime()) return null;
    return ((todayMs - start.getTime()) / spanMs) * 100;
  }, [todayMs, start, end, spanMs]);

  // ── Drag plan-trake (PB_EDIT): pomeri OBA plan-datuma za isti broj dana ─────
  // Stanje drag-a živi u ref-u (bez re-rendera po pikselu); preview je jedina
  // React state promena i menja se tek kad delta pređe granicu dana.
  const dragRef = useRef<GanttDragState | null>(null);
  const [dragPreview, setDragPreview] = useState<{ id: string; deltaDays: number } | null>(null);
  const [dragErr, setDragErr] = useState<string | null>(null);

  // Stabilni delegati na document-u (referentna stabilnost za removeEventListener),
  // logika im se osvežava svakim renderom preko *Handler ref-ova.
  const moveHandler = useRef<(e: MouseEvent) => void>(() => {});
  const upHandler = useRef<(e: MouseEvent) => void>(() => {});
  const moveListener = useRef((e: MouseEvent) => moveHandler.current(e)).current;
  const upListener = useRef((e: MouseEvent) => upHandler.current(e)).current;

  useEffect(() => {
    moveHandler.current = (ev) => {
      const st = dragRef.current;
      if (!st) return;
      const dx = ev.clientX - st.startX;
      if (!st.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      st.moved = true;
      const deltaDays = Math.round(dx / st.pxPerDay);
      setDragPreview((p) => (p && p.id === st.id && p.deltaDays === deltaDays ? p : { id: st.id, deltaDays }));
    };
    upHandler.current = (ev) => {
      document.removeEventListener('mousemove', moveListener);
      document.removeEventListener('mouseup', upListener);
      const st = dragRef.current;
      dragRef.current = null;
      if (!st || !st.moved) return setDragPreview(null);
      const deltaDays = Math.round((ev.clientX - st.startX) / st.pxPerDay);
      if (deltaDays === 0) return setDragPreview(null);
      const newStart = shiftYmd(st.origStart, deltaDays);
      const newEnd = shiftYmd(st.origEnd, deltaDays);
      if (!newStart || !newEnd) return setDragPreview(null);
      setDragErr(null);
      // Preview OSTAJE dok mutacija ne završi (bez „rubber-band" skoka); čisti se u onSettled.
      updateM.mutate(
        { id: st.id, patch: { datumPocetkaPlan: newStart, datumZavrsetkaPlan: newEnd, expectedUpdatedAt: st.updatedAt } },
        {
          onError: (e) =>
            setDragErr(
              e instanceof ApiError && e.status === 409
                ? 'Zadatak je u međuvremenu izmenjen — osveži pregled.'
                : e instanceof ApiError && e.status === 403
                  ? 'Nemate pravo za pomeranje datuma.'
                  : 'Greška pri pomeranju datuma.',
            ),
          onSettled: () => setDragPreview(null),
        },
      );
    };
  });

  // Skini eventualne visece listenere pri unmount-u (bez akumulacije).
  useEffect(
    () => () => {
      document.removeEventListener('mousemove', moveListener);
      document.removeEventListener('mouseup', upListener);
    },
    [moveListener, upListener],
  );

  function startPlanDrag(e: React.MouseEvent<HTMLDivElement>, t: PbTask) {
    if (!canEdit || e.button !== 0) return;
    if (!t.datum_pocetka_plan || !t.datum_zavrsetka_plan) return;
    const cell = e.currentTarget.parentElement; // .relative.h-6 = pun prozor (spanMs = 100%)
    if (!cell) return;
    const cellWidth = cell.getBoundingClientRect().width;
    if (cellWidth <= 0) return;
    e.preventDefault(); // spreči selekciju teksta / native drag
    const daysInWindow = spanMs / MS_PER_DAY;
    dragRef.current = {
      id: t.id,
      startX: e.clientX,
      pxPerDay: cellWidth / daysInWindow,
      moved: false,
      origStart: t.datum_pocetka_plan,
      origEnd: t.datum_zavrsetka_plan,
      updatedAt: t.updated_at,
    };
    document.addEventListener('mousemove', moveListener);
    document.addEventListener('mouseup', upListener);
  }

  function shift(delta: number) {
    setAnchor((a) => {
      const n = new Date(a);
      n.setMonth(n.getMonth() + delta);
      return n;
    });
  }

  function goToday() {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    setAnchor(d);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex gap-1 rounded-panel border border-line bg-surface p-1">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setWin(w.key)}
              className={cn('rounded-control px-2.5 py-1 text-sm', win === w.key ? 'bg-accent text-accent-fg' : 'text-ink-secondary hover:bg-surface-2')}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => shift(-1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            ←
          </button>
          <span className="min-w-32 text-center text-sm font-medium text-ink">{monthLabel}</span>
          <button onClick={() => shift(1)} className="rounded-control border border-line px-2 py-1 text-ink-secondary hover:bg-surface-2">
            →
          </button>
          <button onClick={goToday} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-2" aria-label="Skoči na tekući mesec">
            Danas
          </button>
        </div>
      </div>

      <p className="text-xs text-ink-disabled">
        Legenda: puna traka = plan (boja po statusu), donja traka = ostvareno, crvena vertikala = danas.
        {canEdit ? ' Prevuci plan-traku za pomeranje datuma.' : ''}
      </p>

      {dragErr && (
        <div className="flex items-center justify-between rounded-control border border-status-danger/40 bg-status-danger/10 px-3 py-1.5 text-xs text-status-danger">
          <span>{dragErr}</span>
          <button onClick={() => setDragErr(null)} className="ml-2 shrink-0 hover:underline" aria-label="Zatvori">
            ✕
          </button>
        </div>
      )}

      {tasksQ.isError ? (
        <EmptyState title="Greška pri učitavanju" hint="Osveži stranicu ili pokušaj ponovo." />
      ) : groups.length === 0 ? (
        <EmptyState title="Nema zadataka za prikaz" />
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <table className="w-full text-sm">
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.name}>
                  <tr className="bg-surface-2/60">
                    <td colSpan={2} className="px-3 py-1.5 text-xs font-semibold text-ink">
                      {g.name}
                    </td>
                  </tr>
                  {g.rows.map((t) => {
                    // Tokom drag-a preview pomera plan-traku na buduću poziciju (cele dane).
                    const previewDelta = dragPreview?.id === t.id ? dragPreview.deltaDays : 0;
                    const planFrom = previewDelta !== 0 ? shiftYmd(t.datum_pocetka_plan ?? '', previewDelta) : t.datum_pocetka_plan;
                    const planTo = previewDelta !== 0 ? shiftYmd(t.datum_zavrsetka_plan ?? '', previewDelta) : t.datum_zavrsetka_plan;
                    const plan = barStyle(planFrom, planTo);
                    const real = barStyle(t.datum_pocetka_real, t.datum_zavrsetka_real);
                    const tone = TONE_BG[statusTone(t.status)];
                    return (
                      <tr key={t.id} className="border-b border-line-soft">
                        <td className="w-56 max-w-56 px-3 py-2">
                          <button onClick={() => onOpenTask(t.id)} className="truncate text-left text-ink hover:underline">
                            {t.naziv}
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          <div
                            className="relative h-6"
                            title={`${t.naziv}\nPlan: ${shortDate(t.datum_pocetka_plan)} → ${shortDate(t.datum_zavrsetka_plan)}\nOstvareno: ${shortDate(
                              t.datum_pocetka_real,
                            )} → ${shortDate(t.datum_zavrsetka_real)}\nTrajanje: ${workDaysBetween(t.datum_pocetka_plan, t.datum_zavrsetka_plan) ?? '—'} rd\nStatus: ${
                              t.status
                            } · ${t.procenat_zavrsenosti ?? 0}%`}
                          >
                            {plan ? (
                              <div
                                className={cn('absolute top-0 h-3 rounded', tone, canEdit && 'cursor-grab select-none active:cursor-grabbing')}
                                style={plan}
                                onMouseDown={canEdit ? (e) => startPlanDrag(e, t) : undefined}
                              >
                                <div className="h-full rounded bg-black/20" style={{ width: `${t.procenat_zavrsenosti ?? 0}%` }} />
                              </div>
                            ) : (
                              <span className="text-2xs text-ink-disabled">van prozora</span>
                            )}
                            {real && <div className="absolute top-3.5 h-2 rounded bg-ink/40" style={real} />}
                            {todayPct !== null && (
                              <div className="pointer-events-none absolute inset-y-0 z-10 w-px bg-status-danger/60" style={{ left: `${todayPct}%` }} aria-hidden />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
