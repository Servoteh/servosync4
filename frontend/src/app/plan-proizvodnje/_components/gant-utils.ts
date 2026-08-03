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
 * 'yyyy-MM-dd' (ili Date) → ISO timestamp na KRAJU tog dana (23:59:59.999 lokalno).
 *
 * Osa je dan-granularna: kucan „planirani kraj" znači „zaključno sa tim danom", pa bar
 * pokriva ceo taj dan. Sat je FIKSAN (ne zavisi od trajanja operacije) — zato ponovljeno
 * snimanje istog dana daje identičan timestamp i plan ne može da odlazi unapred.
 */
export function toIsoAtDayEnd(day: string | Date): string {
  const d = typeof day === 'string' ? new Date(`${day}T00:00:00`) : new Date(day);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/**
 * Sačuvan timestamp AKO pada na isti lokalni dan koji stoji u polju (inače null).
 * Snimanje bez promene dana tako ne dira ni minut zatečenog termina — satnica dobijena
 * prevlačenjem/`resize`-om preživljava „Sačuvaj termin" (snimanje je idempotentno).
 */
export function keepIfSameDay(stored: string | null | undefined, day: string): string | null {
  if (!stored || !day) return null;
  const d = new Date(stored);
  if (Number.isNaN(d.getTime())) return null;
  return isoDay(d) === day ? d.toISOString() : null;
}

// ── Minutna granularnost (046/26 Paket B) — termini se kucaju kao datum+vreme ──

/** Date → 'yyyy-MM-ddTHH:mm' po LOKALNOM vremenu (ugovor `input[type=datetime-local]`). */
export function isoLocalMinute(d: Date): string {
  return `${isoDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Sačuvan timestamp AKO pada u ISTI lokalni minut koji stoji u polju (inače null) —
 * minutni analog `keepIfSameDay`. Polje `datetime-local` ne nosi sekunde, pa bi
 * snimanje bez ijedne izmene inače seklo zatečene sekunde/ms (nasleđeni dan-kanon
 * krajevi su 23:59:59.999) i „Sačuvaj termin" ne bi bio idempotentan.
 */
export function keepIfSameMinute(stored: string | null | undefined, local: string): string | null {
  if (!stored || !local) return null;
  const d = new Date(stored);
  if (Number.isNaN(d.getTime())) return null;
  return isoLocalMinute(d) === local ? d.toISOString() : null;
}

/**
 * 'yyyy-MM-ddTHH:mm' + minuti → 'yyyy-MM-ddTHH:mm' (lokalno). Aritmetika za pravilo
 * sinhronizacije u dijalogu stavke: kraj = početak + trajanje (Strahinjina primedba 2:
 * 16 h rada od 08:00 automatski pomera planirani kraj, i preko ponoći).
 */
export function addMinutesLocal(local: string, minutes: number): string {
  return isoLocalMinute(new Date(new Date(local).getTime() + minutes * 60_000));
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

/**
 * Zbir planiranih MINUTA stavki mašine čiji bar seče prikazani prozor
 * [rangeStart, rangeStart + days) — za „· 38,5 h" u redu grupe mašine (046/26-A1).
 *
 * Sat = efektivno trajanje rada (override ili TPZ + TK × kom), NE raspon bara: planer
 * ume da razvuče bar preko vikenda/zastoja, pa bi sabiranje raspona duplo naduvalo
 * opterećenje mašine. „U opsegu" = bar SEČE prozor (stavka se broji cela — rad nije
 * ravnomerno razmazan po danima, pa proporcionalno seckanje ne bi bilo istinitije).
 * Računa se na FE nad UČITANIM redovima (isti skup koji se i crta).
 */
export function machineRangeMinutes(
  rows: GanttRow[],
  rangeStart: Date,
  days: number,
): number {
  const from = startOfDay(rangeStart).getTime();
  const to = from + days * DAY_MS;
  let sum = 0;
  for (const r of rows) {
    if (!r.planned_start_at) continue;
    const s = new Date(r.planned_start_at).getTime();
    const e = barEnd(r).getTime();
    if (s < to && e > from) sum += Math.max(effectiveMinutes(r), 0);
  }
  return sum;
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
