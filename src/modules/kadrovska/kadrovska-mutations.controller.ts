import {
  Body,
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PermissionsGuard } from "../../common/authz/permissions.guard";
import { RequirePermission } from "../../common/authz/require-permission.decorator";
import { PERMISSIONS } from "../../common/authz/permissions";
import { KadrovskaMutationsService } from "./kadrovska-mutations.service";
import * as D from "./dto/kadrovska-mutation.dto";

interface AuthedRequest {
  user: { userId: number; email: string; role: string };
}

/**
 * Kadrovska (HR) — 3.0 TALAS G, R2 MUTACIONI endpointi (MODULE_SPEC_kadrovska_30.md §3).
 * Bazna klasa `kadrovska.read` (vidljivost modula), stroža prava po ruti kroz
 * per-method `@RequirePermission`. ROW/PII maska OSTAJE u sy15 (RLS + DEFINER RPC
 * kroz GUC most; servis izvršava sve kroz withUserRls/runIdempotentRls).
 *
 * Zaseban kontroler od R1 read-a (isti path/version) — GET vs POST/PATCH/DELETE
 * disambiguacija; literal rute deklarisane pre param ruta iste metode.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermission(PERMISSIONS.KADROVSKA_READ)
@Controller({ path: "kadrovska", version: "1" })
export class KadrovskaMutationsController {
  constructor(private readonly m: KadrovskaMutationsService) {}

  private email(req: AuthedRequest) {
    return req.user.email;
  }

  // ---------- ODMORI ----------

  @Post("vacation/entitlements")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACATION_EDIT)
  saveEntitlement(@Req() req: AuthedRequest, @Body() dto: D.SaveEntitlementDto) {
    return this.m.saveEntitlement(this.email(req), dto);
  }

  @Post("vacation/correct")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACATION_EDIT)
  correctBalance(@Req() req: AuthedRequest, @Body() dto: D.CorrectBalanceDto) {
    return this.m.correctBalance(this.email(req), dto);
  }

  @Post("vacation/advance")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACATION_EDIT)
  advance(@Req() req: AuthedRequest, @Body() dto: D.AdvanceApprovalDto) {
    return this.m.setAdvanceApproval(this.email(req), dto);
  }

  @Post("vacation/rollover")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACATION_EDIT)
  rollover(@Req() req: AuthedRequest, @Body() dto: D.RolloverDto) {
    return this.m.rollover(this.email(req), dto);
  }

  @Post("vacation/bonus")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  bonus(@Req() req: AuthedRequest, @Body() dto: D.BonusGoDto) {
    return this.m.grantBonusGo(this.email(req), dto);
  }

  /** Podnošenje GO zahteva — self (∨ mgmt). Guard = coarse-superset `profile.self`
   *  (SVE aktivne uloge — pm/leadpm menadžeri i self-podnosioci); vr_insert RLS
   *  (self ∨ has_edit_role∧manages_employee ∨ admin/hr/vacreq_admin) presuđuje red. */
  @Post("requests/vacation")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  submitVacation(@Req() req: AuthedRequest, @Body() dto: D.SubmitVacationDto) {
    return this.m.submitVacation(this.email(req), dto);
  }

  @Post("requests/vacation/:id/approve")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacApprove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.vacationApprove(this.email(req), id, dto);
  }
  @Post("requests/vacation/:id/vacreq-approve")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacVacreqApprove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.vacationVacreqApprove(this.email(req), id, dto);
  }
  @Post("requests/vacation/:id/reject")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacReject(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.RejectDto) {
    return this.m.vacationReject(this.email(req), id, dto);
  }
  @Post("requests/vacation/:id/reschedule")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacReschedule(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.RescheduleVacationDto) {
    return this.m.vacationReschedule(this.email(req), id, dto);
  }
  @Post("requests/vacation/:id/revise")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacRevise(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.ReviseVacationDto) {
    return this.m.vacationRevise(this.email(req), id, dto);
  }
  @Post("requests/vacation/:id/cancel")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacCancel(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.vacationCancel(this.email(req), id, dto);
  }
  @Delete("requests/vacation/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  vacDelete(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.vacationDelete(this.email(req), id, {});
  }

  /* Nadoknada */
  @Post("requests/makeup/:id/approve")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  mkApprove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.makeupApprove(this.email(req), id, dto);
  }
  @Post("requests/makeup/:id/reject")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  mkReject(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.RejectDto) {
    return this.m.makeupReject(this.email(req), id, dto);
  }
  @Post("requests/makeup/:id/complete")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  mkComplete(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.makeupComplete(this.email(req), id, dto);
  }
  @Post("requests/makeup/:id/storno")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  mkStorno(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.StornoMakeupDto) {
    return this.m.makeupStorno(this.email(req), id, dto);
  }
  @Delete("requests/makeup/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  mkDelete(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.makeupDelete(this.email(req), id, {});
  }

  /* Plaćeno odsustvo */
  @Post("requests/paid-leave/:id/approve")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  plApprove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.paidLeaveApprove(this.email(req), id, dto);
  }
  @Post("requests/paid-leave/:id/reject")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  plReject(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.RejectDto) {
    return this.m.paidLeaveReject(this.email(req), id, dto);
  }
  @Delete("requests/paid-leave/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_VACREQ_MANAGE)
  plDelete(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.paidLeaveDelete(this.email(req), id, {});
  }

  /* Neplaćeno (nop) — SAMO admin */
  @Post("requests/nop/:id/approve")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  nopApprove(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.nopApprove(this.email(req), id, dto);
  }
  @Post("requests/nop/:id/reject")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  nopReject(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.RejectDto) {
    return this.m.nopReject(this.email(req), id, dto);
  }

  /* Odsustva CRUD (kadrovska.edit; neplaceno=admin kroz RLS) */
  @Post("absences")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  createAbsence(@Req() req: AuthedRequest, @Body() dto: D.CreateAbsenceDto) {
    return this.m.createAbsence(this.email(req), dto);
  }
  @Patch("absences/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  updateAbsence(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateAbsenceDto) {
    return this.m.updateAbsence(this.email(req), id, dto);
  }
  @Delete("absences/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  deleteAbsence(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteAbsence(this.email(req), id);
  }

  // ---------- SATI ----------

  @Post("grid/batch")
  @RequirePermission(PERMISSIONS.KADROVSKA_GRID_EDIT)
  gridBatch(@Req() req: AuthedRequest, @Body() dto: D.GridBatchDto) {
    return this.m.gridBatch(this.email(req), dto);
  }
  @Post("grid/go/set")
  @RequirePermission(PERMISSIONS.KADROVSKA_GRID_EDIT)
  gridSetGo(@Req() req: AuthedRequest, @Body() dto: D.GridGoDto) {
    return this.m.gridSetGo(this.email(req), dto);
  }
  @Post("grid/go/unset")
  @RequirePermission(PERMISSIONS.KADROVSKA_GRID_EDIT)
  gridUnsetGo(@Req() req: AuthedRequest, @Body() dto: D.GridGoDto) {
    return this.m.gridUnsetGo(this.email(req), dto);
  }
  @Post("grid/audit")
  @RequirePermission(PERMISSIONS.KADROVSKA_GRID_EDIT)
  gridAudit(
    @Req() req: AuthedRequest,
    @Query("employeeId") employeeId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.m.gridAudit(this.email(req), employeeId, from, to);
  }

  @Post("work-hours/remarks")
  createRemark(@Req() req: AuthedRequest, @Body() dto: D.CreateRemarkDto) {
    return this.m.createRemark(this.email(req), dto);
  }
  @Patch("work-hours/remarks/:id/resolve")
  @RequirePermission(PERMISSIONS.KADROVSKA_GRID_EDIT)
  resolveRemark(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.ResolveRemarkDto) {
    return this.m.resolveRemark(this.email(req), id, dto);
  }

  /* Prisustvo korekcije — own ∨ manager. Guard = coarse-superset `profile.self`
     (sve aktivne uloge); RPC (own ∨ manager scope) presuđuje. */
  @Post("attendance/corrections")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  submitCorrection(@Req() req: AuthedRequest, @Body() dto: D.SubmitCorrectionDto) {
    return this.m.submitCorrection(this.email(req), dto);
  }
  @Post("attendance/corrections/:id/cancel")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  cancelCorrection(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.cancelCorrection(this.email(req), id, dto);
  }
  @Post("attendance/extra-recipients")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  addExtra(@Req() req: AuthedRequest, @Body() dto: D.ExtraRecipientDto) {
    return this.m.addExtraRecipient(this.email(req), dto);
  }
  @Delete("attendance/extra-recipients/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  delExtra(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteExtraRecipient(this.email(req), id);
  }

  // ---------- ZAPOSLENI ----------

  @Post("employees")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  createEmployee(@Req() req: AuthedRequest, @Body() dto: D.CreateEmployeeDto) {
    return this.m.createEmployee(this.email(req), dto);
  }

  /* Storage proxy (kadrovska.pii) — PRE param `employees/:id` (dublja putanja, ok) */
  @Post("employees/:id/documents")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  @UseInterceptors(FileInterceptor("file"))
  uploadDoc(
    @Req() req: AuthedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: D.DocumentMetaDto,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.m.uploadEmployeeDocument(this.email(req), id, dto, file);
  }
  @Post("documents/:docId/sign")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  signDoc(@Req() req: AuthedRequest, @Param("docId", ParseUUIDPipe) docId: string) {
    return this.m.signEmployeeDocument(this.email(req), docId);
  }
  @Delete("documents/:docId")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  deleteDoc(@Req() req: AuthedRequest, @Param("docId", ParseUUIDPipe) docId: string) {
    return this.m.deleteEmployeeDocument(this.email(req), docId);
  }

  /* PII pod-resursi */
  @Post("employees/:id/children")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  createChild(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateChildDto) {
    return this.m.createChild(this.email(req), id, dto);
  }
  @Patch("children/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  updateChild(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateChildDto) {
    return this.m.updateChild(this.email(req), id, dto);
  }
  @Delete("children/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  deleteChild(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteChild(this.email(req), id);
  }

  @Post("employees/:id/bank-cards")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  createBank(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateBankCardDto) {
    return this.m.createBankCard(this.email(req), id, dto);
  }
  @Patch("bank-cards/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  updateBank(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateBankCardDto) {
    return this.m.updateBankCard(this.email(req), id, dto);
  }
  @Delete("bank-cards/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  deleteBank(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteBankCard(this.email(req), id);
  }

  @Post("employees/:id/foreign-docs")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  createForeign(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreatePiiDocDto) {
    return this.m.createForeignDoc(this.email(req), id, dto);
  }
  @Patch("foreign-docs/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  updateForeign(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdatePiiDocDto) {
    return this.m.updateForeignDoc(this.email(req), id, dto);
  }
  @Delete("foreign-docs/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  deleteForeign(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteForeignDoc(this.email(req), id);
  }

  @Post("employees/:id/personal-docs")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  createPersonal(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreatePiiDocDto) {
    return this.m.createPersonalDoc(this.email(req), id, dto);
  }
  @Patch("personal-docs/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  updatePersonal(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdatePiiDocDto) {
    return this.m.updatePersonalDoc(this.email(req), id, dto);
  }
  @Delete("personal-docs/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_PII)
  deletePersonal(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deletePersonalDoc(this.email(req), id);
  }

  /* Zaposleni update/deactivate/purge — param rute POSLE literal `employees/*` */
  @Patch("employees/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  updateEmployee(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateEmployeeDto) {
    return this.m.updateEmployee(this.email(req), id, dto);
  }
  @Post("employees/:id/deactivate")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  deactivate(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.deactivateEmployee(this.email(req), id, dto);
  }
  @Delete("employees/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  purge(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.purgeEmployee(this.email(req), id);
  }

  /* Medical / Certs (manage) */
  @Post("employees/:id/medical-exams")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  createMedical(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateMedicalDto) {
    return this.m.createMedical(this.email(req), id, dto);
  }
  @Patch("medical-exams/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  updateMedical(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateMedicalDto) {
    return this.m.updateMedical(this.email(req), id, dto);
  }
  @Delete("medical-exams/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  deleteMedical(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteMedical(this.email(req), id);
  }
  @Post("employees/:id/certificates")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  createCert(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateCertDto) {
    return this.m.createCert(this.email(req), id, dto);
  }
  @Patch("certificates/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  updateCert(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateCertDto) {
    return this.m.updateCert(this.email(req), id, dto);
  }
  @Delete("certificates/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  deleteCert(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteCert(this.email(req), id);
  }

  /* Ugovori (edit) + set-salary (admin) */
  @Post("employees/:id/contracts")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  createContract(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateContractDto) {
    return this.m.createContract(this.email(req), id, dto);
  }
  @Post("employees/:id/contract-salary")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  setContractSalary(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.ContractSalaryDto) {
    return this.m.setContractSalary(this.email(req), id, dto);
  }
  @Patch("contracts/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  updateContract(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateContractDto) {
    return this.m.updateContract(this.email(req), id, dto);
  }
  @Post("contracts/:id/archive")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  archiveContract(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.archiveContract(this.email(req), id, false);
  }
  @Post("contracts/:id/restore")
  @RequirePermission(PERMISSIONS.KADROVSKA_EDIT)
  restoreContract(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.archiveContract(this.email(req), id, true);
  }

  /* Uvođenje / Izlazak (manage) */
  @Post("onboarding/start")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  onboardingStart(@Req() req: AuthedRequest, @Body() dto: D.OnboardingStartDto) {
    return this.m.onboardingStart(this.email(req), dto);
  }
  @Patch("onboarding/tasks/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  onboardingTask(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OnboardingTaskDto) {
    return this.m.onboardingTask(this.email(req), id, dto);
  }
  /** „✓ Završi tok" / „Otkaži tok" — run.status done/canceled (1.0 setOnbRunStatus). */
  @Patch("onboarding/runs/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  onboardingRunStatus(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OnboardingRunStatusDto) {
    return this.m.onboardingRunStatus(this.email(req), id, dto);
  }
  /* Šabloni + stavke (manage; RLS kadr_can_manage_hr). Brisanje šablona: tokovi ostaju. */
  @Post("onboarding/templates")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  createOnbTemplate(@Req() req: AuthedRequest, @Body() dto: D.CreateOnbTemplateDto) {
    return this.m.createOnbTemplate(this.email(req), dto);
  }
  @Delete("onboarding/templates/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  deleteOnbTemplate(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteOnbTemplate(this.email(req), id);
  }
  @Post("onboarding/template-items")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  createOnbItem(@Req() req: AuthedRequest, @Body() dto: D.CreateOnbTemplateItemDto) {
    return this.m.createOnbTemplateItem(this.email(req), dto);
  }
  @Delete("onboarding/template-items/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  deleteOnbItem(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteOnbTemplateItem(this.email(req), id);
  }

  /* Razvoj / razgovori / 360 (dev_manage; self/read za neke) */
  @Post("dev-plans")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createDevPlan(@Req() req: AuthedRequest, @Body() dto: D.CreateDevPlanDto) {
    return this.m.createDevPlan(this.email(req), dto);
  }
  @Post("dev-plans/:id/checkins")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createCheckin(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.CreateCheckinDto) {
    return this.m.createCheckin(this.email(req), id, dto);
  }
  @Patch("dev-plans/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  updateDevPlan(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateDevPlanDto) {
    return this.m.updateDevPlan(this.email(req), id, dto);
  }
  /** Brisanje plana (1.0 admin dugme; RLS dp_delete=admin) — ciljevi se odvezuju (FK). */
  @Delete("dev-plans/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  deleteDevPlan(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteDevPlan(this.email(req), id);
  }
  /** Brisanje beleške 1-na-1 (RLS dc_delete: autor ∨ manages_dev_plan). */
  @Delete("checkins/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  deleteCheckin(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteCheckin(this.email(req), id);
  }
  @Post("expectations")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createExpectation(@Req() req: AuthedRequest, @Body() dto: D.CreateExpectationDto) {
    return this.m.createExpectation(this.email(req), dto);
  }
  @Patch("expectations/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  updateExpectation(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateExpectationDto) {
    return this.m.updateExpectation(this.email(req), id, dto);
  }
  /** Brisanje razvojnog cilja (1.0 admin dugme; RLS ee_delete=admin). */
  @Delete("expectations/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_ADMIN)
  deleteExpectation(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteExpectation(this.email(req), id);
  }
  @Post("talks")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createTalk(@Req() req: AuthedRequest, @Body() dto: D.CreateTalkDto) {
    return this.m.createTalk(this.email(req), dto);
  }
  @Post("talks/:id/share")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  talkShare(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.talkShare(this.email(req), id, dto);
  }
  @Post("talks/:id/unshare")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  talkUnshare(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.talkUnshare(this.email(req), id, dto);
  }
  /** „Upoznat sam" — zaposleni potvrđuje (self). Guard = `profile.self` (svi
   *  zaposleni potvrđuju svoj razgovor); RPC self-scope presuđuje. */
  @Post("talks/:id/acknowledge")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  talkAck(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.talkAcknowledge(this.email(req), id, dto);
  }
  @Patch("talks/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  updateTalk(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateTalkDto) {
    return this.m.updateTalk(this.email(req), id, dto);
  }
  /** Brisanje zapisnika (1.0: nacrt=autor, podeljen/potvrđen=SAMO admin) — guard
   *  dev_manage, razliku presuđuje RLS talks_delete (admin ∨ manage∧nacrt). */
  @Delete("talks/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  deleteTalk(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteTalk(this.email(req), id);
  }
  /* Korektivni planovi (1.0 saveCorrectivePlan/updateCorrectivePlan; RLS cplans_*) */
  @Post("corrective-plans")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createCorrectivePlan(@Req() req: AuthedRequest, @Body() dto: D.CreateCorrectivePlanDto) {
    return this.m.createCorrectivePlan(this.email(req), dto);
  }
  @Patch("corrective-plans/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  updateCorrectivePlan(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateCorrectivePlanDto) {
    return this.m.updateCorrectivePlan(this.email(req), id, dto);
  }
  @Post("corrective-measures")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  createMeasure(@Req() req: AuthedRequest, @Body() dto: D.CreateMeasureDto) {
    return this.m.createMeasure(this.email(req), dto);
  }
  @Patch("corrective-measures/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  updateMeasure(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateMeasureDto) {
    return this.m.updateMeasure(this.email(req), id, dto);
  }
  @Delete("corrective-measures/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  deleteMeasure(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteMeasure(this.email(req), id);
  }

  /* 360 procene */
  @Post("assessments/360")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  open360(@Req() req: AuthedRequest, @Body() dto: D.Open360Dto) {
    return this.m.assessmentOpen360(this.email(req), dto);
  }
  /** 360 kampanja — RPC gate = current_user_can_manage_org_profile ∨ admin
   *  (= admin/menadzment/pm/leadpm). DEV_MANAGE je najuži ključ koji ih sve pušta
   *  (superskup uz hr, kog RPC 42501-uje ako nije org_profile — defense-in-depth). */
  @Post("assessments/campaign")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  openCampaign(@Req() req: AuthedRequest, @Body() dto: D.OpenCampaignDto) {
    return this.m.assessmentOpenCampaign(this.email(req), dto);
  }
  /** Samoprocena — self (deljeno sa Moj profil/D). Guard = `profile.self` (svaki
   *  zaposleni pokreće/predaje svoju samoprocenu); RPC self-scope presuđuje. */
  @Post("assessments/self")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  openSelf(@Req() req: AuthedRequest, @Body() dto: D.OpenSelfDto) {
    return this.m.assessmentOpenSelf(this.email(req), dto);
  }
  @Post("assessments/:id/self-submit")
  @RequirePermission(PERMISSIONS.PROFILE_SELF)
  selfSubmit(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentSelfSubmit(this.email(req), id, dto);
  }
  @Post("assessments/:id/targets")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  setTargets(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.SetTargetsDto) {
    return this.m.assessmentSetTargets(this.email(req), id, dto);
  }
  @Post("assessments/:id/compute")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  compute(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentCompute(this.email(req), id, dto);
  }
  @Post("assessments/:id/gap")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  gap(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.GapToGoalsDto) {
    return this.m.assessmentGap(this.email(req), id, dto);
  }
  @Post("assessments/:id/share")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  share(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentShare(this.email(req), id, dto);
  }
  @Post("assessments/:id/unshare")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  unshare(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentUnshare(this.email(req), id, dto);
  }
  @Post("assessments/:id/close")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  close(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentClose(this.email(req), id, dto);
  }
  @Post("assessments/:id/reopen")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  reopen(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.assessmentReopen(this.email(req), id, dto);
  }
  @Post("assessments/:id/state")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  setState(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.SetStateDto) {
    return this.m.assessmentSetState(this.email(req), id, dto);
  }
  /** Upis ocena po rater id (leader) — 1.0 saveScores upsert; RLS asc_write (svoj
   *  rater ∧ collecting) presuđuje, pa tuđi rater id → 403.
   *
   *  TODO(paket „Moj profil → Moja procena", review #25): ruta NAMERNO ostaje pod
   *  dev_manage (rukovodilački 360 modal) i NE pokriva 1.0 SELF-assessment tok
   *  (običan zaposleni upisuje svoje ocene/odgovore). Self tok dobija ODVOJENE rute
   *  `POST assessments/self/scores` + `assessments/self/answers` pod PROFILE_SELF
   *  (isti obrazac kao postojeći assessments/self i :id/self-submit) — RLS asc_write
   *  (rater=pozivalac ∧ collecting) tada presuđuje 1.0-verno. NE labaviti guard ovde.
   *  ⚠️ kb2 još NEMA rutu za assessment_answers (1.0 saveAnswers) — bez nje self tok
   *  gubi odgovore na otvorena pitanja, a submit prolazi (prazna procena). */
  @Post("assessments/raters/:raterId/scores")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  saveScores(@Req() req: AuthedRequest, @Param("raterId", ParseUUIDPipe) raterId: string, @Body() dto: D.SaveScoresDto) {
    return this.m.assessmentSaveScores(this.email(req), raterId, dto);
  }
  /** ✉ Pozivnice za CEO ciklus (kampanju) + rezime kreatoru — port edge fn
   *  assessment-invite (cycle režim). 4-segmentna literal ruta, ne sudara se sa :id. */
  @Post("assessments/cycles/:cycleId/invite")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  inviteCycle(@Req() req: AuthedRequest, @Param("cycleId", ParseUUIDPipe) cycleId: string, @Body() dto: D.InviteCycleDto) {
    return this.m.assessmentInvite(this.email(req), { cycleId, notifyCreator: dto.notifyCreator });
  }
  /** ✉ Pozivnice za jednu procenu — port edge fn assessment-invite. */
  @Post("assessments/:id/invite")
  @RequirePermission(PERMISSIONS.KADROVSKA_DEV_MANAGE)
  invite(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    void dto;
    return this.m.assessmentInvite(this.email(req), { assessmentId: id });
  }

  // ---------- ZARADE (SAMO admin) ----------

  @Post("salary/terms")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  createTerm(@Req() req: AuthedRequest, @Body() dto: D.CreateSalaryTermDto) {
    return this.m.createSalaryTerm(this.email(req), dto);
  }
  @Patch("salary/terms/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  updateTerm(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.UpdateSalaryTermDto) {
    return this.m.updateSalaryTerm(this.email(req), id, dto);
  }
  @Delete("salary/terms/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  deleteTerm(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.deleteSalaryTerm(this.email(req), id);
  }
  @Post("salary/payroll/init")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  payrollInit(@Req() req: AuthedRequest, @Body() dto: D.PayrollInitDto) {
    return this.m.payrollInit(this.email(req), dto);
  }
  @Post("salary/payroll/upsert")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  payrollUpsert(@Req() req: AuthedRequest, @Body() dto: D.PayrollUpsertDto) {
    return this.m.payrollUpsert(this.email(req), dto);
  }
  @Post("salary/payroll/recompute")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  payrollRecompute(@Req() req: AuthedRequest, @Body() dto: D.PayrollRecomputeDto) {
    return this.m.payrollRecompute(this.email(req), dto);
  }
  @Post("salary/payroll/:id/lock")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  payrollLock(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.PayrollLockDto) {
    return this.m.payrollLock(this.email(req), id, dto);
  }
  @Post("salary/payroll/:id/unlock")
  @RequirePermission(PERMISSIONS.KADROVSKA_SALARY)
  payrollUnlock(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() dto: D.OptIdempotentDto) {
    return this.m.payrollUnlock(this.email(req), id, dto);
  }

  // ---------- NOTIFIKACIJE (manage) ----------

  @Patch("notification-config")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notifConfig(@Req() req: AuthedRequest, @Body() dto: D.NotificationConfigDto) {
    return this.m.updateNotificationConfig(this.email(req), dto);
  }
  @Post("notifications/:id/retry")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notifRetry(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.notificationRetry(this.email(req), id);
  }
  @Post("notifications/:id/cancel")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notifCancel(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.notificationCancel(this.email(req), id);
  }
  @Delete("notifications/:id")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  notifDelete(@Req() req: AuthedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.m.notificationDelete(this.email(req), id);
  }
  @Post("notifications/hr-reminders/run")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  hrReminders(@Req() req: AuthedRequest) {
    return this.m.triggerHrReminders(this.email(req));
  }
  @Post("reports/risk/run")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  riskRun(@Req() req: AuthedRequest) {
    return this.m.triggerWeeklyRisk(this.email(req));
  }
  @Post("notifications/payroll/run")
  @RequirePermission(PERMISSIONS.KADROVSKA_MANAGE)
  payrollNotify(@Req() req: AuthedRequest, @Body() dto: D.PayrollNotifyDto) {
    return this.m.triggerPayrollNotifications(this.email(req), dto);
  }
}
