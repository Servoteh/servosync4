import {
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
} from "class-validator";

/**
 * Mutacioni DTO-i za Praćenje R2 (MODULE_SPEC_planovi_pracenje_30.md §3). Sve mutacije
 * su DEFINER/wrapper RPC-ovi kroz `withUserRls` (jsonb ulaz/izlaz); row/scope odluka
 * (can_edit_pracenje / can_manage_predmet_aktivacija / admin) presuđuje sy15.
 *
 * ⚠️ BigInt polja (bigtehn_rn_id, parent_rn_id, work_order_id) MORAJU biti SAMO cifre
 * (`^\d+$`) — decimalni string → 400 (ne 500 iz BigInt SyntaxError; C-fix obrazac).
 */
const DIGITS = /^\d+$/;

/* ── Operativni plan — aktivnost (upsert_operativna_aktivnost, 24 param) ── */

export class UpsertAktivnostDto {
  /** null na kreiranju (server PK), postojeći id na izmeni (NIJE idempotency ključ — 1.0 nema). */
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsUUID() radniNalogId?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsUUID() odeljenjeId!: string;
  @IsString() @MaxLength(500) nazivAktivnosti!: string;
  @IsOptional() @IsISO8601() planiraniPocetak?: string;
  @IsOptional() @IsISO8601() planiraniZavrsetak?: string;
  @IsOptional() @IsUUID() odgovoranUserId?: string;
  @IsOptional() @IsUUID() odgovoranRadnikId?: string;
  @IsOptional()
  @IsIn(["nije_krenulo", "u_toku", "blokirano", "zavrseno"])
  status?: string;
  @IsOptional() @IsIn(["nizak", "srednji", "visok"]) prioritet?: string;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() brojTp?: string;
  @IsOptional() @IsString() kolicinaText?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @IsUUID() zavisiOdAktivnostId?: string;
  @IsOptional() @IsString() zavisiOdText?: string;
  @IsOptional()
  @IsIn(["manual", "auto_from_pozicija", "auto_from_operacije"])
  statusMode?: string;
  @IsOptional() @IsString() rizikNapomena?: string;
  @IsOptional() @IsIn(["rucno", "iz_sastanka"]) izvor?: string;
  @IsOptional() @IsUUID() izvorAkcioniPlanId?: string;
  @IsOptional() @IsUUID() izvorPozicijaId?: string;
  @IsOptional() @IsUUID() izvorTpOperacijaId?: string;
}

export class ZatvoriAktivnostDto {
  @IsOptional() @IsString() napomena?: string;
}

export class BlokirajAktivnostDto {
  /**
   * Razlog blokade je OBAVEZAN (1.0 UI + servis enforce). `@Matches(/\S/)` odbija
   * prazan/whitespace-only string na pipe-u → 400 (nezavisno od servisnog guarda,
   * koji ostaje kao defense-in-depth).
   */
  @IsString() @Matches(/\S/) @MaxLength(1000) razlog!: string;
}

export class OdblokirajAktivnostDto {
  @IsOptional() @IsString() napomena?: string;
}

export class PromoteAkcionaTackaDto {
  @IsUUID() akcioniPlanId!: string;
  @IsUUID() odeljenjeId!: string;
  @IsUUID() rnId!: string;
}

/* ── Praćenje overrides / napomena (itemId iz putanje) ── */

export class PracenjeNapomenaDto {
  @Matches(DIGITS) bigtehnRnId!: string;
  @IsString() note!: string;
  @IsOptional() @IsUUID() rnId?: string;
}

export class PracenjeManualOverrideDto {
  @Matches(DIGITS) bigtehnRnId!: string;
  /** '' /izostavljeno → auto (null); inače jedan od kodova. */
  @IsOptional() @IsIn(["u_radu", "kompletirano", "nije_zapoceto"]) status?: string;
  @IsOptional() @IsBoolean() masinska?: boolean;
  @IsOptional() @IsBoolean() povrsinska?: boolean;
  @IsOptional() @IsUUID() rnId?: string;
}

export class PracenjeParentOverrideDto {
  @Matches(DIGITS) bigtehnRnId!: string;
  @IsOptional() @Matches(DIGITS) parentRnId?: string | null;
  @IsOptional() @IsBoolean() clear?: boolean;
}

export class PrioritetShiftDto {
  @IsIn(["up", "down"]) direction!: string;
}

/* ── RN ensure ── */

export class EnsureRnDto {
  @Matches(DIGITS) workOrderId!: string;
}

/* ── Export-log (server-side; presuda P4 — prvi put PRORADI) ── */

export class ExportLogDto {
  @IsOptional() @IsUUID() rnId?: string | null;
  @IsString() @MaxLength(80) tab!: string;
  @IsOptional() @IsString() rnBroj?: string;
  @IsOptional() @IsInt() predmetItemId?: number;
  @IsOptional() @IsObject() extra?: Record<string, unknown>;
}
