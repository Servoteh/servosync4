import { Type } from "class-transformer";
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/**
 * Moj profil — mutacioni DTO-ovi R2 (MODULE_SPEC_pb_profil_podesavanja_30.md §3.2).
 * Sve ide kroz GUC (withUserRls/runIdempotentRls) pozivajući POSTOJEĆE G-RPC-ove — potpisi
 * RPC-ova NETAKNUTI (presuda D6). `clientEventId` (uuid) na NE-idempotentnim POST-ovima
 * (GO/nadoknada/plaćeno submit, korekcija prisustva, ack). Numerički param → 400 (ne 500).
 */

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export class ProfileIdempotentDto {
  @IsUUID() clientEventId!: string;
}

/** GO submit — server re-provera min-datuma/salda/preklapanja (§2.4 pravilo 10). */
export class SubmitVacationDto extends ProfileIdempotentDto {
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) @Max(366) daysCount!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  /** Za člana tima (profile.team u DB odlučuje); prazno = svoj profil. */
  @IsOptional() @IsUUID() employeeId?: string;
}

/** GO izmena (hr_revise_vacation_request; podnosilac∨upravljač u DB). */
export class ReviseVacationDto {
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) @Max(366) daysCount!: number;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsBoolean() forceReapproval?: boolean;
}

/** Nadoknada sati submit (makeup_requests INSERT + kadr_queue_makeup_notification 'submitted'). */
export class SubmitMakeupDto extends ProfileIdempotentDto {
  @IsISO8601() absenceDate!: string;
  @IsNumber() @Min(0.5) @Max(24) absenceHours!: number;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) makeupPlan?: string;
  @IsOptional() @IsISO8601() makeupDeadline?: string;
  @IsOptional()
  @IsIn(["nadoknada", "dan_odmora"])
  compensationType?: string;
  @IsOptional() @IsISO8601() weekendWorkDate?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Plaćeno odsustvo submit (paid_leave_requests INSERT + kadr_queue_paidleave_notification). */
export class SubmitPaidLeaveDto extends ProfileIdempotentDto {
  @IsString() @MaxLength(40) leaveType!: string;
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  @IsInt() @Min(0) @Max(60) daysCount!: number;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
  @IsOptional() @IsString() @MaxLength(2000) proofNote?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Korekcija prisustva (attendance_submit_correction; obrazloženje ≥5, važenje 3 dana — u RPC). */
export class SubmitCorrectionDto extends ProfileIdempotentDto {
  @IsISO8601() day!: string;
  @IsOptional() @Matches(TIME_RE) timeIn?: string;
  @IsOptional() @Matches(TIME_RE) timeOut?: string;
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
  /** Za člana tima (RPC current_user_manages_employee); prazno = svoj profil. */
  @IsOptional() @IsUUID() employeeId?: string;
}

/** e-saglasnost / „Upoznat sam" (kadr_document_ack; RLS self). */
export class AckDocumentDto extends ProfileIdempotentDto {
  @IsString() @MaxLength(60) refType!: string;
  @IsString() @MaxLength(200) refId!: string;
  @IsOptional() @IsString() @MaxLength(300) label?: string;
}

/** 360 samoprocena — otvori/nađi (assessment_open_self). */
export class OpenSelfAssessmentDto {
  /** Period (default tekuća godina u RPC-u). */
  @IsOptional() @IsString() @MaxLength(20) period?: string;
}

class ScoreItemDto {
  @IsUUID() competenceId!: string;
  @IsOptional() @IsInt() @Min(0) @Max(5) level?: number | null;
  @IsOptional() @IsString() @MaxLength(2000) comment?: string;
}

export class SaveSelfScoresDto {
  @IsUUID() raterId!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScoreItemDto)
  items!: ScoreItemDto[];
}

class AnswerItemDto {
  @IsString() @MaxLength(120) questionCode!: string;
  @IsOptional() @IsString() @MaxLength(4000) answerText?: string;
}

export class SaveSelfAnswersDto {
  @IsUUID() raterId!: string;
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AnswerItemDto)
  items!: AnswerItemDto[];
}

export class SubmitSelfAssessmentDto {
  @IsUUID() assessmentId!: string;
}

/**
 * Primedba na mesečne sate (work_hours_remarks; upsert po employee_id+year+month, status→'open').
 * Paritet 1.0 gridRemarks.saveMonthRemark: prazan `text` + postojeći red = brisanje (servis
 * odlučuje). employee_id = rev_current_employee_id() ∨ resolveEmployee (self-scope kroz GUC).
 */
export class SaveHoursRemarkDto extends ProfileIdempotentDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsString() @MaxLength(2000) text!: string;
}
