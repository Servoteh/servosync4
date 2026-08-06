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
  Max,
  MaxLength,
  Min,
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
  // ── Zahtev 046/26 (gant). Sva polja su merge-patch: `undefined` = ne diraj,
  //    `null` = obriši. Termini su PARALELNI pogled — `shiftSortOrder` ostaje master.
  /** Planirani početak (ISO). null = skini stavku sa gant ose. */
  @IsOptional() @IsISO8601() plannedStartAt?: string | null;
  /** Planirani kraj (ISO). null = izvedi iz trajanja. */
  @IsOptional() @IsISO8601() plannedEndAt?: string | null;
  /** Override trajanja u minutima (1..100000). null = vrati na tehnologiju (TPZ+TK×kom). */
  @IsOptional() @IsInt() @Min(1) @Max(100000) plannedDurationMinutes?: number | null;
  /** Override završenosti. null = auto iz kucanja operatera. */
  @IsOptional() @IsBoolean() plannedDone?: boolean | null;
  /** „Uslov" (FS) — RN prethodnika. null = bez uslova (nosi i predecessorLine na null). */
  @IsOptional() @Matches(DIGITS) predecessorWorkOrderId?: string | null;
  @IsOptional() @Matches(DIGITS) predecessorLine?: string | null;
}

/* ── Šifrarnik hala (mašina → hala), zahtev 046/26 F0 ── */

export class MachineHallUpsertDto {
  @IsString() @MaxLength(100) hall!: string;
  @IsOptional() @IsInt() sortOrder?: number | null;
  @IsOptional() @IsString() @MaxLength(500) note?: string | null;
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

/* ── Kaskadno pomeranje lanca (075/26, F2 iz 046/26) ── */

/**
 * Pomeranje SIDRA + celog zatvorenja njegovih sledbenika po `predecessor_*` vezi.
 * Klijent NIKAD ne šalje spisak stavki — server razrešava lanac (FE vidi samo ~300
 * iscrtanih redova nad feed-om koji je i sam `LIMIT 5000`, pa bi klijentski spisak
 * tiho gubio rep lanca).
 */
export class OverlayShiftChainDto {
  /** Sidro — pozicija koju je planer stvarno uhvatio. */
  @Matches(DIGITS) workOrderId!: string;
  @Matches(DIGITS) lineId!: string;
  /**
   * Pomak u CELIM KALENDARSKIM danima (Europe/Belgrade), ne apsolutni termini:
   * server tada radi svu aritmetiku jednim izrazom, pa sidro i rep ne mogu da se
   * raziđu preko prelaza na zimsko računanje vremena (25.10.2026).
   */
  @IsInt() @Min(-3650) @Max(3650) deltaDays!: number;
  /**
   * OBAVEZAN pri upisu (`dryRun !== true`). Delta NIJE idempotentna sama po sebi —
   * dva puta primenjeno je 10 dana umesto 5. NIKAD `?? randomUUID()` kao kod reassign-a.
   */
  @IsOptional() @IsUUID() clientEventId?: string;
  /** Samo pregled — ništa se ne upisuje i ključ se NE troši. */
  @IsOptional() @IsBoolean() dryRun?: boolean;
  /**
   * Token ugovora: hash pregleda koji je planer POTVRDIO u dijalogu. Šalje ga SAMO
   * put kroz dijalog i „Poništi"; brzi put (prevlačenje bez potvrde) ga ne šalje.
   */
  @IsOptional() @IsString() @MaxLength(64) expectedHash?: string;
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
