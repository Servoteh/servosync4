import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

/**
 * Mutacioni DTO-i za Plan proizvodnje R2 (MODULE_SPEC_planovi_pracenje_30.md §3).
 * Overlays/urgency/drawings = merge-upsert (paritet 1.0 direktnog PostgREST-a);
 * reassign = DEFINER RPC sa idempotencijom (`p_client_event_uuid`). Row/force odluka
 * (`can_edit_plan_proizvodnje`/`can_force_plan_reassign`) presuđuje sy15 kroz `withUserRls`.
 *
 * ⚠️ Brojčani identifikatori (BigInt) MORAJU biti SAMO cifre (`^\d+$`) — `@IsNumberString`
 * prima „1.5" → `BigInt("1.5")` baca SyntaxError PRE try/catch-a → 500 (C-fix obrazac).
 */
const DIGITS = /^\d+$/;

/* ── Overlay patch (merge) ── */

export class OverlayUpsertDto {
  @Matches(DIGITS) workOrderId!: string;
  @Matches(DIGITS) lineId!: string;
  /** Ciklus klika (completed se NIKAD ne piše ručno — dolazi iz BigTehn-a). */
  @IsOptional() @IsIn(["waiting", "in_progress", "blocked"]) localStatus?: string;
  @IsOptional() @IsString() shiftNote?: string | null;
  /** pin/unpin/redosled (null = ukloni ručni redosled). */
  @IsOptional() @IsInt() shiftSortOrder?: number | null;
  /** Direktna dodela mašine na overlay-u (guarded put je reassign RPC — v. §3). */
  @IsOptional() @IsString() assignedMachineCode?: string | null;
  @IsOptional() @IsBoolean() camReady?: boolean;
  @IsOptional() @IsBoolean() readyOverride?: boolean;
  @IsOptional() @IsString() cooperationStatus?: string;
  @IsOptional() @IsString() cooperationPartner?: string | null;
  @IsOptional() @IsISO8601() cooperationExpectedReturn?: string | null;
}

export class OverlayReorderItemDto {
  @Matches(DIGITS) workOrderId!: string;
  @Matches(DIGITS) lineId!: string;
}

export class OverlayReorderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => OverlayReorderItemDto)
  items!: OverlayReorderItemDto[];
}

/* ── Urgency (HITNO) ── */

export class SetUrgentDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/* ── Reassign ── */

export class ReassignDto {
  @Matches(DIGITS) workOrderId!: string;
  @Matches(DIGITS) lineId!: string;
  /** null/prazno = vrati na originalnu mašinu. */
  @IsOptional() @IsString() targetMachine?: string | null;
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() reason?: string;
  /** Idempotency ključ (postojeći mehanizam; audit ON CONFLICT (client_event_uuid,line_id)). */
  @IsOptional() @IsUUID() clientEventId?: string;
}

export class BulkReassignPairDto {
  @Matches(DIGITS) workOrderId!: string;
  @Matches(DIGITS) lineId!: string;
}

export class BulkReassignDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => BulkReassignPairDto)
  pairs!: BulkReassignPairDto[];
  @IsOptional() @IsString() targetMachine?: string | null;
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() reason?: string;
  /** JEDAN deljen ključ za ceo bulk (paritet 1.0). */
  @IsOptional() @IsUUID() clientEventId?: string;
}

/* ── Kooperacija — auto grupe (admin) ── */

export class CooperationGroupUpsertDto {
  @IsString() @MaxLength(60) rjGroupCode!: string;
  @IsString() @MaxLength(200) groupLabel!: string;
  @IsOptional() @IsString() notes?: string;
}

export class CooperationGroupPatchDto {
  @IsOptional() @IsString() @MaxLength(200) groupLabel?: string;
  @IsOptional() @IsString() notes?: string;
  /** true = soft-remove (removed_at/by), false = restore (removed_at → null). */
  @IsOptional() @IsBoolean() removed?: boolean;
}

/* ── Skice (production-drawings) ── */

export class DrawingUploadDto {
  @Matches(DIGITS) workOrder!: string;
  @Matches(DIGITS) line!: string;
}

export class BigtehnDrawingSignQueryDto {
  @IsString() code!: string;
}
