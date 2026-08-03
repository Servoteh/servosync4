import {
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from "class-validator";

/**
 * Query DTO-i za Praćenje read endpointe (paritet Sastanci: nevalidan uuid/broj u
 * query parametru → 400, ne 22P02→500). Globalni ValidationPipe (transform+whitelist).
 *
 * ⚠️ Polja koja idu u `BigInt(...)` / `::int` MORAJU biti SAMO cifre (`^\d+$`), NE
 * `@IsNumberString` (koji prima „1.5" → `BigInt("1.5")` baca SyntaxError PRE try/catch-a
 * → 500, krši DTO ugovor „nevalidan broj → 400"). `@Matches(/^\d+$/)` odbija decimale u pipe-u.
 */
const DIGITS = /^\d+$/;

/**
 * Id čvora stabla praćenja (zahtev 053/26 paket 2) — cifre = `work_orders.id`, cifre sa
 * VODEĆIM MINUSOM = virtuelni (ručno napravljen) sklop (`node_id = -id`). Deep-link
 * `?root=-7` i „Opseg (sklop)" moraju da rade i za sklop bez RN-a. Ostatak je isto strog
 * kao `DIGITS` (bez decimala/razmaka; „-0" nije validno — oba SERIAL-a kreću od 1).
 */
const NODE_ID = /^-?[1-9]\d*$|^\d+$/;

export class PortfolioQueryDto {
  /** Veličina lota za rollup (get_pracenje_portfolio p_lot_qty; default 12). */
  @IsOptional() @IsNumberString() lotQty?: string;
}

export class IzvestajQueryDto {
  /** Koren opsega: RN id ILI negativan id ručno napravljenog sklopa (053/26 paket 2). */
  @IsOptional() @Matches(NODE_ID) rootRn?: string;
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
  /** BigTehn varijanta: MES work_order_id (→ BigInt) + operacija (→ ::int) (+ opciona mašina). */
  @IsOptional() @Matches(DIGITS) workOrder?: string;
  @IsOptional() @Matches(DIGITS) op?: string;
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
