import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * Moj tim (P5-BE) — DTO-ovi za menadžerske akcije nad članom (guard profile.team; row-odluku
 * presuđuje sy15 RLS/DEFINER kroz GUC — `current_user_manages_employee` / RPC). `:employeeId`
 * je path-param (uuid = employees.id), pa nije u telu.
 */

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * Šef koriguje kucanje člana (attendance_submit_correction za tog člana). allowDayPick: min
 * granica (danas-3) se validira i BE-strani (rano 422) i u RPC-u (autoritativno). `clientEventId`
 * (uuid) pinuje dupli-klik kroz runIdempotentRls. RPC presuđuje da li caller sme za tog člana.
 */
export class TeamAttendanceCorrectionDto {
  @IsUUID() clientEventId!: string;
  @IsISO8601() day!: string;
  @IsOptional() @Matches(TIME_RE) timeIn?: string;
  @IsOptional() @Matches(TIME_RE) timeOut?: string;
  @IsString() @MinLength(5) @MaxLength(1000) reason!: string;
}

/** Karnet člana za mesec (isti izračun kao /profile/hours, ali za člana kroz RLS). */
export class TeamMonthQueryDto {
  /** `YYYY-MM` (default tekući mesec). */
  @IsOptional() @Matches(/^\d{4}-\d{2}$/) month?: string;
}
