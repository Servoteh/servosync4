import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

/**
 * Podešavanja — P10 Kompetencije editor CRUD (competence_groups / competences /
 * competence_levels / competence_questions). 1.0 `ui/podesavanja/competenceFrameworkEditor.js`.
 * Sve admin (guard settings.users; DB RLS ALL=current_user_is_admin). ID-jevi = INTEGER.
 * `code` se NE prima od klijenta — servis ga auto-generiše (slug + sufiks) kao 1.0 _genCode.
 * Prazan descriptor nivoa = DELETE tog nivoa (paritet 1.0). DELETE kompetencije: servis
 * PRVO eksplicitno briše nivoe (FK je RESTRICT, ne CASCADE) pa onda kompetenciju.
 */

const SCOPES = ["core", "strucna", "liderska"] as const;

// ---------- Grupe (ose) ----------

export class CreateCompetenceGroupDto {
  @IsString() @MinLength(1) @MaxLength(200) nameSr!: string;
  @IsOptional() @IsString() @MaxLength(4000) descriptionSr?: string;
  @IsIn(SCOPES) scope!: (typeof SCOPES)[number];
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateCompetenceGroupDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) nameSr?: string;
  @IsOptional() @IsString() @MaxLength(4000) descriptionSr?: string;
  @IsOptional() @IsIn(SCOPES) scope?: (typeof SCOPES)[number];
  @IsOptional() @IsInt() sortOrder?: number;
}

// ---------- Kompetencije + nivoi ----------

/** Jedan nivo (0–5). Prazan descriptorSr → DELETE tog nivoa (paritet 1.0). */
export class CompetenceLevelDto {
  @IsInt() @Min(0) @Max(5) level!: number;
  @IsOptional() @IsString() @MaxLength(4000) descriptorSr?: string;
}

export class CreateCompetenceDto {
  @IsInt() groupId!: number;
  @IsString() @MinLength(1) @MaxLength(200) nameSr!: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => CompetenceLevelDto)
  levels?: CompetenceLevelDto[];
}

export class UpdateCompetenceDto {
  @IsOptional() @IsInt() groupId?: number;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) nameSr?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => CompetenceLevelDto)
  levels?: CompetenceLevelDto[];
}

// ---------- Pitanja (group_id NULL = opšte) ----------

export class CreateCompetenceQuestionDto {
  /** null/izostavljeno = opšte pitanje (group_id NULL). */
  @IsOptional() @IsInt() groupId?: number | null;
  @IsString() @MinLength(1) @MaxLength(2000) textSr!: string;
  @IsOptional() @IsInt() sortOrder?: number;
}

export class UpdateCompetenceQuestionDto {
  @IsOptional() @IsInt() groupId?: number | null;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) textSr?: string;
  @IsOptional() @IsInt() sortOrder?: number;
}
