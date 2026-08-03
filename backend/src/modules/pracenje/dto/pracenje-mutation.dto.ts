import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

/**
 * Mutation DTOs for Praćenje (F1, plan docs/PLAN_PRACENJE_PROIZVODNJE_2026-07.md §3.2).
 * All writes now hit the ORIGINAL 2.0 tables through `PracenjeService` (Prisma), NOT
 * sy15 RPCs. RN id == `work_orders.id` (Int) == legacy `bigtehn_rn_id`; the FE still
 * sends it as `bigtehnRnId` (digits string). Activity refs (odeljenje, RN, project,
 * responsible, source) are 2.0 Int ids — the legacy 1.0 uuids are gone.
 *
 * ⚠️ `bigtehnRnId` MUST be digits only (`^\d+$`) — a decimal string would make
 * `Number(...)` produce a non-integer id; `@Matches(/^\d+$/)` rejects it at the pipe
 * (400, not a downstream 500).
 *
 * ⚠️ EVERY Int field carries `@Type(() => Number)`. The global `ValidationPipe`
 * (src/main.ts) runs with `transform: true` but WITHOUT `enableImplicitConversion`,
 * so a JSON string ("5" from an HTML `<select>.value`) would NOT coerce to a number
 * and `@IsInt()` would reject it (POST /aktivnosti → 400). `@Type(() => Number)`
 * coerces at the transform step; class-transformer keeps `null`/`undefined` as-is
 * (no null→0), so `@IsOptional()` still short-circuits. Boolean fields deliberately
 * get NO `@Type(() => Boolean)` — `Boolean("false")` is `true`, so a string→bool
 * coercion would be wrong; booleans must arrive as real JSON booleans.
 */
const DIGITS = /^\d+$/;

/**
 * Id čvora stabla praćenja (zahtev 053/26 paket 2): cifre = `work_orders.id`, cifre sa
 * VODEĆIM MINUSOM = virtuelni (ručno napravljen) sklop iz `pracenje_virtuelni_sklopovi`
 * (`node_id = -id`, vidi `../virtual-node.ts`). Ostatak validacije je isto strog kao
 * `DIGITS`: bez decimala, bez razmaka, bez „-0" (koje bi `Number()` dalo kao 0 = ni RN
 * ni virtuelni sklop, jer oba SERIAL-a kreću od 1).
 */
const NODE_ID = /^-?[1-9]\d*$|^\d+$/;

/* ── Operativni plan — aktivnost (→ operativne_aktivnosti) ── */

export class UpsertAktivnostDto {
  /** null on create (server assigns Int PK); existing Int id on edit. */
  @IsOptional() @Type(() => Number) @IsInt() id?: number;
  /** → work_orders.id (Int, meki ref). */
  @IsOptional() @Type(() => Number) @IsInt() radniNalogId?: number;
  /** → projects.id (Int, meki ref). */
  @IsOptional() @Type(() => Number) @IsInt() projekatId?: number;
  /** → odeljenja.id (Int, real FK). */
  @Type(() => Number) @IsInt() odeljenjeId!: number;
  @IsString() @MaxLength(500) nazivAktivnosti!: string;
  @IsOptional() @IsISO8601() planiraniPocetak?: string;
  @IsOptional() @IsISO8601() planiraniZavrsetak?: string;
  @IsOptional() @Type(() => Number) @IsInt() odgovoranUserId?: number;
  /** → operativne_aktivnosti.odgovoran_worker_id (workers.id, meki ref). */
  @IsOptional() @Type(() => Number) @IsInt() odgovoranRadnikId?: number;
  @IsOptional()
  @IsIn(["nije_krenulo", "u_toku", "blokirano", "zavrseno"])
  status?: string;
  @IsOptional() @IsIn(["nizak", "srednji", "visok"]) prioritet?: string;
  @IsOptional() @Type(() => Number) @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() brojTp?: string;
  @IsOptional() @IsString() kolicinaText?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @Type(() => Number) @IsInt() zavisiOdAktivnostId?: number;
  @IsOptional() @IsString() zavisiOdText?: string;
  @IsOptional()
  @IsIn(["manual", "auto_from_pozicija", "auto_from_operacije"])
  statusMode?: string;
  @IsOptional() @IsString() rizikNapomena?: string;
  // 'iz_tp' carried by 1.0-imported activities (source = tech process); edit must NOT 400.
  @IsOptional()
  @IsIn(["rucno", "iz_sastanka", "akcioni_plan", "iz_tp"])
  izvor?: string;
  @IsOptional() @Type(() => Number) @IsInt() izvorAkcioniPlanId?: number;
  @IsOptional() @Type(() => Number) @IsInt() izvorPozicijaId?: number;
  @IsOptional() @Type(() => Number) @IsInt() izvorTpOperacijaId?: number;
}

export class ZatvoriAktivnostDto {
  @IsOptional() @IsString() napomena?: string;
}

export class BlokirajAktivnostDto {
  /**
   * Razlog blokade is REQUIRED (1.0 UI + service enforce). `@Matches(/\S/)` rejects
   * an empty/whitespace-only string at the pipe → 400 (the service guard stays as
   * defense-in-depth).
   */
  @IsString() @Matches(/\S/) @MaxLength(1000) razlog!: string;
}

export class OdblokirajAktivnostDto {
  @IsOptional() @IsString() napomena?: string;
}

/**
 * Promote an action point into an activity. Kept as 1.0-shaped uuids because the
 * akcioni-plan/sastanci source is still sy15 — the service returns 501 (NOT_IMPLEMENTED)
 * until that module is ported to 2.0 (see PracenjeService.promoteAkcionaTacka).
 */
export class PromoteAkcionaTackaDto {
  @IsUUID() akcioniPlanId!: string;
  @IsUUID() odeljenjeId!: string;
  @IsUUID() rnId!: string;
}

/* ── Praćenje overrides / napomena (projectId from the route :itemId) ── */

export class PracenjeNapomenaDto {
  /**
   * Id čvora: RN (== work_orders.id == legacy bigtehn_rn_id) ILI virtuelni sklop (negativan,
   * zahtev 053/26 paket 2). Napomena je DOZVOLJENA i na ručno napravljenom sklopu —
   * `pracenje_notes.work_order_id` je goli Int bez FK-a, a čitanje je spojeno po istom ključu.
   */
  @Matches(NODE_ID) bigtehnRnId!: string;
  @IsString() note!: string;
}

export class PracenjeManualOverrideDto {
  /**
   * Id čvora. Negativan (virtuelni sklop) prolazi pipe, ali ga servis odbija sa 422 i
   * čitkom porukom — ručni status/količina se vode na POZICIJI (RN), ne na grupišućem
   * sklopu (zahtev 053/26 paket 2). Bez ovoga bi mobilni OverrideSheet dobio golo 400.
   */
  @Matches(NODE_ID) bigtehnRnId!: string;
  /** ''/omitted → auto (null). 'kompletirano' auto-forces machining+surface DA (docx §4.7). */
  @IsOptional()
  @IsIn(["u_radu", "kompletirano", "nije_zapoceto"])
  status?: string;
  @IsOptional() @IsBoolean() masinska?: boolean;
  @IsOptional() @IsBoolean() povrsinska?: boolean;
  /** "Physically done but not clocked" manual quantity (pieces) — docx §4.6. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) manualQty?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class PracenjeParentOverrideDto {
  /** Id čvora koji se premešta: RN ili VIRTUELNI sklop (negativan — sklop u sklopu). */
  @Matches(NODE_ID) bigtehnRnId!: string;
  /**
   * Novi roditelj: RN id ILI negativan id virtuelnog sklopa (zahtev 053/26 paket 2 —
   * „ubaci poziciju u ručno napravljen sklop"); null/izostavljeno = odlepi na koren.
   */
  @IsOptional() @Matches(NODE_ID) parentRnId?: string | null;
  /** true = revert to the auto (BOM) structure (delete the override). */
  @IsOptional() @IsBoolean() clear?: boolean;
}

/* ── Virtuelni (ručno napravljen) sklop — zahtev 053/26 paket 2 ── */

/**
 * Kreiranje ručnog sklopa u stablu praćenja (`pracenje_virtuelni_sklopovi`). Predmet
 * dolazi iz rute (`:itemId`). NIJE idempotentno po nazivu — dva sklopa istog imena su
 * dozvoljena (odluka: korisnikova odgovornost, kao i dva RN-a istog naziva).
 * `@Matches(/\S/)` odbija naziv od samih razmaka u pipe-u (400, ne prazan red u stablu).
 */
export class VirtuelniSklopCreateDto {
  @IsString() @Matches(/\S/) @MaxLength(200) naziv!: string;
  @IsOptional() @IsIn(["glavni", "pod", "zav"]) tip?: string;
}

/** Izmena ručnog sklopa — oba polja opciona (preimenovanje ILI promena tipa). */
export class VirtuelniSklopUpdateDto {
  @IsOptional() @IsString() @Matches(/\S/) @MaxLength(200) naziv?: string;
  @IsOptional() @IsIn(["glavni", "pod", "zav"]) tip?: string;
}

export class PrioritetShiftDto {
  @IsIn(["up", "down"]) direction!: string;
}

/* ── RN ensure ── */

export class EnsureRnDto {
  @Matches(DIGITS) workOrderId!: string;
}

/* ── ⭐ plan-prioritet setter (spec §7-P10) ── */

/**
 * Set the ⭐ plan-priority list (spec §7-P10 / MODULE_SPEC §2.15): the whole list is
 * replaced — clear all, then write 1..N in the given order. `projectIds` are 2.0
 * `predmet_aktivacije.project_id` values in the desired order. Guards: ≤50 slots,
 * no duplicates (`@ArrayUnique`), each id ≥1 (a positive Int). Existence in
 * `predmet_aktivacije` is verified server-side (→ 422). `@Type(() => Number)` coerces
 * JSON string elements (the global ValidationPipe has no implicit conversion).
 */
export class SetPlanPrioritetDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  projectIds!: number[];
}

/* ── Export-log (server-side → 2.0 audit_log) ── */

export class ExportLogDto {
  /** RN id — accepts a 2.0 Int-string or a legacy uuid (stored verbatim as entity id). */
  @IsOptional() @IsString() @MaxLength(100) rnId?: string | null;
  @IsString() @MaxLength(80) tab!: string;
  @IsOptional() @IsString() rnBroj?: string;
  @IsOptional() @Type(() => Number) @IsInt() predmetItemId?: number;
  @IsOptional() @IsObject() extra?: Record<string, unknown>;
}
