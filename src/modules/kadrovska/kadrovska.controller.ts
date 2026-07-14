import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { KadrovskaService } from "./kadrovska.service";
import {
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

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Kadrovska (HR) — 3.0 TALAS G, R1 read endpoints (MODULE_SPEC_kadrovska_30.md §3).
 * Klasa: `kadrovska.read` (paritet 1.0 `canAccessKadrovska` — VIDLJIVOST menija).
 * Stroža prava po ruti kroz per-method `@RequirePermission` (pii/manage/salary/…);
 * ROW/PII maska OSTAJE u sy15 (RLS + v_employees_safe + DEFINER helperi kroz GUC).
 * Mutacije/RPC-write/PDF/payroll engine/storage proxy su R2 — ovde ih NEMA.
 *
 * ⚠️ NON-INVOKER VIEW GUARD (adversarni review R1, CRITICAL): 3 view-a KOJE modul čita
 * NISU `security_invoker` (owner postgres = BYPASSRLS): `v_kadr_audit_log`,
 * `v_kadr_medical_exam_status`, `v_kadr_certificate_status`. Pod `withUserRls`
 * (SET LOCAL ROLE authenticated) oni rade kao postgres → RLS bazne tabele se NE
 * primenjuje → GUARD je JEDINA zaštita. Zato izveštaji nad njima NISU pod (preširokom)
 * `kadrovska.read` nego pod NAMENSKIM rutama koje TAČNO repliciraju baznu SELECT politiku:
 *   - reports/audit  → `kadrovska.admin`  (kadr_audit_log_select = current_user_is_admin)
 *   - reports/medical → `kadrovska.manage` (= hr_or_admin ∨ poslovni_admin — tačan skup)
 *   - reports/certs   → `kadrovska.manage` (= hr_or_admin ∨ poslovni_admin)
 * Dedicirani `/medical-exams` i `/certificates` (isti non-invoker view-ovi) su VEĆ pod
 * `kadrovska.manage`. Generička `reports/:kind` (RLS-svesni/R2 kindovi) EKSPLICITNO
 * odbija ova 3 (defense-in-depth ako se redosled ruta ikad slomi).
 *
 * ⚠️ Route ordering: LITERAL rute pre `:kind`/`:id` (nema top-level `:id` rute — svaki
 * detalj je namespace-ovan: employees/:id, dev-plans/:id/*, assessments/:id/*).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KADROVSKA_READ)
@Controller({ path: "kadrovska", version: "1" })
export class KadrovskaController {
  /** Izveštaji nad NON-INVOKER view-ovima (BYPASSRLS) — SAMO kroz namenske guard-ovane
   *  rute; generička `reports/:kind` ih odbija (defense-in-depth). */
  private static readonly NON_INVOKER_REPORTS = new Set([
    "audit",
    "medical",
    "certs",
  ]);

  constructor(private readonly kadrovska: KadrovskaService) {}

  // ---------- Pregled ----------

  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.kadrovska.me(req.user.email);
  }

  @Get("dashboard")
  dashboard(@Req() req: AuthedRequest, @Query() q: MonthQueryDto) {
    return this.kadrovska.dashboard(req.user.email, q);
  }

  // Izveštaji nad NON-INVOKER view-ovima — namenske rute sa TAČNOM baznom permisijom
  // (guard = jedina zaštita; RLS ne pomaže jer view radi kao postgres). Deklarisane PRE
  // generičke `reports/:kind` (Express: literal pre param).
  @Get("reports/audit")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  reportAudit(@Req() req: AuthedRequest) {
    return this.kadrovska.report(req.user.email, "audit");
  }

  @Get("reports/medical")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  reportMedical(@Req() req: AuthedRequest) {
    return this.kadrovska.report(req.user.email, "medical");
  }

  @Get("reports/certs")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  reportCerts(@Req() req: AuthedRequest) {
    return this.kadrovska.report(req.user.email, "certs");
  }

  /** Izveštaj „Deca zaposlenih" (PII) — namenska ruta (kao medical/certs); vraća sirove
   *  redove (dete + zaposleni), FE računa starosne raspone. */
  @Get("reports/children")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  reportChildren(@Req() req: AuthedRequest) {
    return this.kadrovska.reportChildren(req.user.email);
  }

  /** Izveštaj „Rizik" (PII — 1.0 canViewEmployeePii gate) — BO agregat po zaposlenom +
   *  isteci lekarskog/ugovora; nivo rizika i heatmap računa FE (1.0 logika). */
  @Get("reports/risk")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  reportRisk(@Req() req: AuthedRequest, @Query() q: ReportQueryDto) {
    return this.kadrovska.reportRisk(req.user.email, q);
  }

  /** Generički izveštaji (view-read ili SQL agregat; nepoznat kind → 422). NE sme da
   *  servira non-invoker/PII kindove — oni idu kroz namenske rute gore; defense-in-depth
   *  403 ako routing ikad padne. */
  @Get("reports/:kind")
  report(
    @Req() req: AuthedRequest,
    @Param("kind") kind: string,
    @Query() q: ReportQueryDto,
  ) {
    if (
      KadrovskaController.NON_INVOKER_REPORTS.has(kind) ||
      kind === "children" ||
      kind === "risk"
    ) {
      throw new ForbiddenException(
        `Izveštaj '${kind}' ide kroz namensku rutu sa strožom permisijom`,
      );
    }
    return this.kadrovska.report(req.user.email, kind, q);
  }

  @Get("notifications")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notifications(@Req() req: AuthedRequest, @Query() q: NotificationsQueryDto) {
    return this.kadrovska.notifications(req.user.email, q);
  }

  @Get("notification-config")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notificationConfig(@Req() req: AuthedRequest) {
    return this.kadrovska.notificationConfig(req.user.email);
  }

  // ---------- Odmori ----------

  @Get("vacation/balance")
  vacationBalance(@Req() req: AuthedRequest, @Query() q: VacationQueryDto) {
    return this.kadrovska.vacationBalance(req.user.email, q);
  }

  @Get("vacation/history")
  vacationHistory(@Req() req: AuthedRequest, @Query() q: VacationQueryDto) {
    return this.kadrovska.vacationHistory(req.user.email, q);
  }

  @Get("vacation/entitlements")
  vacationEntitlements(
    @Req() req: AuthedRequest,
    @Query() q: VacationQueryDto,
  ) {
    return this.kadrovska.vacationEntitlements(req.user.email, q);
  }

  @Get("requests")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  requests(@Req() req: AuthedRequest, @Query() q: RequestsQueryDto) {
    return this.kadrovska.requests(req.user.email, q);
  }

  @Get("absences/absent-now")
  absentNow(@Req() req: AuthedRequest) {
    return this.kadrovska.absentNow(req.user.email);
  }

  @Get("absences")
  absences(@Req() req: AuthedRequest, @Query() q: AbsencesQueryDto) {
    return this.kadrovska.absences(req.user.email, q);
  }

  // ---------- Sati ----------

  @Get("grid")
  grid(@Req() req: AuthedRequest, @Query() q: GridQueryDto) {
    return this.kadrovska.grid(req.user.email, q);
  }

  @Get("work-hours")
  workHours(@Req() req: AuthedRequest, @Query() q: WorkHoursQueryDto) {
    return this.kadrovska.workHours(req.user.email, q);
  }

  @Get("attendance/now")
  @RequirePermission(PERMISSIONS.KADROVSKA_ATTENDANCE)
  attendanceNow(@Req() req: AuthedRequest) {
    return this.kadrovska.attendanceNow(req.user.email);
  }

  @Get("attendance/shadow")
  @RequirePermission(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW)
  attendanceShadow(@Req() req: AuthedRequest, @Query() q: MonthQueryDto) {
    return this.kadrovska.attendanceShadow(req.user.email, q);
  }

  @Get("attendance/vs-grid")
  @RequirePermission(PERMISSIONS.KADROVSKA_ATTENDANCE_SHADOW)
  attendanceVsGrid(
    @Req() req: AuthedRequest,
    @Query() q: AttendanceDailyQueryDto,
  ) {
    return this.kadrovska.attendanceVsGrid(req.user.email, q);
  }

  @Get("attendance/daily")
  attendanceDaily(
    @Req() req: AuthedRequest,
    @Query() q: AttendanceDailyQueryDto,
  ) {
    return this.kadrovska.attendanceDaily(req.user.email, q);
  }

  @Get("attendance/corrections")
  attendanceCorrections(
    @Req() req: AuthedRequest,
    @Query() q: AttendanceDailyQueryDto,
  ) {
    return this.kadrovska.attendanceCorrections(req.user.email, q);
  }

  @Get("attendance/extra-recipients")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  attendanceExtraRecipients(@Req() req: AuthedRequest) {
    return this.kadrovska.attendanceExtraRecipients(req.user.email);
  }

  // ---------- Zaposleni ----------

  @Get("employees")
  employees(@Req() req: AuthedRequest, @Query() q: ListEmployeesQueryDto) {
    return this.kadrovska.employees(req.user.email, q);
  }

  @Get("employees/:id/children")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  employeeChildren(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.employeeChildren(req.user.email, id);
  }

  @Get("employees/:id/bank-cards")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  employeeBankCards(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.employeeBankCards(req.user.email, id);
  }

  @Get("employees/:id/foreign-docs")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  employeeForeignDocs(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.employeeForeignDocs(req.user.email, id);
  }

  @Get("employees/:id/personal-docs")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  employeePersonalDocs(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.employeePersonalDocs(req.user.email, id);
  }

  @Get("employees/:id/documents")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  employeeDocuments(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.employeeDocuments(req.user.email, id);
  }

  @Get("employees/:id")
  employee(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.kadrovska.employee(req.user.email, id);
  }

  @Get("medical-exams")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  medicalExams(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.medicalExams(req.user.email, q);
  }

  @Get("certificates")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  certificates(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.certificates(req.user.email, q);
  }

  @Get("contracts")
  @RequirePermission(PERMISSIONS.KADROVSKA_CONTRACTS_READ)
  contracts(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.contracts(req.user.email, q);
  }

  @Get("directory")
  directory(@Req() req: AuthedRequest) {
    return this.kadrovska.directory(req.user.email);
  }

  @Get("onboarding/templates")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  onboardingTemplates(@Req() req: AuthedRequest) {
    return this.kadrovska.onboardingTemplates(req.user.email);
  }

  @Get("onboarding")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  onboarding(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.onboarding(req.user.email, q);
  }

  @Get("dev-plans/:id/checkins")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  devPlanCheckins(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.devPlanCheckins(req.user.email, id);
  }

  @Get("dev-plans")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  devPlans(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.devPlans(req.user.email, q);
  }

  @Get("expectations")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  expectations(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.expectations(req.user.email, q);
  }

  @Get("talks")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  talks(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.talks(req.user.email, q);
  }

  /* 360 read — literal rute (campaign/framework/raters/…) PRE `:id` param ruta. */
  @Get("assessments/campaign")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentCampaigns(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.assessmentCampaigns(req.user.email, q);
  }

  @Get("assessments/framework")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentFramework(@Req() req: AuthedRequest) {
    return this.kadrovska.assessmentFramework(req.user.email);
  }

  @Get("assessments/raters/:raterId/scores")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentRaterScores(
    @Req() req: AuthedRequest,
    @Param("raterId", ParseUUIDPipe) raterId: string,
  ) {
    return this.kadrovska.assessmentRaterScores(req.user.email, raterId);
  }

  @Get("assessments/:id/scope")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentScope(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.assessmentScope(req.user.email, id);
  }

  @Get("assessments/:id/raters")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentRaters(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.assessmentRaters(req.user.email, id);
  }

  @Get("assessments/:id/results")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentResults(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.assessmentResults(req.user.email, id);
  }

  @Get("assessments/:id/targets")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessmentTargets(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.kadrovska.assessmentTargets(req.user.email, id);
  }

  @Get("assessments")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  assessments(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.assessments(req.user.email, q);
  }

  /** Offboarding: neizmirena REVERSI zaduženja zaposlenog (panel „Zaduženja za vraćanje"). */
  @Get("onboarding/reversi/:employeeId")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  offboardingReversi(
    @Req() req: AuthedRequest,
    @Param("employeeId", ParseUUIDPipe) employeeId: string,
  ) {
    return this.kadrovska.offboardingOutstandingReversi(req.user.email, employeeId);
  }

  // ---------- Zarade (SAMO admin — kadrovska.salary) ----------

  @Get("salary/terms")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  salaryTerms(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.salaryTerms(req.user.email, q);
  }

  @Get("salary/current")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  salaryCurrent(@Req() req: AuthedRequest, @Query() q: ByEmployeeQueryDto) {
    return this.kadrovska.salaryCurrent(req.user.email, q);
  }

  @Get("salary/payroll")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  salaryPayroll(@Req() req: AuthedRequest, @Query() q: MonthQueryDto) {
    return this.kadrovska.salaryPayroll(req.user.email, q);
  }
}
