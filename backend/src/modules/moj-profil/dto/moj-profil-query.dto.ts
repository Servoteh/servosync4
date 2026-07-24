import { IsInt, IsOptional, Matches, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { IsCalendarDate } from "./is-calendar-date";

/**
 * Opseg prisustva (default: tekući mesec). Nevalidan datum → 400 (ne 500). Strogi kalendarski
 * `YYYY-MM-DD` (IsCalendarDate) umesto labavog `@IsISO8601` koji je propuštao `2026-W30`/`2026-07`/
 * `2026-200`/`2026-02-31` do Postgresa (22007/22008 → 500). Koristi je i self `/profile/attendance`
 * i timska `/profile/team/:id/attendance` — popravka važi na obe rute.
 */
export class AttendanceRangeQueryDto {
  @IsOptional() @IsCalendarDate() from?: string;
  @IsOptional() @IsCalendarDate() to?: string;
}

/** Mesečni sati (karnet/chips) — `month=YYYY-MM` (default tekući mesec). Nevalidan → 400. */
export class MonthlyHoursQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: "month mora biti YYYY-MM" })
  month?: string;
}

/** Brisanje mesečne primedbe (self) — year+month obavezni (query). */
export class DeleteHoursRemarkQueryDto {
  @Type(() => Number) @IsInt() @Min(2000) @Max(2100) year!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(12) month!: number;
}
