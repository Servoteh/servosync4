import { opKey, type GanttRow } from '@/api/plan-proizvodnje';

/**
 * Čista logika taba „Gant" (zahtev 046/26): dan-aritmetika vremenske ose, izvođenje kraja
 * bara iz trajanja i grupisanje redova **Hala → mašina**. Bez React-a — testabilno i
 * odvojeno od crtanja (isti obrazac kao `zauzetost-agg.ts`).
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Ključ grupe za mašine bez dodeljene hale (šifrarnik nema red). */
export const NO_HALL = '￿';

/** Širina jednog dana u px (dan-granularnost ose). */
export const DAY_W = 44;

/**
 * FIKSNE visine redova (px, border-box — ivice ulaze u visinu). Paket C ih čini
 * konstantama da bi sloj veza (SVG linije prethodnik → sledbenik) mogao da računa
 * y-pozicije deterministički iz indeksa reda, bez merenja DOM-a (v. `layoutRows`).
 */
export const ROW_H = 40;
/** Visina reda grupe (hala i mašina). */
export const GROUP_H = 28;
/** Vrh bara unutar reda — bar (h-6 = 24px) vertikalno centriran u ROW_H. */
export const BAR_TOP = 8;

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

// ── Trajanje se KUCA u satima, ČUVA u minutima (zahtev 076/26) ────────────────
//
// Strahinjin zahtev: polje „Trajanje — override" da prima SATE („ako upišem 2,
// sistem sam pretvori u 120 minuta"). Izmereno 05.08.2026 nad 37 unetih override-a:
// 31 (84 %) je tačan umnožak 60 minuta, najmanji 60 min, prosek 889 min (≈14,8 h),
// najveći 10.100 min (168 h) — ljudi već misle u satima a kucaju minute.
//
// ⚠️ BAZA I API OSTAJU U MINUTIMA (`planned_duration_minutes INTEGER`, DTO `@IsInt`).
// Prevod je ISKLJUČIVO u polju kartice: zatečeni podaci se ne diraju (Strahinjina
// reč), a prevlačenje i razvlačenje bara na gantu i dalje pišu MINUTE — inače bi
// jedan potez mišem promenio trajanje 60 puta. Iz istog broja se računaju dužina
// bara i zauzetost mašine, pa je jedina bezbedna granica ovaj par funkcija.

/**
 * Broj iz korisničkog unosa sa SRPSKIM decimalnim zarezom. `Number("1,5")` je `NaN`,
 * pa bi goli `Number()` odbio unos koji ljudi ovde najčešće kucaju. Prima i zarez i
 * tačku (isti obrazac kao `parsePrice`/`parseWholeNumber` u modulu održavanja):
 * kad zarez postoji on je decimalni, a tačke su hiljade; bez zareza tačka je decimalna.
 *
 * Vraća `null` za PRAZNO (to je legitimna vrednost = „vrati na tehnologiju") i `NaN`
 * za stvarno neispravan unos — dve različite stvari koje pozivalac mora da razlikuje.
 */
export function parseDecimalCommaInput(raw: string): number | null {
  const t = String(raw ?? '').replace(/[^\d,.-]/g, '').trim();
  if (!t) return null;
  const body = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  const n = Number(body);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * SATI iz polja → CELI MINUTI za upis (`planned_duration_minutes`). DTO je `@IsInt`,
 * pa zaokruživanje mora ovde: `2` → 120, `1,5` → 90, `2,51` → 151 (150,6 min).
 *
 * Vraća `null` za prazno polje („vrati na tehnologiju"), `NaN` za neispravan unos i
 * za nulu/negativno (trajanje mora biti pozitivno — pozivalac javlja razlog). Pod je
 * 1 minut: sitan ali pozitivan unos (`0,001` h) je namera da nešto traje, a ne nula.
 */
export function minutesFromHoursInput(raw: string): number | null {
  const h = parseDecimalCommaInput(raw);
  if (h === null) return null;
  if (!Number.isFinite(h) || h <= 0) return NaN;
  return Math.max(1, Math.round(h * 60));
}

/**
 * MINUTI iz baze → tekst polja u SATIMA (decimalni zarez, bez suvišnih nula):
 * 120 → „2", 90 → „1,5", 10.100 → „168,33".
 *
 * Dve decimale su DOVOLJNE da povratak bude tačan: greška zaokruživanja je najviše
 * 0,005 h = 0,3 min < pola minuta, pa `minutesFromHoursInput` uvek vrati IDENTIČAN
 * broj minuta. Zato „Sačuvaj termin" bez ijedne izmene polja ostaje idempotentan i
 * nasleđeni podaci u minutima ne mogu tiho da odlutaju kroz otvaranje kartice.
 */
export function hoursInputFromMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '';
  const n = Number(minutes);
  if (!Number.isFinite(n)) return '';
  return (n / 60)
    .toFixed(2)
    .replace(/\.?0+$/, '')
    .replace('.', ',');
}

/** Minuti → „X h" za pomoćni tekst (jedna decimala, decimalni zarez). */
export function hoursLabel(minutes: number): string {
  return `${(minutes / 60).toFixed(1).replace('.', ',')} h`;
}

/**
 * Ključ reda = DELJENI ključ otvorene operacije (`opKey`, `@/api/plan-proizvodnje`).
 * Namerno isti izraz i isti izvor kao „Po mašini": optimistički upis redosleda (070/26)
 * mapira gant redove po ovom ključu, pa dva različita računa ključa ne smeju da postoje.
 */
export const rowKey = opKey;

/**
 * 069/26 — oznaka škarta: JEDAN izvor je `@/api/plan-proizvodnje` (tamo živi i
 * optimistički update koji je koristi). Ovde samo re-eksport, da tab i dijalog nastave
 * da uvoze logiku ganta s jednog mesta (isti obrazac kao `rowKey`).
 * `autoDone` se NE re-eksportuje — troši ga samo optimistički update u api sloju.
 */
export { scrapOutstanding, scrapBadge, scrapText } from '@/api/plan-proizvodnje';

/**
 * Geometrija bara u px unutar ose (izvučeno iz `Bar`-a da isti račun koristi i sloj
 * veza — linija mora da pogodi TAČNO ivicu bara). `shiftMs`/`growMs` su pomaci živog
 * prevlačenja (move pomera ceo interval, resize samo kraj; pod = 30 min vidljivog bara).
 *
 * Klipovanje na prozor [0, days×DAY_W]: odsečen bar gubi i ŠIRINU odsečenog dela (ne
 * samo početak). Bar CEO van prozora → `visible: false` uz left/width prikovane za
 * ivicu prozora (width 0) — Bar ga ne crta, ali linija veze i dalje ima sidro na ivici
 * („veza se nastavlja van prozora").
 */
export interface BarGeom {
  left: number;
  width: number;
  clipLeft: boolean;
  clipRight: boolean;
  /** false = bar je ceo van prikazanog prozora (ne crta se). */
  visible: boolean;
}

export function barGeometry(
  row: GanttRow,
  rangeStart: Date,
  days: number,
  shiftMs = 0,
  growMs = 0,
): BarGeom | null {
  if (!row.planned_start_at) return null;
  const start = new Date(row.planned_start_at);
  const end = barEnd(row);
  const s = start.getTime() + shiftMs;
  const e = Math.max(end.getTime() + shiftMs + growMs, s + 30 * 60_000);
  const rawLeft = ((s - rangeStart.getTime()) / DAY_MS) * DAY_W;
  const rawWidth = Math.max(((e - s) / DAY_MS) * DAY_W, 10);
  const rawRight = rawLeft + rawWidth;
  const total = days * DAY_W;
  if (rawRight < 0) return { left: 0, width: 0, clipLeft: true, clipRight: false, visible: false };
  if (rawLeft > total) return { left: total, width: 0, clipLeft: false, clipRight: true, visible: false };
  const clipLeft = rawLeft < 0;
  const clipRight = rawRight > total;
  const left = clipLeft ? 0 : rawLeft;
  const width = Math.max((clipRight ? total : rawRight) - left, 10);
  return { left, width, clipLeft, clipRight, visible: true };
}

/**
 * Vertikalni raspored redova ganta (za SVG sloj veza): ide ISTIM redosledom kao render
 * (hala → mašina → stavke) i svakoj stavci dodeljuje `top` u px od vrha tela ose.
 * Radi jer su visine FIKSNE konstante (ROW_H/GROUP_H) — nema merenja DOM-a, pa se
 * linije crtaju u istom prolazu rendera i ostaju tačne pri skrolu (žive u sadržaju).
 */
export interface RowLayout {
  top: number;
  row: GanttRow;
}

export function layoutRows(groups: HallGroup[]): {
  map: Map<string, RowLayout>;
  totalH: number;
} {
  let y = 0;
  const map = new Map<string, RowLayout>();
  for (const g of groups) {
    y += GROUP_H; // red hale
    for (const m of g.machines) {
      y += GROUP_H; // red mašine
      for (const r of m.rows) {
        map.set(rowKey(r), { top: y, row: r });
        y += ROW_H;
      }
    }
  }
  return { map, totalH: y };
}

/**
 * SVG putanja veze prethodnik → sledbenik (MS Project „elbow" stil): sa KRAJA bara
 * prethodnika kratak izlaz udesno, vertikala do reda sledbenika, pa u POČETAK bara
 * sledbenika (strelica). Kad sledbenik počinje levo od kraja prethodnika (back-link),
 * ruta obilazi ivicom reda sledbenika da linija ne seče barove.
 */
export function linkPath(x1: number, y1: number, x2: number, y2: number, succTop: number): string {
  const stub = 8;
  if (x1 + stub <= x2 - stub) {
    const m = x1 + stub;
    return `M ${x1} ${y1} L ${m} ${y1} L ${m} ${y2} L ${x2} ${y2}`;
  }
  const ymid = y1 <= y2 ? succTop : succTop + ROW_H;
  return `M ${x1} ${y1} L ${x1 + stub} ${y1} L ${x1 + stub} ${ymid} L ${x2 - stub} ${ymid} L ${x2 - stub} ${y2} L ${x2} ${y2}`;
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

/** Hala reda (sentinel `NO_HALL` = „Bez hale"). */
export function hallOf(r: GanttRow): string {
  return r.hall ?? NO_HALL;
}
/** Efektivna mašina reda (posle reassign-a); prazna → sentinel labela grupe. */
export function machineOf(r: GanttRow): string {
  return r.effective_machine_code ?? '(bez mašine)';
}
/**
 * Ključ grupe MAŠINE (hala + mašina) — isti ključ koji gradi `groupRows` i po kom
 * prevlačenje (070/26) skuplja stavke za renumeraciju. Razdvajač je `NO_HALL` sentinel
 * (￿), znak koji ne može da se pojavi ni u nazivu hale ni u šifri mašine.
 */
export function makeGroupKey(hall: string, machine: string): string {
  return `${hall}${NO_HALL}${machine}`;
}

export function groupKey(r: GanttRow): string {
  return makeGroupKey(hallOf(r), machineOf(r));
}

/**
 * Grupisanje Hala → mašina, uz stabilan poredak: hale abecedno („Bez hale" uvek
 * poslednja preko `NO_HALL` sentinela), mašine abecedno, stavke po `compareRows`
 * (ručni redosled smene `shift_sort_order` je master — v. dole).
 */
export function groupRows(rows: GanttRow[], mode: GanttSort = 'termin'): HallGroup[] {
  const byHall = new Map<string, Map<string, MachineGroup>>();
  for (const r of rows) {
    const hall = hallOf(r);
    const machine = machineOf(r);
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
    for (const m of list) m.rows.sort((a, b) => compareRows(a, b, mode));
    out.push({ hall, machines: list });
  }
  return out.sort((a, b) => a.hall.localeCompare(b.hall, 'sr', { numeric: true }));
}

/**
 * Režim ređanja redova unutar mašine (070/26, prekidač „Ređaj po"):
 *   • `termin` = PODRAZUMEVANO i identično stanju pre 070/26 — planirani početak je
 *     primaran, lista ostaje hronološka,
 *   • `rucni` = ručni redosled smene (`shift_sort_order`) je primaran; jedino u tom
 *     režimu prevlačenje redova ima šta da pokaže.
 */
export type GanttSort = 'termin' | 'rucni';

/** `null`/`undefined` idu POSLE svega (ogledalo `NULLS LAST` iz BE upita). */
function cmpNullsLast(a: string | null | undefined, b: string | null | undefined): number {
  const an = a == null || a === '';
  const bn = b == null || b === '';
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Poredak stavki UNUTAR mašine — DOSLOVNO ogledalo BE `gantt()` ORDER BY (v.
 * `plan-proizvodnje-read.service.ts`), ključ po ključ, u OBA režima:
 *   termin:  planned_start_at ↦ shift_sort_order ↦ rok_izrade ↦ rn_ident_broj ↦ operacija
 *   rucni:   shift_sort_order ↦ planned_start_at ↦ rok_izrade ↦ rn_ident_broj ↦ operacija
 * (grupni ključevi `hall, effective_machine_code` su iznad ovoga — njih radi `groupRows`.)
 *
 * ⚠️ Poredak mora da se poklapa sa BE-om zato što se feed SEČE na BE strani (`LIMIT`), a
 * crta po ovom računu: ako se razmimoiđu, rez uzme druge redove od onih koje prikaz stavlja
 * na vrh. Zato su ovde i `rok_izrade`/`operacija` (BE ih ima) i zato NULL vrednosti idu
 * POSLE (`NULLS LAST`) — ranije je FE stavljao stavke bez termina na POČETAK, suprotno BE-u.
 */
export function compareRows(a: GanttRow, b: GanttRow, mode: GanttSort = 'termin'): number {
  const oa = a.shift_sort_order ?? Number.MAX_SAFE_INTEGER;
  const ob = b.shift_sort_order ?? Number.MAX_SAFE_INTEGER;
  const rucni = oa !== ob ? oa - ob : 0;
  const termin = cmpNullsLast(a.planned_start_at, b.planned_start_at);
  if (mode === 'rucni') {
    if (rucni !== 0) return rucni;
    if (termin !== 0) return termin;
  } else {
    if (termin !== 0) return termin;
    if (rucni !== 0) return rucni;
  }
  const rok = cmpNullsLast(a.rok_izrade, b.rok_izrade);
  if (rok !== 0) return rok;
  const rn = String(a.rn_ident_broj ?? '').localeCompare(String(b.rn_ident_broj ?? ''), 'sr', {
    numeric: true,
  });
  if (rn !== 0) return rn;
  return (Number(a.operacija ?? 0) || 0) - (Number(b.operacija ?? 0) || 0);
}

/**
 * Novi redosled liste posle prevlačenja (070/26) — DOSLOVNO isti račun kao „Po mašini"
 * (`ops-table.tsx` `onDrop`): `after` = puštanje ISPOD polovine reda-mete (umetni POSLE),
 * a kompenzacija `if (from < to) to -= 1` je obavezna jer se prevučeni red prvo ukloni
 * (`splice(from, 1)`), pa se svi indeksi desno od njega pomere za 1 (bez nje je
 * off-by-one). `null` = nema pomeraja → pozivalac NE šalje upis.
 */
export function reorderByDrop(
  list: GanttRow[],
  dragKey: string,
  overKey: string,
  after: boolean,
): GanttRow[] | null {
  const from = list.findIndex((r) => rowKey(r) === dragKey);
  let to = list.findIndex((r) => rowKey(r) === overKey);
  if (from < 0 || to < 0) return null;
  if (after) to += 1;
  if (from < to) to -= 1;
  if (from === to) return null;
  const out = [...list];
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
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
