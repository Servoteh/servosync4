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
 * Modul je čist (bez baze/Nest-a) da bi grupisanje, faze i prazan slučaj bili
 * jedinično testirani.
 */

/** Izvor raspona: `zahtev` = vacation_requests (kanon), `evidencija` = absences. */
export type VacationPeriodSource = "zahtev" | "evidencija";

/** Vremenska faza raspona u odnosu na današnji dan (NE izvodi se iz statusa). */
export type VacationPeriodPhase = "planiran" | "u_toku" | "iskorisceno";

export interface VacationPeriod {
  id: string;
  employeeId: string;
  /** YYYY-MM-DD */
  dateFrom: string;
  /** YYYY-MM-DD */
  dateTo: string;
  daysCount: number;
  /** Sirov status zahteva; za `evidencija` uvek "approved" (absences = odobreno). */
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
 * Sastavi listu GO raspona po zaposlenom: zahtevi (kanon) + evidencija koja
 * nema svoj zahtev. Sortirano po datumu početka rastuće (pa po kraju).
 */
export function buildVacationPeriods(input: {
  requests: VacationPeriodRequestInput[];
  absences?: VacationPeriodAbsenceInput[];
  /** Današnji dan u Europe/Belgrade, 'YYYY-MM-DD'. */
  today: string;
}): VacationPeriod[] {
  const today = isoDay(input.today);

  const fromRequests: VacationPeriod[] = [];
  for (const r of input.requests ?? []) {
    if (!VACATION_PERIOD_STATUSES.has(r.status)) continue;
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

  return [...fromRequests, ...fromAbsences].sort((x, y) =>
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
