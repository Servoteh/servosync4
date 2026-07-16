import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/**
 * Podešavanja — Drop 2 predmet-aktivacija WRITE DTO-ovi (P11). Guard = settings.predmet_aktivacija;
 * RPC-ovi (set_predmet_aktivacija / set_predmet_plan_prioritet*) re-validiraju gate u DB kroz GUC.
 * Paritet 1.0 predmetAktivacija.js / predmetPlanPrioritet.js.
 */

/** Tvrdi gornji prag prioriteta (= CHECK slot <=49 + RPC bound 1..50; paritet 1.0). */
export const PRIORITET_MAX_CEILING = 50;

/**
 * Postavi aktivaciju jednog predmeta. `aktivan` obavezan (RPC p_aktivan). `napomena`:
 * undefined/izostavljeno = ne diraj (RPC NULL→keep); '' = obriši (RPC ''→clear); string = postavi.
 * `projektovanjeMontaza`: undefined = ne diraj flag.
 */
export class SetPredmetAktivacijaDto {
  @IsBoolean() aktivan!: boolean;
  @IsOptional() @IsString() @MaxLength(4000) napomena?: string;
  @IsOptional() @IsBoolean() projektovanjeMontaza?: boolean;
}

/** Redosled ⭐ prioriteta (set_predmet_plan_prioritet p_item_ids). */
export class SetPrioritetIdsDto {
  @IsArray()
  @ArrayMaxSize(PRIORITET_MAX_CEILING)
  @IsInt({ each: true })
  @Type(() => Number)
  itemIds!: number[];
}

/** Novi maksimum broja prioriteta (set_predmet_plan_prioritet_max p_max; 1..50). */
export class SetPrioritetMaxDto {
  @IsInt()
  @Min(1)
  @Max(PRIORITET_MAX_CEILING)
  @Type(() => Number)
  max!: number;
}
