import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { IsCalendarDate } from "./is-calendar-date";

/**
 * Moj profil — Drop 2 DTO-ovi (razvoj self / očekivanja self / 360 read / prisustvo).
 * Sve ide kroz GUC (withUserRls/runIdempotentRls) pozivajući POSTOJEĆE tabele/RPC-ove —
 * RLS presuđuje scope (dp_update_self / ee_update_self / self-rater). Potpisi RPC-ova NETAKNUTI.
 */

/** Radnik menja SOPSTVENU samoprocenu plana razvoja (development_plans.self_assessment_md). */
export class SelfAssessmentDto {
  @IsOptional() @IsString() @MaxLength(20000) selfAssessmentMd?: string;
}

/** Beleška 1-na-1 koju upisuje ZAPOSLENI (development_checkins kind='zaposleni'). */
export class CreateSelfCheckinDto {
  @IsUUID() clientEventId!: string;
  @IsString() @MaxLength(8000) noteMd!: string;
}

/**
 * Radnik markira SOPSTVENO očekivanje (employee_expectations; RLS ee_update_self dozvoljava
 * status u_toku/ispunjeno ∨ progress uz status). Ako je `status` dat → status-grana; inače ako
 * je `progress` dat → progress-grana (paritet markMyExpectationStatus / markMyExpectationProgress).
 */
export class UpdateMyExpectationDto {
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) progress?: number;
  @IsOptional() @IsString() @MaxLength(4000) completionNote?: string;
}

/** 360 READ — sve za self modal u jednom pozivu (period default tekuća godina u RPC-u). */
export class SelfAssessmentReadQueryDto {
  @IsOptional() @IsString() @MaxLength(20) period?: string;
}

/**
 * Prisustvo — sirovi događaji za jedan dan (attendance_events; YYYY-MM-DD). Strogi kalendarski
 * datum (IsCalendarDate): raniji regex je propuštao `2026-02-31` (mesec 02 dan 31) → Postgres
 * 22007 → 500. Koristi je i self `/profile/attendance/events` i timska ruta — popravka svuda.
 */
export class AttendanceEventsQueryDto {
  @IsCalendarDate({ message: "day mora biti validan datum u formatu YYYY-MM-DD" })
  day!: string;
}
