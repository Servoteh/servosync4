import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { IsCalendarDate } from "../../moj-profil/dto/is-calendar-date";
import { IsPredmetRef } from "./is-predmet-ref";

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
/** Kao TIME_RE, ali dozvoljava '' = OBRIŠI vreme (service `toDbTime('')` → null).
 *  Samo na PATCH-u termina (S4 „Uredi") — create/šabloni ostaju strogi. */
const TIME_OR_CLEAR_RE = /^$|^\d{2}:\d{2}(:\d{2})?$/;

/**
 * Učesnik za poziv iz „prve forme" (zahtev 005/26). NAMERNO samo email+label:
 * `pozvan`/`prisutan` se NE primaju od klijenta — create uvek upiše pozvan=true,
 * prisutan=false (poziv = kandidat za otkazni mejl; prisutan tek na „▶ Počni").
 * (Zamka pozvan=false: triger `sast_trg_ucesnik_invite` NE gleda pozvan i ipak
 * pošalje pozivnicu, dok otkazni RPC filtrira pozvan=true → asimetrija.)
 */
export class InviteUcesnikDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() @MaxLength(200) label?: string;
}

export class CreateSastanakDto extends IdempotentDto {
  /** 'periodicni' od 024/26 (predlog d1): serija sa proizvoljnim intervalom;
   *  'sedmicni' (kolegijum) ostaje ZASEBAN tip — njegova automatika i „Sedmični"
   *  modal rade nepromenjeno (uslov iz predloga: bez promene za kolegijum). */
  @IsOptional()
  @IsIn(["sedmicni", "projektni", "tematski", "dnevni", "periodicni"])
  tip?: string;

  /** Broj dana između dva termina — OBAVEZAN uz tip 'periodicni', zabranjen uz
   *  ostale (servisna validacija; kolona `sastanci.interval_days`, 024/26 d1). */
  @IsOptional() @IsInt() @Min(1) @Max(365) intervalDays?: number;

  @IsString() @MaxLength(300) naslov!: string;

  /** YYYY-MM-DD (kalendarski datum sastanka). */
  @IsISO8601() datum!: string;

  @IsOptional() @Matches(TIME_RE) vreme?: string;
  @IsOptional() @IsString() mesto?: string;
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
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

  /**
   * Zahtev 005/26 — pozivanje učesnika iz „prve forme" (Zoran Jaraković, 23.07).
   * Opcioni; prazno = sastanak bez poziva. Svaki umetnut red u `sastanak_ucesnici`
   * (za planiran sastanak) AUTO-okida sy15 DEFINER trigger `sast_trg_ucesnik_invite`
   * → 'meeting_invite' mejl (tema=naslov / termin=datum+vreme / mesto) svakom
   * učesniku, isporuka postojećim `sast_notify_dispatch` cron → edge-om. Doktrina
   * B10: BE NIKAD ne INSERT-uje u `sastanci_notification_log` — enqueue radi trigger
   * (isti put kao dodavanje učesnika kroz PUT/POST /:id/ucesnici). Cap 100 = zaštita
   * od masovnog mejla i tx timeout-a. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => InviteUcesnikDto)
  ucesnici?: InviteUcesnikDto[];
}

export class UpdateSastanakDto {
  /** Promena tipa postojećeg sastanka (024/26 predlog d2 — „od trenutka promene
   *  važi novi režim, istorija netaknuta"). */
  @IsOptional()
  @IsIn(["sedmicni", "projektni", "tematski", "dnevni", "periodicni"])
  tip?: string;
  /** Vidi CreateSastanakDto.intervalDays. */
  @IsOptional() @IsInt() @Min(1) @Max(365) intervalDays?: number;
  @IsOptional() @IsString() @MaxLength(300) naslov?: string;
  @IsOptional() @IsISO8601() datum?: string;
  @IsOptional() @Matches(TIME_OR_CLEAR_RE) vreme?: string;
  @IsOptional() @IsString() mesto?: string;
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
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
  /**
   * Datum ODRŽAVANJA koji nosi zapisnik — PDF, telo mejla i naziv priloga
   * (`Zapisnik-<datum>.pdf`). FE ga podrazumevano puni danom zaključavanja, a nudi
   * i `sastanci.datum` (zakazani termin) kad se razlikuju. Izostavljen → RPC ostavlja
   * kolonu kakva jeste (po pravilu NULL) i sve pada na `sastanci.datum`, tj. ponašanje
   * kao pre. Zahtev 014/26 + presuda vlasnika 25.07.2026.
   * Strogi kalendarski `YYYY-MM-DD` (`2026-02-31` bi u ::date cast-u dao 22008 → 500).
   */
  @IsOptional() @IsCalendarDate() zapisnikDatum?: string;
}

/**
 * Ispravka datuma zapisnika POSLE zaključavanja (Zoranova primedba 014/26 —
 * zaključan zapisnik sa pogrešnim datumom). Nije idempotency-nosilac: PATCH sa
 * istim datumom je bezopasno ponovljiv (apsolutna vrednost, ne inkrement).
 */
export class SetZapisnikDatumDto {
  @IsCalendarDate() zapisnikDatum!: string;
}

/** Otkazivanje (S2) — nosi samo idempotency ključ; RPC šalje `meeting_cancel`
 *  mejlove pozvanim učesnicima, pa dupli POST NE sme da ih pošalje dvaput. */
export class CancelSastanakDto extends IdempotentDto {}

export class RsvpDto {
  /** dolazim | ne_dolazim | null(clear). */
  @IsOptional() @IsIn(["dolazim", "ne_dolazim"]) status?: string;
}

/** Status SOPSTVENE akcione tačke (odluka Nenada 26.07 — pod sastanci.read;
 *  SECURITY DEFINER RPC presuđuje vlasništvo po odgovoran_email). */
export class MyAkcijaStatusDto {
  @IsIn(["otvoren", "u_toku", "zavrsen"]) status!: string;
}

/** SOPSTVENA priprema (odluka 26.07): samo pripremljen + tekst — pozvan/prisutan
 *  i dalje vodi zapisničar (su_update RLS netaknut). */
export class MyPripremaDto {
  @IsOptional() @IsBoolean() pripremljen?: boolean;
  @IsOptional() @IsString() @MaxLength(4000) priprema?: string;
}

/* ── Učesnici ── */

export class UcesnikInputDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsBoolean() prisutan?: boolean;
  @IsOptional() @IsBoolean() pozvan?: boolean;
  @IsOptional() @IsString() napomena?: string;
}

export class BulkUcesniciDto extends IdempotentDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UcesnikInputDto)
  ucesnici!: UcesnikInputDto[];
}

export class AddUcesnikDto {
  @IsEmail() @MaxLength(254) email!: string;
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
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
  @IsOptional() @IsInt() rb?: number;
  // 4000 = odbrana u dubinu za PDF prelom (zahtev 014/26 t.6); naslov ima 500.
  @IsOptional() @IsString() @MaxLength(4000) opis?: string;
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
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
  @IsOptional() @IsInt() rb?: number;
  @IsOptional() @IsString() @MaxLength(4000) opis?: string;
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
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
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
  /** Predmet: 3.0 `Int` ILI sy15 uuid; `null` briše vezu (prelazno — blokada 5). */
  @IsOptional() @IsPredmetRef() projekatId?: string | number | null;
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
  /** Predmet je OBAVEZAN za draft temu; 3.0 `Int` ILI sy15 uuid (blokada 5). */
  @IsPredmetRef() projektId!: string | number;
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
