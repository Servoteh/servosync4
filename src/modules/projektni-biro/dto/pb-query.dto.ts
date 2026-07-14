import {
  IsBooleanString,
  IsISO8601,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

/**
 * Query DTO-i za Projektni biro read endpointe (TALAS D, R1).
 * Nevalidan uuid/datum u query parametru mora dati 400 (kao 1.0/PostgREST), ne 22P02→500.
 * Globalni ValidationPipe (transform+whitelist) ih sprovodi. Statusi/vrste se filtriraju
 * kao TEKST nad enum kolonom (`status::text = ...`) → 1.0 labele („U toku") ostaju semantika
 * (doktrina §C: ne menjati enume/formate), bez Prisma enum-member prevoda.
 */
export class ListTasksQueryDto {
  @IsOptional() @IsUUID() projectId?: string;
  @IsOptional() @IsUUID() employeeId?: string;
  /** 1.0 labela statusa (npr. „U toku", „Završeno"). */
  @IsOptional() @IsString() status?: string;
  /** 1.0 labela vrste (npr. „Projektovanje 3D"). */
  @IsOptional() @IsString() vrsta?: string;
  @IsOptional() @IsString() q?: string;
  /** „true" → uključi i soft-deleted (paritet 1.0 prikaza korpe); default samo aktivni. */
  @IsOptional() @IsString() includeDeleted?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}

export class WorkReportsQueryDto {
  @IsOptional() @IsUUID() employeeId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class WorkReportSummaryQueryDto {
  @IsISO8601() from!: string;
  @IsISO8601() to!: string;
  /** Bez employeeId: DB fn odlučuje svi-vs-svoje (pb_current_user_can_see_all_reports). */
  @IsOptional() @IsUUID() employeeId?: string;
}

export class LoadStatsQueryDto {
  /** Prozor u radnim danima (1.0 default 20). */
  @IsOptional() @IsString() windowDays?: string;
}

/**
 * Filteri saveta — mapiraju se 1:1 na `pb_list_eng_tips(p_filter jsonb)` ključeve
 * (verifikovano živo telo fn + 1.0 `pbEngTips.listEngTips`): `search`, `category_ids`
 * (uuid[]), `tags` (text[]), `my_only`, `include_drafts`, `sort`, `limit`, `offset`.
 * RPC NEMA project/status filter — draft vidljivost je `include_drafts` (bool; autor∨admin
 * u DB), a published je uvek vidljiv. Skalar `categoryId` se obmotava u `category_ids: [id]`.
 */
export class TipsQueryDto {
  /** Pretraga (search_tsv websearch); → `search`. */
  @IsOptional() @IsString() q?: string;
  /** Jedna kategorija; → `category_ids: [categoryId]`. */
  @IsOptional() @IsUUID() categoryId?: string;
  /** CSV tagova; → `tags` (text[], lower/trim u DB). */
  @IsOptional() @IsString() tags?: string;
  /** Samo moji saveti; → `my_only`. */
  @IsOptional() @IsBooleanString() myOnly?: string;
  /** Uključi nacrte (autor∨admin u DB); → `include_drafts` (zamena 1.0 „status=draft"). */
  @IsOptional() @IsBooleanString() includeDrafts?: string;
  /** Sort: recent | popular; → `sort` (default recent). */
  @IsOptional() @IsIn(["recent", "popular"]) sort?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() offset?: string;
}
