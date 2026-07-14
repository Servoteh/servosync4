import {
  IsBooleanString,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * Query DTO-i za Kadrovska R1 read endpointe (MODULE_SPEC_kadrovska_30.md §3).
 * Nevalidan uuid/datum/broj u query parametru → 400 (paritet 1.0/PostgREST), ne
 * 22P02→500. Globalni ValidationPipe (transform+whitelist, main.ts) ih sprovodi.
 * Row-scope/PII maska NIJE ovde — presuđuje sy15 RLS/v_employees_safe kroz withUserRls.
 */

/** Godina+mesec (grid, payroll, dashboard, shadow). */
export class MonthQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(12) month?: number;
}

/** Grid meseca — employeeId opciono suženje (RLS i dalje presuđuje redove). */
export class GridQueryDto extends MonthQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Sortabilne kolone liste (paritet 1.0 employeesTab header-sort). */
export const EMPLOYEE_SORT_KEYS = [
  "name",
  "position",
  "department",
  "subDepartment",
  "email",
  "medical",
  "birthday",
  "status",
] as const;

/** Quick-filter čipovi (paritet 1.0 employeesTab:225-233): jedan klik = jedan uslov.
 *  `active` je odvojen param (postoji). Ostali su ovde kao enum. */
export const EMPLOYEE_QUICK_FILTERS = [
  "med-soon",
  "bday-soon",
  "missing-jmbg",
  "no-email",
  "no-phone",
] as const;

export class ListEmployeesQueryDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsBooleanString() active?: string;
  @IsOptional() @IsString() department?: string;
  /** Ugovorni tip suženje (contracts.contract_type aktivnog ugovora). */
  @IsOptional() @IsString() conType?: string;
  /** Server-side sort kolona (persist na FE u localStorage). */
  @IsOptional() @IsIn(EMPLOYEE_SORT_KEYS as unknown as string[]) sort?: string;
  @IsOptional() @IsIn(["asc", "desc"]) dir?: string;
  /** Quick-filter čip (jedan aktivan). */
  @IsOptional()
  @IsIn(EMPLOYEE_QUICK_FILTERS as unknown as string[])
  filter?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}

/** Saldo/istorija/akrual GO — employeeId + year suženje. */
export class VacationQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;
}

/** Jedinstveni inbox 4 izvora: status + izvor (vacation/makeup/paid_leave/nop). */
export class RequestsQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() source?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

/** Odsustva/kalendar — employeeId + raspon datuma + arhiva pogled (paritet
 *  1.0 absencesTab Aktivna/Arhivirana). `archived` neizostavljen = SVE (paritet
 *  postojećeg ponašanja); 'active' = archived_at IS NULL; 'archived' = NOT NULL. */
export class AbsencesQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsIn(["active", "archived", "all"]) archived?: string;
}

/** Praznici u proizvoljnom rasponu (most odsustvo→grid, pregled odsustava). */
export class HolidaysQueryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/** Sirovi prolazi sa kapije (feed „Poslednji prolazi") — limit N. */
export class AttendanceEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Dnevno prisustvo / vs-grid — employeeId + raspon dana. */
export class AttendanceDailyQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/** Sati pojedinačno — employeeId + raspon datuma. */
export class WorkHoursQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

/** Notifikacije outbox — status/tip suženje (row-scope hr_or_admin u RLS). */
export class NotificationsQueryDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() type?: string;
}

/** Filtriranje po zaposlenom (medical/certs/contracts/onboarding/dev/talks/assessments). */
export class ByEmployeeQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsString() status?: string;
}
