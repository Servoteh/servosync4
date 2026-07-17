import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

/**
 * R3 — Kartica alata + kartica mašine (PLAN_PARITET_reversi_2026-07-17.md, Drop R3).
 * CRUD sub-evidencija ručnog alata i mašine — paritet 1.0 `reversiToolDetail.js`
 * (baterije RB-07, servis RB-09) i `revMasineTab.js` (glave RB-57). Podaci žive u
 * sy15; pisanje ide kroz `withUser` (create — created_by = auth.uid()) ili direktan
 * typed PATCH/DELETE (BYPASSRLS — endpoint guard `reversi.manage` je granica, kao
 * `updateTool`/`updateCuttingTool`). Enum vrednosti su DB CHECK ograničenja
 * (`20260701_rev_tools_detail_service_otpis.sql`, `20260702_rev_machines_view_heads.sql`).
 */

/** Baterija alata (RB-07) — INSERT/UPDATE rev_tool_batteries. */
export class CreateBatteryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  serijskiBroj?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  kapacitet?: string | null;

  @IsOptional()
  @IsDateString()
  datumNabavke?: string | null;

  @IsOptional()
  @IsIn(["active", "scrapped", "lost"])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string | null;
}

export class UpdateBatteryDto extends CreateBatteryDto {}

/** Servis / popravka alata (RB-09) — INSERT/UPDATE rev_tool_service_log. */
export class CreateServiceDto {
  /** Ako se izostavi, DB podrazumeva CURRENT_DATE (paritet 1.0 default = danas). */
  @IsOptional()
  @IsDateString()
  datum?: string;

  @IsOptional()
  @IsIn(["servis", "popravka", "zamena_baterije", "kalibracija", "ostalo"])
  tip?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  opis?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  izvrsilac?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  trosak?: number | null;

  @IsOptional()
  @IsIn(["planiran", "u_toku", "zavrsen", "otkazan"])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string | null;
}

export class UpdateServiceDto extends CreateServiceDto {}

/** Glava mašine (RB-57) — INSERT/UPDATE rev_machine_heads (evidencija na kartici). */
export class CreateMachineHeadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  naziv!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tip?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serijskiBroj?: string | null;

  @IsOptional()
  @IsIn(["ACTIVE", "SERVIS", "OTPISANA"])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string | null;
}

/** Izmena glave (RB-57) — sva polja opciona (PATCH). */
export class UpdateMachineHeadDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  oznaka?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  naziv?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  tip?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serijskiBroj?: string | null;

  @IsOptional()
  @IsIn(["ACTIVE", "SERVIS", "OTPISANA"])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  napomena?: string | null;
}
