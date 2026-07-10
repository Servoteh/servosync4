import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * Rezni alat (rev_cutting_tool_catalog). Barkod dodeljuje triger na insertu.
 * `compatibleMachineCodes` = na kojim mašinama se koristi (paritet 1.0).
 */
export class CuttingToolCreateDto {
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
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockQty?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  compatibleMachineCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  napomena?: string;
}

export class CuttingToolUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  naziv?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockQty?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  compatibleMachineCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  napomena?: string;
}
