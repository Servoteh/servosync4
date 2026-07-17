import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
} from "class-validator";
import { LocMovementTypeEnum, LocTypeEnum } from "@prisma-sy15/client";

/**
 * DTO-ovi transakcionih Lokacije akcija (MODULE_SPEC_lokacije_30.md §3, R2).
 * API konvencija = camelCase (kao R1 read query-ji); servis mapira u snake_case
 * jsonb/kolone. Enum vrednosti se validiraju iz žive šeme (Prisma enumi = paritet
 * loc_type_enum / loc_movement_type_enum, verifikovano protiv sy15 12.07/13.07).
 */

const MOVEMENT_TYPES: string[] = Object.values(LocMovementTypeEnum);
const LOC_TYPES: string[] = Object.values(LocTypeEnum);

/**
 * Pokret (SVE tipove) — pass-through u `loc_create_movement(jsonb)`. `clientEventUuid`
 * je OBAVEZAN idempotency ključ (DB fn ga proverava po `client_event_uuid` UNIQUE i na
 * replay vraća `{ok, idempotent:true}` — native idempotencija, NE rev_api_idempotency).
 */
export class CreateMovementDto {
  @IsUUID()
  clientEventUuid!: string;

  @IsString()
  @IsNotEmpty()
  itemRefTable!: string;

  @IsString()
  @IsNotEmpty()
  itemRefId!: string;

  @IsIn(MOVEMENT_TYPES)
  movementType!: string;

  @IsOptional()
  @IsString()
  orderNo?: string;

  @IsOptional()
  @IsString()
  drawingNo?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  quantity?: number;

  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  @IsOptional()
  @IsString()
  movementReason?: string;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsDateString()
  movedAt?: string;
}

/** Premeštaj kaveza u drugu halu — `loc_move_cage(p_cage_id, p_new_hall_id, p_reason)`. */
export class CageMoveDto {
  @IsUUID()
  cageId!: string;

  @IsUUID()
  newHallId!: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * Nova master lokacija (Prisma INSERT nad `loc_locations`; paritet 1.0 createLocation:
 * location_code/name/location_type/parent_id/capacity_note/notes + is_active=true).
 * path_cached/depth računa BEFORE trigger; created_by ostaje NULL (paritet 1.0 REST).
 */
export class CreateLocationDto {
  @IsString()
  @IsNotEmpty()
  locationCode!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsIn(LOC_TYPES)
  locationType!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  capacityNote?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}

/**
 * Izmena master lokacije (Prisma UPDATE; SAMO polja koja 1.0 UI edituje — paritet
 * updateLocation: name/location_type/parent_id/is_active/capacity_note/notes;
 * location_code se NE menja). `parentId:null` = premeštaj u koren (hala bez roditelja).
 */
export class UpdateLocationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsIn(LOC_TYPES)
  locationType?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  capacityNote?: string | null;

  @IsOptional()
  @IsString()
  notes?: string | null;
}

/** Sync arm/disarm — `loc_bigtehn_ingest_arm(p_armed boolean)` (admin). */
export class SyncArmDto {
  @IsBoolean()
  armed!: boolean;
}

/**
 * PLK-02: potvrdna brana za ručno okidanje ingest-a. `confirm` MORA biti `true`
 * (bilo šta drugo / izostanak → 400) da slučajan/dupli POST ne okine `loc_bigtehn_ingest_run_now`.
 */
export class SyncRunNowDto {
  @IsBoolean()
  @IsIn([true], { message: "confirm mora biti true za ručno okidanje ingest-a" })
  confirm!: boolean;
}
