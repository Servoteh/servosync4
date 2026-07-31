'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Factory, Link2, Plus, Search } from 'lucide-react';
import {
  useGantt,
  useGanttOverlay,
  useMachineHalls,
  type GanttRow,
} from '@/api/plan-proizvodnje';
import { Button } from '@/components/ui-kit/button';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { HaleDialog } from './hale-dialog';
import { GantStavkaDialog } from './gant-stavka-dialog';
import { DodajNaPlanDialog } from './gant-dodaj-dialog';
import {
  DAY_MS,
  NO_HALL,
  addDays,
  barEnd,
  dayDiff,
  groupRows,
  isoDay,
  rowKey,
  startOfDay,
} from './gant-utils';

/**
 * Tab „Gant" (zahtev 046/26, faza F0+F1) — planiranje mašinske proizvodnje na vremenskoj
 * osi, nalik MS Project-u. Redovi su grupisani **Hala → mašina** (hala dolazi iz RUČNOG
 * šifrarnika `plan_proizvodnje_machine_halls`; mašine bez dodele idu u „Bez hale").
 *
 * ⚠️ PARALELAN POGLED (odluka vlasnika): planirani termini NE menjaju raspored — ručni
 * redosled smene (`shift_sort_order`, tab „Po mašini") ostaje master. Ovde se samo crta i
 * pomera plan; nijedan postojeći sort/bucket ne zavisi od `planned_*` polja.
 *
 * Stavka bez `planned_start_at` NIJE na osi (nema bara) — na plan se stavlja dugmetom
 * „Dodaj na plan". Trajanje je podrazumevano iz tehnologije (TPZ + TK × kom) uz ručni
 * override; početak/kraj se pomeraju prevlačenjem bara (dan-granularnost) ili tastaturom
 * (←/→ pomeri, Shift+←/→ produži/skrati), a precizno se kucaju u dijalogu stavke.
 *
 * Static export bezbedno: bez `[id]` ruta i bez `useSearchParams` (tab živi u `?tab=` kroz
 * `useQueryTab` u `page.tsx`).
 */

/** Širina jednog dana u px (dan-granularnost ose). */
const DAY_W = 44;
/** Širina leve kolone (naziv stavke) u px — deljena sa zaglavljem. */
const LABEL_W = 300;
/** Ponuđene dužine prozora (dana). */
const RANGES = [14, 30, 60] as const;

type DragMode = 'move' | 'resize';
interface DragState {
  key: string;
  mode: DragMode;
  startX: number;
  deltaDays: number;
}

export function GanttTab() {
  const [hall, setHall] = useState('');
  const [rawQ, setRawQ] = useState('');
  const [q, setQ] = useState('');
  const [days, setDays] = useState<number>(30);
  const [rangeStart, setRangeStart] = useState<Date>(() => addDays(startOfDay(new Date()), -3));
  const [showUnplanned, setShowUnplanned] = useState(false);
  const [openHalls, setOpenHalls] = useState(false);
  const [openAdd, setOpenAdd] = useState(false);
  const [detail, setDetail] = useState<GanttRow | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);

  const gantt = useGantt({ hall: hall || undefined, q: q || undefined });
  const halls = useMachineHalls();
  const save = useGanttOverlay({ ok: 'Termin sačuvan' });

  const rows = useMemo(() => gantt.data?.data ?? [], [gantt.data]);
  const planned = useMemo(() => rows.filter((r) => !!r.planned_start_at), [rows]);
  const visible = showUnplanned ? rows : planned;
  const groups = useMemo(() => groupRows(visible), [visible]);

  /** Spisak hala za filter (iz šifrarnika, ne iz feed-a — vidi se i prazna hala). */
  const hallOptions = useMemo(() => {
    const set = new Set<string>();
    for (const h of halls.data?.data ?? []) if (h.hall) set.add(h.hall);
    return [...set].sort((a, b) => a.localeCompare(b, 'sr'));
  }, [halls.data]);

  const dayList = useMemo(
    () => Array.from({ length: days }, (_, i) => addDays(rangeStart, i)),
    [rangeStart, days],
  );
  const todayIdx = dayDiff(startOfDay(new Date()), rangeStart);

  // ── Drag (pomeranje / promena trajanja bara) ───────────────────────────────
  // Pointer eventi na `window` dok traje prevlačenje: bar sme da izađe iz svog reda,
  // a `pointercancel` (skrol na dodiru) mora da poništi radnju bez upisa.
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = Math.round((e.clientX - d.startX) / DAY_W);
      if (delta !== d.deltaDays) setDrag({ ...d, deltaDays: delta });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || d.deltaDays === 0) return;
      const row = rows.find((r) => rowKey(r) === d.key);
      if (!row?.planned_start_at) return;
      const start = new Date(row.planned_start_at);
      const end = barEnd(row);
      if (d.mode === 'move') {
        save.mutate({
          workOrderId: row.work_order_id,
          lineId: row.line_id,
          plannedStartAt: addDays(start, d.deltaDays).toISOString(),
          plannedEndAt: addDays(end, d.deltaDays).toISOString(),
        });
      } else {
        const nextEnd = addDays(end, d.deltaDays);
        // Kraj ne sme pre početka — minimum je isti dan (30 min vidljivog bara).
        const floor = new Date(start.getTime() + 30 * 60_000);
        const eff = nextEnd.getTime() < floor.getTime() ? floor : nextEnd;
        save.mutate({
          workOrderId: row.work_order_id,
          lineId: row.line_id,
          plannedEndAt: eff.toISOString(),
          plannedDurationMinutes: Math.max(1, Math.round((eff.getTime() - start.getTime()) / 60_000)),
        });
      }
    };
    const onCancel = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [drag, rows, save]);

  /** Tastatura nad fokusiranim barom: ←/→ pomeri dan, Shift+←/→ produži/skrati. */
  function onBarKey(e: React.KeyboardEvent, row: GanttRow) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setDetail(row);
      return;
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    if (!row.planned_start_at) return;
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    const start = new Date(row.planned_start_at);
    const end = barEnd(row);
    if (e.shiftKey) {
      const nextEnd = addDays(end, step);
      if (nextEnd.getTime() <= start.getTime()) return;
      save.mutate({
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedEndAt: nextEnd.toISOString(),
        plannedDurationMinutes: Math.max(1, Math.round((nextEnd.getTime() - start.getTime()) / 60_000)),
      });
    } else {
      save.mutate({
        workOrderId: row.work_order_id,
        lineId: row.line_id,
        plannedStartAt: addDays(start, step).toISOString(),
        plannedEndAt: addDays(end, step).toISOString(),
      });
    }
  }

  const timelineW = days * DAY_W;

  return (
    <div className="space-y-3">
      {/* ── Alatna traka ── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2">
          <CalendarDays className="h-4 w-4 text-ink-disabled" aria-hidden />
          <input
            type="date"
            aria-label="Početak prozora"
            value={isoDay(rangeStart)}
            onChange={(e) => e.target.value && setRangeStart(startOfDay(new Date(`${e.target.value}T00:00:00`)))}
            className="h-8 bg-transparent text-sm text-ink outline-none"
          />
        </div>
        <div className="inline-flex overflow-hidden rounded-control border border-line" role="group" aria-label="Dužina prozora">
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={cn(
                'h-8 px-3 text-xs transition-colors',
                days === d ? 'bg-accent text-accent-fg' : 'bg-surface text-ink-secondary hover:bg-surface-2',
              )}
            >
              {d} dana
            </button>
          ))}
        </div>
        <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setRangeStart(addDays(startOfDay(new Date()), -3))}>
          Danas
        </Button>

        <select
          aria-label="Filter hale"
          value={hall}
          onChange={(e) => setHall(e.target.value)}
          className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"
        >
          <option value="">Sve hale</option>
          {hallOptions.map((h) => (
            <option key={h} value={h}>{h}</option>
          ))}
          <option value="-">Bez hale</option>
        </select>

        <form
          className="inline-flex items-center gap-1 rounded-control border border-line bg-surface px-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(rawQ.trim());
          }}
        >
          <Search className="h-4 w-4 text-ink-disabled" aria-hidden />
          <input
            value={rawQ}
            onChange={(e) => setRawQ(e.target.value)}
            placeholder="Crtež / RN / naziv"
            aria-label="Filter po crtežu, RN-u ili nazivu"
            className="h-8 w-44 bg-transparent text-sm text-ink outline-none placeholder:text-ink-disabled"
          />
        </form>

        <label className="inline-flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={showUnplanned} onChange={(e) => setShowUnplanned(e.target.checked)} />
          Prikaži i stavke van plana
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Button variant="secondary" className="h-8 px-3 text-xs" onClick={() => setOpenHalls(true)}>
            <Factory className="h-4 w-4" aria-hidden /> Hale
          </Button>
          <Button className="h-8 px-3 text-xs" onClick={() => setOpenAdd(true)}>
            <Plus className="h-4 w-4" aria-hidden /> Dodaj na plan
          </Button>
        </div>
      </div>

      <p className="text-2xs text-ink-disabled">
        {planned.length} stavki na planu · redosled smene ostaje u tabu „Po mašini" (gant je paralelan pogled).
        Prevuci bar da pomeriš termin, prevuci desnu ivicu da promeniš trajanje, klikni za detalje.
      </p>

      {/* ── Osa ── */}
      {gantt.isLoading ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-secondary">
          Učitavanje plana…
        </div>
      ) : groups.length === 0 ? (
        <div className="rounded-panel border border-line bg-surface px-4 py-10 text-center text-sm text-ink-disabled">
          {showUnplanned
            ? 'Nema operacija za zadate filtere.'
            : 'Nijedna stavka još nije na planu. Klikni „Dodaj na plan" da postaviš prvi termin.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-panel border border-line bg-surface">
          <div style={{ minWidth: LABEL_W + timelineW }}>
            {/* zaglavlje dana */}
            <div className="sticky top-0 z-20 flex border-b border-line bg-surface-2">
              <div
                className="shrink-0 border-r border-line px-3 py-1.5 text-2xs uppercase tracking-wider text-ink-secondary"
                style={{ width: LABEL_W }}
              >
                Hala / mašina / stavka
              </div>
              <div className="relative flex" style={{ width: timelineW }}>
                {dayList.map((d, i) => (
                  <div
                    key={i}
                    className={cn(
                      'shrink-0 border-r border-line-soft py-1 text-center text-2xs',
                      isWeekend(d) ? 'bg-surface text-ink-disabled' : 'text-ink-secondary',
                      i === todayIdx && 'bg-accent/10 font-semibold text-ink',
                    )}
                    style={{ width: DAY_W }}
                    title={formatDate(d.toISOString())}
                  >
                    <div className="tnums">{d.getDate()}.</div>
                    <div className="tnums text-ink-disabled">{d.getMonth() + 1}.</div>
                  </div>
                ))}
              </div>
            </div>

            {/* grupe */}
            {groups.map((g) => (
              <div key={g.hall}>
                <div className="flex border-b border-line bg-surface-2/70">
                  <div
                    className="shrink-0 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-ink"
                    style={{ width: LABEL_W }}
                  >
                    {g.hall === NO_HALL ? 'Bez hale' : g.hall}
                  </div>
                  <div style={{ width: timelineW }} />
                </div>
                {g.machines.map((m) => (
                  <div key={`${g.hall}:${m.machine}`}>
                    <div className="flex border-b border-line-soft bg-surface">
                      <div
                        className="shrink-0 px-3 py-1 pl-5 text-xs font-medium text-ink-secondary"
                        style={{ width: LABEL_W }}
                      >
                        {m.machine}
                        {m.machineName ? <span className="ml-1 text-ink-disabled">· {m.machineName}</span> : null}
                        <span className="ml-1 text-ink-disabled">({m.rows.length})</span>
                      </div>
                      <div style={{ width: timelineW }} />
                    </div>
                    {m.rows.map((r) => {
                      const key = rowKey(r);
                      const d = drag?.key === key ? drag : null;
                      return (
                        <div key={key} className="flex border-b border-line-soft hover:bg-surface-2">
                          <div className="shrink-0 truncate px-3 py-1 pl-7 text-xs" style={{ width: LABEL_W }}>
                            <button
                              type="button"
                              onClick={() => setDetail(r)}
                              className="block w-full truncate text-left text-ink hover:underline"
                              title={`${r.broj_crteza ?? ''} · ${r.naziv_dela ?? ''}`}
                            >
                              <span className="tnums text-ink-secondary">{r.rn_ident_broj ?? '—'}</span>{' '}
                              {r.naziv_dela ?? r.broj_crteza ?? '(bez naziva)'}
                            </button>
                            <span className="text-2xs text-ink-disabled">
                              op. {String(r.operacija ?? '—')} · {r.opis_rada ?? '—'} · {r.komada_total ?? 0} kom
                            </span>
                          </div>
                          <div className="relative" style={{ width: timelineW }}>
                            {/* mreža dana */}
                            <div className="absolute inset-0 flex">
                              {dayList.map((dd, i) => (
                                <div
                                  key={i}
                                  className={cn(
                                    'shrink-0 border-r border-line-soft',
                                    isWeekend(dd) && 'bg-surface-2/50',
                                    i === todayIdx && 'bg-accent/5',
                                  )}
                                  style={{ width: DAY_W }}
                                />
                              ))}
                            </div>
                            {r.planned_start_at ? (
                              <Bar
                                row={r}
                                rangeStart={rangeStart}
                                days={days}
                                dragDelta={d?.deltaDays ?? 0}
                                dragMode={d?.mode ?? null}
                                onOpen={() => setDetail(r)}
                                onKeyDown={(e) => onBarKey(e, r)}
                                onDragStart={(mode, x) => setDrag({ key, mode, startX: x, deltaDays: 0 })}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDetail(r)}
                                className="relative z-10 ml-1 mt-1 rounded-control border border-dashed border-line px-2 py-0.5 text-2xs text-ink-disabled hover:border-accent hover:text-accent"
                              >
                                Nije na planu — postavi termin
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {gantt.data?.meta?.truncated ? (
        <p className="text-2xs text-status-warn">
          Prikaz je skraćen na {gantt.data.meta.limit} stavki — suzi filter (hala / crtež / RN).
        </p>
      ) : null}

      {openHalls && <HaleDialog open onClose={() => setOpenHalls(false)} />}
      {openAdd && (
        <DodajNaPlanDialog
          open
          onClose={() => setOpenAdd(false)}
          rows={rows.filter((r) => !r.planned_start_at)}
          defaultDay={startOfDay(new Date())}
        />
      )}
      {detail && (
        <GantStavkaDialog
          open
          row={rows.find((r) => rowKey(r) === rowKey(detail)) ?? detail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  );
}

/** Bar jedne stavke: pozicija/širina iz termina, boja iz spremnosti/završenosti. */
function Bar({
  row,
  rangeStart,
  days,
  dragDelta,
  dragMode,
  onOpen,
  onKeyDown,
  onDragStart,
}: {
  row: GanttRow;
  rangeStart: Date;
  days: number;
  dragDelta: number;
  dragMode: DragMode | null;
  onOpen: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onDragStart: (mode: DragMode, clientX: number) => void;
}) {
  const start = new Date(row.planned_start_at as string);
  const end = barEnd(row);
  const shiftMs = (dragMode === 'move' ? dragDelta : 0) * DAY_MS;
  const growMs = (dragMode === 'resize' ? dragDelta : 0) * DAY_MS;
  const s = start.getTime() + shiftMs;
  const e = Math.max(end.getTime() + shiftMs + growMs, s + 30 * 60_000);

  const left = ((s - rangeStart.getTime()) / DAY_MS) * DAY_W;
  const width = Math.max(((e - s) / DAY_MS) * DAY_W, 10);
  const total = days * DAY_W;
  // Van prozora → ne crtaj (i ne pravi vodoravni skrol duplo šireg bara).
  if (left + width < 0 || left > total) return null;

  const done = row.is_completed_effective === true;
  const ready = row.is_ready_for_machine === true;
  const tone = done
    ? 'bg-surface-2 border-line text-ink-secondary'
    : ready
      ? 'bg-status-success-bg border-status-success/50 text-status-success'
      : 'bg-status-danger-bg border-status-danger/50 text-status-danger';

  return (
    <div
      className="absolute top-1 z-10 h-6"
      style={{ left: Math.max(left, -4), width: Math.min(width, total - Math.max(left, 0) + 4) }}
    >
      <button
        type="button"
        onClick={onOpen}
        onKeyDown={onKeyDown}
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          onDragStart('move', ev.clientX);
        }}
        title={`${row.rn_ident_broj ?? ''} · ${row.naziv_dela ?? ''}\n${formatDate(start.toISOString())} → ${formatDate(end.toISOString())}\n${row.is_urgent ? 'HITNO · ' : ''}${ready ? 'Spremno' : 'Nije spremno'}`}
        className={cn(
          'flex h-6 w-full cursor-grab items-center gap-1 overflow-hidden rounded-control border px-1.5 text-2xs',
          'focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] active:cursor-grabbing',
          tone,
          row.is_urgent && !done && 'ring-1 ring-status-danger',
        )}
      >
        {row.predecessor_work_order_id ? <Link2 className="h-3 w-3 shrink-0" aria-hidden /> : null}
        {done ? <span aria-hidden>✓</span> : null}
        <span className="truncate">
          {row.broj_crteza ?? row.rn_ident_broj ?? '—'} · op. {String(row.operacija ?? '—')}
        </span>
      </button>
      {/* hvatište za promenu trajanja */}
      <span
        role="separator"
        aria-label="Promeni trajanje"
        onPointerDown={(ev) => {
          ev.stopPropagation();
          if (ev.button !== 0) return;
          onDragStart('resize', ev.clientX);
        }}
        className="absolute right-0 top-0 h-6 w-1.5 cursor-ew-resize rounded-r-control bg-ink/20 hover:bg-ink/40"
      />
    </div>
  );
}

function isWeekend(d: Date): boolean {
  const w = d.getDay();
  return w === 0 || w === 6;
}
