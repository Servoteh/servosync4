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

/**
 * ZAHTEV 026/26 — molba za IZMENU/OTKAZ već POTVRĐENOG (approved) GO termina.
 * Ne menja ništa sama po sebi: pravi red u `vacation_change_requests` koji HR
 * odobrava (`kadr_vacreq_change_submit`). Za `kind='revise'` datumi su obavezni.
 */
export class SubmitVacationChangeDto extends ProfileIdempotentDto {
  @IsIn(["cancel", "revise"]) kind!: "cancel" | "revise";
  @IsOptional() @IsISO8601() dateFrom?: string;
  @IsOptional() @IsISO8601() dateTo?: string;
  @IsOptional() @IsInt() @Min(0) @Max(366) daysCount?: number;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
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
  /**
   * ZAHTEV 074/26 — NEOBAVEZAN „Planirani slobodan dan" za tip `dan_odmora`
   * (odluka vlasnika 06.08.2026). Ko zna kad će koristiti dobijeni dan — upiše ga;
   * ko ne zna — ostavi prazno i sve radi kao ranije. Servis ga upisuje u
   * `absence_date` (kolona je NOT NULL i za `dan_odmora` je do sada bila puki
   * duplikat `weekend_work_date`). Za tip `nadoknada` polje NEMA smisla — servis
   * ga odbija sa jasnom porukom (vidi `submitMakeup`).
   */
  @IsOptional() @IsISO8601() plannedAbsenceDate?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Plaćeno odsustvo submit (paid_leave_requests INSERT + kadr_queue_paidleave_notification). */
/**
 * Kodovi osnova plaćenog odsustva (paritet 1.0 `paidLeaveRequests.js:19-32`).
 * ⚠️ AUDIT-K4: MORAJU se poklapati sa `paid_leave_reason_map(leave_type)` u sy15 —
 * nepoznat string tamo pada na ELSE i u `absences` upiše `slobodan_reason='ostalo'`,
 * čime se gubi pravni osnov. Ranije je polje bilo slobodan tekst do 40 znakova.
 */
export const PAID_LEAVE_CODES = [
  "brak",
  "rodjenje_deteta",
  "bolest_uze",
  "nepogoda",
  "selidba",
  "selidba_drugo",
  "ispit",
  "smrt_uze",
  "krv",
  "ostalo",
] as const;

export class SubmitPaidLeaveDto extends ProfileIdempotentDto {
  @IsIn(PAID_LEAVE_CODES as unknown as string[]) leaveType!: string;
  @IsISO8601() dateFrom!: string;
  @IsISO8601() dateTo!: string;
  /** Prikazna vrednost klijenta; MERODAVAN broj računa server (bez vikenda i praznika). */
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
  // competence_id JE Int (Competence.id autoincrement) — ne uuid; raniji @IsUUID je
  // odbijao validan numerički id na granici API-ja (360 self-scoring pao).
  @Type(() => Number) @IsInt() competenceId!: number;
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
/** Radnik štiklira SOPSTVENI onboarding zadatak (odluka Nenada 26.07): done ↔
 *  pending; 'skipped' ostaje HR-u (kadr endpoint). Vlasništvo presuđuje RPC. */
export class OnboardingTaskSelfDto {
  @IsBoolean() done!: boolean;
}

export class SaveHoursRemarkDto extends ProfileIdempotentDto {
  @IsInt() @Min(2000) @Max(2100) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsString() @MaxLength(2000) text!: string;
}
