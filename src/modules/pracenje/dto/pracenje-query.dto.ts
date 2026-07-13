import { IsNumberString, IsOptional, IsString, IsUUID } from "class-validator";

/**
 * Query DTO-i za Praćenje read endpointe (paritet Sastanci: nevalidan uuid/broj u
 * query parametru → 400, ne 22P02→500). Globalni ValidationPipe (transform+whitelist).
 */

export class PortfolioQueryDto {
  /** Veličina lota za rollup (get_pracenje_portfolio p_lot_qty; default 12). */
  @IsOptional() @IsNumberString() lotQty?: string;
}

export class IzvestajQueryDto {
  /** Koren RN (bigint MES id) — get_predmet_pracenje_izvestaj p_root_rn_id. */
  @IsOptional() @IsNumberString() rootRn?: string;
  @IsOptional() @IsNumberString() lotQty?: string;
}

export class OperativniPlanQueryDto {
  /** Filter po projektu (get_operativni_plan p_projekat_id). */
  @IsOptional() @IsUUID() projekat?: string;
}

export class CanEditQueryDto {
  @IsOptional() @IsUUID() projekat?: string;
}

export class PrijaveQueryDto {
  /** BigTehn varijanta: MES work_order_id + operacija (+ opciona mašina). */
  @IsOptional() @IsNumberString() workOrder?: string;
  @IsOptional() @IsNumberString() op?: string;
  @IsOptional() @IsString() machine?: string;
  /** Lokalna varijanta: prijava_rada po Faza-2 poziciji (uuid). */
  @IsOptional() @IsUUID() pozicija?: string;
}

export class AkcioneTackeQueryDto {
  @IsOptional() @IsUUID() projekat?: string;
}

export class SearchDeloviQueryDto {
  @IsOptional() @IsString() q?: string;
}

export class RnResolveQueryDto {
  /** RN broj / legacy_idrn / uuid — resolveRnId paritet. */
  @IsString() ref!: string;
}
