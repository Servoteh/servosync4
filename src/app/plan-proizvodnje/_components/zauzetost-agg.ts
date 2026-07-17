// Klijentska agregacija za tabove „Zauzetost mašina" i „Pregled svih" (GAP-PM-13/14).
// DOSLOVNI port 1.0 `summarizeByMachine` (services/planProizvodnje.js:1597) i
// `buildDeadlineMatrix` (:1703) nad /operations/all — ista polja, isti bucket kanon,
// isti plannedSeconds (TPZ preskočen ako done>0, remaining=0 → 0; bez „ili 1" laži).

import type { OpRow } from '@/api/plan-proizvodnje';
import { plannedSeconds, num, rokUrgencyClass } from './shared';

// ── Zauzetost: sumar po mašini ──────────────────────────────────────────────

export interface MachineSummary {
  machineCode: string;
  totalOps: number;
  drawingsCount: number;
  readyOps: number;
  urgentOps: number;
  camReadyOps: number;
  overdueOps: number;
  todayOps: number;
  soonOps: number;
  warnOps: number;
  okOps: number;
  noDeadlineOps: number;
  plannedSec: number;
  realSec: number;
  reassignedInOps: number;
  nonMachiningOps: number;
}

/** Port 1.0 `summarizeByMachine`. Operacije bez effective_machine_code preskočene. */
export function summarizeByMachine(rows: OpRow[]): MachineSummary[] {
  const byMachine = new Map<string, MachineSummary & { drawingsSet: Set<string> }>();
  for (const r of rows) {
    const mc = r.effective_machine_code;
    if (!mc) continue;
    let s = byMachine.get(mc);
    if (!s) {
      s = {
        machineCode: mc,
        totalOps: 0,
        drawingsCount: 0,
        drawingsSet: new Set<string>(),
        overdueOps: 0,
        todayOps: 0,
        soonOps: 0,
        warnOps: 0,
        okOps: 0,
        noDeadlineOps: 0,
        plannedSec: 0,
        realSec: 0,
        nonMachiningOps: 0,
        reassignedInOps: 0,
        camReadyOps: 0,
        readyOps: 0,
        urgentOps: 0,
      };
      byMachine.set(mc, s);
    }
    s.totalOps += 1;
    if (r.broj_crteza) s.drawingsSet.add(String(r.broj_crteza));
    if (r.cam_ready) s.camReadyOps += 1;
    if (r.is_ready_for_machine) s.readyOps += 1;
    if (r.is_urgent) s.urgentOps += 1;
    if (r.is_non_machining) s.nonMachiningOps += 1;
    if (r.assigned_machine_code) s.reassignedInOps += 1;
    s.plannedSec += plannedSeconds(r);
    s.realSec += num(r.real_seconds);

    const u = rokUrgencyClass(r.rok_izrade);
    if (!u) s.noDeadlineOps += 1;
    else if (u === 'overdue') s.overdueOps += 1;
    else if (u === 'today') s.todayOps += 1;
    else if (u === 'soon') s.soonOps += 1;
    else if (u === 'warn') s.warnOps += 1;
    else s.okOps += 1;
  }
  const out: MachineSummary[] = [];
  for (const s of byMachine.values()) {
    const { drawingsSet, ...rest } = s;
    out.push({ ...rest, drawingsCount: drawingsSet.size });
  }
  return out;
}

// ── Pregled svih: matrica mašina × radni dani ───────────────────────────────

export interface DayCol {
  date: string; // YYYY-MM-DD
  dow: number;
  label: string; // „Pon 21.04"
  isToday: boolean;
}

export interface MatrixMachine {
  machineCode: string;
  totalOps: number;
  camReadyOps: number;
  readyOps: number;
  urgentOps: number;
  buckets: Record<string, number>; // overdue|future|noDeadline|<date>
  urgentBuckets: Record<string, number>;
}

const DAY_NAMES = ['Ned', 'Pon', 'Uto', 'Sre', 'Čet', 'Pet', 'Sub'];

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** Port 1.0 `nextWorkingDays` — narednih N radnih dana (Pon–Pet), uklj. danas ako je radni. */
export function nextWorkingDays(numWorkingDays = 5, fromDate: Date = new Date()): DayCol[] {
  const out: DayCol[] = [];
  const cur = new Date(fromDate);
  cur.setHours(0, 0, 0, 0);
  const todayStr = isoDay(new Date());
  for (let i = 0; i < 14 && out.length < numWorkingDays; i++) {
    const d = new Date(cur);
    d.setDate(cur.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const isoStr = isoDay(d);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    out.push({ date: isoStr, dow, label: `${DAY_NAMES[dow]} ${dd}.${mm}`, isToday: isoStr === todayStr });
  }
  return out;
}

export interface DeadlineMatrix {
  days: DayCol[];
  machines: MatrixMachine[];
}

/** Port 1.0 `buildDeadlineMatrix`. */
export function buildDeadlineMatrix(rows: OpRow[], numWorkingDays = 5): DeadlineMatrix {
  const days = nextWorkingDays(numWorkingDays);
  const lastDay = days.length ? days[days.length - 1].date : null;
  const todayStr = isoDay(new Date());

  const byMachine = new Map<string, MatrixMachine>();
  for (const r of rows) {
    const mc = r.effective_machine_code;
    if (!mc) continue;
    let m = byMachine.get(mc);
    if (!m) {
      m = {
        machineCode: mc,
        totalOps: 0,
        camReadyOps: 0,
        readyOps: 0,
        urgentOps: 0,
        buckets: { overdue: 0, future: 0, noDeadline: 0 },
        urgentBuckets: { overdue: 0, future: 0, noDeadline: 0 },
      };
      for (const d of days) {
        m.buckets[d.date] = 0;
        m.urgentBuckets[d.date] = 0;
      }
      byMachine.set(mc, m);
    }
    m.totalOps += 1;
    if (r.cam_ready) m.camReadyOps += 1;
    if (r.is_ready_for_machine) m.readyOps += 1;
    if (r.is_urgent) m.urgentOps += 1;
    const rok = r.rok_izrade ? isoDay(new Date(r.rok_izrade)) : null;
    let bucketKey: string;
    if (!rok) bucketKey = 'noDeadline';
    else if (rok < todayStr) bucketKey = 'overdue';
    else if (lastDay && rok > lastDay) bucketKey = 'future';
    else if (m.buckets[rok] !== undefined) bucketKey = rok;
    else bucketKey = 'future';
    m.buckets[bucketKey] += 1;
    if (r.is_urgent) m.urgentBuckets[bucketKey] += 1;
  }

  return { days, machines: Array.from(byMachine.values()) };
}

/**
 * Boja ćelije po hitnosti dana (port 1.0 `bucketClass`, pregledTab.js:407):
 * today / soon (≤3d) / warn (4–7d) / ok (>7d). Prazna ćelija → ''.
 */
export type CellUrgency = 'today' | 'soon' | 'warn' | 'ok' | '';
export function cellUrgency(day: DayCol, n: number): CellUrgency {
  if (n === 0) return '';
  if (day.isToday) return 'today';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dDate = new Date(day.date);
  const diff = Math.floor((dDate.getTime() - today.getTime()) / (24 * 3600 * 1000));
  if (diff <= 3) return 'soon';
  if (diff <= 7) return 'warn';
  return 'ok';
}
