import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * Bulk-import inventara ručnog alata (paritet 1.0 bulkImportModal tip 1 →
 * `rev_tools`). Idempotentno po `oznaka` (postojeći se preskače). Barkod i
 * `loc_item_ref_id` dodeljuju trigeri na insertu. Rezni alat i uvoz postojećih
 * reversa (tipovi 2/3) su follow-up (REVERSI_PILOT_DEPLOY.md).
 */
export class BulkToolRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  naziv!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serijskiBroj?: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(200)
  napomena?: string;
}

export class BulkImportToolsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkToolRowDto)
  rows!: BulkToolRowDto[];
}
