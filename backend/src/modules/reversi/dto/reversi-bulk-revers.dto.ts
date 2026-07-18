import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

/**
 * R5d — Bulk import reznog kataloga + reversa (PLAN_PARITET_reversi_2026-07-17.md).
 *
 * FE parsira XLSX/CSV, mapira kolone po alias-ima i (opc.) popravlja mojibake
 * (RC-44/47/48) pa šalje NORMALIZOVANE redove (camelCase ključevi). Backend nosi
 * tešku višeentitetsku logiku iz 1.0 `bulkImportModal.js`:
 *   - `bulk-import/cutting-tools`  → RC-50 (insert rev_cutting_tool_catalog + seed),
 *   - `bulk-import/reversals/analyze` → RC-51/53/56 (dry-run: resolve + blokade),
 *   - `bulk-import/reversals` → RC-54 (auto-create + grupisanje + issue, idempotent
 *     po `bulk_import_legacy_key` — kao 1.0),
 *   - `bulk-import/reversals/rollback` → RC-55 (storno sesije → RETURNED).
 */

/** RC-50 — jedan red uvoza reznog kataloga (paritet 1.0 CUTTING_COLS). */
export class BulkCuttingRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  naziv!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  compatibleMachineCodes?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  unit?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minStockQty?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string;

  /** Početna količina → seed u ALAT-MAG-01 ako > 0 (paritet 1.0 importCutting). */
  @IsOptional()
  @IsInt()
  @Min(0)
  initialQty?: number;
}

export class BulkImportCuttingDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkCuttingRowDto)
  rows!: BulkCuttingRowDto[];
}

/**
 * RC-51/54/56 — jedan red uvoza reversa (paritet 1.0 REVERS_COLS, mapirano na
 * camelCase). `tip` ∈ {TOOL, COOPERATION_GOODS, CUTTING_TOOL}; `primalacTip` ∈
 * {EMPLOYEE, DEPARTMENT, EXTERNAL_COMPANY, MACHINE}. Za CUTTING_TOOL `primalac`
 * sme biti zarezom-odvojena lista (PRIMARY + SECONDARY operateri).
 */
export class ReversalRowDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  tip!: string;

  /** 'YYYY-MM-DD' — datum izdavanja (prazno = danas). */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  datum?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  primalacTip!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(400)
  primalac!: string;

  /** rj_code mašine (obavezno za CUTTING_TOOL i MACHINE primaoca). */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  masina?: string;

  /** Oznaka ili barkod alata/šifre reznog. */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  alat!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  kolicina?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  rokPovracaja?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string;
}

export class AnalyzeReversalsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReversalRowDto)
  rows!: ReversalRowDto[];

  /** Ime izvornog fajla — ulazi u `bulk_import_legacy_key` (dedup po fajlu). */
  @IsOptional()
  @IsString()
  @MaxLength(260)
  sourceFileName?: string;
}

export class ExecuteReversalsDto extends AnalyzeReversalsDto {
  /** `true` = potvrđen „⚠ Ipak nastavi" (override detekcije duplikata, RC-53). */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RollbackReversalsDto {
  @IsArray()
  @IsUUID(undefined, { each: true })
  documentIds!: string[];
}

/** RC-52 — fuzzy razrešavanje liste imena radnika u employee_id. */
export class ResolveEmployeesDto {
  @IsArray()
  @IsString({ each: true })
  names!: string[];
}
