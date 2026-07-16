import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * Podešavanja — Drop 2 org_profile WRITE DTO-ovi (P9). Vrednosti firme (company_profile id=1) +
 * očekivanja zaposlenih (employee_expectations CRUD + bulk). Guard = settings.org_profile;
 * RLS presuđuje row-write kroz GUC. Paritet 1.0 companyProfileTab / employeeExpectationsTab.
 */

/** Vrednosti firme (PATCH company_profile id=1). Sva 3 polja opciona (null = obriši). */
export class UpdateCompanyProfileDto {
  @IsOptional() @IsString() @MaxLength(20000) missionMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) visionMd?: string;
  @IsOptional() @IsString() @MaxLength(20000) valuesMd?: string;
}

/** Jedno očekivanje (INSERT employee_expectations). Paritet 1.0 saveExpectation. */
export class CreateExpectationDto {
  @IsUUID() employeeId!: string;
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(20) priority?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() planId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) progress?: number;
}

/** Isti zadatak na više zaposlenih (array INSERT). Paritet 1.0 bulkSaveExpectation. */
export class BulkExpectationDto {
  @IsArray() @ArrayMinSize(1) @IsUUID("all", { each: true })
  employeeIds!: string[];
  @IsString() @MaxLength(300) title!: string;
  @IsOptional() @IsString() @MaxLength(8000) descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(20) priority?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() planId?: string;
}

/** Izmena očekivanja (PATCH employee_expectations). Paritet 1.0 updateExpectation. */
export class UpdateExpectationDto {
  @IsOptional() @IsString() @MaxLength(300) title?: string;
  @IsOptional() @IsString() @MaxLength(8000) descriptionMd?: string;
  @IsOptional() @IsISO8601() dueDate?: string;
  @IsOptional() @IsString() @MaxLength(20) priority?: string;
  @IsOptional() @IsString() @MaxLength(20) status?: string;
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsUUID() planId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) progress?: number;
  @IsOptional() @IsString() @MaxLength(4000) completionNote?: string;
  @IsOptional() @IsISO8601() completedAt?: string;
}
