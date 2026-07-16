import { IsISO8601, IsInt, IsOptional, Matches, Max, Min } from "class-validator";
import { Type } from "class-transformer";

/** Opseg prisustva (default: tekući mesec). Nevalidan datum → 400 (ne 500). */
export class AttendanceRangeQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
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
