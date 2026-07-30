/**
 * GO periodi „od–do" za prikaz na kartici zaposlenog (Kadrovska → Odmori).
 *
 * ⚠️ ZAŠTO OVAJ MODUL POSTOJI: saldo-kanon za BROJ dana je grid (`work_hours`,
 * jedan red po RADNOM danu). Ako se iz grida izvedu i RASPONI, jedan odmor se
 * raspadne na onoliko komada koliko ga vikendi/praznici seku — npr. odobreni GO
 * 04.08.–17.08.2026. (10 radnih dana) prikaže se kao TRI perioda 04–07.08,
 * 10–14.08 i 17.08. Tako radi i SQL `go_ledger`/`ai_chat_go_pregled`
 * (`work_date - row_number()` gap-and-islands) i FE `mergeConsecutiveDays`.
 *
 * Zato je ovde merodavan izvor `vacation_requests` — JEDAN zahtev = JEDAN
 * neprekidan raspon, sa statusom (pending / sef_approved / approved). Tabela
 * `absences` (ogledalo finalno odobrenog zahteva, bez kolone `status`) služi
 * SAMO kao dopuna za odmore koji nemaju svoj zahtev (stariji ručni HR unos) i
 * takvi su jasno označeni izvorom `evidencija`.
 *
 * ⚠️ NALAZ F1 (review 30.07.2026): dva izvora NISU dovoljna. Na živoj bazi 2026.
 * postoji 181 GO dan u gridu za 61 zaposlenog BEZ ijednog zahteva/odsustva
 * (npr. Dolovac Vladimir: 07–08.05, 20–24.07, 27–31.07 — sve samo u gridu). Ti
 * isti dani ULAZE u `v_vacation_balance` (`days_used`/`days_planned`), pa je red
 * istovremeno tvrdio „Iskorišćeno 18 · Planirano 1" i „nema planiranog odmora".
 * Zato je grid TREĆI izvor (`source: "grid"`), ali se dani MERGE-uju sa
 * premošćavanjem vikenda i neradnih praznika — inače se vrati baš ona
 * fragmentacija (04–07 / 10–14 / 17.08) zbog koje modul i postoji.
 *
 * Modul je čist (bez baze/Nest-a) da bi grupisanje, premošćavanje, faze i
 * prazan slučaj bili jedinično testirani.
 */

/**
 * Izvor raspona:
 *  - `zahtev`     = vacation_requests (kanon, nosi status odobravanja),
 *  - `evidencija` = absences (type='godisnji') bez svog zahteva,
 *  - `grid`       = work_hours (absence_code='go') bez zahteva i bez odsustva.
 */
export type VacationPeriodSource = "zahtev" | "evidencija" | "grid";

/** Vremenska faza raspona u odnosu na današnji dan (NE izvodi se iz statusa). */
export type VacationPeriodPhase = "planiran" | "u_toku" | "iskorisceno";

export interface VacationPeriod {
  id: string;
  employeeId: string;
  /** YYYY-MM-DD */
  dateFrom: string;
  /** YYYY-MM-DD */
  dateTo: string;
  /**
   * Broj dana odmora. Za `zahtev`/`evidencija` = `days_count` iz reda; za `grid`
   * = BROJ GO dana u rasponu (ne kalendarski raspon), tako da se poklapa sa
   * `v_vacation_balance` koji broji iste redove `work_hours`.
   */
  daysCount: number;
  /**
   * Sirov status zahteva; za `evidencija` uvek "approved" (absences se pišu tek
   * u `hr_vacreq_approve`), za `grid` = "grid" (nema odluke o odobrenju).
   */
  status: string;
  /** Finalno odobren (status = approved). `sef_approved` NIJE finalno odobren. */
  approved: boolean;
  phase: VacationPeriodPhase;
  source: VacationPeriodSource;
}

/** Ulazni oblik zahteva (podskup `vacation_requests`). */
export interface VacationPeriodRequestInput {
  id: string;
  employeeId: string;
  dateFrom: Date | string;
  dateTo: Date | string;
  daysCount: number | null;
  status: string;
}

/** Ulazni oblik evidencije (podskup `absences`, type = 'godisnji'). */
export interface VacationPeriodAbsenceInput {
  id: string;
  employeeId: string;
  dateFrom: Date | string;
  dateTo: Date | string;
  daysCount: number | null;
}

/** Ulazni oblik grida (podskup `work_hours`, absence_code = 'go'). */
export interface VacationPeriodGridDayInput {
  employeeId: string;
  workDate: Date | string;
}

/** Ulazni oblik praznika (podskup `kadr_holidays`) — za premošćavanje jaza. */
export interface VacationPeriodHolidayInput {
  holidayDate: Date | string;
  isWorkday: boolean | null;
}

/**
 * Statusi koji se PRIKAZUJU kao odmor. `rejected`/`canceled` se izostavljaju —
 * to nije ni planiran ni odobren odmor. `sef_approved` (međukorak dvostepenog
 * odobravanja: šef potvrdio, čeka HR/admin) MORA da ostane, inače ljudi nestanu
 * iz pregleda dok im zahtev čeka drugi stepen.
 */
export const VACATION_PERIOD_STATUSES = new Set([
  "pending",
  "sef_approved",
  "approved",
]);

/**
 * Statusi vidljivi pozivaocu BEZ `kadrovska.vacreq_manage` (nalaz F3, review
 * 30.07.2026). Ruta nosi klasnu `kadrovska.read`, a red-opseg joj je
 * `current_user_manages_employee()` koja na živoj bazi vraća TRUE za SVE
 * zaposlene svakome sa rolom pm/leadpm/projektant_vodja. `projektant_vodja` ima
 * `kadrovska.read` ali NEMA `kadrovska.vacreq_manage`, pa bi bez ovog filtera
 * video `pending`/`sef_approved` zahteve cele firme — „ko je tražio odmor a još
 * nije odobren" je klasa podatka koja je do sada bila samo iza `/kadrovska/requests`.
 * Realizovan odmor (`evidencija`, `grid`) NIJE ta klasa i ostaje svima.
 */
export const VACATION_PERIOD_STATUSES_PUBLIC = new Set(["approved"]);

const MS_DAY = 86_400_000;

/** 'YYYY-MM-DD' → UTC ms (`@db.Date` je UTC ponoć, pa nema TZ pomeraja). */
function dayMs(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`);
}

function msDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Subota/nedelja po UTC danu (datum je bez vremena). */
function isWeekend(iso: string): boolean {
  const d = new Date(dayMs(iso)).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Neradni dan = vikend ILI praznik sa `is_workday = false`. Eksplicitan red u
 * `kadr_holidays` presuđuje i nad vikendom (radna subota → `is_workday = true`
 * → dan JESTE radni pa seče raspon).
 */
export function isNonWorkingDay(
  iso: string,
  holidays: ReadonlyMap<string, boolean>,
): boolean {
  const workday = holidays.get(iso);
  if (workday !== undefined) return !workday;
  return isWeekend(iso);
}

/**
 * Najduži jaz koji se sme premostiti. Najduži stvaran neradni niz u Srbiji je
 * Uskrs (Veliki petak–Vaskršnji ponedeljak = 4 dana, uz susedni vikend do 6) i
 * Nova godina (01–02.01 + vikend + 07.01). 10 je odbrana od izopačenih podataka,
 * NIJE poslovno pravilo — bez njega bi jedan GO dan u januaru i jedan u
 * decembru mogli da se spoje da su svi dani između kojim čudom neradni.
 */
const MAX_BRIDGE_GAP_DAYS = 10;

/** Sme li se jaz između dva GO dana premostiti (svi dani između neradni)? */
function bridgeable(
  prev: string,
  next: string,
  holidays: ReadonlyMap<string, boolean>,
): boolean {
  const gap = (dayMs(next) - dayMs(prev)) / MS_DAY;
  if (gap <= 0) return false;
  if (gap === 1) return true; // susedni dani
  if (gap - 1 > MAX_BRIDGE_GAP_DAYS) return false;
  for (let ms = dayMs(prev) + MS_DAY; ms < dayMs(next); ms += MS_DAY) {
    if (!isNonWorkingDay(msDay(ms), holidays)) return false;
  }
  return true;
}

/** Neprekidan raspon izveden iz pojedinačnih GO dana grida. */
export interface VacationGridRange {
  dateFrom: string;
  dateTo: string;
  /** Broj STVARNIH GO dana u rasponu (premošćeni vikendi/praznici se ne broje). */
  daysCount: number;
}

/**
 * Gap-and-islands nad GO danima grida, ali sa PREMOŠĆAVANJEM neradnih dana:
 * petak + ponedeljak = JEDAN raspon (vikend između ne prekida odmor), isto i
 * preko neradnog praznika. Bez ovoga se odmor 04.08.–17.08. raspadne na
 * 04–07 / 10–14 / 17.08 — greška zbog koje ceo modul postoji.
 */
export function mergeGridDays(
  days: readonly string[],
  holidays: ReadonlyMap<string, boolean> = new Map(),
): VacationGridRange[] {
  const uniq = [...new Set(days.filter(Boolean))].sort();
  const out: VacationGridRange[] = [];
  for (const d of uniq) {
    const last = out[out.length - 1];
    if (last && bridgeable(last.dateTo, d, holidays)) {
      last.dateTo = d;
      last.daysCount += 1;
      continue;
    }
    out.push({ dateFrom: d, dateTo: d, daysCount: 1 });
  }
  return out;
}

/** `Date` (Prisma @db.Date, UTC ponoć) ili string → 'YYYY-MM-DD'. */
export function isoDay(v: Date | string | null | undefined): string {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

/** Faza po datumima (kao `ai_chat_go_zahtevi.vremenski_status`), NE po statusu. */
export function phaseOf(
  dateFrom: string,
  dateTo: string,
  today: string,
): VacationPeriodPhase {
  if (dateFrom > today) return "planiran";
  if (dateTo < today) return "iskorisceno";
  return "u_toku";
}

/** Presek dva zatvorena raspona (string poređenje je bezbedno za YYYY-MM-DD). */
function overlaps(
  aFrom: string,
  aTo: string,
  bFrom: string,
  bTo: string,
): boolean {
  return aFrom <= bTo && bFrom <= aTo;
}

/**
 * Sastavi listu GO raspona po zaposlenom, tri izvora po opadajućem prioritetu:
 *  1. `vacation_requests` (kanon — jedan zahtev = jedan raspon, sa statusom),
 *  2. `absences` (type='godisnji') koje nemaju svoj zahtev,
 *  3. GO dani iz grida (`work_hours`) koji nisu pokriveni ni 1. ni 2.
 *
 * Preklapanje: zahtev/evidencija UVEK pobeđuje — zahtev se nikad ne cepa niti
 * duplira. Grid se rešava na nivou DANA: dan koji pada u već prikazan raspon se
 * izostavlja, a PREOSTALI dani se ponovo spajaju istim pravilom. Delimično
 * pokrivanje zato daje ostatak kao zaseban `grid` raspon (npr. zahtev
 * 04–17.08 + grid 18–19.08 → „04–17.08 [odobren]" + „18–19.08 [iz evidencije
 * (bez zahteva)]"), umesto da se ta dva dana tiho izgube iz prikaza a ostanu
 * u saldu („Iskorišćeno" ih i dalje broji).
 *
 * Sortirano po datumu početka rastuće (pa po kraju).
 */
export function buildVacationPeriods(input: {
  requests: VacationPeriodRequestInput[];
  absences?: VacationPeriodAbsenceInput[];
  /** GO dani iz grida (`work_hours.absence_code='go'`) — treći izvor (F1). */
  gridDays?: VacationPeriodGridDayInput[];
  /** `kadr_holidays` za godinu — neradni praznici se premošćuju kao vikend. */
  holidays?: VacationPeriodHolidayInput[];
  /** Današnji dan u Europe/Belgrade, 'YYYY-MM-DD'. */
  today: string;
  /**
   * Sme li pozivalac da vidi NE-odobrene zahteve (`pending`/`sef_approved`)?
   * = ima li `kadrovska.vacreq_manage` (F3). Podrazumevano NE — uža projekcija
   * je bezbedan default ako se ikad zaboravi da se prosledi.
   */
  includeUnapproved?: boolean;
}): VacationPeriod[] {
  const today = isoDay(input.today);
  const allowedStatuses = input.includeUnapproved
    ? VACATION_PERIOD_STATUSES
    : VACATION_PERIOD_STATUSES_PUBLIC;

  const fromRequests: VacationPeriod[] = [];
  for (const r of input.requests ?? []) {
    if (!allowedStatuses.has(r.status)) continue;
    const dateFrom = isoDay(r.dateFrom);
    const dateTo = isoDay(r.dateTo);
    if (!dateFrom || !dateTo) continue;
    fromRequests.push({
      id: r.id,
      employeeId: r.employeeId,
      dateFrom,
      dateTo,
      daysCount: r.daysCount ?? 0,
      status: r.status,
      approved: r.status === "approved",
      phase: phaseOf(dateFrom, dateTo, today),
      source: "zahtev",
    });
  }

  // Evidencija ulazi SAMO ako je zahtev nema — inače bi se isti odmor duplirao.
  const byEmp = new Map<string, VacationPeriod[]>();
  for (const p of fromRequests) {
    const list = byEmp.get(p.employeeId);
    if (list) list.push(p);
    else byEmp.set(p.employeeId, [p]);
  }

  const fromAbsences: VacationPeriod[] = [];
  for (const a of input.absences ?? []) {
    const dateFrom = isoDay(a.dateFrom);
    const dateTo = isoDay(a.dateTo);
    if (!dateFrom || !dateTo) continue;
    const covered = (byEmp.get(a.employeeId) ?? []).some((p) =>
      overlaps(dateFrom, dateTo, p.dateFrom, p.dateTo),
    );
    if (covered) continue;
    fromAbsences.push({
      id: a.id,
      employeeId: a.employeeId,
      dateFrom,
      dateTo,
      daysCount: a.daysCount ?? 0,
      // `absences` nema kolonu `status` — u nju piše tek `hr_vacreq_approve`,
      // dakle svaki red je odobren odmor.
      status: "approved",
      approved: true,
      phase: phaseOf(dateFrom, dateTo, today),
      source: "evidencija",
    });
  }

  // Evidencija koja je ušla u prikaz i sama postaje „pokriven" raspon za grid.
  for (const p of fromAbsences) {
    const list = byEmp.get(p.employeeId);
    if (list) list.push(p);
    else byEmp.set(p.employeeId, [p]);
  }

  // ── 3. izvor: GRID (`work_hours.absence_code='go'`) ────────────────────────
  // Jedini izvor za 181 GO dan / 61 zaposlenog u 2026. bez ijednog zahteva.
  const holidays = new Map<string, boolean>();
  for (const h of input.holidays ?? []) {
    const d = isoDay(h.holidayDate);
    if (d) holidays.set(d, h.isWorkday === true);
  }

  const gridByEmp = new Map<string, string[]>();
  for (const g of input.gridDays ?? []) {
    const d = isoDay(g.workDate);
    if (!d) continue;
    const list = gridByEmp.get(g.employeeId);
    if (list) list.push(d);
    else gridByEmp.set(g.employeeId, [d]);
  }

  const fromGrid: VacationPeriod[] = [];
  for (const [employeeId, days] of gridByEmp) {
    const covering = byEmp.get(employeeId) ?? [];
    const free = days.filter(
      (d) => !covering.some((p) => d >= p.dateFrom && d <= p.dateTo),
    );
    for (const r of mergeGridDays(free, holidays)) {
      fromGrid.push({
        // Stabilan ključ (FE ga koristi kao React key) — grid nema svoj `id`.
        id: `grid:${employeeId}:${r.dateFrom}`,
        employeeId,
        dateFrom: r.dateFrom,
        dateTo: r.dateTo,
        daysCount: r.daysCount,
        // Grid nema odluku o odobrenju — dani su samo evidentirani u mesečnom
        // gridu (isti redovi koje broji `v_vacation_balance`).
        status: "grid",
        approved: false,
        phase: phaseOf(r.dateFrom, r.dateTo, today),
        source: "grid",
      });
    }
  }

  return [...fromRequests, ...fromAbsences, ...fromGrid].sort((x, y) =>
    x.dateFrom !== y.dateFrom
      ? x.dateFrom < y.dateFrom
        ? -1
        : 1
      : x.dateTo < y.dateTo
        ? -1
        : x.dateTo > y.dateTo
          ? 1
          : 0,
  );
}
