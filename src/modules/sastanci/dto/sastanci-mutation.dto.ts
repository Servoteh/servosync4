import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
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
  ValidateNested,
} from "class-validator";

/**
 * Mutacioni DTO-ovi za Sastanci R2 (MODULE_SPEC_sastanci_ai_30.md §3).
 * `clientEventId` (uuid) je OBAVEZAN na NE-idempotentnim POST mutacijama
 * (create sastanak/akcija/tema/odluka/tačka, bulk replace učesnika, lock,
 * instantiate, draft predlog) — idempotency ključ (Sy15Service.runIdempotentRls).
 * PATCH/DELETE/reorder/toggle/re-send (delete-pa-enqueue) su idempotentni pa ga
 * NEMAJU. Row-odluka (organizator-trio/učesnik-scope) presuđuje sy15 RLS kroz GUC.
 */

/** Baza za idempotentne POST-ove. */
export class IdempotentDto {
  @IsUUID()
  clientEventId!: string;
}

const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

export class CreateSastanakDto extends IdempotentDto {
  @IsOptional()
  @IsIn(["sedmicni", "projektni", "tematski", "dnevni"])
  tip?: string;

  @IsString() @MaxLength(300) naslov!: string;

  /** YYYY-MM-DD (kalendarski datum sastanka). */
  @IsISO8601() datum!: string;

  @IsOptional() @Matches(TIME_RE) vreme?: string;
  @IsOptional() @IsString() mesto?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsString() vodioEmail?: string;
  @IsOptional() @IsString() vodioLabel?: string;
  @IsOptional() @IsString() zapisnicarEmail?: string;
  @IsOptional() @IsString() zapisnicarLabel?: string;
  /** BEZ 'zakljucan' — zaključavanje ide ISKLJUČIVO kroz POST /:id/lock
   *  (RPC sast_zakljucaj_sastanak: snapshot + PDF path + meeting_locked mejlovi).
   *  Backdoor status='zakljucan' bi zaključao bez arhive/notifikacija (S-P0). */
  @IsOptional()
  @IsIn(["planiran", "u_toku", "zavrsen", "otkazan"])
  status?: string;
  @IsOptional() @IsString() napomena?: string;
}

export class UpdateSastanakDto {
  @IsOptional()
  @IsIn(["sedmicni", "projektni", "tematski", "dnevni"])
  tip?: string;
  @IsOptional() @IsString() @MaxLength(300) naslov?: string;
  @IsOptional() @IsISO8601() datum?: string;
  @IsOptional() @Matches(TIME_RE) vreme?: string;
  @IsOptional() @IsString() mesto?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsString() vodioEmail?: string;
  @IsOptional() @IsString() vodioLabel?: string;
  @IsOptional() @IsString() zapisnicarEmail?: string;
  @IsOptional() @IsString() zapisnicarLabel?: string;
  /** BEZ 'zakljucan' — vidi CreateSastanakDto (lock samo kroz POST /:id/lock). */
  @IsOptional()
  @IsIn(["planiran", "u_toku", "zavrsen", "otkazan"])
  status?: string;
  @IsOptional() @IsString() napomena?: string;
}

export class LockSastanakDto extends IdempotentDto {
  /** Bucket-relativna putanja PDF-a (`{id}/{ts}_zapisnik.pdf`) — upisuje je RPC
   *  PRE meeting_locked trigera (§2 pravilo 8). Opcioni (zaključavanje bez PDF-a). */
  @IsOptional() @IsString() pdfStoragePath?: string;
}

export class RsvpDto {
  /** dolazim | ne_dolazim | null(clear). */
  @IsOptional() @IsIn(["dolazim", "ne_dolazim"]) status?: string;
}

/* ── Učesnici ── */

export class UcesnikInputDto {
  @IsString() email!: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsBoolean() prisutan?: boolean;
  @IsOptional() @IsBoolean() pozvan?: boolean;
  @IsOptional() @IsString() napomena?: string;
}

export class BulkUcesniciDto extends IdempotentDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UcesnikInputDto)
  ucesnici!: UcesnikInputDto[];
}

export class AddUcesnikDto {
  @IsString() email!: string;
  @IsOptional() @IsString() label?: string;
}

export class UpdateUcesnikDto {
  @IsOptional() @IsBoolean() pozvan?: boolean;
  @IsOptional() @IsBoolean() prisutan?: boolean;
  @IsOptional() @IsBoolean() pripremljen?: boolean;
  @IsOptional() @IsString() priprema?: string;
}

/* ── Tačke zapisnika (presek_aktivnosti) ── */

export class CreateAktivnostDto extends IdempotentDto {
  @IsOptional() @IsString() @MaxLength(500) naslov?: string;
  @IsOptional() @IsString() podRn?: string;
  @IsOptional() @IsString() sadrzajHtml?: string;
  @IsOptional() @IsString() sadrzajText?: string;
  @IsOptional() @IsString() odgovoranEmail?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @IsString() odgovoranText?: string;
  @IsOptional() @IsISO8601() rok?: string;
  @IsOptional() @IsString() rokText?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() napomena?: string;
  @IsOptional() @IsUUID() temaId?: string;
}

export class UpdateAktivnostDto {
  @IsOptional() @IsString() @MaxLength(500) naslov?: string;
  @IsOptional() @IsString() podRn?: string;
  @IsOptional() @IsString() sadrzajHtml?: string;
  @IsOptional() @IsString() sadrzajText?: string;
  @IsOptional() @IsString() odgovoranEmail?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @IsString() odgovoranText?: string;
  @IsOptional() @IsISO8601() rok?: string;
  @IsOptional() @IsString() rokText?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() napomena?: string;
}

export class ReorderDto {
  /** Novi redosled po ID-ju (index = redosled). */
  @IsArray() @ArrayMinSize(1) @IsUUID("4", { each: true }) ids!: string[];
}

/* ── Odluke ── */

export class CreateOdlukaDto extends IdempotentDto {
  @IsString() @MaxLength(500) naslov!: string;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() odlucioEmail?: string;
  @IsOptional() @IsString() odlucioLabel?: string;
  @IsOptional() @IsISO8601() odlukaDatum?: string;
  @IsOptional() @IsString() uticaj?: string;
  @IsOptional() @IsUUID() vezaTemaId?: string;
  @IsOptional() @IsUUID() vezaAkcijaId?: string;
  @IsOptional() @IsIn(["na_snazi", "opozvana"]) status?: string;
}

export class UpdateOdlukaDto {
  @IsOptional() @IsString() @MaxLength(500) naslov?: string;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() odlucioEmail?: string;
  @IsOptional() @IsString() odlucioLabel?: string;
  @IsOptional() @IsISO8601() odlukaDatum?: string;
  @IsOptional() @IsString() uticaj?: string;
  @IsOptional() @IsUUID() vezaTemaId?: string;
  @IsOptional() @IsUUID() vezaAkcijaId?: string;
  @IsOptional() @IsIn(["na_snazi", "opozvana"]) status?: string;
}

/* ── Akcioni plan ── */

export class CreateAkcijaDto extends IdempotentDto {
  @IsString() @MaxLength(500) naslov!: string;
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsUUID() temaId?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() odgovoranEmail?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @IsString() odgovoranText?: string;
  @IsOptional() @IsISO8601() rok?: string;
  @IsOptional() @IsString() rokText?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsInt() prioritet?: number;
}

export class PatchAkcijaDto {
  @IsOptional() @IsString() @MaxLength(500) naslov?: string;
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsString() odgovoranEmail?: string;
  @IsOptional() @IsString() odgovoranLabel?: string;
  @IsOptional() @IsString() odgovoranText?: string;
  @IsOptional() @IsISO8601() rok?: string;
  @IsOptional() @IsString() rokText?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsInt() prioritet?: number;
  @IsOptional() @IsString() zatvorenNapomena?: string;
}

export class BulkStatusDto {
  @IsArray() @ArrayMinSize(1) @IsUUID("4", { each: true }) ids!: string[];
  @IsString() status!: string;
}

/* ── PM teme ── */

export class CreateTemaDto extends IdempotentDto {
  @IsString() @MaxLength(500) naslov!: string;
  @IsOptional() @IsString() vrsta?: string;
  @IsOptional() @IsString() oblast?: string;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsInt() prioritet?: number;
  @IsOptional() @IsBoolean() hitno?: boolean;
  @IsOptional() @IsBoolean() zaRazmatranje?: boolean;
}

export class UpdateTemaDto {
  @IsOptional() @IsString() @MaxLength(500) naslov?: string;
  @IsOptional() @IsString() vrsta?: string;
  @IsOptional() @IsString() oblast?: string;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsUUID() projekatId?: string;
  @IsOptional() @IsUUID() sastanakId?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsInt() prioritet?: number;
  @IsOptional() @IsBoolean() hitno?: boolean;
  @IsOptional() @IsBoolean() zaRazmatranje?: boolean;
  @IsOptional() @IsString() resioNapomena?: string;
}

export class TemaHitnoDto {
  @IsBoolean() hitno!: boolean;
}

export class TemaRazmatranjeDto {
  @IsBoolean() zaRazmatranje!: boolean;
}

export class TemaAdminRangDto {
  /** null = ukloni rang. */
  @IsOptional() @IsInt() rang?: number | null;
}

export class TemaDodeliDto {
  @IsUUID() sastanakId!: string;
}

export class ReorderRangDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RangItemDto)
  items!: RangItemDto[];
}

export class RangItemDto {
  @IsUUID() id!: string;
  @IsOptional() @IsInt() rang?: number | null;
}

export class CreateDraftTemaDto extends IdempotentDto {
  @IsUUID() projektId!: string;
  @IsString() @MaxLength(500) naslov!: string;
  @IsOptional() @IsString() vrsta?: string;
  @IsOptional() @IsString() oblast?: string;
  @IsOptional() @IsString() opis?: string;
  @IsOptional() @IsInt() prioritet?: number;
  @IsOptional() @IsBoolean() hitno?: boolean;
  @IsOptional() @IsString() predlozioLabel?: string;
}

export class DraftReviewDto {
  @IsIn(["aktivna", "odbijena", "usvojeno", "odbijeno"]) odluka!: string;
  @IsOptional() @IsString() napomena?: string;
}

export class DraftUvediDto {
  @IsUUID() sastanakId!: string;
}

/* ── Šabloni ── */

export class TemplateUcesnikDto {
  @IsString() email!: string;
  @IsOptional() @IsString() label?: string;
}

export class CreateTemplateDto extends IdempotentDto {
  @IsString() @MaxLength(200) naziv!: string;
  @IsOptional() @IsString() tip?: string;
  @IsOptional() @IsString() mesto?: string;
  @IsOptional() @IsString() vodioEmail?: string;
  @IsOptional() @IsString() zapisnicarEmail?: string;
  @IsOptional()
  @IsIn(["none", "daily", "weekly", "biweekly", "monthly"])
  cadence?: string;
  @IsOptional() @IsInt() cadenceDow?: number;
  @IsOptional() @IsInt() cadenceDom?: number;
  @IsOptional() @Matches(TIME_RE) vreme?: string;
  @IsOptional() @IsString() napomena?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateUcesnikDto)
  ucesnici?: TemplateUcesnikDto[];
}

export class UpdateTemplateDto {
  @IsOptional() @IsString() @MaxLength(200) naziv?: string;
  @IsOptional() @IsString() tip?: string;
  @IsOptional() @IsString() mesto?: string;
  @IsOptional() @IsString() vodioEmail?: string;
  @IsOptional() @IsString() zapisnicarEmail?: string;
  @IsOptional()
  @IsIn(["none", "daily", "weekly", "biweekly", "monthly"])
  cadence?: string;
  @IsOptional() @IsInt() cadenceDow?: number;
  @IsOptional() @IsInt() cadenceDom?: number;
  @IsOptional() @Matches(TIME_RE) vreme?: string;
  @IsOptional() @IsString() napomena?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateUcesnikDto)
  ucesnici?: TemplateUcesnikDto[];
}

export class InstantiateTemplateDto extends IdempotentDto {}

/* ── Prefs ── */

export class UpdatePrefsDto {
  @IsOptional() @IsBoolean() onNewAkcija?: boolean;
  @IsOptional() @IsBoolean() onChangeAkcija?: boolean;
  @IsOptional() @IsBoolean() onMeetingInvite?: boolean;
  @IsOptional() @IsBoolean() onMeetingLocked?: boolean;
  @IsOptional() @IsBoolean() onActionReminder?: boolean;
  @IsOptional() @IsBoolean() onMeetingReminder?: boolean;
}

/* ── Slike ── */

/** Multipart polja uz upload slike (fajl je `file`). */
export class UploadSlikaDto {
  @IsOptional() @IsUUID() aktivnostId?: string;
  @IsOptional() @IsString() caption?: string;
}

export class UpdateSlikaDto {
  @IsOptional() @IsString() caption?: string;
  @IsOptional() @IsInt() redosled?: number;
}

/* ── Arhiva PDF (lock/regeneriši) ── */

/** Idempotentni upload PDF zapisnika (multipart `file`) uz opcioni clientEventId. */
export class ArhivaPdfDto {
  @IsOptional() @IsUUID() clientEventId?: string;
  /** Regen tok (zaključan sastanak): true → arhiva red MORA biti pogođen; 0 redova
   *  (RLS write-scope odbija ili red ne postoji) = 403 umesto tihog 200 sa starim
   *  PDF-om u arhivi. Lock tok NE šalje flag — red nastaje tek u RPC-u
   *  sast_zakljucaj_sastanak (path ide kroz p_pdf_storage_path), pa je 0 legitimno.
   *  Multipart NE prenosi native boolean ('true' stiže kao string) → koercija pre
   *  @IsBoolean (obrazac DocumentMetaDto, kadrovska CRITICAL #1). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  requireArhiva?: boolean;
}

/* ── Prenos (Sedmični + prenos) ── */

/** POST /:id/prenos — paritet 1.0 prenesiUNoviSastanak (sastanci.js:258). */
export class PrenosDto extends IdempotentDto {
  /** Izvorni sastanak sa koga se prenose učesnici + otvorene akcije.
   *  Izostavljen → BE auto-pick 1.0 semantikom (poslednji istog tipa
   *  STROGO pre datuma novog). */
  @IsOptional() @IsUUID() fromSastanakId?: string;
}

/* ── Sedmični ── */

export class WeeklyPomeriDto {
  @IsISO8601() datum!: string;
  @IsOptional() @Matches(TIME_RE) vreme?: string;
}

export class WeeklyOdloziDto {
  /** Ponedeljak ciljne nedelje (null = naredna). */
  @IsOptional() @IsISO8601() weekMonday?: string;
  @IsOptional() @IsString() reason?: string;
}

export class WeeklyVratiDto {
  @IsOptional() @IsISO8601() weekMonday?: string;
}

/* ── AI model (admin) ── */

export class SetAiModelDto {
  @IsIn(["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"])
  model!: string;
}

/* ── AI rezime sastanka (Sažmi zapisnik) ── */

export class AiSummaryDto {
  /** Sklopljen objekat sastanka (naslov/datum/učesnici/grupe akcija/diff) — FE gradi. */
  @IsObject() sastanak!: Record<string, unknown>;
}
