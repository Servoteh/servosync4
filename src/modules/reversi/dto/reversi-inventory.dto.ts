import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

/**
 * R1 — Alat i oprema (inventar) + Grupe (PLAN_PARITET_reversi_2026-07-17.md).
 * Paritet 1.0 `modals.js` („Nova jedinica"), `reversiToolDetail.js` („Izmena
 * artikla") i `inventoryGroupsModal.js` (klasifikacija). Podaci žive u sy15;
 * pisanje ide direktno u tabele (konekciona rola je BYPASSRLS — guard je granica),
 * a CRUD klasifikacije preko postojećih DEFINER fn (rev_add_inventory_*).
 */

/** Zajednička polja artikla ručnog alata (create/update dele skup). */
class ToolFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serijskiBroj?: string | null;

  @IsOptional()
  @IsDateString()
  datumKupovine?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  nabavnaVrednost?: number | null;

  @IsOptional()
  @IsDateString()
  garancijaDo?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  garancijaNapomena?: string | null;

  @IsOptional()
  @IsBoolean()
  imaPunjac?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  punjacSerijski?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string | null;

  /** Klasifikacija — null briše (nesvrstano). */
  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsUUID()
  subgroupId?: string | null;

  @IsOptional()
  @ValidateIf((_o: unknown, v: unknown) => v !== null)
  @IsUUID()
  subsubgroupId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockQty?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxStockQty?: number | null;
}

/** Modal „Nova jedinica u inventaru" (RB-46) → INSERT rev_tools. */
export class CreateToolDto extends ToolFieldsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  naziv!: string;

  @IsOptional()
  @IsBoolean()
  isQuantity?: boolean;

  @IsOptional()
  @IsBoolean()
  isConsumable?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  totalQty?: number;

  /**
   * Ako je zadat, alat se posle inserta smešta u tu WAREHOUSE lokaciju
   * (INITIAL_PLACEMENT kroz loc_create_movement — paritet 1.0
   * initialPlacementForTool). Bez njega alat je i dalje upotrebljiv u Izdaj.
   */
  @IsOptional()
  @IsUUID()
  initialPlacementLocationId?: string;

  /** Idempotency ključ za INITIAL_PLACEMENT pokret (loc_create_movement). */
  @IsOptional()
  @IsUUID()
  clientEventId?: string;
}

/** Modal „Izmena artikla" (RB-11) → PATCH rev_tools. */
export class UpdateToolDto extends ToolFieldsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  naziv?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  totalQty?: number;

  @IsOptional()
  @IsIn(["active", "scrapped", "lost"])
  status?: string;
}

/** Modal „Grupe" — dodaj podgrupu (RA-26) → rev_add_inventory_subgroup. */
export class AddSubgroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  groupCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  napomena?: string;
}

/** Modal „Grupe" — dodaj podpodgrupu (RA-26) → rev_add_inventory_subsubgroup. */
export class AddSubsubgroupDto {
  @IsUUID()
  subgroupId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  napomena?: string;
}

/** Modal „Grupe" — preimenovanje bilo kog nivoa (RA-27). */
export class RenameClassificationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  label!: string;
}

/** Bulk štampa nalepnica (RA-22) + nalepnica pri dodavanju (RB-47). FE gradi TSPL2. */
export class ReversiPrintLabelDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200_000)
  tspl2!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  copies?: number;
}
