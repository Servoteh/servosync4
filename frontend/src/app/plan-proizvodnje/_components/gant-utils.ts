import type { GanttRow } from '@/api/plan-proizvodnje';

/**
 * Čista logika taba „Gant" (zahtev 046/26): dan-aritmetika vremenske ose, izvođenje kraja
 * bara iz trajanja i grupisanje redova **Hala → mašina**. Bez React-a — testabilno i
 * odvojeno od crtanja (isti obrazac kao `zauzetost-agg.ts`).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Ključ grupe za mašine bez dodeljene hale (šifrarnik nema red). */
export const NO_HALL = '￿';

/**
 * Početak radnog dana (07:00 lokalno) — termin postavljen „na dan" počinje u prvoj smeni,
 * a ne u ponoć. Dan-granularnost ose čini sat nebitnim za crtanje, ali čini prikaz u
 * dijalogu stavke i izveštajima smislenim.
 */
export const WORK_DAY_START_H = 7;

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Razlika u KALENDARSKIM danima (a − b), otporna na letnje/zimsko računanje vremena. */
export function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS);
}

/** 'yyyy-MM-dd' po LOKALNOM danu (ugovor `input[type=date]`). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'yyyy-MM-dd' (ili Date) → ISO timestamp u 07:00 LOKALNO (početak radnog dana). */
export function toIsoAtWorkStart(day: string | Date): string {
  const d = typeof day === 'string' ? new Date(`${day}T00:00:00`) : new Date(day);
  d.setHours(WORK_DAY_START_H, 0, 0, 0);
  return d.toISOString();
}

/**
 * Kraj bara: `planned_end_at` ako je zadat, inače početak + efektivno trajanje
 * (override ili TPZ + TK × kom iz tehnologije). Bez ijednog podatka → +1 dan, da bar
 * postoji i može da se uhvati mišem.
 */
export function barEnd(row: GanttRow): Date {
  const start = new Date(row.planned_start_at ?? Date.now());
  if (row.planned_end_at) return new Date(row.planned_end_at);
  const min = effectiveMinutes(row);
  return new Date(start.getTime() + (min > 0 ? min : 24 * 60) * 60_000);
}

/** Efektivno trajanje u minutima: override → BE `effective_duration_minutes` → TPZ+TK×kom. */
export function effectiveMinutes(row: GanttRow): number {
  if (row.planned_duration_minutes != null) return row.planned_duration_minutes;
  if (row.effective_duration_minutes != null) return row.effective_duration_minutes;
  return technologyMinutes(row);
}

/** Trajanje iz tehnologije: TPZ + TK × komada (minuti). */
export function technologyMinutes(row: GanttRow): number {
  const tpz = Number(row.tpz_min ?? 0) || 0;
  const tk = Number(row.tk_min ?? 0) || 0;
  const kom = Number(row.komada_total ?? 0) || 0;
  return Math.round(tpz + tk * kom);
}

export function rowKey(r: { work_order_id: string; line_id: string }): string {
  return `${r.work_order_id}:${r.line_id}`;
}

export interface MachineGroup {
  machine: string;
  machineName: string | null;
  rows: GanttRow[];
}
export interface HallGroup {
  hall: string;
  machines: MachineGroup[];
}

/**
 * Grupisanje Hala → mašina, uz stabilan poredak: hale abecedno („Bez hale" uvek
 * poslednja preko `NO_HALL` sentinela), mašine abecedno, stavke po planiranom početku
 * pa po ručnom redosledu smene (`shift_sort_order`) — isti kanon kao ostali tabovi.
 */
export function groupRows(rows: GanttRow[]): HallGroup[] {
  const byHall = new Map<string, Map<string, MachineGroup>>();
  for (const r of rows) {
    const hall = r.hall ?? NO_HALL;
    const machine = r.effective_machine_code ?? '(bez mašine)';
    let machines = byHall.get(hall);
    if (!machines) {
      machines = new Map();
      byHall.set(hall, machines);
    }
    let g = machines.get(machine);
    if (!g) {
      g = { machine, machineName: r.original_machine_name ?? null, rows: [] };
      machines.set(machine, g);
    }
    g.rows.push(r);
  }
  const out: HallGroup[] = [];
  for (const [hall, machines] of byHall) {
    const list = [...machines.values()].sort((a, b) => a.machine.localeCompare(b.machine, 'sr', { numeric: true }));
    for (const m of list) m.rows.sort(compareRows);
    out.push({ hall, machines: list });
  }
  return out.sort((a, b) => a.hall.localeCompare(b.hall, 'sr', { numeric: true }));
}

function compareRows(a: GanttRow, b: GanttRow): number {
  const sa = a.planned_start_at ?? '';
  const sb = b.planned_start_at ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  const oa = a.shift_sort_order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.shift_sort_order ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return String(a.rn_ident_broj ?? '').localeCompare(String(b.rn_ident_broj ?? ''), 'sr', { numeric: true });
}

/**
 * Razlog za „spremnost = NE" (prikaz u dijalogu stavke). Kanon spremnosti je BE
 * (`is_ready_for_machine`) — ovde se samo objašnjava ČIME je oborena.
 */
export function readyReason(row: GanttRow): string {
  if (row.is_ready_for_machine) return row.is_ready_manual ? 'Ručno označeno spremno' : 'Prethodne operacije završene';
  const prev = row.previous_operation_operacija;
  switch (row.previous_operation_status) {
    case 'in_progress':
      return `Prethodna operacija ${prev ?? ''} je u toku${row.previous_operation_machine_code ? ` (${row.previous_operation_machine_code})` : ''}`;
    case 'not_started':
      return `Prethodna operacija ${prev ?? ''} nije počela${row.previous_operation_machine_code ? ` (${row.previous_operation_machine_code})` : ''}`;
    default:
      return 'Prethodna operacija nije završena';
  }
}
