import { IsISO8601, IsOptional } from "class-validator";

/** Opseg prisustva (default: tekući mesec). Nevalidan datum → 400 (ne 500). */
export class AttendanceRangeQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
