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
  Max,
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

/* ════════════════ ZAPOSLENI ════════════════ */

export class CreateEmployeeDto extends IdempotentDto {
  @IsString() @MaxLength(300) fullName!: string;
  @IsString() workType!: string;
  @IsOptional() @IsString() position?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsInt() departmentId?: number;
  @IsOptional() @IsInt() subDepartmentId?: number;
  @IsOptional() @IsInt() positionId?: number;
  @IsOptional() @IsString() team?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsISO8601() hireDate?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
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
/** Promena statusa toka: „✓ Završi tok" (done) / „Otkaži tok" (canceled) — 1.0 setOnbRunStatus. */
export class OnboardingRunStatusDto extends OptIdempotentDto {
  @IsIn(["active", "done", "canceled"]) status!: string;
}
/** Šablon uvođenja/izlaska (naziv + tip). */
export class CreateOnbTemplateDto extends IdempotentDto {
  @IsString() @MaxLength(200) name!: string;
  @IsIn(["onboarding", "offboarding"]) kind!: string;
}
/** Stavka šablona (naziv, zaduženi hint, rok +N dana, sort). */
export class CreateOnbTemplateItemDto extends IdempotentDto {
  @IsUUID() templateId!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() assigneeHint?: string;
  @IsOptional() @IsInt() offsetDays?: number;
  @IsOptional() @IsInt() sortOrder?: number;
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
/** Odluka o zaradi (godišnji razgovor, 1.0 talksSection.js) — deljena Create/Update. */
const RAISE_DECISIONS = ["da", "ne", "odlozeno"] as const;

export class CreateTalkDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsString() talkType!: string;
  @IsOptional() @IsISO8601() talkDate?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() zapisnikMd?: string;
  @IsOptional() @IsUUID() planId?: string;
  /** Godišnji razgovor — strukturisana odluka o zaradi (da/ne/odloženo, %, važi-od, obrazloženje). */
  @IsOptional() @IsIn(RAISE_DECISIONS) raiseDecision?: string;
  @IsOptional() @IsNumber() raisePercent?: number;
  @IsOptional() @IsISO8601() raiseEffectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(500) raiseNote?: string;
}
export class UpdateTalkDto {
  @IsOptional() @IsString() talkType?: string;
  @IsOptional() @IsISO8601() talkDate?: string;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() zapisnikMd?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsIn(RAISE_DECISIONS) raiseDecision?: string;
  @IsOptional() @IsNumber() raisePercent?: number;
  @IsOptional() @IsISO8601() raiseEffectiveFrom?: string;
  @IsOptional() @IsString() @MaxLength(500) raiseNote?: string;
}

/** Korektivni plan (1.0 saveCorrectivePlan/updateCorrectivePlan). Editor: razlog/status/
 *  follow-up; closed_at pri zatvaranju; visible_to_employee prati status razgovora. */
export class CreateCorrectivePlanDto extends IdempotentDto {
  @IsUUID() employeeId!: string;
  @IsOptional() @IsUUID() talkId?: string;
  @IsOptional() @IsBoolean() visibleToEmployee?: boolean;
  @IsOptional() @IsString() reasonMd?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsISO8601() followupDate?: string;
}
export class UpdateCorrectivePlanDto {
  @IsOptional() @IsString() reasonMd?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsISO8601() followupDate?: string;
  @IsOptional() @IsISO8601() closedAt?: string;
  @IsOptional() @IsBoolean() visibleToEmployee?: boolean;
}
export class CreateMeasureDto extends IdempotentDto {
  @IsUUID() planId!: string;
  @IsString() descriptionMd!: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsUUID() responsibleEmployeeId?: string;
  /** 1.0 modal default = 'otvoreno' (NE 'u_toku'); status-select šalje izbor. */
  @IsOptional() @IsIn(["otvoreno", "u_toku", "ispunjeno", "neispunjeno"]) status?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsInt() sort?: number;
}
export class UpdateMeasureDto {
  @IsOptional() @IsString() descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsUUID() responsibleEmployeeId?: string;
  @IsOptional() @IsIn(["otvoreno", "u_toku", "ispunjeno", "neispunjeno"]) status?: string;
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

/** Ocena rukovodioca po kompetenciji (0–5 ili null = obriši ocenu). */
export class ScoreItemDto {
  @IsInt() competenceId!: number;
  @IsOptional() @IsInt() @Min(0) @Max(5) level?: number | null;
  @IsOptional() @IsString() @MaxLength(1000) comment?: string;
}
/** Bulk upsert ocena jednog ocenjivača (1.0 saveScores, on_conflict=rater_id,competence_id). */
export class SaveScoresDto extends OptIdempotentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ScoreItemDto)
  items!: ScoreItemDto[];
}
/** Email pozivnice ocenjivačima (1.0 edge fn assessment-invite). Per-ciklus varijanta
 *  nosi opciju rezimea kreatoru (default true). Per-procena varijanta prima id u ruti. */
export class InviteCycleDto extends OptIdempotentDto {
  @IsOptional() @IsBoolean() notifyCreator?: boolean;
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
  @IsOptional() @IsISO8601() effectiveTo?: string;
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
