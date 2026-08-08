import {
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  belgradeParts,
  belgradeTimeToUtc,
  shiftBelgradeDate,
} from "../scheduler/belgrade-time";

/**
 * Prepis sy15 `SECURITY DEFINER` funkcija oblasti **PLATE** i **PRISUSTVO** u
 * NestJS, nad 3.0 bazom — korak 4 seobe (docs/SEOBA_KADROVSKE_2026-08-07.md,
 * §8 blokada 2). Ovaj fajl zatvara 17 od 116 funkcija domena.
 *
 * ⚠️ MODUL JE ZAMRZNUT ZA DORADE (docs/OTVORENI_POSLOVI.md §K). Zamrznute su
 * FUNKCIONALNE izmene; SEOBA je ono što zamrzavanje ukida. Zato je ovde logika
 * prepisana **KAKVA JESTE** — uključujući mesta koja su očigledno pogrešna.
 * Svako takvo mesto nosi oznaku `🔴 ZATEČENO` i popisano je u runbook-u §9;
 * popravka bi bila dorada, tj. prekršaj odluke vlasnika.
 *
 * IZVOR: sva tela su pročitana sa ŽIVE sy15 (`pg_get_functiondef`, 08.08.2026),
 * ne po sećanju i ne po dokumentaciji. Mapa domena koja je pratila zadatak
 * pogrešila je na dva mesta i to je ispravljeno merenjem (v. „ISPRAVKE MAPE").
 *
 * ── ŠTA JE PRENETO (17 funkcija) ─────────────────────────────────────────────
 *  PLATE (8):
 *    current_user_can_view_salary      -> canViewSalary                🔴 BRAVA
 *    kadr_get_contract_salary          -> getContractSalary
 *    kadr_get_contract_bruto           -> getContractBruto
 *    v_salary_payroll_month (RLS view) -> listPayrollMonth
 *    kadr_payroll_init_month           -> payrollInitMonth
 *    hr_upsert_salary_payroll          -> upsertSalaryPayroll
 *    kadr_payroll_unlock               -> payrollUnlock
 *    kadr_set_contract_salary          -> setContractSalary
 *    kadr_queue_payroll_notifications  -> queuePayrollNotifications
 *  PRISUSTVO (9):
 *    can_edit_kadrovska_grid           -> canEditKadrovskaGrid          🔴 BRAVA
 *    hr_upsert_work_hours_batch        -> upsertWorkHoursBatch
 *    kadr_work_hours_audit             -> workHoursAudit
 *    v_attendance_daily (view)         -> attendanceDaily / racunajDnevnoPrisustvo
 *    attendance_submit_correction      -> submitAttendanceCorrection
 *    attendance_cancel_correction      -> cancelAttendanceCorrection
 *    kiosk_record_punch                -> kioskRecordPunch
 *    attendance_katze_max_idreg        -> katzeMaxIdreg
 *    kadr_schedule_attendance_alerts   -> scheduleAttendanceAlerts
 *    kadr_schedule_attendance_weekly_digest -> scheduleAttendanceWeeklyDigest
 *  Pomoćne DEFINER funkcije koje gornje zovu (prenete jer bez njih ne rade):
 *    current_user_email, current_user_is_admin, current_user_is_hr,
 *    current_user_is_hr_or_admin, current_user_is_poslovni_admin,
 *    current_user_managed_sub_department_ids, current_user_manages_employee,
 *    kadr_oversight_recipients, attendance_extra_recipients
 *
 * ── 🔴 BRAVA NAD PLATAMA — PRENETA DOSLOVNO ──────────────────────────────────
 * U sy15 zarade NE čuva rola nego **allowlist tabela** `kadr_salary_viewer_allowlist`
 * (2 reda, izmereno 08.08.2026). Sve 4 RLS politike na `salary_payroll` i sve 4 na
 * `salary_terms` su **samo** `current_user_can_view_salary()` — bez `is_admin`, bez
 * `is_hr`, bez ijedne role. 3.0 NEMA RLS (ODLUKE.md), pa ta brana mora da postoji
 * u servisnom sloju ili zarade procure. Zato:
 *
 *   1. `canViewSalary(email)` je JEDINI ulaz u podatke o zaradi i čita ISKLJUČIVO
 *      allowlist tabelu — nikad rolu, nikad `users.role`, nikad permisiju;
 *   2. SVAKI put do zarade (`getContractSalary`, `getContractBruto`,
 *      `listPayrollMonth`, `payrollInitMonth`, `upsertSalaryPayroll`,
 *      `payrollUnlock`, `setContractSalary`) prolazi kroz `assertCanViewSalary`
 *      ili kroz izričito izmerenu širu granu (v. tačka 3) — nema puta koji brani
 *      izbegne; tabela istinitosti je u `kadrovska-fn-plate.service.spec.ts`;
 *   3. 🔴 ISPRAVKA MAPE: `current_user_can_view_salary` NIJE „jedina brava".
 *      DVE funkcije primaju i `poslovni_admin` — `kadr_get_contract_bruto`
 *      (`can_view_salary OR is_poslovni_admin`) i `kadr_set_contract_salary`
 *      (isto). Pošto su DEFINER, one **zaobilaze RLS**, pa `poslovni_admin`
 *      (1 aktivan, izmereno) STVARNO vidi ugovorni bruto i STVARNO menja
 *      ugovornu zaradu, iako ga nijedna RLS politika ne pušta do tabele.
 *      To je zatečeno stanje i preneto je doslovno — ali se MORA znati, jer
 *      „samo dva mejla vide zarade" nije cela istina.
 *
 * ── 🔴 PRISUSTVO: 491.271 red i Katze most koji PIŠE UŽIVO ───────────────────
 * `attendance_events` je najveća tabela domena: **491.271 red / 140 MB**
 * (`ANALYZE` + `count(*)`, 08.08.2026 — ne `n_live_tup`). Po izvoru:
 * `katze` 488.924 + `katze_manual` 2.320 = **491.244 sa kapije**, `manual`
 * (korekcije) 27, `kiosk` 0. Zadnji upis mosta: 08.08.2026 10:40 po Beogradu.
 *
 * PRELAZNI REŽIM (opisan, NE implementiran — preusmeravanje mosta je runbook
 * §5.3 / blokada 8, poseban posao van ovog repo-a):
 *   • Most (`bridge/src/jobs/syncKatze.js`, systemd `servoteh-bridge`, na 10 min)
 *     piše u sy15 preko Supabase REST-a i NIJE pod `KADROVSKA_IZVOR`.
 *   • Dok je prekidač na `sy15` (podrazumevano) ništa se ne menja — ovaj servis
 *     se ne poziva. Kad prekidač stane na `3.0`, most MORA da se preusmeri
 *     ISTOG DANA; do tog trenutka 3.0 kapija stoji na stanju iz prenosa.
 *   • Zato SVE metode ovde rade i nad **nepotpunim i nemonotonim** nizom
 *     događaja: nijedna ne pretpostavlja „poslednji red = poslednje kucanje",
 *     nijedna ne računa razliku prema `MAX(id)`, i nijedna ne pada kad dan
 *     nema ni jedan događaj (vraća prazno, ne grešku). `katzeMaxIdreg()` je
 *     vodeni žig mosta i po `MAX(external_id)` je **samooporavljiv**: čim most
 *     počne da piše u 3.0, pokupi sve što je propustio.
 *   • Čitanja se filtriraju po `event_ts` (indeksirano: `idx_attendance_events_ts`,
 *     `idx_attendance_events_emp_ts`), a lokalni dan se proverava u kodu.
 *     Filtriranje po `event_ts_local` nema indeks i nad 491k redova bi bio
 *     sekvencijalni prolaz na svaki dnevni posao.
 *
 * ── ODSTUPANJA OD IZVORA (samo posledice seobe, ne izbor) ────────────────────
 *  1. `auth.jwt() ->> 'email'` / `request.jwt.claims` ne postoje -> mejl je
 *     EKSPLICITAN prvi argument svake metode (isti obrazac kao `SastanciFnService`).
 *  2. sy15 `user_roles` je (mejl, rola, project_id); 3.0 ima `users.role`
 *     (primarna) + `user_roles` (dodatne, `scope_type`). Gleda se UNIJA — inače
 *     korisnik čija je jedina rola primarna izgubi pravo koje je u sy15 imao.
 *     `scope_type='global'` je parnjak sy15 uslovu `project_id IS NULL`.
 *  3. Trigeri `trg_0_salary_payroll_immutability`, `trg_salary_payroll_totals` i
 *     `trg_salary_terms_close_prev` su PRENETI U MIGRACIJU (§5e/5f) i ostaju u
 *     bazi — ovaj servis ih NE duplira. `payrollUnlock` zato mora da radi u
 *     transakciji: `set_config('payroll.unlock_ok','on', true)` je lokalan za
 *     transakciju i bez njega brana odbija upis.
 *  4. `kadr_work_hours_audit` je u sy15 čitao ZAJEDNIČKI `audit_log` koji puni
 *     triger `audit_row_change()`. Taj triger migracija NAMERNO ne prenosi
 *     (migracija §6b, blokada 5), pa pod `3.0` istorija sati ostaje PRAZNA dok
 *     blokada 5 ne padne. Prepisano je ČITANJE (uz gejt i limite), a upis
 *     audita se NE dodaje ovde — to bi bio drugi izvor istine paralelan sa
 *     blokadom 5. Prazan odgovor je NAZNAČEN (`auditIzvorPrenet: false`), da se
 *     ne protumači kao „nije bilo izmena".
 *
 * ── ISPRAVKE MAPE DOMENA (izmereno, mapa je grešila) ─────────────────────────
 *  • `attendance_katze_max_idreg` je `prosecdef = FALSE` (mapa: „definer: true").
 *    Radi jer je `attendance_events` čitljiv aplikativnoj roli — ali NIJE DEFINER,
 *    pa bi pod RLS-om vraćao žig SAMO nad vidljivim redovima. Bitno mostu.
 *  • `kiosk_record_punch` ima 2.629 znakova, `attendance_katze_max_idreg` 289
 *    (mapa: „velicina_znakova: 0" za oba — nisu bile izmerene).
 */

/** Prisma klijent ILI transakcioni klijent — sve metode rade sa oba. */
export type PlateTx = Prisma.TransactionClient;

/** `hr_upsert_salary_payroll(p_row jsonb)` — ulaz. Nedostajući ključ ≠ `null`. */
export interface PayrollUpsertRow {
  id?: string | null;
  employee_id?: string | null;
  period_year?: number | null;
  period_month?: number | null;
  expected_updated_at?: string | Date | null;
  salary_type?: string | null;
  compensation_model?: string | null;
  advance_amount?: number | string | null;
  advance_paid_on?: string | null;
  advance_note?: string | null;
  fixed_salary?: number | string | null;
  hours_worked?: number | string | null;
  hourly_rate?: number | string | null;
  transport_rsd?: number | string | null;
  domestic_days?: number | null;
  per_diem_rsd?: number | string | null;
  foreign_days?: number | null;
  per_diem_eur?: number | string | null;
  final_paid_on?: string | null;
  status?: string | null;
  note?: string | null;
  fond_sati_meseca?: number | string | null;
  redovan_rad_sati?: number | string | null;
  prekovremeni_sati?: number | string | null;
  praznik_placeni_sati?: number | string | null;
  praznik_rad_sati?: number | string | null;
  godisnji_sati?: number | string | null;
  slobodni_dani_sati?: number | string | null;
  bolovanje_65_sati?: number | string | null;
  bolovanje_100_sati?: number | string | null;
  dve_masine_sati?: number | string | null;
  teren_u_zemlji_count?: number | null;
  teren_u_inostranstvu_count?: number | null;
  payable_hours?: number | string | null;
  ukupna_zarada?: number | string | null;
  prvi_deo?: number | string | null;
  preostalo_za_isplatu?: number | string | null;
  warnings?: unknown;
}

/** Vraćeni oblik `hr_upsert_salary_payroll` (paritet `jsonb_build_object`). */
export type PayrollUpsertResult =
  | {
      applied: true;
      id: string;
      updated_at: Date | null;
      status: string;
      total_rsd: Prisma.Decimal;
      ukupna_zarada: Prisma.Decimal;
    }
  | {
      applied: false;
      reason: "row_exists";
      existing_id: string | null;
      current_updated_at: Date | null;
    }
  | {
      applied: false;
      reason: "locked";
      current_updated_at: Date | null;
      current_status: "paid";
    }
  | { applied: false; reason: "stale"; current_updated_at: Date | null };

/** `hr_upsert_work_hours_batch(p_rows jsonb)` — jedan red ulaza. */
export interface WorkHoursBatchRow {
  employee_id: string;
  work_date: string;
  hours?: number | string | null;
  overtime_hours?: number | string | null;
  field_hours?: number | string | null;
  field_subtype?: string | null;
  two_machine_hours?: number | string | null;
  absence_code?: string | null;
  absence_subtype?: string | null;
  note?: string | null;
  project_ref?: string | null;
}

/** Jedan red `v_attendance_daily`. */
export interface AttendanceDailyRow {
  employeeId: string;
  day: string;
  firstIn: string | null;
  lastOut: string | null;
  presenceHours: number | null;
  eventsCnt: number;
  openIntervals: number;
  doubleInCnt: number;
}

/** Minimalan događaj kapije koji `racunajDnevnoPrisustvo` traži. */
export interface PunchEvent {
  id: bigint;
  employeeId: string;
  eventTsLocal: Date;
  direction: string;
}

/** Redosled istovremenih događaja iz `v_attendance_daily` (`dir_prio`). */
const DIR_PRIO: Record<string, number> = {
  in: 0,
  official_out: 1,
  break: 2,
  out: 3,
};

/** `direction IN ('in','official_out')` — smerovi koji OTVARAJU interval. */
const OTVARA = new Set(["in", "official_out"]);

/** `direction IN ('out','official_out','break')` — kandidati za `last_out`. */
const ZATVARA = new Set(["out", "official_out", "break"]);

/** `salary_type IN ('ugovor','dogovor')` — mesečna zarada (ne satnica). */
const MESECNI_TIPOVI = new Set(["ugovor", "dogovor"]);

/** `field_subtype` dozvoljene vrednosti; sve ostalo se TIHO baca na NULL. */
const FIELD_SUBTYPES = new Set(["domestic", "foreign"]);

/** `current_user_is_hr_or_admin()` — izmeren skup rola. */
const HR_OR_ADMIN_ROLES = new Set(["admin", "hr", "menadzment"]);

/**
 * `current_user_manages_employee()` — role koje upravljaju SVIMA bez obzira na
 * pododeljenje (izmereno: `pm`, `leadpm`, `projektant_vodja` + admin/hr/poslovni_admin).
 */
const MANAGES_ALL_ROLES = new Set(["pm", "leadpm", "projektant_vodja"]);

/** Role koje nose `managed_sub_department_ids` (sy15 `IN ('menadzment','tim_lider')`). */
const SCOPED_ROLES = new Set(["menadzment", "tim_lider"]);

@Injectable()
export class KadrovskaFnPlateService {
  private readonly logger = new Logger(KadrovskaFnPlateService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================================================
  // Pomoćno — mejlovi, datumi, brojevi
  // ==========================================================================

  /** `lower(coalesce(x,''))` iz PL/pgSQL-a. */
  private norm(email: string | null | undefined): string {
    return (email ?? "").trim().toLowerCase();
  }

  /** `@db.Date` kolona (UTC ponoć) -> 'YYYY-MM-DD'. */
  private ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** 'YYYY-MM-DD' -> `Date` za `@db.Date` kolonu. */
  private dbDate(v: string): Date {
    return new Date(`${v}T00:00:00Z`);
  }

  /**
   * `@db.Time`/`@db.Timestamp` -> 'HH:MM'. Bez timezone konverzije: obe kolone
   * su `without time zone`, pa je UTC prikaz Date-a tačno lokalni zapis
   * (pouka „Vremena u bazi su UTC bez zone").
   */
  private hhmm(v: Date | null | undefined): string | null {
    return v ? v.toISOString().slice(11, 16) : null;
  }

  /** 'HH:MM[:SS]' -> `Date` za `@db.Time(6)` kolonu. */
  private dbTime(v: string): Date {
    const s = v.length === 5 ? `${v}:00` : v;
    return new Date(`1970-01-01T${s}Z`);
  }

  /** `p_day + p_in` (date + time -> timestamp bez zone). */
  private danPlusVreme(day: string, time: Date): Date {
    return new Date(`${day}T${time.toISOString().slice(11, 23)}Z`);
  }

  /** 'YYYY-MM-DD' + n dana (kalendarski). */
  private plusDana(day: string, n: number): string {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** `(now() AT TIME ZONE 'Europe/Belgrade')::date` */
  private danasBeograd(at: Date = new Date()): string {
    const p = belgradeParts(at);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }

  /** 'DD.MM.YYYY.' — format datuma u svim mejlovima domena. */
  private ddmmyyyy(day: string): string {
    const [y, m, d] = day.split("-");
    return `${d}.${m}.${y}.`;
  }

  /**
   * `COALESCE((p_row ->> 'k')::numeric, fallback)` — ključ koji NE POSTOJI ili
   * je `null` pada na `fallback`. Prazan string u `->>` daje `''::numeric` =
   * greška u PG-u, pa se i on tretira kao „nije zadato" (jedina bezbedna grana).
   */
  private num(
    v: number | string | null | undefined,
    fallback: Prisma.Decimal | number,
  ): Prisma.Decimal {
    if (v === null || v === undefined || v === "") {
      return fallback instanceof Prisma.Decimal
        ? fallback
        : new Prisma.Decimal(fallback);
    }
    return new Prisma.Decimal(v);
  }

  /** `COALESCE((p_row ->> 'k')::int, fallback)`. */
  private int(v: number | null | undefined, fallback: number): number {
    return v === null || v === undefined ? fallback : Math.trunc(v);
  }

  /** `COALESCE(p_row ->> 'k', fallback)` za tekst. */
  private txt(
    v: string | null | undefined,
    fallback: string | null,
  ): string | null {
    return v === null || v === undefined ? fallback : v;
  }

  /**
   * `numeric(5,2)::text` iz PG-a — `sum(hours)` nad `numeric(5,2)` daje '8.00',
   * ne '8'. Mejlovi domena taj tekst ubacuju direktno, pa se skala čuva.
   */
  private satiTxt(d: Prisma.Decimal): string {
    return d.toFixed(2);
  }

  /** `NULLIF(p_row ->> 'k','')::date` — prazno/nedostajuće = NULL (BRIŠE polje). */
  private optDate(v: string | null | undefined): Date | null {
    const s = (v ?? "").trim();
    return s === "" ? null : this.dbDate(s.slice(0, 10));
  }

  // ==========================================================================
  // GEJTOVI PRAVA — prepis DEFINER funkcija koje su bile ulaz u RLS
  // --------------------------------------------------------------------------
  // Kad `KadrovskaAuthzService` nastane (runbook §8 blokada 1), ovi gejtovi se
  // sele tamo BEZ promene ponašanja; testovi ovog fajla su njihova specifikacija.
  // ==========================================================================

  /**
   * Sve aktivne role korisnika (primarna `users.role` + globalne `user_roles`),
   * lowercase, uz `managed_sub_department_ids` prve odgovarajuće role.
   *
   * `managedSubIds === null` znači „nema reda za `menadzment`/`tim_lider`" i
   * to je parnjak sy15 `NULL`-u koji `current_user_manages_employee` posebno
   * grana. Prazan niz (`[]`) NIJE isto: `x = any('{}')` je FALSE u PG-u, pa
   * korisnik sa praznim spiskom ne upravlja NIKIM.
   */
  private async rolesOf(
    email: string | null | undefined,
  ): Promise<{ roles: Set<string>; managedSubIds: number[] | null }> {
    const key = this.norm(email);
    if (key === "") return { roles: new Set(), managedSubIds: null };
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: key, mode: "insensitive" }, active: true },
      select: { id: true, role: true },
    });
    if (!user) return { roles: new Set(), managedSubIds: null };
    const extra = await this.prisma.userRole.findMany({
      where: { userId: user.id, isActive: true, scopeType: "global" },
      select: { role: true, managedSubDepartmentIds: true },
    });
    const roles = new Set<string>([user.role.toLowerCase()]);
    let managedSubIds: number[] | null = null;
    for (const r of extra) {
      const rola = r.role.toLowerCase();
      roles.add(rola);
      // Paritet `current_user_managed_sub_department_ids()`: LIMIT 1 nad
      // rolama `menadzment`/`tim_lider`, `project_id NULLS FIRST` (= global).
      if (managedSubIds === null && SCOPED_ROLES.has(rola)) {
        managedSubIds = r.managedSubDepartmentIds;
      }
    }
    return { roles, managedSubIds };
  }

  /**
   * 🔴 Paritet `current_user_can_view_salary()` — JEDINA brava nad zaradama.
   * Čita ISKLJUČIVO `kadr_salary_viewer_allowlist`; rola ne znači ništa.
   * Prazan mejl je FALSE (nikad „true jer nije nađen red").
   */
  async canViewSalary(email: string | null | undefined): Promise<boolean> {
    const key = this.norm(email);
    if (key === "") return false;
    const n = await this.prisma.kadrSalaryViewerAllowlist.count({
      where: { email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }

  /** Paritet `can_edit_kadrovska_grid()` — allowlist `kadr_grid_editor_allowlist`. */
  async canEditKadrovskaGrid(
    email: string | null | undefined,
  ): Promise<boolean> {
    const key = this.norm(email);
    if (key === "") return false;
    const n = await this.prisma.kadrGridEditorAllowlist.count({
      where: { email: { equals: key, mode: "insensitive" } },
    });
    return n > 0;
  }

  /** Paritet `current_user_is_admin()`. */
  async isAdmin(email: string | null | undefined): Promise<boolean> {
    return (await this.rolesOf(email)).roles.has("admin");
  }

  /** Paritet `current_user_is_hr()`. */
  async isHr(email: string | null | undefined): Promise<boolean> {
    return (await this.rolesOf(email)).roles.has("hr");
  }

  /** Paritet `current_user_is_poslovni_admin()`. */
  async isPoslovniAdmin(email: string | null | undefined): Promise<boolean> {
    return (await this.rolesOf(email)).roles.has("poslovni_admin");
  }

  /** Paritet `current_user_is_hr_or_admin()` — `admin | hr | menadzment`. */
  async isHrOrAdmin(email: string | null | undefined): Promise<boolean> {
    const { roles } = await this.rolesOf(email);
    for (const r of roles) if (HR_OR_ADMIN_ROLES.has(r)) return true;
    return false;
  }

  /**
   * Paritet `current_user_manages_employee(uuid)` — prepisan CASE po CASE:
   * admin -> hr -> poslovni_admin -> {pm,leadpm,projektant_vodja} -> ako nema
   * reda sa `managed_sub_department_ids` onda samo `menadzment` -> inače
   * poklapanje pododeljenja zaposlenog sa spiskom.
   */
  async managesEmployee(
    email: string | null | undefined,
    employeeId: string | null | undefined,
  ): Promise<boolean> {
    const { roles, managedSubIds } = await this.rolesOf(email);
    if (roles.has("admin") || roles.has("hr") || roles.has("poslovni_admin")) {
      return true;
    }
    for (const r of roles) if (MANAGES_ALL_ROLES.has(r)) return true;
    if (managedSubIds === null) return roles.has("menadzment");
    if (!employeeId || managedSubIds.length === 0) return false;
    const n = await this.prisma.employee.count({
      where: { id: employeeId, subDepartmentId: { in: managedSubIds } },
    });
    return n > 0;
  }

  /**
   * 🔴 `RAISE EXCEPTION 'permission_denied' USING ERRCODE='42501'` iz izvora.
   * Poruka je zadržana kao KOD (`permission_denied`), jer je FE prepoznaje.
   */
  private async assertCanViewSalary(
    email: string | null | undefined,
    hint: string,
  ): Promise<void> {
    if (await this.canViewSalary(email)) return;
    throw new ForbiddenException({
      error: { code: "permission_denied", message: hint },
    });
  }

  /** `kadr_oversight_recipients(uuid)` — samo redovi sa `role_label='sef'`. */
  async oversightSefRecipients(employeeId: string): Promise<string[]> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { subDepartmentId: true },
    });
    if (!emp?.subDepartmentId) return [];
    const rows = await this.prisma.userRole.findMany({
      where: {
        role: "menadzment",
        isActive: true,
        managedSubDepartmentIds: { has: emp.subDepartmentId },
      },
      select: { user: { select: { email: true } } },
    });
    const out = new Set<string>();
    for (const r of rows) {
      const e = this.norm(r.user?.email);
      if (e !== "") out.add(e);
    }
    return [...out];
  }

  /** `kadr_oversight_recipients(uuid)` — redovi sa `role_label='uprava'` (admini). */
  async oversightUpravaRecipients(): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { role: "admin", isActive: true },
      select: { user: { select: { email: true } } },
    });
    const primary = await this.prisma.user.findMany({
      where: { role: "admin", active: true },
      select: { email: true },
    });
    const out = new Set<string>();
    for (const r of rows) {
      const e = this.norm(r.user?.email);
      if (e !== "") out.add(e);
    }
    // 3.0 ima i PRIMARNU rolu (§odstupanje 2): admin bez reda u `user_roles`
    // je u sy15 imao red, pa bi bez ovoga tiho prestao da prima obaveštenja.
    for (const u of primary) {
      const e = this.norm(u.email);
      if (e !== "") out.add(e);
    }
    return [...out];
  }

  /** `attendance_extra_recipients(uuid)` — dopunski primaoci po pododeljenju. */
  async extraRecipients(employeeId: string): Promise<string[]> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { subDepartmentId: true },
    });
    if (!emp) return [];
    // Paritet JOIN-a: poklapanje pododeljenja ILI oba NULL.
    const rows = await this.prisma.attendanceNotifyExtra.findMany({
      where: {
        subDepartmentId:
          emp.subDepartmentId === null ? null : emp.subDepartmentId,
      },
      select: { email: true },
    });
    const out = new Set<string>();
    for (const r of rows) {
      const e = this.norm(r.email);
      if (e !== "") out.add(e);
    }
    return [...out];
  }

  // ==========================================================================
  // PLATE — 🔴 sve ide kroz `canViewSalary`
  // ==========================================================================

  /**
   * `kadr_get_contract_salary(uuid)`. Van allowlist-a vraća **NULL**, ne grešku —
   * izvor je `CASE WHEN can_view_salary THEN (...) END`, pa je „nema podatka"
   * nerazlučivo od „nema prava". Preneto doslovno (FE se na to naslanja).
   */
  async getContractSalary(
    email: string | null | undefined,
    employeeId: string,
  ): Promise<Record<string, unknown> | null> {
    if (!(await this.canViewSalary(email))) return null;
    const st = await this.vaziciUslov(employeeId);
    if (!st) return null;
    return {
      term_id: st.id,
      neto_rsd: st.netoRsd,
      bruto_rsd: st.brutoRsd,
      amount: st.amount,
      amount_type: st.amountType,
      currency: st.currency,
      salary_type: st.salaryType,
      effective_from: st.effectiveFrom,
      approved_by: st.approvedBy,
      approved_at: st.approvedAt,
    };
  }

  /**
   * `kadr_get_contract_bruto(uuid)`.
   * 🔴 ŠIRA brana od ostalih: `can_view_salary OR is_poslovni_admin` (izmereno).
   * Vraća `coalesce(bruto_rsd, amount kad je amount_type='bruto')`.
   */
  async getContractBruto(
    email: string | null | undefined,
    employeeId: string,
  ): Promise<Prisma.Decimal | null> {
    const dozvoljeno =
      (await this.canViewSalary(email)) || (await this.isPoslovniAdmin(email));
    if (!dozvoljeno) return null;
    const st = await this.vaziciUslov(employeeId);
    if (!st) return null;
    if (st.brutoRsd !== null) return st.brutoRsd;
    return st.amountType === "bruto" ? st.amount : null;
  }

  /**
   * Važeći `salary_terms` red na DANAŠNJI dan, redosledom iz
   * `kadr_get_contract_salary`/`_bruto`: `effective_from DESC NULLS LAST,
   * created_at DESC`.
   *
   * 🔴 ZATEČENO: `v_employee_current_salary` (koju koristi `payrollInitMonth`)
   * ista dva reda rešava DRUGIM redosledom — `effective_from DESC` BEZ
   * `created_at` — pa kad dva uslova dele `effective_from`, „trenutna zarada"
   * zavisi od toga koji put je pitao. Nije popravljano (modul je zamrznut).
   */
  private async vaziciUslov(employeeId: string) {
    const danas = this.dbDate(this.danasBeograd());
    const rows = await this.prisma.salaryTerm.findMany({
      where: {
        employeeId,
        effectiveFrom: { lte: danas },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: danas } }],
      },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      take: 1,
    });
    return rows[0] ?? null;
  }

  /**
   * Prepis view-a `v_salary_payroll_month` (`security_invoker = true`, pa je
   * RLS na `salary_payroll` VAŽIO i kroz view). 3.0 nema RLS -> brana ide ovde.
   * Van allowlist-a: **prazna lista**, isto što je RLS radio (ne 403) — inače
   * bi se ponašanje ekrana promenilo, a to je dorada.
   */
  async listPayrollMonth(
    email: string | null | undefined,
    year: number,
    month: number,
  ) {
    if (!(await this.canViewSalary(email))) return [];
    return this.prisma.salaryPayroll.findMany({
      where: { periodYear: year, periodMonth: month },
      include: {
        employee: {
          select: {
            fullName: true,
            position: true,
            department: true,
            isActive: true,
            workType: true,
            hireDate: true,
          },
        },
      },
      orderBy: { employee: { fullName: "asc" } },
    });
  }

  /**
   * `kadr_payroll_init_month(p_year, p_month)` — otvara `draft` red za svakog
   * AKTIVNOG zaposlenog koji ga za taj mesec još nema. Vraća broj upisanih.
   *
   * PARITET KOJI SE MORA ZADRŽATI:
   *  - gejt `current_user_can_view_salary()` (RAISE 42501, ne tiha nula),
   *  - `p_month` van 1..12 = greška,
   *  - `fixed_salary` se puni SAMO za `ugovor`/`dogovor`, `hourly_rate` SAMO za
   *    `satnica` — inače 0,
   *  - `warnings` je JEDAN od tri slučaja i to u TOM redosledu: nema uslova ->
   *    `no_salary_terms`; ima uslov bez modela -> `no_compensation_model`;
   *    inače `[]`,
   *  - `NOT EXISTS` po (employee, year, month) — ponovni poziv ne duplira.
   */
  async payrollInitMonth(
    email: string | null | undefined,
    year: number,
    month: number,
  ): Promise<number> {
    await this.assertCanViewSalary(
      email,
      "Samo administrator može da otvori obračun zarade.",
    );
    if (month < 1 || month > 12) {
      throw new UnprocessableEntityException({
        error: { code: "invalid_month", message: `invalid month ${month}` },
      });
    }

    const employees = await this.prisma.employee.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (employees.length === 0) return 0;

    const postojeci = new Set(
      (
        await this.prisma.salaryPayroll.findMany({
          where: { periodYear: year, periodMonth: month },
          select: { employeeId: true },
        })
      ).map((r) => r.employeeId),
    );
    const trenutni = await this.trenutniUsloviPoZaposlenom();

    let upisano = 0;
    for (const e of employees) {
      if (postojeci.has(e.id)) continue;
      const s = trenutni.get(e.id) ?? null;
      const tip = s?.salaryType ?? "ugovor";
      const warnings =
        s === null
          ? [
              {
                code: "no_salary_terms",
                message: "Zaposleni nema aktivne uslove zarade — obračun je 0.",
              },
            ]
          : s.compensationModel === null
            ? [
                {
                  code: "no_compensation_model",
                  message:
                    "Aktivni uslov zarade nema definisan tip zarade (compensation_model).",
                },
              ]
            : [];
      await this.prisma.salaryPayroll.create({
        data: {
          employeeId: e.id,
          periodYear: year,
          periodMonth: month,
          salaryType: tip,
          compensationModel: s?.compensationModel ?? null,
          fixedSalary: MESECNI_TIPOVI.has(tip)
            ? (s?.amount ?? new Prisma.Decimal(0))
            : new Prisma.Decimal(0),
          hourlyRate:
            s?.salaryType === "satnica"
              ? (s?.amount ?? new Prisma.Decimal(0))
              : new Prisma.Decimal(0),
          transportRsd: s?.transportAllowanceRsd ?? new Prisma.Decimal(0),
          perDiemRsd: s?.perDiemRsd ?? new Prisma.Decimal(0),
          perDiemEur: s?.perDiemEur ?? new Prisma.Decimal(0),
          status: "draft",
          warnings,
        },
      });
      upisano += 1;
    }
    return upisano;
  }

  /**
   * Prepis view-a `v_employee_current_salary` (`DISTINCT ON (employee_id)`,
   * `ORDER BY employee_id, effective_from DESC`) — bez `created_at`, doslovno
   * kako view stoji (v. napomena u `vaziciUslov`).
   */
  private async trenutniUsloviPoZaposlenom() {
    const danas = this.dbDate(this.danasBeograd());
    const rows = await this.prisma.salaryTerm.findMany({
      where: {
        effectiveFrom: { lte: danas },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: danas } }],
      },
      orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }],
    });
    const map = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!map.has(r.employeeId)) map.set(r.employeeId, r);
    return map;
  }

  /**
   * `hr_upsert_salary_payroll(p_row jsonb)` — najveća funkcija oblasti (9.186
   * znakova). Dve putanje: INSERT (bez `id`) i UPDATE (sa `id`).
   *
   * PARITET KOJI SE MORA ZADRŽATI (svaki red je pinovan testom):
   *  - gejt `current_user_can_view_salary()` PRE svega ostalog,
   *  - INSERT: `ON CONFLICT (employee, year, month) DO NOTHING` ->
   *    `{applied:false, reason:'row_exists', existing_id, current_updated_at}`,
   *  - UPDATE nad nepostojećim id-om = greška (`02000`),
   *  - `status='paid'` -> `{applied:false, reason:'locked'}` BEZ izmene
   *    (brana `trg_0_salary_payroll_immutability` je druga linija, ne prva),
   *  - `expected_updated_at` mora da se poklopi; NULL ili razlika -> `'stale'`,
   *  - trka posle provere (0 ažuriranih redova) -> takođe `'stale'`,
   *  - zbirove (`total_rsd`, `total_eur`, `second_part_rsd`) NE računa servis
   *    nego triger `trg_salary_payroll_totals` u bazi.
   *
   * 🔴 ZATEČENO (ne popravljano — modul je zamrznut): `advance_paid_on` i
   * `final_paid_on` NISU pod `COALESCE`-om nego pod `NULLIF(...)::date`. Delimičan
   * upis koji ta dva ključa ne pošalje **BRIŠE** oba datuma, dok svako drugo polje
   * čuva staru vrednost. Tiho gubljenje datuma isplate.
   */
  async upsertSalaryPayroll(
    email: string | null | undefined,
    row: PayrollUpsertRow | null | undefined,
  ): Promise<PayrollUpsertResult> {
    await this.assertCanViewSalary(
      email,
      "Samo administrator može da menja obračun zarade.",
    );
    if (!row || typeof row !== "object") {
      throw new UnprocessableEntityException({
        error: { code: "invalid_payload", message: "invalid_payload" },
      });
    }

    const id = (row.id ?? "") === "" ? null : String(row.id);
    const expected =
      (row.expected_updated_at ?? "") === ""
        ? null
        : new Date(row.expected_updated_at as string | Date);

    // ── INSERT putanja ──────────────────────────────────────────────────────
    if (id === null) {
      const employeeId = String(row.employee_id);
      const year = Number(row.period_year);
      const month = Number(row.period_month);
      const postoji = await this.prisma.salaryPayroll.findUnique({
        where: {
          employeeId_periodYear_periodMonth: {
            employeeId,
            periodYear: year,
            periodMonth: month,
          },
        },
        select: { id: true, updatedAt: true },
      });
      if (postoji) {
        return {
          applied: false,
          reason: "row_exists",
          existing_id: postoji.id,
          current_updated_at: postoji.updatedAt,
        };
      }
      const created = await this.prisma.salaryPayroll.create({
        data: {
          employeeId,
          periodYear: year,
          periodMonth: month,
          salaryType: this.txt(row.salary_type, "ugovor") ?? "ugovor",
          compensationModel:
            (row.compensation_model ?? "") === ""
              ? null
              : String(row.compensation_model),
          advanceAmount: this.num(row.advance_amount, 0),
          advancePaidOn: this.optDate(row.advance_paid_on),
          advanceNote: this.txt(row.advance_note, "") ?? "",
          fixedSalary: this.num(row.fixed_salary, 0),
          hoursWorked: this.num(row.hours_worked, 0),
          hourlyRate: this.num(row.hourly_rate, 0),
          transportRsd: this.num(row.transport_rsd, 0),
          domesticDays: this.int(row.domestic_days, 0),
          perDiemRsd: this.num(row.per_diem_rsd, 0),
          foreignDays: this.int(row.foreign_days, 0),
          perDiemEur: this.num(row.per_diem_eur, 0),
          finalPaidOn: this.optDate(row.final_paid_on),
          status: this.txt(row.status, "draft") ?? "draft",
          note: this.txt(row.note, "") ?? "",
          fondSatiMeseca: this.num(row.fond_sati_meseca, 0),
          redovanRadSati: this.num(row.redovan_rad_sati, 0),
          prekovremeniSati: this.num(row.prekovremeni_sati, 0),
          praznikPlaceniSati: this.num(row.praznik_placeni_sati, 0),
          praznikRadSati: this.num(row.praznik_rad_sati, 0),
          godisnjiSati: this.num(row.godisnji_sati, 0),
          slobodniDaniSati: this.num(row.slobodni_dani_sati, 0),
          bolovanje65Sati: this.num(row.bolovanje_65_sati, 0),
          bolovanje100Sati: this.num(row.bolovanje_100_sati, 0),
          dveMasineSati: this.num(row.dve_masine_sati, 0),
          terenUZemljiCount: this.int(row.teren_u_zemlji_count, 0),
          terenUInostranstvuCount: this.int(row.teren_u_inostranstvu_count, 0),
          payableHours: this.num(row.payable_hours, 0),
          ukupnaZarada: this.num(row.ukupna_zarada, 0),
          prviDeo: this.num(row.prvi_deo, 0),
          preostaloZaIsplatu: this.num(row.preostalo_za_isplatu, 0),
          warnings: row.warnings ?? [],
        },
        select: {
          id: true,
          updatedAt: true,
          status: true,
          totalRsd: true,
          ukupnaZarada: true,
        },
      });
      return {
        applied: true,
        id: created.id,
        updated_at: created.updatedAt,
        status: created.status,
        total_rsd: created.totalRsd,
        ukupna_zarada: created.ukupnaZarada,
      };
    }

    // ── UPDATE putanja ──────────────────────────────────────────────────────
    const stari = await this.prisma.salaryPayroll.findUnique({ where: { id } });
    if (!stari) {
      throw new UnprocessableEntityException({
        error: {
          code: "salary_payroll_row_missing",
          message: "salary_payroll_row_missing",
        },
      });
    }
    if (stari.status === "paid") {
      return {
        applied: false,
        reason: "locked",
        current_updated_at: stari.updatedAt,
        current_status: "paid",
      };
    }
    if (
      expected === null ||
      stari.updatedAt === null ||
      stari.updatedAt.getTime() !== expected.getTime()
    ) {
      return {
        applied: false,
        reason: "stale",
        current_updated_at: stari.updatedAt,
      };
    }

    const res = await this.prisma.salaryPayroll.updateMany({
      where: { id, updatedAt: expected },
      data: {
        salaryType: this.txt(row.salary_type, stari.salaryType) ?? undefined,
        compensationModel:
          (row.compensation_model ?? "") === ""
            ? stari.compensationModel
            : String(row.compensation_model),
        advanceAmount: this.num(row.advance_amount, stari.advanceAmount),
        // 🔴 ZATEČENO: nema COALESCE — nedostajući ključ BRIŠE datum.
        advancePaidOn: this.optDate(row.advance_paid_on),
        advanceNote: this.txt(row.advance_note, stari.advanceNote),
        fixedSalary: this.num(row.fixed_salary, stari.fixedSalary),
        hoursWorked: this.num(row.hours_worked, stari.hoursWorked),
        hourlyRate: this.num(row.hourly_rate, stari.hourlyRate),
        transportRsd: this.num(row.transport_rsd, stari.transportRsd),
        domesticDays: this.int(row.domestic_days, stari.domesticDays),
        perDiemRsd: this.num(row.per_diem_rsd, stari.perDiemRsd),
        foreignDays: this.int(row.foreign_days, stari.foreignDays),
        perDiemEur: this.num(row.per_diem_eur, stari.perDiemEur),
        // 🔴 ZATEČENO: isto kao `advance_paid_on`.
        finalPaidOn: this.optDate(row.final_paid_on),
        status: this.txt(row.status, stari.status) ?? stari.status,
        note: this.txt(row.note, stari.note),
        fondSatiMeseca: this.num(row.fond_sati_meseca, stari.fondSatiMeseca),
        redovanRadSati: this.num(row.redovan_rad_sati, stari.redovanRadSati),
        prekovremeniSati: this.num(
          row.prekovremeni_sati,
          stari.prekovremeniSati,
        ),
        praznikPlaceniSati: this.num(
          row.praznik_placeni_sati,
          stari.praznikPlaceniSati,
        ),
        praznikRadSati: this.num(row.praznik_rad_sati, stari.praznikRadSati),
        godisnjiSati: this.num(row.godisnji_sati, stari.godisnjiSati),
        slobodniDaniSati: this.num(
          row.slobodni_dani_sati,
          stari.slobodniDaniSati,
        ),
        bolovanje65Sati: this.num(row.bolovanje_65_sati, stari.bolovanje65Sati),
        bolovanje100Sati: this.num(
          row.bolovanje_100_sati,
          stari.bolovanje100Sati,
        ),
        dveMasineSati: this.num(row.dve_masine_sati, stari.dveMasineSati),
        terenUZemljiCount: this.int(
          row.teren_u_zemlji_count,
          stari.terenUZemljiCount,
        ),
        terenUInostranstvuCount: this.int(
          row.teren_u_inostranstvu_count,
          stari.terenUInostranstvuCount,
        ),
        payableHours: this.num(row.payable_hours, stari.payableHours),
        ukupnaZarada: this.num(row.ukupna_zarada, stari.ukupnaZarada),
        prviDeo: this.num(row.prvi_deo, stari.prviDeo),
        preostaloZaIsplatu: this.num(
          row.preostalo_za_isplatu,
          stari.preostaloZaIsplatu,
        ),
        warnings:
          row.warnings === undefined || row.warnings === null
            ? (stari.warnings as Prisma.InputJsonValue)
            : (row.warnings as Prisma.InputJsonValue),
      },
    });

    if (res.count === 0) {
      const sada = await this.prisma.salaryPayroll.findUnique({
        where: { id },
        select: { updatedAt: true },
      });
      return {
        applied: false,
        reason: "stale",
        current_updated_at: sada?.updatedAt ?? null,
      };
    }

    const posle = await this.prisma.salaryPayroll.findUnique({
      where: { id },
      select: {
        updatedAt: true,
        status: true,
        totalRsd: true,
        ukupnaZarada: true,
      },
    });
    return {
      applied: true,
      id,
      updated_at: posle?.updatedAt ?? null,
      status: posle?.status ?? "",
      total_rsd: posle?.totalRsd ?? new Prisma.Decimal(0),
      ukupna_zarada: posle?.ukupnaZarada ?? new Prisma.Decimal(0),
    };
  }

  /**
   * `kadr_payroll_unlock(p_id)` — `paid` -> `finalized`.
   *
   * 🔴 MORA da radi u transakciji: `set_config('payroll.unlock_ok','on', true)`
   * je LOKALAN ZA TRANSAKCIJU i baš to brana `trg_0_salary_payroll_immutability`
   * čita. Van transakcije GUC bi otišao na drugu konekciju (ili ostao „on"
   * globalno) — prvo bi obrisalo bravu, drugo bi je otvorilo svima.
   * Idempotentno: red koji ne postoji ili nije `paid` daje `noop`, ne grešku.
   */
  async payrollUnlock(
    email: string | null | undefined,
    id: string,
  ): Promise<
    | {
        status: "unlocked";
        id: string;
        new_status: "finalized";
        updated_at: Date | null;
      }
    | { status: "noop"; id: string; reason: "not_paid_or_missing" }
  > {
    await this.assertCanViewSalary(
      email,
      "Samo administrator može da otključa mesec.",
    );
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('payroll.unlock_ok', 'on', true)`;
      const res = await tx.salaryPayroll.updateMany({
        where: { id, status: "paid" },
        data: { status: "finalized" },
      });
      if (res.count === 0) {
        return {
          status: "noop" as const,
          id,
          reason: "not_paid_or_missing" as const,
        };
      }
      const row = await tx.salaryPayroll.findUnique({
        where: { id },
        select: { updatedAt: true },
      });
      return {
        status: "unlocked" as const,
        id,
        new_status: "finalized" as const,
        updated_at: row?.updatedAt ?? null,
      };
    });
  }

  /**
   * `kadr_set_contract_salary(uuid, neto, bruto, effective_from, approved_by)`.
   *
   * PARITET (četiri ishoda, u ovom redosledu):
   *  1. `unchanged` — isti neto I bruto (zaokruženo na 2 decimale) kao na
   *     važećem redu; ako je stigao `approved_by` a stari je prazan, samo se
   *     dopisuje potpis (istorija se NE dira);
   *  2. `updated` — isti `effective_from` kao važeći red -> ispravka U MESTU;
   *  3. `created` (ima prethodni) — NOVI istorijski red, svi parametri obračuna
   *     se prenose sa prethodnog; `trg_salary_terms_close_prev` zatvara stari;
   *  4. `created` (nema prethodnog) — prvi unos: `ugovor` + model `fiksno`.
   *
   * `v_touch_amount` je namerno uzak: `amount` se prepisuje netom SAMO za
   * `ugovor`/`dogovor` u RSD, jer za `satnica`/devize `amount` znači nešto drugo.
   *
   * 🔴 ŠIRA brana (izmereno): `can_view_salary OR is_poslovni_admin`.
   */
  async setContractSalary(
    email: string | null | undefined,
    args: {
      employeeId: string;
      neto: number | string | Prisma.Decimal;
      bruto: number | string | Prisma.Decimal;
      effectiveFrom?: string | null;
      approvedBy?: string | null;
    },
  ): Promise<{ status: "unchanged" | "updated" | "created"; term_id: string }> {
    const dozvoljeno =
      (await this.canViewSalary(email)) || (await this.isPoslovniAdmin(email));
    if (!dozvoljeno) {
      throw new ForbiddenException({
        error: { code: "not_allowed", message: "not_allowed" },
      });
    }
    const emp = await this.prisma.employee.count({
      where: { id: args.employeeId },
    });
    if (emp === 0) {
      throw new UnprocessableEntityException({
        error: { code: "employee_not_found", message: "employee_not_found" },
      });
    }
    const neto = new Prisma.Decimal(args.neto);
    const bruto = new Prisma.Decimal(args.bruto);
    if (
      neto.lessThanOrEqualTo(0) ||
      bruto.lessThanOrEqualTo(0) ||
      bruto.lessThan(neto)
    ) {
      throw new UnprocessableEntityException({
        error: { code: "invalid_amount", message: "invalid_amount" },
      });
    }
    const from = this.dbDate(args.effectiveFrom ?? this.danasBeograd());
    const approvedBy = args.approvedBy ?? null;

    const prevRows = await this.prisma.salaryTerm.findMany({
      where: {
        employeeId: args.employeeId,
        effectiveFrom: { lte: from },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
      },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      take: 1,
    });
    const prev = prevRows[0] ?? null;

    // 1. Bez promene.
    if (
      prev &&
      (prev.netoRsd ?? new Prisma.Decimal(-1))
        .toDecimalPlaces(2)
        .equals(neto.toDecimalPlaces(2)) &&
      (prev.brutoRsd ?? new Prisma.Decimal(-1))
        .toDecimalPlaces(2)
        .equals(bruto.toDecimalPlaces(2))
    ) {
      if (approvedBy !== null && (prev.approvedBy ?? "") === "") {
        await this.prisma.salaryTerm.update({
          where: { id: prev.id },
          data: { approvedBy, approvedAt: from },
        });
      }
      return { status: "unchanged", term_id: prev.id };
    }

    const touchAmount =
      prev !== null &&
      MESECNI_TIPOVI.has(prev.salaryType) &&
      (prev.currency || "RSD") === "RSD";

    // 2. Isti „važi od" -> ispravka u mestu.
    if (prev && this.ymd(prev.effectiveFrom) === this.ymd(from)) {
      await this.prisma.salaryTerm.update({
        where: { id: prev.id },
        data: {
          amount: touchAmount ? neto : prev.amount,
          amountType: touchAmount ? "neto" : prev.amountType,
          netoRsd: neto,
          brutoRsd: bruto,
          approvedBy: approvedBy ?? prev.approvedBy,
          approvedAt: approvedBy !== null ? from : prev.approvedAt,
        },
      });
      return { status: "updated", term_id: prev.id };
    }

    // 3./4. Novi istorijski red.
    const created = prev
      ? await this.prisma.salaryTerm.create({
          data: {
            employeeId: args.employeeId,
            salaryType: prev.salaryType,
            compensationModel: prev.compensationModel,
            effectiveFrom: from,
            effectiveTo: null,
            amount: touchAmount ? neto : prev.amount,
            amountType: touchAmount ? "neto" : prev.amountType,
            currency: prev.currency || "RSD",
            hourlyRate: prev.hourlyRate,
            transportAllowanceRsd: prev.transportAllowanceRsd,
            perDiemRsd: prev.perDiemRsd,
            perDiemEur: prev.perDiemEur,
            fixedAmount: prev.fixedAmount,
            fixedTransportComponent: prev.fixedTransportComponent,
            fixedExtraHourRate: prev.fixedExtraHourRate,
            firstPartAmount: prev.firstPartAmount,
            splitHourRate: prev.splitHourRate,
            splitTransportAmount: prev.splitTransportAmount,
            hourlyTransportAmount: prev.hourlyTransportAmount,
            terrainDomesticRate: prev.terrainDomesticRate,
            terrainForeignRate: prev.terrainForeignRate,
            contractRef: prev.contractRef,
            note: "Izmena ugovorne zarade (forma zaposlenog)",
            netoRsd: neto,
            brutoRsd: bruto,
            approvedBy,
            approvedAt: approvedBy !== null ? from : null,
          },
          select: { id: true },
        })
      : await this.prisma.salaryTerm.create({
          data: {
            employeeId: args.employeeId,
            salaryType: "ugovor",
            compensationModel: "fiksno",
            effectiveFrom: from,
            amount: neto,
            amountType: "neto",
            currency: "RSD",
            note: "Ugovorna zarada (forma zaposlenog)",
            netoRsd: neto,
            brutoRsd: bruto,
            approvedBy,
            approvedAt: approvedBy !== null ? from : null,
          },
          select: { id: true },
        });
    return { status: "created", term_id: created.id };
  }

  /**
   * `kadr_queue_payroll_notifications(p_year, p_month)` — stavlja u red mejl i
   * WhatsApp poruku sa ZBIROM SATI (ne sa iznosom zarade) svakom aktivnom
   * zaposlenom koji ima upisane sate u tom mesecu. Vraća broj poruka.
   *
   * 🔴 ZATEČENO — DVA nalaza, oba prenesena kakva su (modul je zamrznut):
   *  a) funkcija NEMA NIJEDAN gejt prava, a `EXECUTE` je dat roli
   *     `authenticated` (izmereno). Kao `SECURITY DEFINER` znači da je u sy15
   *     SVAKI prijavljen korisnik mogao da pokrene masovno slanje. U 3.0 je
   *     jedina brana `@RequirePermission(KADROVSKA_MANAGE)` na ruti
   *     `POST notifications/payroll/run` — dakle brana je KOD POZIVAOCA, što je
   *     obrnuto od pravila. NIJE popravljano ovde: dodavanje gejta bi promenilo
   *     ponašanje (dorada), a i pravo bi se odnosilo na drugi krug rola nego što
   *     ruta danas dozvoljava. Popisano u izveštaju.
   *  b) nema dedup-a: dva poziva za isti mesec = DUPLE poruke svima. Ostali
   *     `kadr_schedule_*` poslovi imaju `IF EXISTS ... CONTINUE`, ovaj ne.
   *  c) 🔴🔴 **FUNKCIJA NIKAD NIJE PRORADILA.** `INSERT` ne navodi kolonu
   *     `related_entity_type`, a ona je `NOT NULL` **bez DEFAULT-a** (izmereno
   *     `information_schema.columns`, 08.08.2026). Prvi red zato pada sa
   *     `23502 not_null_violation`, cela transakcija se vraća i **nijedna
   *     poruka se ne upiše**. Dokaz iz podataka: `kadr_notification_log` ima 17
   *     različitih tipova i 1.336 redova, a `payroll_statement` **0**. Ruta
   *     `POST /kadrovska/notifications/payroll/run` dakle danas vraća 500.
   *
   *     ZATO PREPIS ČUVA TAJ ISHOD: zbirovi se izračunaju, poruke se sastave, i
   *     onda se baci ista greška — bez upisa. Popunjavanje kolone bi bilo
   *     „popravka" koja bi PRVI PUT u istoriji poslala mejl i WhatsApp poruku
   *     svakom aktivnom zaposlenom sa satima (152 aktivna) — to je odluka
   *     vlasnika, ne posao seobe (modul je zamrznut, §K).
   */
  async queuePayrollNotifications(
    year: number,
    month: number,
  ): Promise<number> {
    const od = this.dbDate(`${year}-${String(month).padStart(2, "0")}-01`);
    const doDatuma = this.dbDate(
      month === 12
        ? `${year + 1}-01-01`
        : `${year}-${String(month + 1).padStart(2, "0")}-01`,
    );

    const rows = await this.prisma.workHour.findMany({
      where: {
        workDate: { gte: od, lt: doDatuma },
        employee: { isActive: true },
      },
      select: {
        employeeId: true,
        workDate: true,
        hours: true,
        overtimeHours: true,
        fieldHours: true,
        twoMachineHours: true,
        employee: {
          select: {
            fullName: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
          },
        },
      },
    });

    interface Zbir {
      emp: (typeof rows)[number]["employee"];
      regular: Prisma.Decimal;
      overtime: Prisma.Decimal;
      field: Prisma.Decimal;
      twoMachine: Prisma.Decimal;
      dani: Set<string>;
    }
    const po = new Map<string, Zbir>();
    for (const r of rows) {
      let z = po.get(r.employeeId);
      if (!z) {
        z = {
          emp: r.employee,
          regular: new Prisma.Decimal(0),
          overtime: new Prisma.Decimal(0),
          field: new Prisma.Decimal(0),
          twoMachine: new Prisma.Decimal(0),
          dani: new Set(),
        };
        po.set(r.employeeId, z);
      }
      z.regular = z.regular.plus(r.hours);
      z.overtime = z.overtime.plus(r.overtimeHours);
      z.field = z.field.plus(r.fieldHours);
      z.twoMachine = z.twoMachine.plus(r.twoMachineHours);
      // `COUNT(DISTINCT wh.work_date)` — u sy15 je uvek 1 red po (emp, dan),
      // ali DISTINCT je preneto doslovno.
      z.dani.add(this.ymd(r.workDate));
    }

    const label = this.mesecGodina(year, month);
    const poslato = 0;
    for (const [employeeId, z] of po) {
      const ime =
        z.emp.fullName ||
        [z.emp.firstName, z.emp.lastName].filter(Boolean).join(" ") ||
        "Zaposleni";
      const total = z.regular.plus(z.overtime);
      const subject = `Obračun sati za ${label} — ${ime}`;
      // `jsonb_build_object(...)` sa numeric vrednostima -> JSON BROJEVI, ne
      // stringovi (payload čita dispečer, pa se tip mora poklopiti).
      const payload = {
        period_year: year,
        period_month: month,
        regular_hours: z.regular.toNumber(),
        overtime_hours: z.overtime.toNumber(),
        field_hours: z.field.toNumber(),
        two_machine_hours: z.twoMachine.toNumber(),
        work_days: z.dani.size,
      };
      const fieldRow = z.field.greaterThan(0)
        ? '<tr><td style="padding:7px 14px;border:1px solid #e2e8f0;">Terenska</td>' +
          '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;">' +
          `${this.satiTxt(z.field)}h</td></tr>`
        : "";
      const emailBody =
        '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">' +
        `<h2 style="color:#2563eb;margin-bottom:4px;">📋 Obračun sati — ${label}</h2>` +
        `<p>Poštovani/a <strong>${ime}</strong>,</p>` +
        `<p>Ovde je pregled Vaše evidencije radnih sati za <strong>${label}</strong>:</p>` +
        '<table style="border-collapse:collapse;margin:14px 0;width:100%;max-width:380px;">' +
        '<tr style="background:#eff6ff;">' +
        '<td style="padding:8px 14px;border:1px solid #dbeafe;"><strong>Redovni sati</strong></td>' +
        '<td style="padding:8px 14px;border:1px solid #dbeafe;text-align:right;font-weight:700;">' +
        `${this.satiTxt(z.regular)}h</td>` +
        "</tr>" +
        "<tr>" +
        '<td style="padding:7px 14px;border:1px solid #e2e8f0;">Prekovremeni</td>' +
        '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;">' +
        `${this.satiTxt(z.overtime)}h</td>` +
        "</tr>" +
        fieldRow +
        '<tr style="background:#f8fafc;border-top:2px solid #94a3b8;">' +
        '<td style="padding:8px 14px;border:1px solid #cbd5e1;"><strong>Ukupno</strong></td>' +
        '<td style="padding:8px 14px;border:1px solid #cbd5e1;text-align:right;font-weight:700;">' +
        `${this.satiTxt(total)}h</td>` +
        "</tr>" +
        "<tr>" +
        '<td style="padding:7px 14px;border:1px solid #e2e8f0;font-size:.9em;color:#64748b;">Radnih dana</td>' +
        '<td style="padding:7px 14px;border:1px solid #e2e8f0;text-align:right;font-size:.9em;color:#64748b;">' +
        `${z.dani.size}</td>` +
        "</tr>" +
        "</table>" +
        '<p style="font-size:.88em;color:#64748b;">Ukoliko imate pitanja u vezi sa ovom evidencijom, obratite se HR odeljenju.</p>' +
        '<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;">' +
        '<p style="font-size:.85em;color:#64748b;">Srdačan pozdrav,<br><em>HR odeljenje — Servoteh</em></p>' +
        "</div>";
      const waBody =
        `Obračun sati za ${label}: redovni ${this.satiTxt(z.regular)}h` +
        `, prekovremeni ${this.satiTxt(z.overtime)}h` +
        (z.field.greaterThan(0) ? `, terenska ${this.satiTxt(z.field)}h` : "") +
        ` (ukupno ${this.satiTxt(total)}h). ` +
        "Za pitanja kontaktujte HR. — Servoteh";

      const biUpisano =
        ((z.emp.email ?? "") !== "" ? 1 : 0) +
        ((z.emp.phone ?? "") !== "" ? 1 : 0);
      if (biUpisano === 0) continue;

      // 🔴 TAČKA U KOJOJ sy15 PADNE (23502) — v. nalaz (c) iznad. Prvi red koji
      // bi se upisao ruši celu transakciju, pa NIJEDNA poruka ne ostaje.
      // `poslato`/`emailBody`/`waBody`/`payload` su izračunati da bi se videlo
      // da je prepis pun, a ne prazna ljuska; upis se NE izvodi.
      void emailBody;
      void waBody;
      void payload;
      void subject;
      void employeeId;
      this.logger.error(
        `kadr_queue_payroll_notifications(${year}, ${month}): sy15 funkcija pada na ` +
          "prvom upisu jer `kadr_notification_log.related_entity_type` je NOT NULL bez " +
          "DEFAULT-a, a INSERT je ne navodi. Prepis čuva taj ishod (0 poruka). " +
          "Uključivanje je ODLUKA VLASNIKA — prvi mejl bi otišao svim zaposlenima.",
      );
      throw new UnprocessableEntityException({
        error: {
          code: "payroll_notifications_not_null_violation",
          message:
            "kadr_notification_log.related_entity_type je NOT NULL bez DEFAULT-a — " +
            "obaveštenja o obračunu sati nikada nisu radila (0 redova tipa " +
            "payroll_statement). Zatečeno stanje, ne popravlja se dok je modul " +
            "zamrznut (docs/OTVORENI_POSLOVI.md §K).",
        },
      });
    }
    return poslato;
  }

  /** `to_char(make_date(y,m,1), 'TMMonth YYYY')` uz srpski naziv meseca. */
  private mesecGodina(year: number, month: number): string {
    const MESECI = [
      "Januar",
      "Februar",
      "Mart",
      "April",
      "Maj",
      "Jun",
      "Jul",
      "Avgust",
      "Septembar",
      "Oktobar",
      "Novembar",
      "Decembar",
    ];
    return `${MESECI[month - 1] ?? String(month)} ${year}`;
  }

  // ==========================================================================
  // PRISUSTVO — 491.271 red, Katze most piše UŽIVO
  // ==========================================================================

  /**
   * `hr_upsert_work_hours_batch(p_rows jsonb)` — mesečni grid.
   *
   * PARITET:
   *  - gejt `can_edit_kadrovska_grid()` (allowlist, 5 mejlova) — 42501,
   *  - `p_rows` mora biti ARRAY (`22023`),
   *  - `field_subtype` van {domestic, foreign} se TIHO baca na NULL (ne greška),
   *  - prazan `absence_code`/`absence_subtype` -> NULL (`NULLIF(...,'')`),
   *  - `ON CONFLICT (employee_id, work_date) DO UPDATE` — pun set kolona,
   *  - `last_edited_by = current_user_email()`,
   *  - odgovor je `{applied, conflicts: []}`.
   *
   * 🔴 ZATEČENO (ne popravljano): `conflicts` je UVEK prazan niz — ime obećava
   * detekciju sudara koje u telu funkcije NEMA. Nema ni optimističke provere
   * (za razliku od `hr_upsert_salary_payroll`), pa dva urednika gride tiho gaze
   * jedan drugog: pobeđuje ko je poslednji poslao.
   * 🔴 ZATEČENO: `EXECUTE` na ovoj MUTIRAJUĆOJ funkciji ima i rola `anon`
   * (izmereno). Bez tokena gejt vrati false i funkcija padne sa 42501, pa nema
   * probijanja — ali grant je nepotreban i ostaje popisan.
   */
  async upsertWorkHoursBatch(
    email: string | null | undefined,
    rows: WorkHoursBatchRow[] | null | undefined,
  ): Promise<{ applied: number; conflicts: unknown[] }> {
    if (!(await this.canEditKadrovskaGrid(email))) {
      throw new ForbiddenException({
        error: {
          code: "permission_denied",
          message: "Samo ovlašćeni unos sati (mesečni grid).",
        },
      });
    }
    if (!Array.isArray(rows)) {
      throw new UnprocessableEntityException({
        error: {
          code: "invalid_payload",
          message: "p_rows mora biti JSONB array.",
        },
      });
    }
    const editor = this.norm(email);
    let applied = 0;
    for (const r of rows) {
      const fieldSubtype =
        r.field_subtype && FIELD_SUBTYPES.has(r.field_subtype)
          ? r.field_subtype
          : null;
      const absenceCode = (r.absence_code ?? "") === "" ? null : r.absence_code;
      const absenceSubtype =
        (r.absence_subtype ?? "") === "" ? null : r.absence_subtype;
      const data = {
        hours: this.num(r.hours, 0),
        overtimeHours: this.num(r.overtime_hours, 0),
        fieldHours: this.num(r.field_hours, 0),
        fieldSubtype,
        twoMachineHours: this.num(r.two_machine_hours, 0),
        absenceCode,
        absenceSubtype,
        note: this.txt(r.note, "") ?? "",
        projectRef: this.txt(r.project_ref, "") ?? "",
        lastEditedBy: editor,
      };
      await this.prisma.workHour.upsert({
        where: {
          employeeId_workDate: {
            employeeId: r.employee_id,
            workDate: this.dbDate(r.work_date),
          },
        },
        create: {
          employeeId: r.employee_id,
          workDate: this.dbDate(r.work_date),
          ...data,
        },
        update: data,
      });
      applied += 1;
    }
    return { applied, conflicts: [] };
  }

  /**
   * `kadr_work_hours_audit(emp, from, to, limit)` — istorija izmena sati.
   *
   * PARITET: gejt `can_edit_kadrovska_grid() OR current_user_is_admin()`;
   * `limit` se steže na `least(greatest(coalesce(limit,300),1),1000)`; redosled
   * `changed_at DESC`.
   *
   * 🔴 IZVOR AUDITA NIJE PRENET: u sy15 red puni triger `audit_row_change()` na
   * `work_hours`, koji migracija NAMERNO ne prenosi (§6b, blokada 5). Zato pod
   * `3.0` odgovor ostaje PRAZAN dok blokada 5 ne padne — i to je izričito
   * naznačeno kroz `auditIzvorPrenet`, da prazna lista ne prođe kao „nije bilo
   * izmena". Upis audita se ovde NE dodaje: to bi bio drugi, paralelan izvor
   * istine uz onaj koji blokada 5 tek treba da napravi.
   */
  async workHoursAudit(
    email: string | null | undefined,
    filter: {
      employeeId?: string | null;
      dateFrom?: string | null;
      dateTo?: string | null;
      limit?: number | null;
    } = {},
  ): Promise<{
    auditIzvorPrenet: boolean;
    rows: {
      id: number;
      action: string;
      actorEmail: string | null;
      changedAt: Date;
      employeeId: string | null;
      workDate: string | null;
      oldData: unknown;
      newData: unknown;
      diffKeys: string[];
    }[];
  }> {
    const dozvoljeno =
      (await this.canEditKadrovskaGrid(email)) || (await this.isAdmin(email));
    if (!dozvoljeno) {
      throw new ForbiddenException({
        error: {
          code: "permission_denied",
          message:
            "Istorija sati je dostupna samo ovlašćenima za mesečni grid.",
        },
      });
    }
    const limit = Math.min(Math.max(filter.limit ?? 300, 1), 1000);
    // Signal „izvor audita postoji" NE zavisi od filtera: bez njega bi prazan
    // rezultat uskog filtera izgledao kao neprenet izvor, i obrnuto.
    const ukupno = await this.prisma.auditLog.count({
      where: { entityType: "work_hours" },
    });
    if (ukupno === 0) {
      this.logger.warn(
        "kadr_work_hours_audit: `audit_log` nema NIJEDAN red za `work_hours` — " +
          "triger `audit_row_change()` nije prenet (migracija §6b, blokada 5). " +
          "Prazan odgovor NIJE dokaz da izmena nije bilo.",
      );
    }
    const logovi = await this.prisma.auditLog.findMany({
      where: { entityType: "work_hours" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const izlaz: {
      id: number;
      action: string;
      actorEmail: string | null;
      changedAt: Date;
      employeeId: string | null;
      workDate: string | null;
      oldData: unknown;
      newData: unknown;
      diffKeys: string[];
    }[] = [];
    for (const l of logovi) {
      const nov = (l.afterData ?? null) as Record<string, unknown> | null;
      const star = (l.beforeData ?? null) as Record<string, unknown> | null;
      const empId =
        this.jsonStr(nov?.employee_id) ?? this.jsonStr(star?.employee_id);
      const workDate =
        this.jsonStr(nov?.work_date) ?? this.jsonStr(star?.work_date);
      if (filter.employeeId && empId !== filter.employeeId) continue;
      if (filter.dateFrom && (workDate ?? "") < filter.dateFrom) continue;
      if (filter.dateTo && (workDate ?? "") > filter.dateTo) continue;
      izlaz.push({
        id: l.id,
        action: l.action,
        actorEmail: l.actorUsername,
        changedAt: l.createdAt,
        employeeId: empId,
        workDate,
        oldData: star,
        newData: nov,
        diffKeys: this.diffKeys(star, nov),
      });
    }
    return { auditIzvorPrenet: ukupno > 0, rows: izlaz };
  }

  private jsonStr(v: unknown): string | null {
    return typeof v === "string" && v !== "" ? v : null;
  }

  /** `diff_keys` je u sy15 računao triger; ovde se izvodi iz before/after. */
  private diffKeys(
    star: Record<string, unknown> | null,
    nov: Record<string, unknown> | null,
  ): string[] {
    if (!star || !nov) return [];
    const out: string[] = [];
    for (const k of Object.keys(nov)) {
      if (JSON.stringify(star[k]) !== JSON.stringify(nov[k])) out.push(k);
    }
    return out.sort();
  }

  /**
   * `attendance_submit_correction(emp, day, in, out, reason)` — ručna korekcija
   * kapije. Upisuje 1–2 `attendance_events` reda (`source='manual'`) + red u
   * `attendance_corrections` + mejl šefu i dopunskim primaocima.
   *
   * PARITET (redosled provera je BITAN — prva koja padne vraća svoj kod):
   *  1. obrazloženje < 5 znakova (posle trim) -> `obrazlozenje_obavezno`,
   *  2. ni ulaz ni izlaz -> `nema_vremena`,
   *  3. `in >= out` -> `ulaz_posle_izlaza`,
   *  4. prava: SVOJ red (poklapanje `employees.email`) ILI `managesEmployee`
   *     ILI `isHrOrAdmin` -> inače `nema_prava`,
   *  5. dan u budućnosti -> `buducnost`,
   *  6. ne-HR i dan stariji od 3 dana -> `prekasno`,
   *  7. nepoznat/neaktivan zaposleni -> `nepoznat_zaposleni`,
   *  8. već postoji `active` korekcija za taj dan -> `vec_korigovano`,
   *  9. `ulaz_postoji` / `izlaz_postoji` po stanju kapije toga dana.
   *
   * Sve neuspešne grane vraćaju `{ok:false, error}` — NE bacaju izuzetak (izvor
   * ne baca). Uspeh: `{ok:true, correction_id, employee_name}`.
   *
   * PRELAZNI REŽIM (Katze most): metoda čita SAMO dan koji se koriguje i ne
   * pretpostavlja potpunost niza — dok most piše u sy15, u 3.0 taj dan može
   * imati manje događaja, pa `ulaz_postoji` može da propusti korekciju koju bi
   * sy15 odbio. Zato se most preusmerava ISTOG DANA kad prekidač pređe
   * (runbook §5.3); dotle se ova putanja ne poziva jer prekidač stoji na `sy15`.
   */
  async submitAttendanceCorrection(
    email: string | null | undefined,
    args: {
      employeeId: string;
      day: string;
      in?: string | null;
      out?: string | null;
      reason?: string | null;
    },
    now: Date = new Date(),
  ): Promise<
    | { ok: true; correction_id: string; employee_name: string }
    | { ok: false; error: string }
  > {
    const caller = this.norm(email);
    const reason = (args.reason ?? "").trim();
    if (reason.length < 5) return { ok: false, error: "obrazlozenje_obavezno" };
    const pIn = (args.in ?? "") === "" ? null : this.dbTime(args.in as string);
    const pOut =
      (args.out ?? "") === "" ? null : this.dbTime(args.out as string);
    if (pIn === null && pOut === null)
      return { ok: false, error: "nema_vremena" };
    if (pIn && pOut && pIn.getTime() >= pOut.getTime()) {
      return { ok: false, error: "ulaz_posle_izlaza" };
    }

    const isSelf =
      caller !== "" &&
      (await this.prisma.employee.count({
        where: {
          id: args.employeeId,
          email: { equals: caller, mode: "insensitive" },
          NOT: { email: "" },
        },
      })) > 0;
    const isMgr = await this.managesEmployee(email, args.employeeId);
    const isHr = await this.isHrOrAdmin(email);
    if (!(isSelf || isMgr || isHr)) return { ok: false, error: "nema_prava" };

    const today = this.danasBeograd(now);
    if (args.day > today) return { ok: false, error: "buducnost" };
    if (!isHr && args.day < this.plusDana(today, -3)) {
      return { ok: false, error: "prekasno" };
    }

    const emp = await this.prisma.employee.findFirst({
      where: { id: args.employeeId, isActive: true },
      select: { fullName: true },
    });
    if (!emp) return { ok: false, error: "nepoznat_zaposleni" };

    const aktivna = await this.prisma.attendanceCorrection.count({
      where: {
        employeeId: args.employeeId,
        day: this.dbDate(args.day),
        status: "active",
      },
    });
    if (aktivna > 0) return { ok: false, error: "vec_korigovano" };

    // `v_has_in` je u izvoru SIROV `EXISTS` nad `attendance_events` (bez dedup-a
    // iz view-a), a `v_open` dolazi IZ view-a — preneto tačno tako.
    const hasIn = await this.imaUlazTogDana(args.employeeId, args.day);
    const dnevni = await this.attendanceDaily(args.employeeId, args.day);
    const open = dnevni?.openIntervals ?? 0;
    if (pIn !== null && hasIn) return { ok: false, error: "ulaz_postoji" };
    if (pOut !== null && hasIn && open === 0) {
      return { ok: false, error: "izlaz_postoji" };
    }

    const corrId = randomUUID();
    const eventIds: bigint[] = [];
    if (pIn !== null) {
      const ev = await this.prisma.attendanceEvent.create({
        data: {
          source: "manual",
          externalId: `corr-${corrId}-in`,
          employeeId: args.employeeId,
          eventTsLocal: this.danPlusVreme(args.day, pIn),
          eventTs: this.lokalnoUUtc(args.day, pIn),
          direction: "in",
          terminalName: "Korekcija",
          raw: { correction_id: corrId, reason, entered_by: caller },
        },
        select: { id: true },
      });
      eventIds.push(ev.id);
    }
    if (pOut !== null) {
      const ev = await this.prisma.attendanceEvent.create({
        data: {
          source: "manual",
          externalId: `corr-${corrId}-out`,
          employeeId: args.employeeId,
          eventTsLocal: this.danPlusVreme(args.day, pOut),
          eventTs: this.lokalnoUUtc(args.day, pOut),
          direction: "out",
          terminalName: "Korekcija",
          raw: { correction_id: corrId, reason, entered_by: caller },
        },
        select: { id: true },
      });
      eventIds.push(ev.id);
    }

    await this.prisma.attendanceCorrection.create({
      data: {
        id: corrId,
        employeeId: args.employeeId,
        day: this.dbDate(args.day),
        correctedIn: pIn,
        correctedOut: pOut,
        reason,
        createdBy: caller,
        createdForSelf: isSelf,
        eventIds,
      },
    });

    const primaoci = new Set<string>([
      ...(await this.oversightSefRecipients(args.employeeId)),
      ...(await this.extraRecipients(args.employeeId)),
    ]);
    primaoci.delete(caller);
    const dan = this.ddmmyyyy(args.day);
    const ulazTxt = pIn ? `Ulaz: <strong>${this.hhmm(pIn)}</strong> ` : "";
    const izlazTxt = pOut ? `Izlaz: <strong>${this.hhmm(pOut)}</strong>` : "";
    for (const rec of primaoci) {
      await this.prisma.kadrNotificationLog.create({
        data: {
          channel: "email",
          recipient: rec,
          subject: `Korekcija prisustva — ${emp.fullName} (${dan})`,
          body:
            '<div style="font-family:sans-serif;max-width:560px">' +
            '<h3 style="color:#b7791f">✎ Korekcija prisustva</h3>' +
            `<p><strong>${emp.fullName}</strong> — ${dan}</p>` +
            `<p>${ulazTxt}${izlazTxt}</p>` +
            `<p>Obrazloženje: <em>${reason}</em></p>` +
            `<p style="color:#666;font-size:13px">Uneo: ${caller}` +
            (isSelf ? " (za sebe)" : " (u ime radnika)") +
            "</p>" +
            '<p style="color:#666;font-size:13px">Korekciju možete poništiti u aplikaciji (Moj profil › Moj tim / Kadrovska › Prisustvo).</p>' +
            '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
          relatedEntityType: "attendance_correction",
          relatedEntityId: corrId,
          employeeId: args.employeeId,
          notificationType: "attendance_correction",
          status: "queued",
          payload: { work_date: args.day, correction_id: corrId },
        },
      });
    }

    return { ok: true, correction_id: corrId, employee_name: emp.fullName };
  }

  /**
   * `attendance_cancel_correction(p_correction_id)` — poništava korekciju i
   * BRIŠE događaje koje je ona upisala.
   *
   * PARITET: nepoznata -> `nepoznata_korekcija`; ne-`active` -> `vec_ponistena`;
   * prava `managesEmployee OR isHrOrAdmin` (🔴 **NE** i „svoja" — radnik ne može
   * da poništi svoju korekciju, iako je smeo da je unese) -> `nema_prava`.
   */
  async cancelAttendanceCorrection(
    email: string | null | undefined,
    correctionId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const corr = await this.prisma.attendanceCorrection.findUnique({
      where: { id: correctionId },
      select: { id: true, status: true, employeeId: true, eventIds: true },
    });
    if (!corr) return { ok: false, error: "nepoznata_korekcija" };
    if (corr.status !== "active") return { ok: false, error: "vec_ponistena" };
    const dozvoljeno =
      (await this.managesEmployee(email, corr.employeeId)) ||
      (await this.isHrOrAdmin(email));
    if (!dozvoljeno) return { ok: false, error: "nema_prava" };

    await this.prisma.attendanceEvent.deleteMany({
      where: { id: { in: corr.eventIds } },
    });
    await this.prisma.attendanceCorrection.update({
      where: { id: correctionId },
      data: {
        status: "cancelled",
        cancelledBy: this.norm(email),
        cancelledAt: new Date(),
      },
    });
    return { ok: true };
  }

  /**
   * `kiosk_record_punch(p_token, p_direction)` — QR kiosk terminal.
   * 🔴 ISPRAVKA MAPE: funkcija ima 2.629 znakova (mapa je tvrdila 0).
   *
   * PARITET:
   *  - token < 4 znaka (posle trim) -> `prazan_token`,
   *  - aktivan `qr` badge (`valid_to` NULL ili u budućnosti) -> inače `nepoznat_qr`,
   *  - neaktivan zaposleni -> `neaktivan_zaponeli`… (kod je `neaktivan_zaposleni`),
   *  - DEDUP: bilo koji događaj tog čoveka u zadnjih **30 s** -> `{ok:true,
   *    duplicate:true}` i NE upisuje se novi red,
   *  - smer: `p_direction` ('in'/'out') ima prednost; inače se izvodi iz
   *    POSLEDNJEG DANAŠNJEG događaja: `in|break|official_out` -> 'out', inače 'in'
   *    (dakle prvi prolaz u danu je uvek 'in'),
   *  - `source='kiosk'`, `external_id='kiosk-'||uuid`, `terminal_name='Kiosk kapija'`.
   *
   * `event_ts` puni triger `trg_attendance_fill_ts` iz `event_ts_local`
   * (runbook nalaz 5 — smer je OBRNUT od očekivanog); ovde se ipak popunjava
   * eksplicitno jer je kolona NOT NULL, i to ISTOM formulom.
   */
  async kioskRecordPunch(
    token: string | null | undefined,
    direction?: string | null,
    now: Date = new Date(),
  ): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        duplicate?: true;
        employee_name: string;
        direction: string | null;
        time: string | null;
      }
  > {
    const kod = (token ?? "").trim();
    if (kod.length < 4) return { ok: false, error: "prazan_token" };

    const badge = await this.prisma.employeeBadge.findFirst({
      where: {
        badgeType: "qr",
        code: kod,
        isActive: true,
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      select: { employeeId: true },
    });
    if (!badge) return { ok: false, error: "nepoznat_qr" };

    const emp = await this.prisma.employee.findFirst({
      where: { id: badge.employeeId, isActive: true },
      select: { fullName: true },
    });
    if (!emp) return { ok: false, error: "neaktivan_zaposleni" };

    const p = belgradeParts(now);
    const dan = this.danasBeograd(now);
    const nowLocal = new Date(
      `${dan}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}Z`,
    );

    const poslednji = await this.prisma.attendanceEvent.findFirst({
      where: { employeeId: badge.employeeId },
      orderBy: { eventTs: "desc" },
      select: { direction: true, eventTs: true },
    });
    if (poslednji && now.getTime() - poslednji.eventTs.getTime() < 30_000) {
      return {
        ok: true,
        duplicate: true,
        employee_name: emp.fullName,
        direction: poslednji.direction,
        time: this.hhmm(this.utcUlokalno(poslednji.eventTs)),
      };
    }

    let smer: string;
    if (direction === "in" || direction === "out") {
      smer = direction;
    } else {
      // `CASE WHEN v_last_dir IN ('in','break','official_out') THEN 'out'
      //       ELSE 'in' END` — NULL (prvi prolaz u danu) pada u ELSE, dakle 'in'.
      const danasnji = await this.poslednjiDanasnji(badge.employeeId, dan);
      smer =
        danasnji === "in" || danasnji === "break" || danasnji === "official_out"
          ? "out"
          : "in";
    }

    await this.prisma.attendanceEvent.create({
      data: {
        source: "kiosk",
        externalId: `kiosk-${randomUUID()}`,
        badgeCode: kod,
        employeeId: badge.employeeId,
        eventTsLocal: nowLocal,
        eventTs: now,
        direction: smer,
        terminalName: "Kiosk kapija",
        raw: { via: "qr-kiosk" },
      },
    });
    return {
      ok: true,
      employee_name: emp.fullName,
      direction: smer,
      time: this.hhmm(nowLocal),
    };
  }

  /**
   * `EXISTS (... AND ae.event_ts_local::date = p_day AND ae.direction = 'in')`
   * — sirova provera bez dedup-a iz `v_attendance_daily`.
   */
  private async imaUlazTogDana(
    employeeId: string,
    dan: string,
  ): Promise<boolean> {
    const { od, doVremena } = this.utcOkvirDana(dan);
    const rows = await this.prisma.attendanceEvent.findMany({
      where: {
        employeeId,
        direction: "in",
        eventTs: { gte: od, lt: doVremena },
      },
      select: { eventTsLocal: true },
    });
    return rows.some((r) => r.eventTsLocal && this.ymd(r.eventTsLocal) === dan);
  }

  /** Smer poslednjeg DANAŠNJEG događaja (`ORDER BY event_ts DESC LIMIT 1`). */
  private async poslednjiDanasnji(
    employeeId: string,
    dan: string,
  ): Promise<string | null> {
    const { od, doVremena } = this.utcOkvirDana(dan);
    const rows = await this.prisma.attendanceEvent.findMany({
      where: { employeeId, eventTs: { gte: od, lt: doVremena } },
      orderBy: { eventTs: "desc" },
      select: { direction: true, eventTsLocal: true },
    });
    for (const r of rows) {
      if (r.eventTsLocal && this.ymd(r.eventTsLocal) === dan) {
        return r.direction;
      }
    }
    return null;
  }

  /**
   * `attendance_katze_max_idreg()` — vodeni žig Katze mosta.
   * 🔴 ISPRAVKA MAPE: funkcija NIJE `SECURITY DEFINER` (`prosecdef = false`).
   * Vraća `COALESCE(MAX(external_id::bigint), 0)` nad `source IN ('katze',
   * 'katze_manual')`. Most je po ovom žigu SAMOOPORAVLJIV: čim počne da piše u
   * 3.0, pokupi sve što je propustio (runbook §5.3).
   */
  async katzeMaxIdreg(): Promise<bigint> {
    const rows = await this.prisma.$queryRaw<{ max: bigint | null }[]>`
      SELECT COALESCE(MAX(external_id::bigint), 0) AS max
        FROM attendance_events
       WHERE source IN ('katze', 'katze_manual')`;
    return rows[0]?.max ?? 0n;
  }

  // --------------------------------------------------------------------------
  // v_attendance_daily — prepis view-a
  // --------------------------------------------------------------------------

  /** UTC okvir jednog LOKALNOG dana (za indeksirano čitanje po `event_ts`). */
  private utcOkvirDana(dan: string): { od: Date; doVremena: Date } {
    const [y, m, d] = dan.split("-").map(Number);
    const sledeci = shiftBelgradeDate({ year: y, month: m, day: d }, 1);
    return {
      od: belgradeTimeToUtc(y, m, d, 0, 0),
      doVremena: belgradeTimeToUtc(
        sledeci.year,
        sledeci.month,
        sledeci.day,
        0,
        0,
      ),
    };
  }

  /** `event_ts_local` iz lokalnog dana + vremena -> UTC trenutak (`event_ts`). */
  private lokalnoUUtc(dan: string, vreme: Date): Date {
    const [y, m, d] = dan.split("-").map(Number);
    const hh = Number(vreme.toISOString().slice(11, 13));
    const mm = Number(vreme.toISOString().slice(14, 16));
    return belgradeTimeToUtc(y, m, d, hh, mm);
  }

  /** UTC trenutak -> „lokalni zapis" kao Date (za `hhmm`). */
  private utcUlokalno(at: Date): Date {
    const p = belgradeParts(at);
    return new Date(
      Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second),
    );
  }

  /**
   * Jedan red `v_attendance_daily` za (zaposleni, dan). `null` = dan bez ijednog
   * upotrebljivog događaja (view tada NE VRAĆA red — nije nula, nego odsustvo
   * reda; `attendance_submit_correction` se na to naslanja).
   */
  async attendanceDaily(
    employeeId: string,
    dan: string,
  ): Promise<AttendanceDailyRow | null> {
    const { od, doVremena } = this.utcOkvirDana(dan);
    const rows = await this.prisma.attendanceEvent.findMany({
      where: {
        employeeId,
        eventTs: { gte: od, lt: doVremena },
        NOT: { direction: "unknown" },
      },
      select: {
        id: true,
        employeeId: true,
        eventTsLocal: true,
        direction: true,
      },
    });
    const events = this.pripremiEvente(rows, dan);
    const map = racunajDnevnoPrisustvo(events);
    return map.get(`${employeeId}|${dan}`) ?? null;
  }

  /** Svi redovi `v_attendance_daily` za jedan dan (dnevni poslovi). */
  async attendanceDailyForDay(
    dan: string,
  ): Promise<Map<string, AttendanceDailyRow>> {
    const { od, doVremena } = this.utcOkvirDana(dan);
    const rows = await this.prisma.attendanceEvent.findMany({
      where: {
        eventTs: { gte: od, lt: doVremena },
        NOT: { direction: "unknown" },
        employeeId: { not: null },
      },
      select: {
        id: true,
        employeeId: true,
        eventTsLocal: true,
        direction: true,
      },
    });
    return racunajDnevnoPrisustvo(this.pripremiEvente(rows, dan));
  }

  /**
   * `WHERE employee_id IS NOT NULL AND event_ts_local IS NOT NULL AND
   * direction <> 'unknown'` + provera da je LOKALNI dan traženi (UTC okvir ume
   * da zahvati sat sa ivice zbog DST-a).
   */
  private pripremiEvente(
    rows: {
      id: bigint;
      employeeId: string | null;
      eventTsLocal: Date | null;
      direction: string;
    }[],
    dan: string,
  ): PunchEvent[] {
    const out: PunchEvent[] = [];
    for (const r of rows) {
      if (!r.employeeId || !r.eventTsLocal) continue;
      if (this.ymd(r.eventTsLocal) !== dan) continue;
      out.push({
        id: r.id,
        employeeId: r.employeeId,
        eventTsLocal: r.eventTsLocal,
        direction: r.direction,
      });
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // Scheduler poslovi prisustva
  // --------------------------------------------------------------------------

  /**
   * `kadr_schedule_attendance_alerts()` — posao `kadr-attendance-alerts`.
   *
   * PARITET:
   *  - 🔴 SOPSTVENI SAT-GEJT: radi SAMO kad je lokalni sat **6**; svaki drugi
   *    poziv je `RETURN` bez ikakvog efekta (posao se u schedulera zove češće),
   *  - dan = JUČE po Beogradu,
   *  - dva problema: `nema_izlaz` (otvoren interval, a nema `absence_code`) i
   *    `nema_prolaza` (sati u gridu > 0, terenskih 0, bez odsustva, nula
   *    prolaza tog dana, ALI je bio prolaz u prethodnih 7 dana — dakle kartica
   *    nije mrtva),
   *  - primaoci: šefovi iz sistematizacije (`role_label='sef'`) + dopunski, oba
   *    bez samog radnika, PLUS radnik (drugi tekst mejla),
   *  - dedup: postoji li već `attendance_missing_punch` za (radnik, primalac,
   *    `payload.work_date`) — ako da, preskoči.
   */
  async scheduleAttendanceAlerts(now: Date = new Date()): Promise<number> {
    const p = belgradeParts(now);
    if (p.hour !== 6) return 0;
    const dan = this.plusDana(this.danasBeograd(now), -1);

    const dnevni = await this.attendanceDailyForDay(dan);
    const sati = await this.prisma.workHour.findMany({
      where: { workDate: this.dbDate(dan) },
      select: {
        employeeId: true,
        hours: true,
        fieldHours: true,
        absenceCode: true,
      },
    });
    const satiPo = new Map(sati.map((s) => [s.employeeId, s]));

    interface Problem {
      employeeId: string;
      problem: "nema_izlaz" | "nema_prolaza";
      firstIn: string | null;
    }
    const problemi: Problem[] = [];

    // Grana A — otvoren interval.
    for (const row of dnevni.values()) {
      if (row.openIntervals <= 0) continue;
      const w = satiPo.get(row.employeeId);
      if (w && w.absenceCode !== null) continue; // LEFT JOIN + IS NULL
      problemi.push({
        employeeId: row.employeeId,
        problem: "nema_izlaz",
        firstIn: row.firstIn,
      });
    }

    // Grana B — sati u gridu bez ijednog prolaza (a kartica je bila živa).
    for (const w of sati) {
      if (!w.hours.greaterThan(0)) continue;
      if (!w.fieldHours.equals(0)) continue;
      if (w.absenceCode !== null) continue;
      if (dnevni.has(`${w.employeeId}|${dan}`)) continue;
      const bilo = await this.imaProlazaUOpsegu(
        w.employeeId,
        this.plusDana(dan, -7),
        dan,
      );
      if (!bilo) continue;
      problemi.push({
        employeeId: w.employeeId,
        problem: "nema_prolaza",
        firstIn: null,
      });
    }

    let upisano = 0;
    for (const pr of problemi) {
      const emp = await this.prisma.employee.findFirst({
        where: { id: pr.employeeId, isActive: true },
        select: { fullName: true, email: true },
      });
      if (!emp) continue; // `JOIN employees e ON ... AND e.is_active`
      const empEmail = this.norm(emp.email) || null;
      const opis =
        pr.problem === "nema_izlaz"
          ? `ulaz u ${pr.firstIn ?? "?"}, ali izlaz NIJE otkucan`
          : "u gridu su upisani sati, ali NEMA nijednog otkucaja";
      const subject = `Provera kucanja — ${emp.fullName} (${this.ddmmyyyy(dan)})`;

      const sefovi = new Set<string>([
        ...(await this.oversightSefRecipients(pr.employeeId)),
        ...(await this.extraRecipients(pr.employeeId)),
      ]);
      if (empEmail) sefovi.delete(empEmail);

      const primaoci: { email: string; who: "sef" | "radnik" }[] = [
        ...[...sefovi].map((e) => ({ email: e, who: "sef" as const })),
        ...(empEmail ? [{ email: empEmail, who: "radnik" as const }] : []),
      ];

      for (const rec of primaoci) {
        const vecPoslato = await this.postojiAlarm(
          "attendance_missing_punch",
          pr.employeeId,
          rec.email,
          dan,
        );
        if (vecPoslato) continue;
        await this.prisma.kadrNotificationLog.create({
          data: {
            channel: "email",
            recipient: rec.email,
            subject,
            body:
              '<div style="font-family:sans-serif;max-width:560px">' +
              `<h3 style="color:#d97706">⚠ Provera kucanja za ${this.ddmmyyyy(dan)}</h3>` +
              (rec.who === "radnik"
                ? `<p>Za Vas juče: <strong>${opis}</strong>.</p>` +
                  "<p>Ako je greška, ispravite u aplikaciji: <strong>Moj profil › Moje prisustvo</strong> (uz obrazloženje) ili se javite šefu.</p>"
                : `<p>Radnik <strong>${emp.fullName}</strong>: ${opis}.</p>` +
                  "<p>Korekciju možete uneti u <strong>Moj profil › Moj tim</strong> (uz obrazloženje radnika).</p>") +
              '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
            relatedEntityType: "attendance_alert",
            relatedEntityId: pr.employeeId,
            employeeId: pr.employeeId,
            notificationType: "attendance_missing_punch",
            status: "queued",
            payload: { work_date: dan, problem: pr.problem },
          },
        });
        upisano += 1;
      }
    }
    return upisano;
  }

  /** `EXISTS (... event_ts_local::date >= od AND < do)` — samo postojanje. */
  private async imaProlazaUOpsegu(
    employeeId: string,
    od: string,
    doDana: string,
  ): Promise<boolean> {
    const a = this.utcOkvirDana(od).od;
    const b = this.utcOkvirDana(doDana).od;
    const n = await this.prisma.attendanceEvent.count({
      where: { employeeId, eventTs: { gte: a, lt: b } },
    });
    return n > 0;
  }

  /** `IF EXISTS (... AND (payload->>'work_date')::date = v_day) THEN CONTINUE`. */
  private async postojiAlarm(
    notificationType: string,
    employeeId: string,
    recipient: string,
    dan: string,
  ): Promise<boolean> {
    const n = await this.prisma.kadrNotificationLog.count({
      where: {
        notificationType,
        relatedEntityId: employeeId,
        recipient,
        payload: { path: ["work_date"], equals: dan },
      },
    });
    return n > 0;
  }

  /**
   * `kadr_schedule_attendance_weekly_digest()` — posao `kadr-attendance-digest`.
   *
   * PARITET:
   *  - 🔴 DVOSTRUKI GEJT: radi SAMO kad je lokalno **ponedeljak** i sat **6**,
   *  - prozor je [ponedeljak-7, ponedeljak) — dakle prošla nedelja,
   *  - prvi deo: top 20 radnika po broju `attendance_missing_punch` alarma,
   *  - drugi deo („strukturni problem"): aktivni radnici koji imaju sate u
   *    gridu u prozoru (bez terenskih i bez odsustva), a NIJEDAN prolaz od
   *    `od - 7` dana — mrtva/nemapirana kartica,
   *  - ako su oba dela prazna -> ništa se ne šalje,
   *  - primaoci su AKTIVNI ADMINI; dedup po (tip, primalac, `payload.week_start`).
   */
  async scheduleAttendanceWeeklyDigest(
    now: Date = new Date(),
  ): Promise<number> {
    const p = belgradeParts(now);
    if (p.isoDow !== 1 || p.hour !== 6) return 0;
    const doDana = this.danasBeograd(now);
    const od = this.plusDana(doDana, -7);

    const alarmi = await this.prisma.kadrNotificationLog.findMany({
      where: { notificationType: "attendance_missing_punch" },
      select: { employeeId: true, payload: true },
    });
    const brojPo = new Map<string, number>();
    for (const a of alarmi) {
      const wd = (a.payload as Record<string, unknown> | null)?.work_date;
      if (typeof wd !== "string") continue;
      if (wd < od || wd >= doDana) continue;
      if (!a.employeeId) continue;
      brojPo.set(a.employeeId, (brojPo.get(a.employeeId) ?? 0) + 1);
    }
    const top = [...brojPo.entries()].sort((x, y) => y[1] - x[1]).slice(0, 20);
    const imena = new Map(
      (
        await this.prisma.employee.findMany({
          where: { id: { in: top.map((t) => t[0]) } },
          select: { id: true, fullName: true },
        })
      ).map((e) => [e.id, e.fullName]),
    );
    let redovi = "";
    for (const [empId, n] of top) {
      redovi +=
        `<tr><td style="padding:3px 10px">${imena.get(empId) ?? empId}` +
        `</td><td style="padding:3px 10px;text-align:center">${n}</td></tr>`;
    }

    const mrtvi = await this.mrtveKartice(od, doDana);
    let dead = "";
    for (const ime of mrtvi) dead += `<li>${ime}</li>`;

    if (top.length === 0 && dead === "") return 0;

    const admini = await this.oversightUpravaRecipients();
    let upisano = 0;
    for (const rec of admini) {
      const vec = await this.prisma.kadrNotificationLog.count({
        where: {
          notificationType: "attendance_weekly_digest",
          recipient: rec,
          payload: { path: ["week_start"], equals: od },
        },
      });
      if (vec > 0) continue;
      await this.prisma.kadrNotificationLog.create({
        data: {
          channel: "email",
          recipient: rec,
          subject:
            `Prisustvo — nedeljni izveštaj (${this.ddmm(od)}–` +
            `${this.ddmmyyyy(this.plusDana(doDana, -1))})`,
          body:
            '<div style="font-family:sans-serif;max-width:560px">' +
            "<h3>📊 Kucanje — nedeljni pregled</h3>" +
            (redovi !== ""
              ? '<p>Alarmi „nije se dobro kucao" po radniku:</p><table style="border-collapse:collapse;font-size:14px">' +
                '<tr><th style="text-align:left;padding:3px 10px">Radnik</th><th style="padding:3px 10px">Alarma</th></tr>' +
                redovi +
                "</table>"
              : "<p>Nije bilo dnevnih alarma ove nedelje. 🎉</p>") +
            (dead !== ""
              ? '<p style="margin-top:14px"><strong>⚠ Strukturni problem — grid sati bez IJEDNOG prolaza (mrtva/nemapirana kartica?):</strong></p><ul>' +
                dead +
                "</ul>"
              : "") +
            '<p style="color:#999;font-size:12px">Servoteh — automatsko obaveštenje</p></div>',
          relatedEntityType: "attendance_digest",
          relatedEntityId: od,
          notificationType: "attendance_weekly_digest",
          status: "queued",
          payload: { week_start: od },
        },
      });
      upisano += 1;
    }
    return upisano;
  }

  /** 'DD.MM.' — kraći format iz naslova nedeljnog izveštaja. */
  private ddmm(day: string): string {
    const [, m, d] = day.split("-");
    return `${d}.${m}.`;
  }

  /**
   * Radnici sa satima u prozoru, a bez IJEDNOG prolaza od `od - 7` dana.
   * (`NOT EXISTS ... event_ts_local::date >= v_from - 7` — donja granica, bez
   * gornje: dovoljan je JEDAN prolaz bilo kad posle te granice.)
   */
  private async mrtveKartice(od: string, doDana: string): Promise<string[]> {
    const sati = await this.prisma.workHour.findMany({
      where: {
        workDate: { gte: this.dbDate(od), lt: this.dbDate(doDana) },
        absenceCode: null,
        employee: { isActive: true },
      },
      select: {
        employeeId: true,
        hours: true,
        fieldHours: true,
        employee: { select: { fullName: true } },
      },
    });
    const kandidati = new Map<string, string>();
    for (const s of sati) {
      if (!s.hours.greaterThan(0)) continue;
      if (!s.fieldHours.equals(0)) continue;
      kandidati.set(s.employeeId, s.employee.fullName);
    }
    const granica = this.utcOkvirDana(this.plusDana(od, -7)).od;
    const out: string[] = [];
    for (const [empId, ime] of kandidati) {
      const n = await this.prisma.attendanceEvent.count({
        where: { employeeId: empId, eventTs: { gte: granica } },
      });
      if (n === 0) out.push(ime);
    }
    return out.sort((a, b) => a.localeCompare(b, "sr"));
  }
}

/**
 * Prepis TELA view-a `v_attendance_daily` kao čista funkcija — izdvojena da bi
 * se dedup i uparivanje mogli testirati bez baze (i da bi se videlo da su
 * pravila prepisana, ne izmišljena).
 *
 * KORACI IZ VIEW-A (svi obavezni):
 *  1. `dir_prio`: in=0, official_out=1, break=2, out=3, ostalo=4 — redosled
 *     ISTOVREMENIH događaja;
 *  2. sort po (ts, dir_prio, id) unutar (employee, day);
 *  3. DEDUP: red se zadržava ako je prvi, ILI mu je smer različit od
 *     prethodnog, ILI je od prethodnog prošlo VIŠE od 1 minuta. Kapija ume da
 *     upiše isti prolaz nekoliko puta u istoj sekundi;
 *  4. uparivanje (`lead`) po istom redosledu nad DEDUP-ovanim nizom;
 *  5. zbirovi: `first_in`, `last_out`, `presence_hours` (samo intervali koji
 *     počinju sa `in`/`official_out` i IMAJU sledeći događaj), `events_cnt`,
 *     `open_intervals` (otvoreni bez sledećeg), `double_in_cnt`.
 */
export function racunajDnevnoPrisustvo(
  events: PunchEvent[],
): Map<string, AttendanceDailyRow> {
  const groups = new Map<string, PunchEvent[]>();
  for (const e of events) {
    if (e.direction === "unknown") continue;
    const day = e.eventTsLocal.toISOString().slice(0, 10);
    const key = `${e.employeeId}|${day}`;
    const arr = groups.get(key);
    if (arr) arr.push(e);
    else groups.set(key, [e]);
  }

  const out = new Map<string, AttendanceDailyRow>();
  for (const [key, arr] of groups) {
    const prio = (d: string) => DIR_PRIO[d] ?? 4;
    arr.sort((a, b) => {
      const t = a.eventTsLocal.getTime() - b.eventTsLocal.getTime();
      if (t !== 0) return t;
      const p = prio(a.direction) - prio(b.direction);
      if (p !== 0) return p;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // 3. DEDUP — 🔴 `lag(...) OVER w` ide nad CELIM sortiranim nizom, ne nad
    //    onim što je već zadržano. Poređenje je sa NEPOSREDNO PRETHODNIM redom
    //    (i kad je taj red odbačen) — inače se lanac od tri ista otkucaja
    //    ponaša drugačije nego u bazi.
    const dedup: PunchEvent[] = [];
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      const prev = i === 0 ? null : arr[i - 1];
      if (prev === null) {
        dedup.push(e);
        continue;
      }
      const razlika = e.eventTsLocal.getTime() - prev.eventTsLocal.getTime();
      if (e.direction !== prev.direction || razlika > 60_000) dedup.push(e);
    }

    // 4./5. uparivanje i zbirovi
    let firstIn: Date | null = null;
    let lastOut: Date | null = null;
    let presenceMs = 0;
    let imaZatvorenih = false;
    let openIntervals = 0;
    let doubleIn = 0;
    for (let i = 0; i < dedup.length; i++) {
      const cur = dedup[i];
      const next = i + 1 < dedup.length ? dedup[i + 1] : null;
      if (cur.direction === "in") {
        if (firstIn === null || cur.eventTsLocal < firstIn) {
          firstIn = cur.eventTsLocal;
        }
        if (next?.direction === "in") doubleIn += 1;
      }
      if (ZATVARA.has(cur.direction)) {
        if (lastOut === null || cur.eventTsLocal > lastOut) {
          lastOut = cur.eventTsLocal;
        }
      }
      if (OTVARA.has(cur.direction)) {
        if (next !== null) {
          presenceMs +=
            next.eventTsLocal.getTime() - cur.eventTsLocal.getTime();
          imaZatvorenih = true;
        } else {
          openIntervals += 1;
        }
      }
    }

    const [employeeId, day] = key.split("|");
    out.set(key, {
      employeeId,
      day,
      firstIn: firstIn ? firstIn.toISOString().slice(11, 16) : null,
      lastOut: lastOut ? lastOut.toISOString().slice(11, 16) : null,
      // `sum(...) FILTER (...)` nad nula redova je NULL, ne 0 — preneto.
      presenceHours: imaZatvorenih
        ? Math.round((presenceMs / 3_600_000) * 100) / 100
        : null,
      eventsCnt: dedup.length,
      openIntervals,
      doubleInCnt: doubleIn,
    });
  }
  return out;
}
