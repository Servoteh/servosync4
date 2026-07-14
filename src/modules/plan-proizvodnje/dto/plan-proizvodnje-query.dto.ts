import { IsNumberString, IsOptional, IsString, Matches } from "class-validator";

/**
 * Query DTO-i za Plan proizvodnje read endpointe (nevalidan broj → 400).
 * ⚠️ Polja koja idu u `BigInt(...)` MORAJU biti SAMO cifre (`^\d+$`): `@IsNumberString`
 * prima „1.5" → `BigInt("1.5")` baca SyntaxError PRE try/catch-a → 500 (krši DTO ugovor).
 */
const DIGITS = /^\d+$/;

export class OperationsQueryDto {
  /** rj_code mašine → RPC plan_pp_open_ops_for_machine (paginacija po RN). */
  @IsOptional() @IsString() machine?: string;
  /** slug odeljenja (glodanje/struganje/…/ostalo) → view filter po effective_machine_code. */
  @IsOptional() @IsString() dept?: string;
  @IsOptional() @IsNumberString() limit?: string;
  @IsOptional() @IsNumberString() offset?: string;
}

export class SearchOpsQueryDto {
  @IsOptional() @IsString() q?: string;
}

export class CooperationQueryDto {
  @IsOptional() @IsString() q?: string;
}

export class DrawingsQueryDto {
  @Matches(DIGITS) workOrder!: string;
  @Matches(DIGITS) line!: string;
}
