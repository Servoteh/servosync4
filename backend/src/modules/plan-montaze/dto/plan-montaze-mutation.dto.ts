import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import {
  MONTAZA_AI_ALLOWED_MODELS,
  MONTAZA_STATUS_CODES,
} from "../montaza-ai";

/**
 * Mutacioni DTO-i za Plan montaže R2 (MODULE_SPEC_planovi_pracenje_30.md §3).
 * PM CRUD (projekti/WP/faze) = upsert-po-id (paritet 1.0 buildXPayload); row-odluka
 * (`has_edit_role` project-scope) presuđuje sy15 kroz `withUserRls`. Izveštaji POST
 * je idempotentan preko klijentskog UUID `id` (postojeći mehanizam, doktrina A4).
 */

/* ── Projekti ── */

/** POST: `id` opcion (upsert-po-id ako je poslat, paritet 1.0 saveProjectToDb). */
export class UpsertProjectDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MaxLength(120) projectCode!: string;
  @IsString() @MaxLength(300) projectName!: string;
  @IsOptional() @IsString() projectm?: string;
  @IsOptional() @IsISO8601() projectDeadline?: string | null;
  @IsOptional() @IsString() pmEmail?: string;
  @IsOptional() @IsString() leadpmEmail?: string;
  @IsOptional() @IsString() status?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(120) projectCode?: string;
  @IsOptional() @IsString() @MaxLength(300) projectName?: string;
  @IsOptional() @IsString() projectm?: string;
  @IsOptional() @IsISO8601() projectDeadline?: string | null;
  @IsOptional() @IsString() pmEmail?: string;
  @IsOptional() @IsString() leadpmEmail?: string;
  @IsOptional() @IsString() status?: string;
}

/* ── Work packages (nalog montaže) ── */

export class UpsertWorkPackageDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() projectId!: string;
  @IsOptional() @IsString() rnCode?: string;
  @IsOptional() @IsInt() rnOrder?: number;
  @IsString() @MaxLength(300) name!: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() responsibleEngineerDefault?: string;
  @IsOptional() @IsString() montageLeadDefault?: string;
  @IsOptional() @IsISO8601() deadline?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() assemblyDrawingNo?: string;
}

export class UpdateWorkPackageDto {
  @IsOptional() @IsString() rnCode?: string;
  @IsOptional() @IsInt() rnOrder?: number;
  @IsOptional() @IsString() @MaxLength(300) name?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() responsibleEngineerDefault?: string;
  @IsOptional() @IsString() montageLeadDefault?: string;
  @IsOptional() @IsISO8601() deadline?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() assemblyDrawingNo?: string;
}

/* ── Faze ── */

/** `checks` = niz od 8 bool (jsonb array, NE objekat) — paritet 1.0 (8 spremnosti). */
export class PhaseFieldsDto {
  @IsOptional() @IsString() @MaxLength(300) phaseName?: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsISO8601() startDate?: string | null;
  @IsOptional() @IsISO8601() endDate?: string | null;
  @IsOptional() @IsString() responsibleEngineer?: string;
  @IsOptional() @IsString() montageLead?: string;
  @IsOptional() @IsInt() @Min(0) @Max(3) status?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) pct?: number;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(8)
  @ArrayMaxSize(8)
  @IsBoolean({ each: true })
  checks?: boolean[];
  @IsOptional() @IsString() blocker?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsInt() sortOrder?: number;
  @IsOptional() @IsIn(["mechanical", "electrical"]) phaseType?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) linkedDrawings?: string[];
  @IsOptional() @IsISO8601() actualStartDate?: string | null;
  @IsOptional() @IsISO8601() actualEndDate?: string | null;
}

export class UpsertPhaseDto extends PhaseFieldsDto {
  @IsOptional() @IsUUID() id?: string;
  @IsUUID() projectId!: string;
  @IsUUID() workPackageId!: string;
  @IsString() @MaxLength(300) declare phaseName: string;
}

export class UpdatePhaseDto extends PhaseFieldsDto {}

/* ── Izveštaji montera ── */

/**
 * Kreiranje izveštaja — `id` (klijentski UUID) = idempotency ključ (doktrina A4;
 * postojeći mehanizam 1.0). `autorUserId` NE prima klijent (RLS WITH CHECK
 * autor_user_id=auth.uid(); DB default popunjava iz GUC sub-a).
 */
export class CreateReportDto {
  @IsUUID() id!: string;
  @IsOptional() @IsIn([...MONTAZA_STATUS_CODES]) status?: string;
  @IsOptional() @IsString() datum?: string;
  @IsOptional() @IsInt() predmetItemId?: number | null;
  @IsOptional() @IsString() predmet?: string;
  @IsOptional() @IsString() nazivProjekta?: string;
  @IsOptional() @IsString() klijent?: string;
  @IsOptional() @IsString() lokacija?: string;
  @IsOptional() @IsString() pocetakRada?: string;
  @IsOptional() @IsString() krajRada?: string;
  @IsOptional() @IsString() opisRadova?: string;
  @IsOptional() @IsString() problemi?: string;
  @IsOptional() @IsString() otvoreneStavke?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) dodatniClanovi?: string[];
  @IsOptional() @IsString() autorIme?: string;
  @IsOptional() @IsString() siroviTekst?: string;
  @IsOptional() @IsString() aiModel?: string;
  @IsOptional() @IsObject() aiJson?: Record<string, unknown>;
}

/** Poveži/odveži predmet (poveziPredmet): prazan DTO = odveži (sve 4 kolone → null). */
export class LinkPredmetDto {
  @IsOptional() @IsInt() predmetItemId?: number | null;
  @IsOptional() @IsString() predmetBroj?: string;
  @IsOptional() @IsString() nazivProjekta?: string;
  @IsOptional() @IsString() klijent?: string;
}

/* ── AI generisanje (port edge montaza-izvestaj-ai) ── */

export class AiSlikaDto {
  @IsString() media_type!: string;
  @IsString() data!: string; // base64 (bez data: prefiksa)
}

export class AiGenerateDto {
  @IsOptional() @IsString() tekst?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AiSlikaDto)
  slike?: AiSlikaDto[];
  @IsOptional() @IsArray() @IsString({ each: true }) dopune?: string[];
}

/* ── AI model (admin) ── */

export class SetMontazaAiModelDto {
  @IsIn([...MONTAZA_AI_ALLOWED_MODELS])
  model!: string;
}

/* ── Foto upload (multipart, propratna meta) ── */

export class UploadPhotosMetaDto {
  /** CSV rednih brojeva poravnat sa fajlovima (za ciljani retry); prazno = sekvencijalno. */
  @IsOptional() @IsString() redni?: string;
  /** JSON niz opisa poravnat sa fajlovima. */
  @IsOptional() @IsString() opisi?: string;
}
