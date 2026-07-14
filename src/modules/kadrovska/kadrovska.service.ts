import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  NotImplementedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service, type Sy15Tx } from "../../common/sy15/sy15.service";
import { pageMeta, parsePagination } from "../../common/pagination";
import type {
  AbsencesQueryDto,
  AttendanceDailyQueryDto,
  ByEmployeeQueryDto,
  GridQueryDto,
  ListEmployeesQueryDto,
  MonthQueryDto,
  NotificationsQueryDto,
  ReportQueryDto,
  RequestsQueryDto,
  VacationQueryDto,
  WorkHoursQueryDto,
} from "./dto/kadrovska-query.dto";

/**
 * Kadrovska (HR) — 3.0 TALAS G, R1 read sloj (MODULE_SPEC_kadrovska_30.md §3).
 * Podaci žive u sy15 (1.0) bazi (doktrina §A.1); ovaj servis SAMO ČITA:
 *  - PII-masku i zarade kroz kanonske view-ove (`v_employees_safe`, `v_vacation_balance`,
 *    `v_salary_payroll_month`…) — svi `security_invoker=true` → RLS pozivaoca (A6),
 *  - CRUD tabele kroz Prisma (`prisma/sy15.prisma`, BEZ FK relacija — 1.0 šema ih nema),
 *  - dashboard/helper RPC-ove (kadr_dashboard_*, current_user_*) kroz isti most.
 *
 * ⚠️ DOKTRINA A.2a (KRITIČNO za Kadrovsku): konekciona rola `servosync2_app` je
 * BYPASSRLS (izmereno na sy15). SVAKI read ide kroz `Sy15Service.withUserRls`
 * (GUC claims sub+email + `SET LOCAL ROLE authenticated`) → PII maska
 * (`current_user_can_manage_employee_pii`) i zarade (admin-only) presuđuje sy15 RLS
 * TEK pod `authenticated`. `this.sy15.db` (BYPASSRLS) se NIKAD ne koristi za HR read —
 * probio bi JMBG/adresu/zaradu. Row-scope (svoje ∨ manages_employee ∨ vacreq/mgmt)
 * se NE duplira u WHERE — presuđuje RLS. Mutacije/RPC-write/PDF/payroll engine = R2.
 */
@Injectable()
export class KadrovskaService {
  constructor(private readonly sy15: Sy15Service) {}

  // ==========================================================================
  // PREGLED (dashboard + izveštaji + notifikacije)
  // ==========================================================================

  /**
   * Efektivna prava pozivaoca (paritet 1.0 auth.js/shared.js gate-ova) — server ih
   * računa iz GUC upita nad DB helperima (isti izvor istine kao RLS). FE fine-gating.
   */
  async me(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>(
        Prisma.sql`SELECT
            current_user_is_admin()                    AS is_admin,
            current_user_is_hr()                       AS is_hr,
            current_user_is_hr_or_admin()              AS is_hr_or_admin,
            current_user_is_poslovni_admin()           AS poslovni_admin,
            current_user_is_management()               AS is_management,
            current_user_can_manage_employee_pii()     AS can_pii,
            can_edit_kadrovska_grid()                  AS grid_editor,
            can_edit_vacation_balance()                AS vacation_editor,
            current_user_can_manage_vacreq()           AS can_manage_vacreq,
            current_user_is_vacreq_admin()             AS vacreq_admin,
            current_user_employee_id()                 AS employee_id,
            current_user_managed_sub_department_ids()  AS managed_sub_dept_ids`,
      );
      const r = rows[0] ?? {};
      return {
        data: {
          email,
          isAdmin: r.is_admin ?? false,
          isHr: r.is_hr ?? false,
          isHrOrAdmin: r.is_hr_or_admin ?? false,
          poslovniAdmin: r.poslovni_admin ?? false,
          isManagement: r.is_management ?? false,
          // canSalary = SAMO admin (HR namerno nema — §2.6); vezano za current_user_is_admin.
          canSalary: r.is_admin ?? false,
          canPii: r.can_pii ?? false,
          gridEditor: r.grid_editor ?? false,
          vacationEditor: r.vacation_editor ?? false,
          canManageVacreq: r.can_manage_vacreq ?? false,
          vacreqAdmin: r.vacreq_admin ?? false,
          employeeId: r.employee_id ?? null,
          managedSubDeptIds: r.managed_sub_dept_ids ?? [],
        },
      };
    });
  }

  /**
   * Dashboard KPI za Pregled — 1 poziv umesto 3 (paritet 1.0 kadrovskaDashboard):
   * kadr_dashboard_kpis + kadr_dashboard_mini_reports + kadr_dashboard_action_stack.
   * Sve tri su SECURITY DEFINER sa internim guardom → 42501 (→403) za role bez prava.
   */
  async dashboard(email: string, q: MonthQueryDto) {
    const now = new Date();
    const year = q.year ?? now.getUTCFullYear();
    const month = q.month ?? now.getUTCMonth() + 1;
    return this.withUserMapped(email, async (tx) => {
      const [kpis, mini, actions] = await Promise.all([
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT kadr_dashboard_kpis(${year}::int, ${month}::int) AS v`,
        ),
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT kadr_dashboard_mini_reports(${year}::int, ${month}::int) AS v`,
        ),
        tx.$queryRaw<{ v: unknown }[]>(
          Prisma.sql`SELECT kadr_dashboard_action_stack(10::int) AS v`,
        ),
      ]);
      return {
        data: {
          year,
          month,
          kpis: kpis[0]?.v ?? null,
          miniReports: mini[0]?.v ?? null,
          actionStack: actions[0]?.v ?? null,
        },
      };
    });
  }

  /** Izveštaji koji su 1:1 čitanje kanonskog view-a/tabele (view-ови su RLS-svesni).
   *  PII izveštaji gate-uje `kadrovska.pii` (kontroler), audit `kadrovska.admin`;
   *  redove i dalje maskira RLS kroz withUserRls. */
  private static readonly REPORT_SOURCES: Record<string, string> = {
    medical: "v_kadr_medical_exam_status",
    certs: "v_kadr_certificate_status",
    audit: "v_kadr_audit_log",
  };

  /**
   * Izveštaji — dispatch po kind-u (paritet 1.0 reportsTab.js pod-izveštaja).
   * View-kindovi (medical/certs/audit) = 1:1 čitanje; agregatni kindovi (sick/demo/
   * org/vacation/overtime/field) repliciraju 1.0 FE agregaciju u SQL-u nad ISTIM
   * izvorima (work_hours grid, v_employees_safe, org tabele, v_vacation_balance) —
   * XLSX/CSV render i summary chips ostaju FE. `children`/`risk` su namenske PII rute.
   */
  async report(email: string, kind: string, q: ReportQueryDto = {}) {
    const view = KadrovskaService.REPORT_SOURCES[kind];
    if (view) {
      return this.withUserMapped(email, async (tx) => {
        const data = await tx.$queryRaw(
          Prisma.sql`SELECT * FROM ${Prisma.raw(view)} ORDER BY 1`,
        );
        // v_kadr_audit_log.id je bigint → Number (res.json ne serijalizuje BigInt).
        return { data: this.numify(data) };
      });
    }
    switch (kind) {
      case "sick":
        return this.reportSick(email, q);
      case "demo":
        return this.reportDemo(email);
      case "org":
        return this.reportOrg(email);
      case "vacation":
        return this.reportVacation(email, q);
      case "overtime":
        return this.reportOvertime(email, q);
      case "field":
        return this.reportField(email, q);
      default:
        throw new UnprocessableEntityException(`Nepoznat izveštaj '${kind}'`);
    }
  }

  /**
   * Bolovanja (1.0 bolovanjeListFromWorkHours): dnevne 'bo' ćelije grida spojene u
   * epizode (uzastopni dani istog zaposlenog + istog subtype-a — gaps-and-islands).
   * Vraća epizode; per-emp agregat/chips računa FE (paritet sickReport._aggregate).
   */
  private async reportSick(email: string, q: ReportQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [Prisma.sql`absence_code = 'bo'`];
      if (q.from) conds.push(Prisma.sql`work_date >= ${q.from.slice(0, 10)}::date`);
      if (q.to) conds.push(Prisma.sql`work_date <= ${q.to.slice(0, 10)}::date`);
      const data = await tx.$queryRaw(Prisma.sql`
        WITH bo AS (
          SELECT employee_id, work_date, lower(coalesce(absence_subtype, '')) AS sub
            FROM work_hours
           WHERE ${Prisma.join(conds, " AND ")}
        ), g AS (
          SELECT employee_id, sub, work_date,
                 work_date - (ROW_NUMBER() OVER (PARTITION BY employee_id, sub ORDER BY work_date))::int AS anchor
            FROM bo
        )
        SELECT employee_id, MIN(work_date) AS date_from, MAX(work_date) AS date_to,
               (MAX(work_date) - MIN(work_date) + 1) AS days_count,
               NULLIF(sub, '') AS absence_subtype
          FROM g
         GROUP BY employee_id, sub, anchor
         ORDER BY employee_id, date_from`);
      return { data: this.numify(data) };
    });
  }

  /** Demografija (1.0 demoReport) — polja za distribucije (rod/starost/obrazovanje/staž/
   *  odeljenje) iz v_employees_safe; bucket-ovanje i chips računa FE. PII maska view-a. */
  private async reportDemo(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(Prisma.sql`
        SELECT id, full_name, gender, birth_date, education_level, hire_date,
               department, department_id, is_active
          FROM v_employees_safe ORDER BY full_name`);
      return { data };
    });
  }

  /** Organogram (1.0 orgChartReport) — struktura (departments → sub_departments →
   *  job_positions) + zaposleni sa grupišućim poljima; stablo sklapa FE. */
  private async reportOrg(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const [departments, subDepartments, jobPositions, employees] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT id, name, sort_order FROM departments ORDER BY sort_order, name`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT id, department_id, name, sort_order FROM sub_departments ORDER BY sort_order, name`,
        ),
        tx.$queryRaw(
          Prisma.sql`SELECT id, department_id, sub_department_id, name, sort_order FROM job_positions ORDER BY sort_order, name`,
        ),
        tx.$queryRaw(Prisma.sql`
          SELECT id, full_name, position, position_id, sub_department_id, department_id, is_active
            FROM v_employees_safe ORDER BY full_name`),
      ]);
      return { data: { departments, subDepartments, jobPositions, employees } };
    });
  }

  /** Saldo GO (1.0 vacationReport) — v_vacation_balance + entitlements za godinu +
   *  fallback broj GO dana iz grida (countGoDaysByEmployeeForYear). Spajanje radi FE. */
  private async reportVacation(email: string, q: ReportQueryDto) {
    const year = q.year ?? new Date().getUTCFullYear();
    return this.withUserMapped(email, async (tx) => {
      const [balances, entitlements, gridGoDays] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_vacation_balance WHERE year = ${year}::int`,
        ),
        tx.vacationEntitlement.findMany({ where: { year } }),
        tx.$queryRaw(Prisma.sql`
          SELECT employee_id, count(*)::int AS days
            FROM work_hours
           WHERE absence_code = 'go'
             AND work_date >= ${`${year}-01-01`}::date
             AND work_date <= ${`${year}-12-31`}::date
           GROUP BY employee_id`),
      ]);
      return {
        data: {
          year,
          balances: this.numify(balances),
          entitlements,
          gridGoDays: this.numify(gridGoDays),
        },
      };
    });
  }

  /**
   * Prekovremeni (1.0 overtimeByEmployeeForPeriod): po zaposlenom Σ overtime,
   * Σ two_machine (sa dana kad je bilo prekovremenih), broj dana, poslednji datum;
   * + zaposleni SAMO sa two_machine satima (bez overtime-a) kao zasebni redovi.
   * ⚠️ Namerno odstupanje od 1.0: tm-only zaposlenom 1.0 broji SAMO PRVI red (bug u
   * petlji `if (map.has(id)) continue`); ovde se sabiraju svi tm redovi (intencija).
   */
  private async reportOvertime(email: string, q: ReportQueryDto) {
    const period: Prisma.Sql[] = [];
    if (q.from) period.push(Prisma.sql`work_date >= ${q.from.slice(0, 10)}::date`);
    if (q.to) period.push(Prisma.sql`work_date <= ${q.to.slice(0, 10)}::date`);
    const and = period.length
      ? Prisma.sql`AND ${Prisma.join(period, " AND ")}`
      : Prisma.empty;
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(Prisma.sql`
        WITH ot AS (
          SELECT employee_id,
                 SUM(coalesce(overtime_hours, 0)) AS total_overtime,
                 SUM(coalesce(two_machine_hours, 0)) AS two_machine_hours,
                 COUNT(*)::int AS days,
                 MAX(work_date) AS last_date
            FROM work_hours
           WHERE coalesce(overtime_hours, 0) > 0 ${and}
           GROUP BY employee_id
        ), tm AS (
          SELECT employee_id,
                 SUM(coalesce(two_machine_hours, 0)) AS two_machine_hours,
                 MAX(work_date) AS last_date
            FROM work_hours
           WHERE coalesce(two_machine_hours, 0) > 0 ${and}
           GROUP BY employee_id
        )
        SELECT employee_id, total_overtime, two_machine_hours, days, last_date FROM ot
        UNION ALL
        SELECT t.employee_id, 0, t.two_machine_hours, 0, t.last_date FROM tm t
         WHERE NOT EXISTS (SELECT 1 FROM ot o WHERE o.employee_id = t.employee_id)
         ORDER BY total_overtime DESC`);
      return { data: this.numify(data) };
    });
  }

  /** Terenski (1.0 fieldWorkByEmployeeForPeriod): dani/sati po zaposlenom, domaći
   *  (subtype ≠ 'foreign') vs inostrani; dan = red sa field_hours > 0. */
  private async reportField(email: string, q: ReportQueryDto) {
    const conds: Prisma.Sql[] = [Prisma.sql`coalesce(field_hours, 0) > 0`];
    if (q.from) conds.push(Prisma.sql`work_date >= ${q.from.slice(0, 10)}::date`);
    if (q.to) conds.push(Prisma.sql`work_date <= ${q.to.slice(0, 10)}::date`);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(Prisma.sql`
        SELECT employee_id,
               COUNT(*) FILTER (WHERE coalesce(field_subtype, '') <> 'foreign')::int AS domestic_days,
               coalesce(SUM(field_hours) FILTER (WHERE coalesce(field_subtype, '') <> 'foreign'), 0) AS domestic_hours,
               COUNT(*) FILTER (WHERE field_subtype = 'foreign')::int AS foreign_days,
               coalesce(SUM(field_hours) FILTER (WHERE field_subtype = 'foreign'), 0) AS foreign_hours,
               MAX(work_date) AS last_date
          FROM work_hours
         WHERE ${Prisma.join(conds, " AND ")}
         GROUP BY employee_id
         ORDER BY COUNT(*) DESC`);
      return { data: this.numify(data) };
    });
  }

  /**
   * Rizik (1.0 riskReport, PII gate): po zaposlenom BO dani/epizode u periodu
   * (grid 'bo' epizode + absences tip 'bolovanje' — 1.0 spaja OBA izvora),
   * istek lekarskog (v_employees_safe.medical_exam_expires) i najnovijeg aktivnog
   * ugovora (date_from DESC — 1.0 activeConByEmp). Nivo (visok/srednji/nizak),
   * razlozi i heatmap = FE (1.0 _computeRiskLevel logika).
   */
  async reportRisk(email: string, q: ReportQueryDto) {
    const months = q.months ?? 12;
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
    }).format(new Date());
    const start = new Date(`${today}T00:00:00Z`);
    start.setUTCMonth(start.getUTCMonth() - months);
    const periodStart = start.toISOString().slice(0, 10);
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(Prisma.sql`
        WITH bo AS (
          SELECT employee_id, work_date, lower(coalesce(absence_subtype, '')) AS sub
            FROM work_hours
           WHERE absence_code = 'bo'
             AND work_date >= ${periodStart}::date AND work_date <= ${today}::date
        ), g AS (
          SELECT employee_id, sub, work_date,
                 work_date - (ROW_NUMBER() OVER (PARTITION BY employee_id, sub ORDER BY work_date))::int AS anchor
            FROM bo
        ), grid_ep AS (
          SELECT employee_id, MIN(work_date) AS date_from, MAX(work_date) AS date_to
            FROM g GROUP BY employee_id, sub, anchor
        ), abs_ep AS (
          SELECT employee_id, date_from, date_to
            FROM absences
           WHERE type = 'bolovanje' AND archived_at IS NULL
             AND date_from IS NOT NULL AND date_to IS NOT NULL
             AND date_to >= ${periodStart}::date AND date_from <= ${today}::date
        ), bo_all AS (
          SELECT * FROM grid_ep UNION ALL SELECT * FROM abs_ep
        ), agg AS (
          SELECT employee_id,
                 SUM(GREATEST(0, LEAST(date_to, ${today}::date) - GREATEST(date_from, ${periodStart}::date) + 1))::int AS bo_days,
                 COUNT(*)::int AS bo_count
            FROM bo_all GROUP BY employee_id
        ), con AS (
          SELECT DISTINCT ON (employee_id) employee_id, date_to
            FROM contracts
           WHERE archived_at IS NULL AND is_active IS NOT FALSE
           ORDER BY employee_id, date_from DESC NULLS LAST
        )
        SELECT e.id AS employee_id, e.full_name, e.department, e.position, e.is_active,
               coalesce(a.bo_days, 0) AS bo_days, coalesce(a.bo_count, 0) AS bo_count,
               e.medical_exam_expires, c.date_to AS contract_date_to
          FROM v_employees_safe e
          LEFT JOIN agg a ON a.employee_id = e.id
          LEFT JOIN con c ON c.employee_id = e.id
         ORDER BY e.full_name`);
      return { data: { months, periodStart, periodEnd: today, rows: this.numify(data) } };
    });
  }

  /** Notifikacije outbox (read) — row-scope hr_or_admin presuđuje RLS. */
  async notifications(email: string, q: NotificationsQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      if (q.type) conds.push(Prisma.sql`notification_type = ${q.type}`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM kadr_notification_log ${where}
          ORDER BY created_at DESC LIMIT 200`,
      );
      return { data };
    });
  }

  /** Singleton konfiguracija notifikacija (hr_or_admin). */
  async notificationConfig(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.kadrNotificationConfig.findUnique({
        where: { id: 1 },
      });
      return { data };
    });
  }

  // ==========================================================================
  // ODMORI (GO saldo + zahtevi/odobravanja + odsustva)
  // ==========================================================================

  /** GO saldo — v_vacation_balance (GRID-KANON §2.6: saldo iz grida, NE zbir zahteva).
   *  2.0 NE preračunava saldo — čita view. Row-scope (svoje ∨ manages) presuđuje RLS. */
  async vacationBalance(email: string, q: VacationQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
      if (q.year) conds.push(Prisma.sql`year = ${q.year}::int`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_vacation_balance ${where} ORDER BY year DESC`,
      );
      return { data };
    });
  }

  /** Istorija GO (Excel uvoz, ODVOJENO od salda) — SELECT-only. */
  async vacationHistory(email: string, q: VacationQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.vacationHistory.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.year ? { year: q.year } : {}),
        },
        orderBy: [{ year: "desc" }],
      });
      return { data };
    });
  }

  /** Akrual/uvoz salda (vacation_entitlements) — read (uređivanje = vacation_edit, R2). */
  async vacationEntitlements(email: string, q: VacationQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.vacationEntitlement.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.year ? { year: q.year } : {}),
        },
        orderBy: [{ year: "desc" }],
      });
      return { data };
    });
  }

  /**
   * Jedinstveni inbox 4 izvora (paritet 1.0 approvalsTab): vacation_requests +
   * makeup_requests + paid_leave_requests + nop_requests. Svaki nosi `source`.
   * Vidljivost redova (svoje ∨ manages ∨ vacreq/vacreq_admin) presuđuje RLS.
   */
  async requests(email: string, q: RequestsQueryDto) {
    const wantSource = (s: string) => !q.source || q.source === s;
    return this.withUserMapped(email, async (tx) => {
      const empWhere = q.employeeId ? { employeeId: q.employeeId } : {};
      const statusWhere = q.status ? { status: q.status } : {};
      const where = { ...empWhere, ...statusWhere };
      const [vacation, makeup, paidLeave, nop] = await Promise.all([
        wantSource("vacation")
          ? tx.vacationRequest.findMany({
              where,
              orderBy: [{ createdAt: "desc" }],
            })
          : Promise.resolve([]),
        wantSource("makeup")
          ? tx.makeupRequest.findMany({
              where,
              orderBy: [{ createdAt: "desc" }],
            })
          : Promise.resolve([]),
        wantSource("paid_leave")
          ? tx.paidLeaveRequest.findMany({
              where,
              orderBy: [{ createdAt: "desc" }],
            })
          : Promise.resolve([]),
        wantSource("nop")
          ? tx.nopRequest.findMany({
              where,
              orderBy: [{ createdAt: "desc" }],
            })
          : Promise.resolve([]),
      ]);
      return {
        data: {
          vacation: vacation.map((r) => ({ ...r, source: "vacation" })),
          makeup: makeup.map((r) => ({ ...r, source: "makeup" })),
          paidLeave: paidLeave.map((r) => ({ ...r, source: "paid_leave" })),
          nop: nop.map((r) => ({ ...r, source: "nop" })),
        },
      };
    });
  }

  /** Odsustva (absences) — CRUD/apply-to-grid = R2; ovde read + filteri. */
  async absences(email: string, q: AbsencesQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.absence.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.from || q.to
            ? {
                dateFrom: {
                  ...(q.from ? { gte: this.toDbDate(q.from)! } : {}),
                },
                ...(q.to ? { dateTo: { lte: this.toDbDate(q.to)! } } : {}),
              }
            : {}),
        },
        orderBy: [{ dateFrom: "desc" }],
      });
      return { data };
    });
  }

  /** Roster odsutnih danas (paritet odsutniTab) — absences koje pokrivaju današnji dan. */
  async absentNow(email: string) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Belgrade",
    }).format(new Date());
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.absence.findMany({
        where: {
          archivedAt: null,
          dateFrom: { lte: this.toDbDate(today)! },
          dateTo: { gte: this.toDbDate(today)! },
        },
        orderBy: [{ dateFrom: "asc" }],
      });
      return { data };
    });
  }

  // ==========================================================================
  // SATI (mesečni grid + sati pojedinačno + prisustvo)
  // ==========================================================================

  /** Mesečni grid — work_hours meseca + praznici + primedbe. Row-scope u RLS.
   *  Batch upsert / GO set-unset / karnet / audit-undo / realtime = R2. */
  async grid(email: string, q: GridQueryDto) {
    const now = new Date();
    const year = q.year ?? now.getUTCFullYear();
    const month = q.month ?? now.getUTCMonth() + 1;
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));
    return this.withUserMapped(email, async (tx) => {
      const [rows, remarks, holidays] = await Promise.all([
        tx.workHours.findMany({
          where: {
            workDate: { gte: start, lt: end },
            ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          },
          orderBy: [{ employeeId: "asc" }, { workDate: "asc" }],
        }),
        tx.workHoursRemark.findMany({ where: { year, month } }),
        tx.kadrHoliday.findMany({
          where: { holidayDate: { gte: start, lt: end } },
          orderBy: [{ holidayDate: "asc" }],
        }),
      ]);
      return { data: { year, month, rows, remarks, holidays } };
    });
  }

  /** Sati pojedinačno (workHoursTab) — read + filteri; CRUD = R2. */
  async workHours(email: string, q: WorkHoursQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.workHours.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.from || q.to
            ? {
                workDate: {
                  ...(q.from ? { gte: this.toDbDate(q.from)! } : {}),
                  ...(q.to ? { lte: this.toDbDate(q.to)! } : {}),
                },
              }
            : {}),
        },
        orderBy: [{ workDate: "desc" }],
        take: 500,
      });
      return { data };
    });
  }

  /** Prisustvo Uživo (v_attendance_now, auto 60s u FE) — `kadrovska.attendance`. */
  async attendanceNow(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_attendance_now ORDER BY event_ts DESC`,
      );
      return { data };
    });
  }

  /** Poređenje sa gridom — mesečni pregled (v_attendance_shadow_monthly).
   *  ⚠️ `mesec` je DATE (prvi u mesecu) — filter mora 'YYYY-MM-01'::date, ne 'YYYY-MM'. */
  async attendanceShadow(email: string, q: MonthQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const where =
        q.year && q.month
          ? Prisma.sql`WHERE mesec = ${`${q.year}-${String(q.month).padStart(2, "0")}-01`}::date`
          : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_attendance_shadow_monthly ${where} ORDER BY full_name`,
      );
      return { data };
    });
  }

  /** Prisustvo vs grid (dnevno poređenje) — v_attendance_vs_grid. */
  async attendanceVsGrid(email: string, q: AttendanceDailyQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
      if (q.from) conds.push(Prisma.sql`day >= ${q.from}::date`);
      if (q.to) conds.push(Prisma.sql`day <= ${q.to}::date`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_attendance_vs_grid ${where} ORDER BY day DESC`,
      );
      return { data };
    });
  }

  /** Dnevno prisustvo (v_attendance_daily) — own ∨ attendance; RLS presuđuje. */
  async attendanceDaily(email: string, q: AttendanceDailyQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
      if (q.from) conds.push(Prisma.sql`day >= ${q.from}::date`);
      if (q.to) conds.push(Prisma.sql`day <= ${q.to}::date`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_attendance_daily ${where} ORDER BY day DESC`,
      );
      return { data };
    });
  }

  /** Korekcije prisustva (read) — own ∨ manager ∨ hr_or_admin; submit/cancel = R2.
   *  ⚠️ event_ids je bigint[] → Number (JSON ne serijalizuje BigInt; §1 review). */
  async attendanceCorrections(email: string, q: AttendanceDailyQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.attendanceCorrection.findMany({
        where: { ...(q.employeeId ? { employeeId: q.employeeId } : {}) },
        orderBy: [{ createdAt: "desc" }],
        take: 300,
      });
      return { data: rows.map((r) => this.correctionOut(r)) };
    });
  }

  /** Dopunski primaoci mejla prisustva (attendance_notify_extra) — hr_or_admin. */
  async attendanceExtraRecipients(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.attendanceNotifyExtra.findMany({
        orderBy: [{ createdAt: "desc" }],
      });
      return { data };
    });
  }

  // ==========================================================================
  // ZAPOSLENI (zaposleni + PII + ugovori + medical/certs + imenik + onboarding + razvoj)
  // ==========================================================================

  /** Lista zaposlenih — v_employees_safe (PII MASKA; §2.6 pravilo 4). NIKAD `employees`
   *  tabela direktno za prikaz. PII kolone view maskira po current_user_can_manage_pii. */
  async employees(email: string, q: ListEmployeesQueryDto) {
    const { page, pageSize, skip, take } = parsePagination(q.page, q.pageSize);
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.q) conds.push(Prisma.sql`full_name ILIKE ${`%${q.q}%`}`);
      if (q.department) conds.push(Prisma.sql`department = ${q.department}`);
      if (q.active === "true") conds.push(Prisma.sql`is_active = true`);
      if (q.active === "false") conds.push(Prisma.sql`is_active = false`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const [data, totalRows] = await Promise.all([
        tx.$queryRaw(
          Prisma.sql`SELECT * FROM v_employees_safe ${where}
            ORDER BY full_name OFFSET ${skip} LIMIT ${take}`,
        ),
        tx.$queryRaw<{ n: bigint }[]>(
          Prisma.sql`SELECT count(*) AS n FROM v_employees_safe ${where}`,
        ),
      ]);
      const total = Number(totalRows[0]?.n ?? 0);
      return { data, meta: pageMeta(page, pageSize, total) };
    });
  }

  /** Karton zaposlenog — v_employees_safe (PII maska). */
  async employee(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>(
        Prisma.sql`SELECT * FROM v_employees_safe WHERE id = ${id}::uuid`,
      );
      if (!rows[0]) throw new NotFoundException(`Zaposleni ${id} ne postoji`);
      return { data: rows[0] };
    });
  }

  /** PII pod-resursi zaposlenog (deca/kartice/strani/lični dok.) — `kadrovska.pii`
   *  gate na kontroleru; RLS (can_manage_employee_pii) je drugi sloj kroz withUserRls. */
  async employeeChildren(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.employeeChild.findMany({
        where: { employeeId: id },
        orderBy: [{ birthDate: "asc" }],
      }),
    }));
  }

  async employeeBankCards(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.employeeBankCard.findMany({
        where: { employeeId: id },
        orderBy: [{ createdAt: "desc" }],
      }),
    }));
  }

  async employeeForeignDocs(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.employeeForeignDoc.findMany({
        where: { employeeId: id },
        orderBy: [{ createdAt: "desc" }],
      }),
    }));
  }

  async employeePersonalDocs(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.employeePersonalDoc.findMany({
        where: { employeeId: id },
        orderBy: [{ createdAt: "desc" }],
      }),
    }));
  }

  /** Meta dokumenata zaposlenog (employee_documents) — storage bytes proxy = R2.
   *  ⚠️ size_bytes je bigint → Number; deleted_at IS NULL (soft-delete). */
  async employeeDocuments(email: string, id: string) {
    return this.withUserMapped(email, async (tx) => {
      const rows = await tx.employeeDocument.findMany({
        where: { employeeId: id, deletedAt: null },
        orderBy: [{ uploadedAt: "desc" }],
      });
      return { data: rows.map((d) => this.docOut(d)) };
    });
  }

  /** Lekarski pregledi — status view (v_kadr_medical_exam_status); manage/poslovni_admin. */
  async medicalExams(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const where = q.employeeId
        ? Prisma.sql`WHERE employee_id = ${q.employeeId}::uuid`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_kadr_medical_exam_status ${where} ORDER BY employee_name`,
      );
      return { data };
    });
  }

  /** Sertifikati/obuke — status view (v_kadr_certificate_status). */
  async certificates(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const where = q.employeeId
        ? Prisma.sql`WHERE employee_id = ${q.employeeId}::uuid`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_kadr_certificate_status ${where} ORDER BY employee_name`,
      );
      return { data };
    });
  }

  /** Ugovori (contracts) — `kadrovska.contracts_read`; arhiva/PDF/netToGross = R2. */
  async contracts(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.contract.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.status === "active" ? { archivedAt: null } : {}),
        },
        orderBy: [{ dateFrom: "desc" }],
      });
      return { data };
    });
  }

  /** Imenik (tel/tim/odeljenje) — iz v_employees_safe (aktivni). Unos telefona = PII/R2. */
  async directory(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT id, full_name, position, department, team, phone_work, phone_private, email
          FROM v_employees_safe WHERE is_active = true ORDER BY full_name`,
      );
      return { data };
    });
  }

  /** Uvođenje/Izlazak — tokovi (runs + tasks) i šabloni; kadr_can_manage_hr ∨ own-read. */
  async onboarding(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const runs = await tx.kadrOnboardingRun.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ startDate: "desc" }],
      });
      const runIds = runs.map((r) => r.id);
      const tasks = runIds.length
        ? await tx.kadrOnboardingTask.findMany({
            where: { runId: { in: runIds } },
            orderBy: [{ sortOrder: "asc" }],
          })
        : [];
      return { data: { runs, tasks } };
    });
  }

  async onboardingTemplates(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const templates = await tx.kadrOnboardingTemplate.findMany({
        orderBy: [{ name: "asc" }],
      });
      const items = await tx.kadrOnboardingTemplateItem.findMany({
        orderBy: [{ sortOrder: "asc" }],
      });
      return { data: { templates, items } };
    });
  }

  /** Plan razvoja (IRP) — v_development_plans; self ∨ manages_dev_plan presuđuje RLS. */
  async devPlans(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_development_plans ${where} ORDER BY created_at DESC`,
      );
      // goals_total / goals_done su bigint (count agregati) → Number.
      return { data: this.numify(data) };
    });
  }

  /** Check-ins jednog plana razvoja (development_checkins). */
  async devPlanCheckins(email: string, planId: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.developmentCheckin.findMany({
        where: { planId },
        orderBy: [{ checkinDate: "desc" }],
      }),
    }));
  }

  /** Očekivanja zaposlenog (v_employee_expectations) — self status u_toku/ispunjeno (D).
   *  `planId` suženje: razvojni ciljevi jednog plana (1.0 detalj plana grupiše po kategoriji). */
  async expectations(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
      if (q.planId) conds.push(Prisma.sql`plan_id = ${q.planId}::uuid`);
      if (q.status) conds.push(Prisma.sql`status = ${q.status}`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_employee_expectations ${where} ORDER BY due_date NULLS LAST`,
      );
      return { data };
    });
  }

  /** Razgovori (employee_talks) + korektivni planovi/mere (read). Tok nacrt→podeljen→
   *  potvrdjen: zaposleni vidi tek podeljen/potvrdjen — presuđuje RLS (§2.6 pravilo 13). */
  async talks(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const talks = await tx.employeeTalk.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ talkDate: "desc" }],
      });
      const plans = await tx.correctivePlan.findMany({
        where: { ...(q.employeeId ? { employeeId: q.employeeId } : {}) },
        orderBy: [{ createdAt: "desc" }],
      });
      const planIds = plans.map((p) => p.id);
      const measures = planIds.length
        ? await tx.correctiveMeasure.findMany({
            where: { planId: { in: planIds } },
            orderBy: [{ sort: "asc" }],
          })
        : [];
      return {
        data: { talks, correctivePlans: plans, correctiveMeasures: measures },
      };
    });
  }

  /** 360 procene — assessments + scope view; niko o sebi (assessment guard) u RLS/RPC. */
  async assessments(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const assessments = await tx.assessment.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
      });
      return { data: assessments };
    });
  }

  /** Ram kompetencija/scope jedne procene (v_assessment_scope). */
  async assessmentScope(email: string, assessmentId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_assessment_scope WHERE assessment_id = ${assessmentId}::uuid
          ORDER BY group_sort, comp_sort`,
      );
      return { data };
    });
  }

  /** Ocenjivači jedne procene + status/pozivnica (1.0 loadRaters). Rukovodilac vidi
   *  identitete (rater_email/rater_employee_id) i invited_at za ✉ marker; RLS presuđuje. */
  async assessmentRaters(email: string, assessmentId: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.assessmentRater.findMany({
        where: { assessmentId },
        orderBy: [{ raterKind: "asc" }],
      }),
    }));
  }

  /** Pregled kampanja 360 (1.0 loadCampaignAssessments): procene + ciklus + rateri,
   *  za tabelu „360° procene" (samoprocena/kolege/rukovodilac statusi + ✉ pozivnice).
   *  Prisma nema FK relacije (1.0 šema) → sklapamo u kodu (kao onboarding runs+tasks). */
  async assessmentCampaigns(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const assessments = await tx.assessment.findMany({
        where: {
          ...(q.employeeId ? { employeeId: q.employeeId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: [{ createdAt: "desc" }],
        take: 200,
      });
      const cycleIds = [
        ...new Set(assessments.map((a) => a.cycleId).filter((v): v is string => !!v)),
      ];
      const assessmentIds = assessments.map((a) => a.id);
      const [cycles, raters] = await Promise.all([
        cycleIds.length
          ? tx.assessmentCycle.findMany({ where: { id: { in: cycleIds } } })
          : Promise.resolve([]),
        assessmentIds.length
          ? tx.assessmentRater.findMany({
              where: { assessmentId: { in: assessmentIds } },
              orderBy: [{ raterKind: "asc" }],
            })
          : Promise.resolve([]),
      ]);
      const cycleById = new Map(cycles.map((c) => [c.id, c]));
      const ratersByA = new Map<string, typeof raters>();
      for (const r of raters) {
        const arr = ratersByA.get(r.assessmentId) ?? [];
        arr.push(r);
        ratersByA.set(r.assessmentId, arr);
      }
      return {
        data: assessments.map((a) => ({
          ...a,
          cycle: a.cycleId ? (cycleById.get(a.cycleId) ?? null) : null,
          raters: ratersByA.get(a.id) ?? [],
        })),
      };
    });
  }

  /** Agregat rezultata procene (assessment_results) — self/peer/leader/target po grupi i
   *  kompetenciji (1.0 loadResults, radar + PDF). Decimal → JSON string (FE Number-uje). */
  async assessmentResults(email: string, assessmentId: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.assessmentResult.findMany({ where: { assessmentId } }),
    }));
  }

  /** Ciljni nivoi procene (assessment_targets) — 1.0 loadTargets (0–5 „Cilj" tačke). */
  async assessmentTargets(email: string, assessmentId: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.assessmentTarget.findMany({
        where: { assessmentId },
        select: { competenceId: true, targetLevel: true },
      }),
    }));
  }

  /** Ocene jednog ocenjivača (1.0 loadMyScores) — rukovodilac čita svoje (leader) ocene
   *  po rater id (RLS: ocenjivač vidi samo svoje). */
  async assessmentRaterScores(email: string, raterId: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.assessmentScore.findMany({
        where: { raterId },
        select: { competenceId: true, level: true, comment: true },
      }),
    }));
  }

  /** Okvir kompetencija (v_competence_framework) — grupe→kompetencije→nivoi 0–5 sa
   *  deskriptorima (1.0 loadFramework; tooltip nivoa u 360 modalu). */
  async assessmentFramework(email: string) {
    return this.withUserMapped(email, async (tx) => ({
      data: await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_competence_framework ORDER BY group_sort, comp_sort, level`,
      ),
    }));
  }

  /** Offboarding: neizmirena (izdata, nevraćena) REVERSI zaduženja zaposlenog — panel
   *  „Zaduženja za vraćanje" (1.0 loadEmployeeOutstandingReversi). Preostalo po liniji =
   *  quantity − returned_quantity; samo ISSUED linije > 0 na OPEN/PARTIALLY_RETURNED dok.
   *  rev_* SELECT je USING(true) za authenticated (paritet 1.0 — HR vidi za bilo koga). */
  async offboardingOutstandingReversi(email: string, employeeId: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`
          SELECT d.id AS doc_id, d.doc_number, d.doc_type, d.issued_at,
                 t.oznaka, COALESCE(t.naziv, l.part_name) AS naziv,
                 (l.quantity - COALESCE(l.returned_quantity, 0)) AS qty,
                 COALESCE(l.unit, 'kom') AS unit, l.napomena AS pribor
            FROM rev_documents d
            JOIN rev_document_lines l ON l.document_id = d.id
            LEFT JOIN rev_tools t ON t.id = l.tool_id
           WHERE d.recipient_employee_id = ${employeeId}::uuid
             AND d.status IN ('OPEN', 'PARTIALLY_RETURNED')
             AND l.line_status = 'ISSUED'
             AND (l.quantity - COALESCE(l.returned_quantity, 0)) > 0
           ORDER BY d.issued_at DESC
           LIMIT 200`,
      );
      // qty je numeric (Prisma.Decimal) → Number kroz Decimal-aware numify (review #22).
      return { data: this.numify(data) };
    });
  }

  /** Izveštaj „Deca zaposlenih" (PII) — sva deca + ime/odeljenje zaposlenog (1.0
   *  childrenReport, loadChildrenForEmployee bez empId). FE računa starosne raspone. */
  async reportChildren(email: string) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`
          SELECT c.id, c.employee_id, e.full_name AS employee_name, e.department,
                 c.first_name, c.birth_date, c.note
            FROM employee_children c
            JOIN v_employees_safe e ON e.id = c.employee_id
           ORDER BY e.full_name, c.birth_date`,
      );
      return { data };
    });
  }

  // ==========================================================================
  // ZARADE (SAMO admin — kadrovska.salary)
  // ==========================================================================

  /** Uslovi zarade (salary_terms) — admin-only (kontroler + RLS). */
  async salaryTerms(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.salaryTerm.findMany({
        where: { ...(q.employeeId ? { employeeId: q.employeeId } : {}) },
        orderBy: [{ effectiveFrom: "desc" }],
      });
      return { data };
    });
  }

  /** Tekuća zarada (v_employee_current_salary). */
  async salaryCurrent(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const where = q.employeeId
        ? Prisma.sql`WHERE employee_id = ${q.employeeId}::uuid`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_employee_current_salary ${where}`,
      );
      return { data };
    });
  }

  /** Mesečni obračun (v_salary_payroll_month) — recompute/engine/payslip = R2. */
  async salaryPayroll(email: string, q: MonthQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.year) conds.push(Prisma.sql`period_year = ${q.year}::int`);
      if (q.month) conds.push(Prisma.sql`period_month = ${q.month}::int`);
      const where = conds.length
        ? Prisma.sql`WHERE ${Prisma.join(conds, " AND ")}`
        : Prisma.empty;
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM v_salary_payroll_month ${where} ORDER BY employee_name`,
      );
      return { data };
    });
  }

  // ==========================================================================
  // interno
  // ==========================================================================

  /**
   * BigInt + Prisma Decimal → Number za $queryRaw read-ove (res.json ne serijalizuje
   * BigInt → 500; Decimal bi izašao kao JSON STRING pa FE agregacija tiho puca:
   * `sum += r.qty` postaje '0'+'2'='02', `.toFixed()` baca — parity review #22, 14.07).
   * Bigint: view count-agregati (v_development_plans goals_total/done, v_kadr_audit_log.id).
   * Decimal: numeric kolone (work_hours sati, rev qty…) — duck-typed `toNumber` (bez
   * import zavisnosti od Prisma.Decimal). Prisma model bigint polja (size_bytes,
   * event_ids) idu kroz docOut/correctionOut. Rekurzivno (plitko po redu).
   *
   * ⚠️ KONVENCIJA ZA NOVAC: salary endpointi (salaryPayroll/salaryCurrent/salaryTerms)
   * NAMERNO NE idu kroz numify — Decimal iznosi ostaju JSON stringovi (bez rizika
   * po preciznost), FE ih koercira `n()/Number()` helperom. numify je isključivo za
   * IZVEŠTAJNE/agregatne read-ove (sati, dani, količine, brojači, procenti).
   */
  private numify(rows: unknown): unknown {
    if (Array.isArray(rows)) return rows.map((r) => this.numify(r));
    if (this.isDecimalLike(rows)) return rows.toNumber();
    if (rows && typeof rows === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rows as Record<string, unknown>)) {
        out[k] =
          typeof v === "bigint"
            ? Number(v)
            : this.isDecimalLike(v)
              ? v.toNumber()
              : v;
      }
      return out;
    }
    return typeof rows === "bigint" ? Number(rows) : rows;
  }

  /** Prisma.Decimal (decimal.js) duck-type — objekat sa toNumber(). */
  private isDecimalLike(v: unknown): v is { toNumber(): number } {
    return (
      v !== null &&
      typeof v === "object" &&
      typeof (v as { toNumber?: unknown }).toNumber === "function"
    );
  }

  /** size_bytes bigint → Number (BigInt ne prežive res.json). */
  private docOut<T extends { sizeBytes: bigint | null }>(d: T) {
    return {
      ...d,
      sizeBytes: d.sizeBytes == null ? null : Number(d.sizeBytes),
    };
  }

  /** event_ids bigint[] → number[] (Katze idreg-ovi < 2^53). */
  private correctionOut<T extends { eventIds: bigint[] }>(c: T) {
    return { ...c, eventIds: (c.eventIds ?? []).map((n) => Number(n)) };
  }

  /** 'YYYY-MM-DD' → Date za @db.Date (uzima datum-deo). */
  private toDbDate(v?: string | null): Date | null | undefined {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    return new Date(`${v.slice(0, 10)}T00:00:00Z`);
  }

  /**
   * Sav pristup ide kroz `withUserRls` (GUC + SET LOCAL ROLE authenticated) — RLS/PII
   * paritet sa 1.0 PostgREST-om (konekciona rola je BYPASSRLS; doktrina A.2a).
   */
  private async withUserMapped<T>(
    email: string,
    fn: (tx: Sy15Tx) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.sy15.withUserRls(email, fn);
    } catch (e) {
      this.rethrowSy15(e);
    }
  }

  /**
   * SQLSTATE iz DB fn/RLS → HTTP semantika (paritet Reversi/Sastanci §5):
   * 42501→403 (DEFINER guard / RLS scope), P0001/P0002/23514→422, 23505→409,
   * P2025 (RLS-filtrovan 0 redova)→403.
   */
  private rethrowSy15(e: unknown): never {
    if (
      e instanceof NotFoundException ||
      e instanceof ForbiddenException ||
      e instanceof UnprocessableEntityException ||
      e instanceof ConflictException ||
      e instanceof NotImplementedException
    ) {
      throw e;
    }
    const meta = (e as { meta?: { code?: string; message?: string } }).meta;
    const code = meta?.code ?? (e as { code?: string }).code;
    const message = meta?.message ?? (e as Error).message;
    if (code === "42501") throw new ForbiddenException(message);
    if (code === "P0001" || code === "P0002" || code === "23514")
      throw new UnprocessableEntityException(message);
    if (code === "23505") throw new ConflictException(message);
    if (code === "P2025") throw new ForbiddenException(message);
    throw e;
  }
}
