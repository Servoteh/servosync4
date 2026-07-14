import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Mutacioni DTO-ovi za Projektni biro R2 (MODULE_SPEC_pb_profil_podesavanja_30.md §3.1).
 * `clientEventId` (uuid) je OBAVEZAN na NE-idempotentnim POST-ovima (create task/comment/
 * work-report/tip/file) → idempotency ključ (Sy15Service.runIdempotentRls). PATCH/DELETE/
 * progress/like/bulk/soft-delete su idempotentni pa ga NEMAJU. Enum kolone (`vrsta`/`prioritet`/
 * `status`) validiramo protiv 1.0 LABELA (doktrina §C — ne menjati enume/formate); servis piše
 * `${label}::pb_task_status` bez Prisma enum-member prevoda. Numerički param → 400 (ne 500).
 */

const TASK_STATUS = [
  "Nije počelo",
  "U toku",
  "Pregled",
  "Završeno",
  "Blokirano",
] as const;
const TASK_VRSTA = [
  "Projektovanje 3D",
  "Dokumentacija",
  "Nabavka",
  "Algoritam",
  "Montaža",
] as const;
const TASK_PRIORITET = ["Visok", "Srednji", "Nizak"] as const;

/** Baza za idempotentne POST-ove. */
export class PbIdempotentDto {
  @IsUUID() clientEventId!: string;
}

export class CreateTaskDto extends PbIdempotentDto {
  @IsString() @MinLength(1) @MaxLength(300) naziv!: string;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsIn(TASK_VRSTA as unknown as string[]) vrsta?: string;
  @IsOptional() @IsIn(TASK_PRIORITET as unknown as string[]) prioritet?: string;
  @IsOptional() @IsIn(TASK_STATUS as unknown as string[]) status?: string;
  @IsOptional() @IsISO8601() datumPocetkaPlan?: string;
  @IsOptional() @IsISO8601() datumZavrsetkaPlan?: string;
  @IsOptional() @IsISO8601() datumPocetkaReal?: string;
  @IsOptional() @IsISO8601() datumZavrsetkaReal?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) procenatZavrsenosti?: number;
  @IsOptional() @IsInt() @Min(1) @Max(7) normaSatiDan?: number;
}

export class UpdateTaskDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) naziv?: string;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() problem?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsIn(TASK_VRSTA as unknown as string[]) vrsta?: string;
  @IsOptional() @IsIn(TASK_PRIORITET as unknown as string[]) prioritet?: string;
  @IsOptional() @IsIn(TASK_STATUS as unknown as string[]) status?: string;
  @IsOptional() @IsISO8601() datumPocetkaPlan?: string;
  @IsOptional() @IsISO8601() datumZavrsetkaPlan?: string;
  @IsOptional() @IsISO8601() datumPocetkaReal?: string;
  @IsOptional() @IsISO8601() datumZavrsetkaReal?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) procenatZavrsenosti?: number;
  @IsOptional() @IsInt() @Min(1) @Max(7) normaSatiDan?: number;
  /** Optimistic lock — PATCH prolazi samo ako `updated_at` u bazi i dalje odgovara (409 inače). */
  @IsOptional() @IsISO8601() expectedUpdatedAt?: string;
}

/** Bulk PATCH (status/prioritet/inženjer nad `id=in`) — paritet 1.0 bulkUpdatePbTasks. */
export class BulkTasksDto {
  @IsArray() @ArrayMinSize(1) @IsUUID("all", { each: true }) ids!: string[];
  @IsOptional() @IsIn(TASK_STATUS as unknown as string[]) status?: string;
  @IsOptional() @IsIn(TASK_PRIORITET as unknown as string[]) prioritet?: string;
  @IsOptional() @IsUUID() employeeId?: string;
}

export class SoftDeleteTasksDto {
  @IsArray() @ArrayMinSize(1) @IsUUID("all", { each: true }) ids!: string[];
}

/** Restriktovani edit (`inzenjer`) — samo status/procenat kroz pb_update_task_progress RPC. */
export class ProgressDto {
  @IsOptional() @IsIn(TASK_STATUS as unknown as string[]) status?: string;
  @IsOptional() @IsInt() @Min(0) @Max(100) procenat?: number;
}

export class CreateCommentDto extends PbIdempotentDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

export class UpdateCommentDto {
  @IsString() @MinLength(1) @MaxLength(4000) body!: string;
}

export class CreateDepDto {
  @IsUUID() dependsOnTaskId!: string;
}

export class CreateWorkReportDto extends PbIdempotentDto {
  @IsISO8601() datum!: string;
  /** 0.5–24 (decimal korak). @IsNumber (ne @IsInt) da 0.5 prođe; servis re-validira. */
  @IsNumber({}, { message: "sati mora biti broj" })
  @Min(0.5)
  @Max(24)
  sati!: number;
  @IsOptional() @IsString() @MaxLength(2000) opis?: string;
  /** Za drugog (samo uz pb.reports_all u DB); prazno = svoj red (pb_current_employee_id). */
  @IsOptional() @IsUUID() employeeId?: string;
}

/** PB notif config PATCH (id=1) — pb.admin. */
export class NotifConfigPatchDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(60) deadlineWarningDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(500) overloadThresholdPct?: number;
  @IsOptional() @IsArray() @IsString({ each: true }) emailRecipients?: string[];
  @IsOptional() @IsBoolean() notifyOnBlocked?: boolean;
  @IsOptional() @IsBoolean() notifyOnOverload?: boolean;
  @IsOptional() @IsBoolean() notifyOnDeadlineWarning?: boolean;
  @IsOptional() @IsBoolean() notifyOnDeadlineOverdue?: boolean;
  @IsOptional() @IsBoolean() notifyOnNoEngineer?: boolean;
  @IsOptional() @IsBoolean() digestMode?: boolean;
}

/**
 * Saveti (pb_save_eng_tip p_payload jsonb). Ključevi payload-a se mapiraju 1:1 na živo telo fn
 * (§C paritet): `id`/`naslov`/`telo`/`category_id`/`tags`/`vendor`/`url`/`project_id`/`status`.
 * `id` prisutan = update (autor∨admin u DB); odsutan = create (can_write_pb_eng_tips u DB).
 */
export class SaveTipDto extends PbIdempotentDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(3) @MaxLength(200) naslov!: string;
  @IsString() @MinLength(10) telo!: string;
  @IsOptional() @IsUUID() categoryId?: string;
  /** ≤10 (paritet 1.0 „Maksimalno 10 tag-ova" + DB pb_save_eng_tip 22023 → ovde 400). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  tags?: string[];
  @IsOptional() @IsString() @MaxLength(120) vendor?: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string;
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsIn(["draft", "published"]) status?: string;
}

/** Kategorija saveta (pb_upsert_eng_tip_category p_payload) — pb.admin. */
export class TipCategoryDto {
  @IsOptional() @IsUUID() id?: string;
  @IsString() @MinLength(1) @MaxLength(120) naziv!: string;
  @IsOptional() @IsString() @MaxLength(120) slug?: string;
  @IsOptional() @IsString() @MaxLength(40) ikona?: string;
  @IsOptional() @IsString() @MaxLength(40) boja?: string;
  @IsOptional() @IsInt() @Min(0) redosled?: number;
  @IsOptional() @IsBoolean() jeAktivna?: boolean;
}

/** Meta za upload priloga taska (multipart file je odvojen; clientEventId = idempotency). */
export class TaskFileMetaDto extends PbIdempotentDto {
  @IsOptional() @IsString() @MaxLength(40) category?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

/** Meta za upload priloga saveta. */
export class TipFileMetaDto extends PbIdempotentDto {}
