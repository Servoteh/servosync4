import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

/**
 * Mutacioni DTO-ovi — Kadrovska R2 (MODULE_SPEC_kadrovska_30.md §3).
 *
 * Idempotencija (doktrina A4; modul nema svoj mehanizam → `rev_api_idempotency`):
 *  - `clientEventId` (uuid) je OBAVEZAN na POST-ovima koji KREIRAJU nov red
 *    (submit zahteva, create absence/medical/cert/PII/contract/salary_term/
 *    dev-plan/onboarding-start/entitlement) — `runIdempotentRls`.
 *  - Odluke/prelazi (approve/reject/reschedule/…/patch/delete/toggle) nose
 *    OPCIONI `clientEventId`; kad ga FE pošalje → `runIdempotentRls`, inače
 *    `withUserRls` (naturalno guardovano status-proverom u DEFINER RPC-u).
 * DTO validacija (numerički/uuid/datum) → 400 pre dodira baze.
 */

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/** Obavezan idempotency ključ (kreiranje novog reda). */
export class IdempotentDto {
  @IsUUID() clientEventId!: string;
}

/** Opcioni idempotency ključ (odluke/prelazi). */
export class OptIdempotentDto {
  @IsOptional() @IsUUID() clientEventId?: string;
}

/* ════════════════ ODMORI ════════════════ */

export class SubmitVacationDto extends IdempotentDto {
  /** Za koga (menadžer/HR podnosi za drugog); prazno = za sebe (RLS presuđuje). */
  @IsOptional() @IsUUID() employeeId?: string;
  @IsInt() year!: number;
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) daysCount!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class RejectDto extends OptIdempotentDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class RescheduleVacationDto extends OptIdempotentDto {
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) daysCount!: number;
}

export class ReviseVacationDto extends OptIdempotentDto {
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) daysCount!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() forceReapproval?: boolean;
}

/** saveEntitlement (upsert vacation_entitlements; can_edit_vacation_balance). */
export class SaveEntitlementDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsInt() year!: number;
  @IsInt() @Min(0) daysTotal!: number;
  @IsOptional() @IsInt() daysCarriedOver?: number;
  @IsOptional() @IsInt() openingUsed?: number;
  @IsOptional() @IsBoolean() accrualModel?: boolean;
  @IsOptional() @IsInt() accrualBase?: number;
  @IsOptional() @IsISO8601() accrualStart?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class CorrectBalanceDto extends OptIdempotentDto {
  @IsUUID() employeeId!: string;
  @IsInt() year!: number;
  @IsInt() targetRemaining!: number;
  @IsOptional() @IsInt() accrual?: number;
}

export class AdvanceApprovalDto extends OptIdempotentDto {
  @IsUUID() employeeId!: string;
  @IsInt() year!: number;
  @IsBoolean() approved!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class RolloverDto extends OptIdempotentDto {
  @IsInt() fromYear!: number;
  @IsInt() toYear!: number;
  /** Podrazumevano true (samo simulacija) — paritet hr_rollover_year. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

export class BonusGoDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() workDate!: string;
  @IsOptional() @IsNumber() days?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsUUID() makeupRequestId?: string;
}

export class StornoMakeupDto extends OptIdempotentDto {
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/* Odsustva CRUD (Prisma; RLS admin∨hr∨edit∧manages; neplaceno=admin) */
export class CreateAbsenceDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() type!: string;
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsOptional() @IsInt() daysCount?: number;
  @IsOptional() @IsString() paidReason?: string;
  @IsOptional() @IsString() absenceSubtype?: string;
  @IsOptional() @IsString() slobodanReason?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class UpdateAbsenceDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsISO8601() dateFrom?: string;
  @IsOptional() @IsISO8601() dateTo?: string;
  @IsOptional() @IsInt() daysCount?: number;
  @IsOptional() @IsString() paidReason?: string;
  @IsOptional() @IsString() absenceSubtype?: string;
  @IsOptional() @IsString() slobodanReason?: string;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

/* ════════════════ SATI ════════════════ */

export class WorkHoursRowDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() workDate!: string;
  @IsOptional() @IsNumber() hours?: number;
  @IsOptional() @IsNumber() overtimeHours?: number;
  @IsOptional() @IsNumber() fieldHours?: number;
  @IsOptional() @IsIn(["domestic", "foreign"]) fieldSubtype?: string;
  @IsOptional() @IsNumber() twoMachineHours?: number;
  @IsOptional() @IsString() absenceCode?: string;
  @IsOptional() @IsString() absenceSubtype?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() projectRef?: string;
  /** Teren→predmet vezivanje (bigtehn_items_cache broj/naziv). Batch RPC ih ne
   *  prima → servis ih upisuje direktnim RLS UPDATE-om (grid_edit) posle batch-a. */
  @IsOptional() @IsString() fieldPredmetBroj?: string;
  @IsOptional() @IsString() fieldPredmetNaziv?: string;
}

export class GridBatchDto extends OptIdempotentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => WorkHoursRowDto)
  rows!: WorkHoursRowDto[];
}

export class GridGoDto extends OptIdempotentDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
}

export class CreateRemarkDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsInt() year!: number;
  @IsInt() month!: number;
  @IsString() @MaxLength(2000) note!: string;
}

export class ResolveRemarkDto extends OptIdempotentDto {
  @IsOptional() @IsIn(["open", "resolved"]) status?: string;
}

export class SubmitCorrectionDto extends OptIdempotentDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() day!: string;
  @IsOptional() @Matches(TIME_RE) in?: string;
  @IsOptional() @Matches(TIME_RE) out?: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

export class ExtraRecipientDto extends IdempotentDto {
  @IsString() email!: string;
  @IsOptional() @IsInt() subDepartmentId?: number;
  @IsOptional() @IsString() note?: string;
}

/** Predlog neplaćenog dana (nop_requests INSERT; RLS has_edit_role∧manages_employee).
 *  Kreiranje → kadr_queue_nop_notification('requested'). Direktan upis u grid = admin. */
export class CreateNopDto extends OptIdempotentDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() workDate!: string;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

/* ════════════════ ZAPOSLENI ════════════════ */

/**
 * CREATE zaposlenog — PUN 1.0 skup (CRITICAL #1, adversarni review 14.07):
 * ValidationPipe whitelist TIHO BRIŠE ključeve kojih nema u DTO-u, pa je uži DTO
 * gubio JMBG/rođenje/pol/lekarski/telefon/PII blok bez ikakve greške. Skup =
 * 1.0 buildEmployeePayload (services/employees.js:97-140). PII gating NE radi
 * guard nego ŽIVI DB trigger `employees_sensitive_guard` (INSERT sa PII bez
 * can_manage_employee_pii → 42501 → naš 403) — upis ide pod GUC claims
 * pozivaoca kroz runIdempotentRls, pa trigger vidi pravog korisnika.
 */
export class CreateEmployeeDto extends IdempotentDto {
  @IsString() @MaxLength(300) fullName!: string;
  @IsString() workType!: string;
  @IsOptional() @IsString() @MaxLength(150) firstName?: string;
  @IsOptional() @IsString() @MaxLength(150) lastName?: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsInt() departmentId?: number;
  @IsOptional() @IsInt() subDepartmentId?: number;
  @IsOptional() @IsInt() positionId?: number;
  @IsOptional() @IsString() team?: string;
  /** 1.0 kolona je `phone` (FE šalje phoneWork) — servis mapira phoneWork→phone. */
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() phoneWork?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsISO8601() hireDate?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  // Osnovni karton (nije PII-maskiran u view-u):
  @IsOptional() @IsISO8601() birthDate?: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() slava?: string;
  @IsOptional() @IsString() slavaDay?: string;
  @IsOptional() @IsString() educationLevel?: string;
  @IsOptional() @IsString() educationTitle?: string;
  @IsOptional() @IsISO8601() medicalExamDate?: string;
  @IsOptional() @IsISO8601() medicalExamExpires?: string;
  // PII blok (DB trigger presuđuje — 42501 bez kadrovska.pii kruga):
  @IsOptional() @IsString() personalId?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() postalCode?: string;
  @IsOptional() @IsString() bankName?: string;
  @IsOptional() @IsString() bankAccount?: string;
  @IsOptional() @IsString() phonePrivate?: string;
  @IsOptional() @IsString() emergencyContactName?: string;
  @IsOptional() @IsString() emergencyContactPhone?: string;
  @IsOptional() @IsString() emergencyContactRelation?: string;
  @IsOptional() @IsString() emergencyContactPhoneAlt?: string;
}

/** hr_update_employee(p_id, p_patch, p_expected_updated_at) — optimistic lock. */
export class UpdateEmployeeDto {
  @IsObject() patch!: Record<string, unknown>;
  /** Očekivani updated_at (ISO) — nepoklapanje → 409 (stale). */
  @IsOptional() @IsISO8601() expectedUpdatedAt?: string;
}

/* PII pod-resursi (kadrovska.pii; RLS can_manage_employee_pii) */
export class CreateChildDto extends IdempotentDto {
  @IsString() firstName!: string;
  @IsOptional() @IsISO8601() birthDate?: string;
  @IsOptional() @IsString() note?: string;
}
export class UpdateChildDto {
  @IsOptional() @IsString() firstName?: string;
  @IsOptional() @IsISO8601() birthDate?: string;
  @IsOptional() @IsString() note?: string;
}
export class CreateBankCardDto extends IdempotentDto {
  @IsString() bank!: string;
  @IsOptional() @IsString() cardNumber?: string;
  @IsOptional() @IsISO8601() validThru?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() note?: string;
}
export class UpdateBankCardDto {
  @IsOptional() @IsString() bank?: string;
  @IsOptional() @IsString() cardNumber?: string;
  @IsOptional() @IsISO8601() validThru?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() note?: string;
}
/** Strani/lični dokumenti — dinamička polja (raznovrsna); validira se kao objekat. */
export class CreatePiiDocDto extends IdempotentDto {
  @IsObject() data!: Record<string, unknown>;
}
export class UpdatePiiDocDto {
  @IsObject() data!: Record<string, unknown>;
}

/* Medical / Certs (kadrovska.manage) */
export class CreateMedicalDto extends IdempotentDto {
  @IsISO8601() examDate!: string;
  @IsString() examType!: string;
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsString() institution?: string;
  @IsOptional() @IsNumber() costRsd?: number;
  @IsOptional() @IsString() documentUrl?: string;
  @IsOptional() @IsString() note?: string;
}
export class UpdateMedicalDto {
  @IsOptional() @IsISO8601() examDate?: string;
  @IsOptional() @IsString() examType?: string;
  @IsOptional() @IsISO8601() validUntil?: string;
  @IsOptional() @IsString() institution?: string;
  @IsOptional() @IsNumber() costRsd?: number;
  @IsOptional() @IsString() documentUrl?: string;
  @IsOptional() @IsString() note?: string;
}
export class CreateCertDto extends IdempotentDto {
  @IsString() certType!: string;
  @IsString() certName!: string;
  @IsISO8601() issuedOn!: string;
  @IsOptional() @IsISO8601() expiresOn?: string;
  @IsOptional() @IsString() issuer?: string;
  @IsOptional() @IsString() documentNo?: string;
  @IsOptional() @IsNumber() costRsd?: number;
  @IsOptional() @IsString() documentUrl?: string;
  @IsOptional() @IsString() note?: string;
}
export class UpdateCertDto {
  @IsOptional() @IsString() certType?: string;
  @IsOptional() @IsString() certName?: string;
  @IsOptional() @IsISO8601() issuedOn?: string;
  @IsOptional() @IsISO8601() expiresOn?: string;
  @IsOptional() @IsString() issuer?: string;
  @IsOptional() @IsString() documentNo?: string;
  @IsOptional() @IsNumber() costRsd?: number;
  @IsOptional() @IsString() documentUrl?: string;
  @IsOptional() @IsString() note?: string;
}

/* Ugovori (kadrovska.edit; contracts_read za read) */
export class CreateContractDto extends IdempotentDto {
  @IsString() contractType!: string;
  @IsISO8601() dateFrom!: string;
  @IsOptional() @IsISO8601() dateTo?: string;
  @IsOptional() @IsString() contractNumber?: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsBoolean() probniRad?: boolean;
  @IsOptional() @IsInt() probniMeseci?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() note?: string;
}
export class UpdateContractDto {
  @IsOptional() @IsString() contractType?: string;
  @IsOptional() @IsISO8601() dateFrom?: string;
  @IsOptional() @IsISO8601() dateTo?: string;
  @IsOptional() @IsString() contractNumber?: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsBoolean() probniRad?: boolean;
  @IsOptional() @IsInt() probniMeseci?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() note?: string;
}
/** kadr_set_contract_salary(neto,bruto,effective_from,approved_by) — admin. */
export class ContractSalaryDto extends OptIdempotentDto {
  @IsNumber() neto!: number;
  @IsNumber() bruto!: number;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
}

/* Onboarding (kadrovska.manage) */
export class OnboardingStartDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsUUID() templateId!: string;
  @IsOptional() @IsISO8601() startDate?: string;
}
export class OnboardingTaskDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsBoolean() done?: boolean;
  @IsOptional() @IsString() note?: string;
}

/* Razvoj / razgovori / 360 (kadrovska.dev_manage; self za neke) */
export class CreateDevPlanDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() periodLabel!: string;
  @IsOptional() @IsISO8601() periodStart?: string;
  @IsOptional() @IsISO8601() periodEnd?: string;
  @IsOptional() @IsString() careerGoalMd?: string;
  @IsOptional() @IsInt() targetPositionId?: number;
  @IsOptional() @IsUUID() mentorEmployeeId?: string;
  @IsOptional() @IsString() status?: string;
}
export class UpdateDevPlanDto {
  @IsOptional() @IsString() periodLabel?: string;
  @IsOptional() @IsISO8601() periodStart?: string;
  @IsOptional() @IsISO8601() periodEnd?: string;
  @IsOptional() @IsString() careerGoalMd?: string;
  @IsOptional() @IsInt() targetPositionId?: number;
  @IsOptional() @IsUUID() mentorEmployeeId?: string;
  @IsOptional() @IsString() summaryMd?: string;
  @IsOptional() @IsString() selfAssessmentMd?: string;
  @IsOptional() @IsString() status?: string;
}
export class CreateCheckinDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsISO8601() checkinDate!: string;
  @IsOptional() @IsString() authorKind?: string;
  @IsOptional() @IsString() noteMd?: string;
}
export class CreateExpectationDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() title!: string;
  @IsString() category!: string;
  @IsString() priority!: string;
  @IsOptional() @IsString() descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsUUID() planId?: string;
}
export class UpdateExpectationDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsInt() progress?: number;
  @IsOptional() @IsString() completionNote?: string;
}
export class CreateTalkDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() talkType!: string;
  @IsOptional() @IsISO8601() talkDate?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() zapisnikMd?: string;
  @IsOptional() @IsUUID() planId?: string;
}
export class UpdateTalkDto {
  @IsOptional() @IsString() talkType?: string;
  @IsOptional() @IsISO8601() talkDate?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() zapisnikMd?: string;
  @IsOptional() @IsString() status?: string;
}
export class CreateMeasureDto extends IdempotentDto {
  @IsUUID() planId!: string;
  @IsString() descriptionMd!: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsUUID() responsibleEmployeeId?: string;
  @IsOptional() @IsInt() sort?: number;
}
export class UpdateMeasureDto {
  @IsOptional() @IsString() descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsUUID() responsibleEmployeeId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsInt() sort?: number;
}

/* 360 procene */
export class Open360Dto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @IsString() period?: string;
  @IsOptional() @IsArray() @IsUUID("all", { each: true }) peerEmployeeIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) peerEmails?: string[];
  @IsOptional() @IsUUID() cycle?: string;
}
export class OpenCampaignDto extends IdempotentDto {
  @IsString() title!: string;
  @IsString() period!: string;
  @IsArray() @ArrayMinSize(1) @IsUUID("all", { each: true }) employeeIds!: string[];
}
export class OpenSelfDto extends IdempotentDto {
  @IsOptional() @IsString() period?: string;
}
export class SetTargetsDto extends OptIdempotentDto {
  @IsArray() targets!: unknown[];
}
export class GapToGoalsDto extends OptIdempotentDto {
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsNumber() minGap?: number;
}
export class SetStateDto extends OptIdempotentDto {
  @IsString() status!: string;
  @IsBoolean() visible!: boolean;
}

/* Employee documents (storage proxy; kadrovska.pii) */
export class DocumentMetaDto {
  @IsOptional() @IsUUID() clientEventId?: string;
  @IsString() docType!: string;
  @IsOptional() @IsString() description?: string;
  /** Poslati mejl knjigovođi/primaocu nakon uploada (kadr_queue_document_email). */
  @IsOptional() @IsBoolean() queueEmail?: boolean;
  @IsOptional() @IsString() emailLabel?: string;
}

/* ════════════════ ZARADE (admin) ════════════════ */

export class CreateSalaryTermDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() salaryType!: string;
  @IsISO8601() effectiveFrom!: string;
  @IsOptional() @IsISO8601() effectiveTo?: string;
  @IsOptional() @IsString() compensationModel?: string;
  @IsObject() @IsOptional() amounts?: Record<string, unknown>;
  @IsOptional() @IsString() note?: string;
}
export class UpdateSalaryTermDto {
  @IsOptional() @IsString() salaryType?: string;
  @IsOptional() @IsISO8601() effectiveFrom?: string;
  /** P9 dopuna: eksplicitni `null` VRAĆA term na „aktivno" (effective_to=NULL) —
   *  „Ispravi u mestu" tok. `@IsOptional` preskače validaciju za null; izostavljeno
   *  = ne diraj. */
  @IsOptional() @IsISO8601() effectiveTo?: string | null;
  @IsOptional() @IsString() compensationModel?: string;
  @IsObject() @IsOptional() amounts?: Record<string, unknown>;
  @IsOptional() @IsString() note?: string;
}

export class PayrollInitDto extends OptIdempotentDto {
  @IsInt() year!: number;
  @IsInt() @Min(1) month!: number;
}

/** hr_upsert_salary_payroll(p_row) — V2 optimistic (expected_updated_at u row-u). */
export class PayrollUpsertDto extends OptIdempotentDto {
  @IsObject() row!: Record<string, unknown>;
}

export class PayrollLockDto extends OptIdempotentDto {
  @IsISO8601() expectedUpdatedAt!: string;
}

/** Recompute iz grida kroz ported engine (BE). */
export class PayrollRecomputeDto extends OptIdempotentDto {
  @IsInt() year!: number;
  @IsInt() @Min(1) month!: number;
  /** Jedan zaposleni; prazno = svi aktivni (preview/upsert svih). */
  @IsOptional() @IsUUID() employeeId?: string;
  /** true = upiši rezultate (hr_upsert_salary_payroll); false = samo preview. */
  @IsOptional() @IsBoolean() persist?: boolean;
}

/* ════════════════ NOTIFIKACIJE (manage) ════════════════ */

export class NotificationConfigDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() medicalLeadDays?: number;
  @IsOptional() @IsInt() contractLeadDays?: number;
  @IsOptional() @IsBoolean() birthdayEnabled?: boolean;
  @IsOptional() @IsBoolean() workAnniversaryEnabled?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) whatsappRecipients?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) emailRecipients?: string[];
  @IsOptional() @IsBoolean() childBirthdayEnabled?: boolean;
  @IsOptional() @IsBoolean() birthdayOversightEnabled?: boolean;
  @IsOptional() @IsBoolean() birthdayDigestEnabled?: boolean;
  @IsOptional() @IsInt() lkLeadDays?: number;
  @IsOptional() @IsInt() passportLeadDays?: number;
  @IsOptional() @IsInt() driverLicenseLeadDays?: number;
  @IsOptional() @IsInt() medicalEmpLeadDays?: number;
}

export class PayrollNotifyDto extends OptIdempotentDto {
  @IsInt() year!: number;
  @IsInt() @Min(1) month!: number;
}

/** Preusmeravanje queued outbox reda na knjigovođu (1.0 retargetQueuedNotif) —
 *  UPDATE recipient/subject/body WHERE status='queued' (RLS hr_or_admin). */
export class RetargetNotifDto {
  @IsString() recipient!: string;
  @IsOptional() @IsString() @MaxLength(500) subject?: string;
  @IsOptional() @IsString() body?: string;
}
