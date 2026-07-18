import {
  IsBooleanString,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
} from "class-validator";

/**
 * Query DTO-i za Sastanci read endpointe (review 12.07, nalaz 3g):
 * nevalidan uuid/datum u query parametru mora dati 400 (kao 1.0/PostgREST),
 * ne 22P02→500. Globalni ValidationPipe (transform+whitelist) ih sprovodi.
 */

export class ListSastanciQueryDto {
  @IsOptional() @IsString() tip?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() pageSize?: string;
}

export class AkcijeQueryDto {
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  /** Filter po effective_status (1.0 loadAkcije effectiveStatus). */
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() odgovoranEmail?: string;
}

export class WeeklyDiffQueryDto {
  /** ISO timestamp prethodnog zaključanja (1.0 sinceIso); bez njega novo/zavrsenoOveNedelje = 0. */
  @IsOptional() @IsISO8601() since?: string;
  @IsOptional() @IsUUID() projekatId?: string;
}

export class TemeQueryDto {
  @IsOptional() @IsString() status?: string;
  /** CSV lista statusa za isključivanje (1.0 excludeStatuses → status=not.in). */
  @IsOptional() @IsString() excludeStatuses?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsString() oblast?: string;
  @IsOptional() @IsString() predlozioEmail?: string;
  @IsOptional() @IsBooleanString() hitnoOnly?: string;
  @IsOptional() @IsBooleanString() razmatranjeOnly?: string;
}

export class NotificationsQueryDto {
  @IsOptional() @IsUUID() sastanakId?: string;
}
