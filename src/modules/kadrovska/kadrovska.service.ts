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
   *  redove i dalje maskira RLS kroz withUserRls. Agregatni/XLSX izveštaji = R2. */
  private static readonly REPORT_SOURCES: Record<string, string> = {
    medical: "v_kadr_medical_exam_status",
    certs: "v_kadr_certificate_status",
    audit: "v_kadr_audit_log",
  };
  /** Kindovi koji traže agregaciju iz grida / XLSX render → R2 (parity matrica #3). */
  private static readonly REPORT_R2 = new Set([
    "sick",
    "demo",
    "org",
    "vacation",
    "overtime",
    "field",
    "children",
    "risk",
  ]);

  async report(email: string, kind: string) {
    const view = KadrovskaService.REPORT_SOURCES[kind];
    if (!view) {
      if (KadrovskaService.REPORT_R2.has(kind)) {
        // Agregat/XLSX izveštaj — R2 (engine + exporteri). Honest 501 umesto tihe greške.
        throw new NotImplementedException(
          `Izveštaj '${kind}' je R2 (agregat/XLSX exporter)`,
        );
      }
      throw new UnprocessableEntityException(`Nepoznat izveštaj '${kind}'`);
    }
    return this.withUserMapped(email, async (tx) => {
      const data = await tx.$queryRaw(
        Prisma.sql`SELECT * FROM ${Prisma.raw(view)} ORDER BY 1`,
      );
      return { data };
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
      return { data };
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

  /** Očekivanja zaposlenog (v_employee_expectations) — self status u_toku/ispunjeno (D). */
  async expectations(email: string, q: ByEmployeeQueryDto) {
    return this.withUserMapped(email, async (tx) => {
      const conds: Prisma.Sql[] = [];
      if (q.employeeId)
        conds.push(Prisma.sql`employee_id = ${q.employeeId}::uuid`);
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
