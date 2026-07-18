import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/**
 * Podešavanja — P8 Organizacija CRUD (struktura + opisi pozicija). 1.0 `services/orgStructure.js`
 * (departments/sub_departments/job_positions REST) + `orgProfile.js` (opisi = PATCH job_positions).
 * ID-jevi su INTEGER (autoincrement), NE uuid → path-param se parsira kao broj (ParseIntPipe).
 * Struktura CRUD guard = settings.users (admin, DB RLS ALL=current_user_is_admin); opisi pozicija
 * guard = settings.org_profile (DB RLS jp_update_org_profile=current_user_can_manage_org_profile).
 * RLS je autoritativan (42501→403).
 */

// ---------- Departments ----------

export class CreateDepartmentDto {
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateDepartmentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

// ---------- Sub-departments ----------

export class CreateSubDepartmentDto {
  @IsInt() departmentId!: number;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateSubDepartmentDto {
  @IsOptional() @IsInt() departmentId?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

// ---------- Job positions (struktura) ----------

export class CreateJobPositionDto {
  @IsInt() departmentId!: number;
  @IsOptional() @IsInt() subDepartmentId?: number;
  @IsString() @MinLength(1) @MaxLength(200) name!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateJobPositionDto {
  @IsOptional() @IsInt() departmentId?: number;
  @IsOptional() @IsInt() subDepartmentId?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) name?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

// ---------- Opis pozicije (org_profile domen) ----------

/** Opis pozicije (4 md sekcije + profile_updated_at/by). Paritet 1.0 updateJobPositionProfile.
 *  Nedato polje = null (1.0 body uvek šalje sva 4 sa `?? null`). */
export class UpdateJobPositionProfileDto {
  @IsOptional() @IsString() @MaxLength(20000) summaryMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) expectationsMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) responsibilitiesMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) dutiesMd?: string;
}

/** Jedan red bulk importa opisa pozicija (BE prima VEĆ isparsirane sekcije — parser je FE). */
export class BulkProfileItemDto {
  @IsInt() @Min(1) id!: number;
  @IsOptional() @IsString() @MaxLength(20000) summaryMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) expectationsMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) responsibilitiesMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) dutiesMd?: string;
}

/** Bulk import opisa pozicija (sekvencijalni update → {ok, fail, results}). Paritet 1.0
 *  bulkUpdateJobPositionProfiles. */
export class BulkJobPositionProfileDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BulkProfileItemDto)
  items!: BulkProfileItemDto[];
}
