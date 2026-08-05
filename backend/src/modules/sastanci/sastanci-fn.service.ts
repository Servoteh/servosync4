import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { SastanciAuthzService } from "./sastanci-authz.service";
import {
  belgradeParts,
  belgradeTimeToUtc,
  shiftBelgradeDate,
} from "../scheduler/belgrade-time";

/**
 * Prepis sy15 `SECURITY DEFINER` funkcija i LOGIČKIH trigera domena sastanaka u
 * NestJS, nad 3.0 bazom (korak 1 seobe — docs/SEOBA_SASTANCI_PB_2026-08-05.md).
 *
 * ŠTA JE OVDE, A ŠTA NIJE: prepisane su ISKLJUČIVO funkcije koje 3.0 backend
 * STVARNO zove (izmereno grep-om nad `src/`, 06.08.2026) — 17 od 74 funkcije
 * domena. Ostale (`sast_create_weekly_at` je izuzetak, zove je `sast_weekly_*`)
 * niko ne poziva i umiru sa sy15; spisak je u runbook-u.
 *
 * Uz njih su prepisana i ČETIRI trigera koja NISU mehanika nego poslovna logika
 * (migracija ih namerno ne prenosi — v. §2.5 migracije):
 *   sast_trg_ucesnik_invite          -> ucesnikInviteTrigger
 *   sast_trg_ucesnik_invite_cleanup  -> ucesnikInviteCleanup
 *   sast_trg_meeting_locked          -> (u sklopu `zakljucajSastanak`)
 *   akcioni_plan_trg_istorija        -> akcijaIstorija
 * plus dva guard-trigera koja su bila brana upisa:
 *   sast_check_not_locked            -> assertNotLocked
 *   sast_pm_teme_draft_status_guard  -> assertDraftStatusPrelaz
 *
 * IZVOR: sva tela su prepisana sa ŽIVE sy15 (`pg_get_functiondef`, 06.08.2026),
 * ne po sećanju i ne po dokumentaciji. Odstupanja od izvora su samo tri, i sva
 * tri su posledica seobe (ne izbor):
 *   1. `auth.jwt() ->> 'email'` ne postoji -> mejl je EKSPLICITAN argument;
 *   2. `current_user_is_management()` / `has_edit_role()` -> `SastanciAuthzService`
 *      (3.0 `users` + `user_roles`, isti skup rola);
 *   3. `kadr_holidays` je kadrovska (korak 4) i JOŠ NIJE u 3.0 -> praznici se
 *      dobijaju od pozivaoca (`praznici` argument). Ko ih ne prosledi, dobija
 *      ponašanje „nema praznika" — v. `adjustForHoliday`.
 *
 * Sve metode primaju `tx` (Prisma transakcioni klijent) da bi se uklopile u
 * transakciju pozivaoca — u sy15 su bile DEFINER funkcije POZVANE IZ iste
 * transakcije, pa atomičnost (npr. „enqueue otkaza pa brisanje") mora ostati.
 */

/** Prisma klijent ILI transakcioni klijent — sve metode rade sa oba. */
export type SastanciTx = Prisma.TransactionClient;

/** Kind-ovi obaveštenja koje domen zna (paritet CASE-a u `sastanci_enqueue_notification`). */
type NotifKind =
  | "akcija_new"
  | "akcija_changed"
  | "meeting_invite"
  | "meeting_locked"
  | "meeting_cancel"
  | "meeting_prep_reminder"
  | "action_reminder"
  | "meeting_reminder";

interface EnqueueArgs {
  kind: NotifKind | string;
  channel?: string | null;
  recipientEmail: string | null | undefined;
  recipientLabel?: string | null;
  subject: string;
  bodyHtml?: string | null;
  bodyText?: string | null;
  relatedSastanakId?: string | null;
  relatedAkcijaId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  createdByEmail?: string | null;
}

/** Modeli koji su u sy15 bili PG enumi ostaju String — ovde samo dozvoljeni skupovi. */
const AI_MODELI = ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"];

@Injectable()
export class SastanciFnService {
  private readonly logger = new Logger(SastanciFnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: SastanciAuthzService,
  ) {}

  // ==========================================================================
  // Pomoćno — datumi i mejlovi
  // ==========================================================================

  /** `lower(coalesce(x,''))` iz PL/pgSQL-a. */
  private norm(email: string | null | undefined): string {
    return (email ?? "").trim().toLowerCase();
  }

  /** @db.Date kolona (UTC ponoć) -> 'YYYY-MM-DD'. */
  private ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** 'YYYY-MM-DD' -> Date za @db.Date kolonu. */
  private dbDate(v: string): Date {
    return new Date(`${v}T00:00:00Z`);
  }

  /** @db.Time -> 'HH:MM' (paritet `left(vreme::text, 5)`). */
  private hhmm(v: Date | null): string | null {
    return v ? v.toISOString().slice(11, 16) : null;
  }

  /** 'YYYY-MM-DD' + n dana (kalendarski). */
  private plusDana(ymd: string, n: number): string {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** ISO dan u nedelji (1=pon … 7=ned) za 'YYYY-MM-DD'. */
  private isoDow(ymd: string): number {
    const d = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    return d === 0 ? 7 : d;
  }

  /** Današnji datum po Europe/Belgrade (sidro svih „danas" grana u sy15 fn-ovima). */
  private danasBeograd(at: Date = new Date()): string {
    const p = belgradeParts(at);
    return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  }

  /** Paritet `sast_next_week_monday(d)` = `d + ((8 - isodow(d)) % 7)`. */
  nextWeekMonday(ymd: string): string {
    return this.plusDana(ymd, (8 - this.isoDow(ymd)) % 7);
  }

  /**
   * Paritet `sast_adjust_for_holiday(m)`: prvi NERADNI-slobodan dan u Pon..Pet
   * iste nedelje; cela nedelja praznik -> vrati ponedeljak.
   *
   * ⚠️ `praznici` je skup 'YYYY-MM-DD' NERADNIH dana (`is_workday = false`).
   * U sy15 ih je fn čitala sama iz `kadr_holidays`; ta tabela je kadrovska i
   * stiže tek u koraku 4, pa ih ovde prosleđuje pozivalac. Prazan skup = isto
   * ponašanje kao baza bez ijednog praznika (vrati ponedeljak) — ne greška.
   */
  adjustForHoliday(monday: string, praznici: ReadonlySet<string>): string {
    let d = monday;
    for (let i = 0; i < 5; i++) {
      if (!praznici.has(d)) return d;
      d = this.plusDana(d, 1);
    }
    return monday;
  }

  // ==========================================================================
  // sastanci_enqueue_notification — JEZGRO mejl kanala
  // ==========================================================================

  /**
   * Prepis `sastanci_enqueue_notification(...)`. Vraća id upisanog reda ili
   * `null` kad primalac nema mejl (paritet: fn tada vraća NULL, bez greške).
   *
   * PARITET KOJI SE MORA ZADRŽATI:
   *  - primalac se upisuje `lower(...)`; prazan mejl -> NULL (nema reda),
   *  - opt-out se čita iz `sastanci_notification_prefs`; NEMA reda = sve TRUE,
   *  - `meeting_locked` IGNORIŠE opt-out (zvanična distribucija zapisnika),
   *  - opt-out ne briše red nego ga upisuje sa `status='skipped'` (revizioni trag),
   *  - `subject` prazan -> pada na `kind` (COALESCE u izvoru),
   *  - `scheduled_at` i `next_attempt_at` = now() (red je odmah spreman).
   */
  async enqueueNotification(
    tx: SastanciTx,
    args: EnqueueArgs,
  ): Promise<string | null> {
    const recipient = this.norm(args.recipientEmail);
    if (recipient === "") return null;

    const prefs = await tx.sastanciNotificationPrefs.findUnique({
      where: { email: recipient },
    });
    const optedIn = ((): boolean => {
      switch (args.kind) {
        case "akcija_new":
          return prefs?.onNewAkcija ?? true;
        case "akcija_changed":
          return prefs?.onChangeAkcija ?? true;
        case "meeting_invite":
          return prefs?.onMeetingInvite ?? true;
        // Namerno NIJE `prefs.onMeetingLocked`: izvor vraća konstantu TRUE.
        case "meeting_locked":
          return true;
        case "action_reminder":
          return prefs?.onActionReminder ?? true;
        case "meeting_reminder":
          return prefs?.onMeetingReminder ?? true;
        default:
          return true;
      }
    })();

    const now = new Date();
    const row = await tx.sastanciNotificationLog.create({
      data: {
        kind: args.kind,
        channel: args.channel ?? "email",
        recipientEmail: recipient,
        recipientLabel: args.recipientLabel ?? null,
        subject: args.subject || args.kind,
        bodyHtml: args.bodyHtml ?? null,
        bodyText: args.bodyText ?? null,
        relatedSastanakId: args.relatedSastanakId ?? null,
        relatedAkcijaId: args.relatedAkcijaId ?? null,
        status: optedIn ? "queued" : "skipped",
        scheduledAt: now,
        nextAttemptAt: now,
        payload: args.payload ?? Prisma.DbNull,
        createdByEmail: args.createdByEmail ?? null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Postoji li već „živ" (queued|sent) red za taj kind/primaoca/vezu? */
  private async vecPoslato(
    tx: SastanciTx,
    kind: string,
    recipient: string,
    veza: { sastanakId?: string | null; akcijaId?: string | null },
    odKada?: Date,
  ): Promise<boolean> {
    const n = await tx.sastanciNotificationLog.count({
      where: {
        kind,
        recipientEmail: recipient,
        ...(veza.sastanakId !== undefined
          ? { relatedSastanakId: veza.sastanakId }
          : {}),
        ...(veza.akcijaId !== undefined ? { relatedAkcijaId: veza.akcijaId } : {}),
        status: { in: ["queued", "sent"] },
        ...(odKada ? { createdAt: { gte: odKada } } : {}),
      },
    });
    return n > 0;
  }

  /** Zajednički payload sastanka (isti ključevi u invite/cancel/reminder). */
  private sastanakPayload(s: {
    id: string;
    naslov: string;
    datum: Date;
    vreme: Date | null;
    mesto: string | null;
    tip: string;
    vodioEmail: string | null;
    createdByEmail: string | null;
  }): Prisma.InputJsonObject {
    return {
      sastanak_id: s.id,
      naslov: s.naslov,
      datum: this.ymd(s.datum),
      vreme: this.hhmm(s.vreme),
      mesto: s.mesto,
      tip: s.tip,
      organizator: s.vodioEmail ?? s.createdByEmail,
    };
  }

  // ==========================================================================
  // Pozivnice / otkazi / podsetnici (ručne radnje iz UI-ja)
  // ==========================================================================

  /**
   * Prepis `sastanci_send_invites(uuid)` — „Pošalji pozivnice".
   * Gejt: `current_user_is_management()` -> 42501. Semantika je DELETE-pa-ENQUEUE
   * (re-send), i to samo za `pozvan = true`.
   */
  async sendInvites(
    tx: SastanciTx,
    email: string,
    sastanakId: string,
  ): Promise<number> {
    if (!(await this.authz.isManagement(email))) {
      throw new ForbiddenException("Nemate pravo da šaljete pozivnice.");
    }
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s) return 0;

    await tx.sastanciNotificationLog.deleteMany({
      where: {
        kind: "meeting_invite",
        relatedSastanakId: sastanakId,
        relatedAkcijaId: null,
      },
    });
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId, pozvan: true },
      select: { email: true, label: true },
    });
    let n = 0;
    for (const u of ucesnici) {
      await this.enqueueNotification(tx, {
        kind: "meeting_invite",
        recipientEmail: u.email,
        recipientLabel: u.label,
        subject: `Pozivnica: ${s.naslov}`,
        relatedSastanakId: sastanakId,
        payload: this.sastanakPayload(s),
      });
      n++;
    }
    return n;
  }

  /**
   * Prepis `sastanci_remind_unprepared(uuid)` — podsetnik SAMO onima koji su
   * `pozvan = true AND pripremljen = false`.
   */
  async remindUnprepared(
    tx: SastanciTx,
    email: string,
    sastanakId: string,
  ): Promise<number> {
    if (!(await this.authz.isManagement(email))) {
      throw new ForbiddenException("Nemate pravo da šaljete podsetnike.");
    }
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s) return 0;

    await tx.sastanciNotificationLog.deleteMany({
      where: {
        kind: "meeting_prep_reminder",
        relatedSastanakId: sastanakId,
        relatedAkcijaId: null,
      },
    });
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId, pozvan: true, pripremljen: false },
      select: { email: true, label: true },
    });
    let n = 0;
    for (const u of ucesnici) {
      await this.enqueueNotification(tx, {
        kind: "meeting_prep_reminder",
        recipientEmail: u.email,
        recipientLabel: u.label,
        subject: `Podsetnik: pripremi se za „${s.naslov}"`,
        relatedSastanakId: sastanakId,
        // Izvor NE šalje `tip` u ovom payload-u — samo mesto/organizator.
        payload: {
          sastanak_id: sastanakId,
          naslov: s.naslov,
          datum: this.ymd(s.datum),
          vreme: this.hhmm(s.vreme),
          mesto: s.mesto,
          organizator: s.vodioEmail ?? s.createdByEmail,
        },
      });
      n++;
    }
    return n;
  }

  /**
   * Prepis `sastanci_resend_meeting_locked(uuid)` — „Pošalji zapisnik ponovo".
   * Radi SAMO na zaključanom sastanku i gađa SVE učesnike (ne samo pozvane).
   */
  async resendMeetingLocked(
    tx: SastanciTx,
    email: string,
    sastanakId: string,
  ): Promise<number> {
    if (!(await this.authz.isManagement(email))) {
      throw new ForbiddenException("Nemate pravo da šaljete zapisnik.");
    }
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s || s.status !== "zakljucan") return 0;
    return this.enqueueMeetingLocked(tx, s);
  }

  /**
   * Prepis `sast_enqueue_cancel(uuid)` — otkazna obaveštenja za `pozvan = true`.
   * NEMA gejta prava (kao ni izvor): pravo presuđuje pozivalac PRE ovog poziva,
   * u istoj transakciji (v. `deleteSastanak` / `cancel` u `SastanciService`).
   */
  async enqueueCancel(tx: SastanciTx, sastanakId: string): Promise<number> {
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s) return 0;
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId, pozvan: true },
      select: { email: true, label: true },
    });
    let n = 0;
    for (const u of ucesnici) {
      await this.enqueueNotification(tx, {
        kind: "meeting_cancel",
        recipientEmail: u.email,
        recipientLabel: u.label,
        subject: `Otkazano: ${s.naslov}`,
        relatedSastanakId: sastanakId,
        // Izvor u cancel payload-u NE šalje `organizator`.
        payload: {
          sastanak_id: sastanakId,
          naslov: s.naslov,
          datum: this.ymd(s.datum),
          vreme: this.hhmm(s.vreme),
          mesto: s.mesto,
          tip: s.tip,
        },
      });
      n++;
    }
    return n;
  }

  // ==========================================================================
  // Trigeri koji su bili LOGIKA (migracija ih namerno ne prenosi)
  // ==========================================================================

  /**
   * Prepis trigera `sast_notif_ucesnik_invite` (AFTER INSERT na
   * `sastanak_ucesnici`): pozivnica se šalje SAMO za `status='planiran'` i samo
   * ako za tog primaoca još nema živog (queued|sent) 'meeting_invite' reda.
   *
   * Zove se IZ servisa posle svakog umetanja učesnika (create/add/bulk/prenos) —
   * isti trenutak kao AFTER INSERT triger, ista transakcija.
   */
  async ucesnikInviteTrigger(
    tx: SastanciTx,
    sastanakId: string,
    ucesnici: { email: string; label?: string | null }[],
  ): Promise<number> {
    if (!ucesnici.length) return 0;
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s || s.status !== "planiran") return 0;

    let n = 0;
    for (const u of ucesnici) {
      const recipient = this.norm(u.email);
      if (recipient === "") continue;
      if (
        await this.vecPoslato(tx, "meeting_invite", recipient, {
          sastanakId,
        })
      ) {
        continue;
      }
      await this.enqueueNotification(tx, {
        kind: "meeting_invite",
        recipientEmail: u.email,
        recipientLabel: u.label ?? null,
        // Izvor trigera ima DRUGI subject od `sastanci_send_invites`: uz naslov
        // nosi i datum. Zadržano doslovno — mejlovi se razlikuju u praksi.
        subject: `Pozivnica: ${s.naslov} - ${this.ddmmyyyy(s.datum)}`,
        relatedSastanakId: sastanakId,
        payload: this.sastanakPayload(s),
      });
      n++;
    }
    return n;
  }

  /**
   * Prepis trigera `sast_notif_ucesnik_invite_cleanup` (AFTER DELETE na
   * `sastanak_ucesnici`): uklonjenom učesniku se briše pozivnica iz reda, da mu
   * ne stigne mejl za sastanak sa kog je skinut.
   */
  async ucesnikInviteCleanup(
    tx: SastanciTx,
    sastanakId: string,
    emails: string[],
  ): Promise<void> {
    const recipients = emails.map((e) => this.norm(e)).filter(Boolean);
    if (!recipients.length) return;
    await tx.sastanciNotificationLog.deleteMany({
      where: {
        kind: "meeting_invite",
        relatedSastanakId: sastanakId,
        recipientEmail: { in: recipients },
      },
    });
  }

  /**
   * Prepis trigera `sast_notif_meeting_locked` (AFTER UPDATE OF status na
   * `sastanci`, samo na prelazu `<> 'zakljucan'` -> `'zakljucan'`).
   *
   * `datum` u payload-u je ONO ŠTO KORISNIK VIDI (`zapisnik_datum` pa `datum`),
   * a `datum_termina` je ZAKAZANI termin — dispečer njime traži prethodni
   * zaključan sastanak za sekciju „Od prošlog sastanka". Ta dva se NE smeju
   * spojiti (komentar u izvoru).
   */
  private async enqueueMeetingLocked(
    tx: SastanciTx,
    s: {
      id: string;
      naslov: string;
      datum: Date;
      vreme: Date | null;
      tip: string;
      zapisnikDatum: Date | null;
      zakljucanAt: Date | null;
      zakljucanByEmail: string | null;
      vodioEmail: string | null;
      createdByEmail: string | null;
    },
  ): Promise<number> {
    await tx.sastanciNotificationLog.deleteMany({
      where: {
        kind: "meeting_locked",
        relatedSastanakId: s.id,
        relatedAkcijaId: null,
      },
    });
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId: s.id },
      select: { email: true, label: true },
    });
    let n = 0;
    for (const u of ucesnici) {
      await this.enqueueNotification(tx, {
        kind: "meeting_locked",
        recipientEmail: u.email,
        recipientLabel: u.label,
        subject: `Zapisnik: ${s.naslov}`,
        relatedSastanakId: s.id,
        payload: {
          sastanak_id: s.id,
          naslov: s.naslov,
          datum: this.ymd(s.zapisnikDatum ?? s.datum),
          datum_termina: this.ymd(s.datum),
          vreme: this.hhmm(s.vreme),
          tip: s.tip,
          zakljucan_at: s.zakljucanAt ? s.zakljucanAt.toISOString() : null,
          zakljucan_by: s.zakljucanByEmail,
          organizator: s.vodioEmail ?? s.createdByEmail,
        },
        createdByEmail: s.zakljucanByEmail,
      });
      n++;
    }
    return n;
  }

  /**
   * Prepis trigera `akcioni_plan_istorija_trg` (AFTER UPDATE na `akcioni_plan`):
   * po jedan red revizionog traga za SVAKO promenjeno polje, od šest praćenih.
   *
   * 🔴 Ovo je tabela sa NAJVIŠE redova u celom domenu (689 naspram 98 akcija) —
   * bez ovog prepisa izmene akcionih tačaka pod `3.0` ne bi ostavljale trag, a
   * to se ne bi ni primetilo dok neko ne otvori istoriju.
   *
   * PARITET: poređenje je `COALESCE(x,'') <> COALESCE(y,'')` (NULL i prazno su
   * ista vrednost); „odgovoran" je IZVEDENO polje `label -> text -> email`;
   * `izmenio_email` je mejl iz sesije (u sy15 iz `request.jwt.claims`).
   */
  async akcijaIstorija(
    tx: SastanciTx,
    stara: {
      status: string | null;
      rok: Date | null;
      rokText: string | null;
      odgovoranLabel: string | null;
      odgovoranText: string | null;
      odgovoranEmail: string | null;
      naslov: string | null;
      projekatId: number | null;
    },
    nova: {
      id: string;
      status: string | null;
      rok: Date | null;
      rokText: string | null;
      odgovoranLabel: string | null;
      odgovoranText: string | null;
      odgovoranEmail: string | null;
      naslov: string | null;
      projekatId: number | null;
    },
    email: string | null | undefined,
  ): Promise<number> {
    const izmenio = this.norm(email) || null;
    const c = (v: unknown): string => (v == null ? "" : String(v));
    const datum = (d: Date | null): string => (d ? this.ymd(d) : "");
    const odg = (r: {
      odgovoranLabel: string | null;
      odgovoranText: string | null;
      odgovoranEmail: string | null;
    }): string => r.odgovoranLabel ?? r.odgovoranText ?? r.odgovoranEmail ?? "";

    const promene: { polje: string; staro: string; novo: string }[] = [];
    const dodaj = (polje: string, staro: string, novo: string) => {
      if (staro !== novo) promene.push({ polje, staro, novo });
    };
    dodaj("status", c(stara.status), c(nova.status));
    dodaj("rok", datum(stara.rok), datum(nova.rok));
    dodaj("rok_text", c(stara.rokText), c(nova.rokText));
    dodaj("odgovoran", odg(stara), odg(nova));
    dodaj("naslov", c(stara.naslov), c(nova.naslov));
    dodaj("projekat", c(stara.projekatId), c(nova.projekatId));
    if (!promene.length) return 0;

    await tx.akcionaTackaIstorija.createMany({
      data: promene.map((p) => ({
        akcijaId: nova.id,
        polje: p.polje,
        // Izvor upisuje NULL kad je stara/nova vrednost NULL (ne prazan string).
        staro: p.staro === "" ? null : p.staro,
        novo: p.novo === "" ? null : p.novo,
        izmenioEmail: izmenio,
      })),
    });
    return promene.length;
  }

  /**
   * Prepis guard-trigera `sast_check_not_locked` (BEFORE INSERT/UPDATE/DELETE na
   * sastanku i SVOJ njegovoj deci): zaključan sastanak menja SAMO rukovodstvo.
   * U sy15 je dizao `23514` koji je `rethrowSy15` mapirao na 422 — zato ovde
   * `UnprocessableEntityException`, da HTTP kod ostane isti.
   */
  async assertNotLocked(
    tx: SastanciTx,
    email: string,
    sastanakId: string | null | undefined,
  ): Promise<void> {
    if (!sastanakId) return;
    const s = await tx.sastanak.findUnique({
      where: { id: sastanakId },
      select: { status: true },
    });
    if (s?.status !== "zakljucan") return;
    if (await this.authz.isManagement(email)) return;
    throw new UnprocessableEntityException(
      `Nije moguće menjati podatke zaključanog sastanka (id: ${sastanakId})`,
    );
  }

  /**
   * Prepis guard-trigera `sast_trg_pm_teme_draft_status_guard`: tema u statusu
   * `draft` sme da pređe ISKLJUČIVO u `usvojeno` ili `odbijeno`.
   */
  assertDraftStatusPrelaz(stari: string, novi: string): void {
    if (stari !== "draft" || novi === stari) return;
    if (novi === "usvojeno" || novi === "odbijeno") return;
    throw new UnprocessableEntityException(
      "Draft tema može biti samo usvojena ili odbijena.",
    );
  }

  /** `to_char(datum, 'DD.MM.YYYY')`. */
  private ddmmyyyy(d: Date): string {
    const s = this.ymd(d);
    return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
  }

  // ==========================================================================
  // Zaključavanje + arhiva (najveća fn domena — 4.316 znaka)
  // ==========================================================================

  /**
   * Prepis `sast_zakljucaj_sastanak(uuid, text, text, date)`.
   *
   * PARITET KOJI SE MORA ZADRŽATI (redosled JE deo ugovora):
   *  1. prazan mejl u sesiji -> 42501 (403);
   *  2. pravo: `mgmt ∨ vodio ∨ zapisnicar ∨ created_by` (mejlovi `lower`-ovani);
   *     nepostojeći sastanak -> P0002 (422 kroz rethrowSy15, ovde 404 ekvivalent);
   *  3. prosleđen `zapisnikDatum` ima PREDNOST; bez njega ostaje zatečeni;
   *  4. snapshot se pravi PRE UPDATE-a, ali mu se RUČNO ušiva razrešeni
   *     `zapisnik_datum` — inače bi štampa iz arhive nosila staru vrednost dok
   *     PDF i mejl nose novu;
   *  5. već zaključan -> MEKI `{ok:false, reason:'already_locked'}` (ne greška),
   *     i to TEK POSLE gradnje snapshota (kao u izvoru);
   *  6. arhiva je UPSERT po `sastanak_id`; `COALESCE` čuva postojeći PDF path
   *     kad novi nije prosleđen;
   *  7. status + `zapisnik_datum` idu u ISTI UPDATE, pa tek onda ide
   *     'meeting_locked' enqueue (u sy15 AFTER UPDATE triger nad NEW.*).
   */
  async zakljucajSastanak(
    tx: SastanciTx,
    email: string,
    sastanakId: string,
    pdfStoragePath: string | null,
    zapisnikDatum: string | null,
  ): Promise<Record<string, unknown>> {
    const v = this.norm(email);
    if (v === "") {
      throw new ForbiddenException("Nemate pravo da zaključite ovaj sastanak.");
    }
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s) throw new NotFoundException("Sastanak nije pronađen.");

    const authorized =
      (await this.authz.isManagement(v)) ||
      this.norm(s.vodioEmail) === v ||
      this.norm(s.zapisnicarEmail) === v ||
      this.norm(s.createdByEmail) === v;
    if (!authorized) {
      throw new ForbiddenException("Nemate pravo da zaključite ovaj sastanak.");
    }

    const now = new Date();
    const pdfPath = pdfStoragePath?.trim() ? pdfStoragePath : null;
    const zapDatum = zapisnikDatum
      ? this.dbDate(zapisnikDatum)
      : (s.zapisnikDatum ?? null);

    // (4) snapshot PRE update-a + ušiven razrešeni datum zapisnika.
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId },
      select: {
        email: true,
        label: true,
        prisutan: true,
        pozvan: true,
        napomena: true,
      },
      orderBy: [{ label: "asc" }, { email: "asc" }],
    });
    const snapshot: Prisma.InputJsonObject = {
      schemaVersion: 2,
      snapshotAt: now.toISOString(),
      sastanak: {
        ...JSON.parse(JSON.stringify(s)),
        zapisnik_datum: zapDatum ? this.ymd(zapDatum) : null,
      },
      ucesnici: ucesnici.map((u) => ({
        email: u.email,
        label: u.label,
        prisutan: u.prisutan,
        pozvan: u.pozvan,
        napomena: u.napomena,
      })),
      // Izvor upisuje PRAZNE nizove — puni ih štampa, ne baza.
      pmTeme: [],
      akcije: [],
      aktivnosti: [],
      slike: [],
    };

    // (5) tek sad — posle snapshota — meki izlaz za već zaključan.
    if (s.status === "zakljucan") {
      return { ok: false, reason: "already_locked", sastanak_id: sastanakId };
    }

    // (6) upsert arhive; COALESCE semantika za PDF path/vreme generisanja.
    const postojeca = await tx.sastanakArhiva.findUnique({
      where: { sastanakId },
      select: { zapisnikStoragePath: true, zapisnikGeneratedAt: true },
    });
    await tx.sastanakArhiva.upsert({
      where: { sastanakId },
      create: {
        sastanakId,
        snapshot,
        zapisnikStoragePath: pdfPath,
        zapisnikGeneratedAt: pdfPath ? now : null,
        arhiviraoEmail: v,
        arhiviraoLabel: v,
        arhiviranoAt: now,
      },
      update: {
        snapshot,
        zapisnikStoragePath: pdfPath ?? postojeca?.zapisnikStoragePath ?? null,
        zapisnikGeneratedAt: pdfPath
          ? now
          : (postojeca?.zapisnikGeneratedAt ?? null),
        arhiviraoEmail: v,
        arhiviraoLabel: v,
        arhiviranoAt: now,
      },
    });

    // (7) status + datum zapisnika u ISTOM upisu, pa enqueue zapisnika.
    const nov = await tx.sastanak.update({
      where: { id: sastanakId },
      data: {
        status: "zakljucan",
        zakljucanAt: now,
        zakljucanByEmail: v,
        zapisnikDatum: zapDatum,
        updatedAt: now,
      },
    });
    await this.enqueueMeetingLocked(tx, nov);

    return {
      ok: true,
      sastanak_id: sastanakId,
      zakljucan_at: now.toISOString(),
      zapisnik_datum: zapDatum ? this.ymd(zapDatum) : null,
    };
  }

  /**
   * Prepis `sast_set_zapisnik_datum(uuid, date)` — ispravka datuma na VEĆ
   * zaključanom sastanku (zahtev 014/26).
   *
   * PARITET: gejt je `current_user_is_management()` (42501 -> 403); sastanak koji
   * NIJE zaključan -> P0001 (422) sa porukom koja nosi zatečeni status; arhiva
   * snapshot mora da prati kolonu (inače štampa ostaje na starom datumu), ali se
   * dira SAMO kad `snapshot.sastanak` postoji i objekat je — `jsonb_set` je
   * STRICT i u izvoru bi NULL obrisao ceo snapshot.
   *
   * Status se NE dira, pa 'meeting_locked' NE okida (ispravka ne šalje mejlove).
   */
  async setZapisnikDatum(
    tx: SastanciTx,
    email: string,
    sastanakId: string,
    zapisnikDatum: string,
  ): Promise<Record<string, unknown>> {
    const v = this.norm(email);
    if (v === "" || !(await this.authz.isManagement(v))) {
      throw new ForbiddenException("Nemate pravo da menjate datum zapisnika.");
    }
    const s = await tx.sastanak.findUnique({
      where: { id: sastanakId },
      select: { status: true },
    });
    if (!s) throw new NotFoundException("Sastanak nije pronađen.");
    if (s.status !== "zakljucan") {
      throw new UnprocessableEntityException(
        `Datum zapisnika se ispravlja samo na zaključanom sastanku (trenutni status: ${s.status}).`,
      );
    }
    await tx.sastanak.update({
      where: { id: sastanakId },
      data: { zapisnikDatum: this.dbDate(zapisnikDatum) },
    });

    const arhiva = await tx.sastanakArhiva.findUnique({
      where: { sastanakId },
      select: { snapshot: true },
    });
    const snap = arhiva?.snapshot as Record<string, unknown> | null | undefined;
    const inner = snap?.["sastanak"];
    if (
      snap &&
      inner != null &&
      typeof inner === "object" &&
      !Array.isArray(inner)
    ) {
      await tx.sastanakArhiva.update({
        where: { sastanakId },
        data: {
          snapshot: {
            ...snap,
            sastanak: {
              ...(inner as Record<string, unknown>),
              zapisnik_datum: zapisnikDatum,
            },
          } as Prisma.InputJsonObject,
        },
      });
    }
    return { ok: true, sastanak_id: sastanakId, zapisnik_datum: zapisnikDatum };
  }

  // ==========================================================================
  // Sedmični kolegijum
  // ==========================================================================

  /**
   * Prepis `sast_target_week_monday()`: ponedeljak SLEDEĆE nedelje; ako je
   * sedmični te nedelje već zaključan/završen, cilj se pomera još nedelju dana
   * (inače bi „sledeći" pokazivao termin koji je već održan).
   */
  async targetWeekMonday(tx: SastanciTx, at: Date = new Date()): Promise<string> {
    const m = this.nextWeekMonday(this.danasBeograd(at));
    const n = await tx.sastanak.count({
      where: {
        tip: "sedmicni",
        datum: { gte: this.dbDate(m), lte: this.dbDate(this.plusDana(m, 6)) },
        status: { in: ["zakljucan", "zavrsen"] },
      },
    });
    return n > 0 ? this.plusDana(m, 7) : m;
  }

  /** Prepis `sast_weekly_status()` — traka „Sledeći sedmični" + `can_move`. */
  async weeklyStatus(
    tx: SastanciTx,
    email: string,
    praznici: ReadonlySet<string>,
  ): Promise<Record<string, unknown>> {
    const monday = await this.targetWeekMonday(tx);
    const target = this.adjustForHoliday(monday, praznici);
    const skip = await tx.sastWeeklySkip.findUnique({
      where: { weekMonday: this.dbDate(monday) },
    });
    const s = await tx.sastanak.findFirst({
      where: {
        tip: "sedmicni",
        datum: {
          gte: this.dbDate(monday),
          lte: this.dbDate(this.plusDana(monday, 6)),
        },
        status: { not: "otkazan" },
      },
      orderBy: [{ datum: "asc" }],
      select: { id: true, datum: true, vreme: true, status: true },
    });
    return {
      week_monday: monday,
      default_date: target,
      skipped: skip !== null,
      skip_reason: skip?.reason ?? null,
      sastanak_id: s?.id ?? null,
      sastanak_datum: s ? this.ymd(s.datum) : null,
      sastanak_vreme: s ? this.hhmm(s.vreme) : null,
      sastanak_status: s?.status ?? null,
      can_move: await this.authz.canMoveWeekly(email),
    };
  }

  /**
   * Prepis `sast_create_weekly_at(date, time)` — kreira sedmični termin i
   * PRENOSI kontekst prethodnog: mesto/vodio, učesnike (pozvan=true,
   * prisutan=false) i OTVORENE/U_TOKU akcije. Izvor je poslednji sedmični
   * STROGO pre ciljanog datuma.
   *
   * Autor je `auto@sistem` (jedna od četiri ne-nalog vrednosti koje seoba
   * prenosi doslovno — §3.2 runbook-a).
   */
  async createWeeklyAt(
    tx: SastanciTx,
    target: string,
    vreme = "09:00",
  ): Promise<string> {
    const src = await tx.sastanak.findFirst({
      where: { tip: "sedmicni", datum: { lt: this.dbDate(target) } },
      orderBy: [{ datum: "desc" }, { createdAt: "desc" }],
      select: { id: true, mesto: true, vodioEmail: true, vodioLabel: true },
    });
    const now = new Date();
    const nov = await tx.sastanak.create({
      data: {
        tip: "sedmicni",
        naslov: `Sedmični sastanak — ${this.ddmmyyyy(this.dbDate(target))}.`,
        datum: this.dbDate(target),
        vreme: new Date(`1970-01-01T${vreme.length === 5 ? `${vreme}:00` : vreme}Z`),
        mesto: src?.mesto ?? "Sala za sastanke",
        status: "planiran",
        vodioEmail: src?.vodioEmail ?? null,
        vodioLabel: src?.vodioLabel ?? null,
        createdByEmail: "auto@sistem",
        // Izvor na kraju stemplje `pozivnice_poslate_at = now()` (UI „pozvano").
        pozivnicePoslateAt: now,
      },
    });

    if (src) {
      const uce = await tx.sastanakUcesnik.findMany({
        where: { sastanakId: src.id },
        select: { email: true, label: true },
      });
      if (uce.length) {
        await tx.sastanakUcesnik.createMany({
          data: uce.map((u) => ({
            sastanakId: nov.id,
            email: u.email,
            label: u.label,
            pozvan: true,
            prisutan: false,
          })),
        });
        // U sy15 je umetanje učesnika okidalo invite triger — ovde eksplicitno.
        await this.ucesnikInviteTrigger(tx, nov.id, uce);
      }
      await tx.akcionaTacka.updateMany({
        where: { sastanakId: src.id, status: { in: ["otvoren", "u_toku"] } },
        data: { sastanakId: nov.id, updatedAt: now },
      });
    }
    return nov.id;
  }

  /**
   * Prepis `sast_auto_create_weekly(boolean)` — petak 08h automatika.
   *
   * ⚠️ VREMENSKI GUARD OSTAJE: izvor odbija da radi van petka/08h LOKALNO
   * (DST-otporno). 3.0 scheduler posao je već zakazan na petak 08:00 lokalno, ali
   * guard se NE briše — `catchUpMinutes: 55` bi inače kreirao sastanak i kad
   * posao stigne sa zakašnjenjem izvan guard-sata, a to je tačno ono što je
   * guard u 1.0 sprečavao.
   */
  async autoCreateWeekly(
    tx: SastanciTx,
    praznici: ReadonlySet<string>,
    force = false,
    at: Date = new Date(),
  ): Promise<string | null> {
    const p = belgradeParts(at);
    if (!force && (p.isoDow !== 5 || p.hour !== 8)) return null;

    const today = this.danasBeograd(at);
    const monday = this.nextWeekMonday(today);

    const odlozena = await tx.sastWeeklySkip.count({
      where: { weekMonday: this.dbDate(monday) },
    });
    if (odlozena > 0) return null;

    const vecPostoji = await tx.sastanak.count({
      where: {
        tip: "sedmicni",
        datum: {
          gte: this.dbDate(monday),
          lte: this.dbDate(this.plusDana(monday, 6)),
        },
        status: { not: "otkazan" },
      },
    });
    if (vecPostoji > 0) return null;

    return this.createWeeklyAt(tx, this.adjustForHoliday(monday, praznici), "09:00");
  }

  /**
   * Prepis `sast_weekly_pomeri(date, time)` — „pomeri sedmični na datum".
   * Gejt je ALLOWLIST (`sast_weekly_movers`), ne rola. Pomeranje PONIŠTAVA
   * odlaganje te nedelje i, kad termin već postoji, šalje NOVE pozivnice.
   */
  async weeklyPomeri(
    tx: SastanciTx,
    email: string,
    datum: string,
    vreme = "09:00",
  ): Promise<string> {
    if (!(await this.authz.canMoveWeekly(email))) {
      throw new ForbiddenException("Nemate pravo da pomerate sedmični sastanak.");
    }
    if (!datum) throw new UnprocessableEntityException("Datum je obavezan.");

    const monday = this.plusDana(datum, -(this.isoDow(datum) - 1));
    await tx.sastWeeklySkip.deleteMany({
      where: { weekMonday: this.dbDate(monday) },
    });

    const postojeci = await tx.sastanak.findFirst({
      where: {
        tip: "sedmicni",
        datum: {
          gte: this.dbDate(monday),
          lte: this.dbDate(this.plusDana(monday, 6)),
        },
        status: { in: ["planiran", "u_toku"] },
      },
      orderBy: [{ datum: "asc" }],
      select: { id: true },
    });
    if (!postojeci) {
      // Još nije kreiran (pre petka) → kreiraj sada za taj datum.
      return this.createWeeklyAt(tx, datum, vreme);
    }
    const now = new Date();
    await tx.sastanak.update({
      where: { id: postojeci.id },
      data: {
        datum: this.dbDate(datum),
        vreme: new Date(`1970-01-01T${vreme.length === 5 ? `${vreme}:00` : vreme}Z`),
        naslov: `Sedmični sastanak — ${this.ddmmyyyy(this.dbDate(datum))}.`,
        pozivnicePoslateAt: now,
        updatedAt: now,
      },
    });
    // Izvor zove `sastanci_send_invites` (mgmt gejt) — ovde direktno enqueue,
    // jer je pravo VEĆ presuđeno allowlistom (`can_move`), a u sy15 je fn bila
    // DEFINER pa je mgmt provera unutra prolazila kroz vlasnika funkcije.
    await this.reissueInvites(tx, postojeci.id);
    return postojeci.id;
  }

  /** Prepis `sast_weekly_odlozi(date, text)` — preskoči nedelju (+ otkaži termin). */
  async weeklyOdlozi(
    tx: SastanciTx,
    email: string,
    weekMonday: string | null,
    reason: string | null,
  ): Promise<Record<string, unknown>> {
    if (!(await this.authz.canMoveWeekly(email))) {
      throw new ForbiddenException("Nemate pravo da odlažete sedmični sastanak.");
    }
    const monday = weekMonday ?? (await this.targetWeekMonday(tx));
    const v = this.norm(email);
    await tx.sastWeeklySkip.upsert({
      where: { weekMonday: this.dbDate(monday) },
      create: {
        weekMonday: this.dbDate(monday),
        reason,
        createdByEmail: v,
      },
      update: { reason, createdByEmail: v },
    });

    const postojeci = await tx.sastanak.findFirst({
      where: {
        tip: "sedmicni",
        datum: {
          gte: this.dbDate(monday),
          lte: this.dbDate(this.plusDana(monday, 6)),
        },
        status: { in: ["planiran", "u_toku"] },
      },
      orderBy: [{ datum: "asc" }],
      select: { id: true },
    });
    let cancelled = false;
    if (postojeci) {
      // Redosled je deo ugovora: PRVO status, PA enqueue — mejl nosi već
      // otkazano stanje (isti redosled prati i ručni „Otkaži i obavesti").
      await tx.sastanak.update({
        where: { id: postojeci.id },
        data: { status: "otkazan", updatedAt: new Date() },
      });
      await this.enqueueCancel(tx, postojeci.id);
      cancelled = true;
    }
    return {
      week_monday: monday,
      cancelled,
      sastanak_id: postojeci?.id ?? null,
    };
  }

  /** Prepis `sast_weekly_vrati(date)` — poništi odlaganje i oživi otkazan termin. */
  async weeklyVrati(
    tx: SastanciTx,
    email: string,
    weekMonday: string | null,
  ): Promise<Record<string, unknown>> {
    if (!(await this.authz.canMoveWeekly(email))) {
      throw new ForbiddenException("Nemate pravo da vraćate sedmični sastanak.");
    }
    const monday = weekMonday ?? (await this.targetWeekMonday(tx));
    await tx.sastWeeklySkip.deleteMany({
      where: { weekMonday: this.dbDate(monday) },
    });

    const otkazan = await tx.sastanak.findFirst({
      where: {
        tip: "sedmicni",
        datum: {
          gte: this.dbDate(monday),
          lte: this.dbDate(this.plusDana(monday, 6)),
        },
        status: "otkazan",
      },
      // Izvor sortira DESC (za razliku od `odlozi`) — poslednji otkazan u nedelji.
      orderBy: [{ datum: "desc" }],
      select: { id: true },
    });
    let reactivated = false;
    if (otkazan) {
      await tx.sastanak.update({
        where: { id: otkazan.id },
        data: { status: "planiran", updatedAt: new Date() },
      });
      await this.reissueInvites(tx, otkazan.id);
      reactivated = true;
    }
    return {
      week_monday: monday,
      reactivated,
      sastanak_id: otkazan?.id ?? null,
    };
  }

  /** `sastanci_send_invites` telo BEZ mgmt gejta — za pozive iz already-authorized toka. */
  private async reissueInvites(
    tx: SastanciTx,
    sastanakId: string,
  ): Promise<number> {
    const s = await tx.sastanak.findUnique({ where: { id: sastanakId } });
    if (!s) return 0;
    await tx.sastanciNotificationLog.deleteMany({
      where: {
        kind: "meeting_invite",
        relatedSastanakId: sastanakId,
        relatedAkcijaId: null,
      },
    });
    const ucesnici = await tx.sastanakUcesnik.findMany({
      where: { sastanakId, pozvan: true },
      select: { email: true, label: true },
    });
    for (const u of ucesnici) {
      await this.enqueueNotification(tx, {
        kind: "meeting_invite",
        recipientEmail: u.email,
        recipientLabel: u.label,
        subject: `Pozivnica: ${s.naslov}`,
        relatedSastanakId: sastanakId,
        payload: this.sastanakPayload(s),
      });
    }
    return ucesnici.length;
  }

  // ==========================================================================
  // Automatika mejlova (scheduler)
  // ==========================================================================

  /**
   * Prepis `sastanci_enqueue_action_reminders()` — dnevno 09h.
   * Prozor roka je `[danas-2, danas+1]`, dedup 20 sati (da dnevni posao koji se
   * ponovi ne pošalje drugi mejl), a naslov zavisi od odnosa roka i danas.
   */
  async enqueueActionReminders(
    tx: SastanciTx,
    at: Date = new Date(),
  ): Promise<number> {
    const today = this.danasBeograd(at);
    const akcije = await tx.akcionaTacka.findMany({
      where: {
        status: { in: ["otvoren", "u_toku", "kasni"] },
        odgovoranEmail: { not: null },
        rok: {
          gte: this.dbDate(this.plusDana(today, -2)),
          lte: this.dbDate(this.plusDana(today, 1)),
        },
      },
      select: {
        id: true,
        naslov: true,
        rok: true,
        rokText: true,
        prioritet: true,
        sastanakId: true,
        odgovoranEmail: true,
        odgovoranLabel: true,
        odgovoranText: true,
      },
    });
    const dedupOd = new Date(at.getTime() - 20 * 3600_000);
    let n = 0;
    for (const a of akcije) {
      const recipient = this.norm(a.odgovoranEmail);
      if (recipient === "" || !a.rok) continue;
      if (
        await this.vecPoslato(tx, "action_reminder", recipient, {
          akcijaId: a.id,
        }, dedupOd)
      ) {
        continue;
      }
      const rok = this.ymd(a.rok);
      const label = a.odgovoranLabel ?? a.odgovoranText ?? a.odgovoranEmail;
      const subject =
        rok < today
          ? `Akcija kasni: ${a.naslov} (rok bio ${this.ddmmyyyy(a.rok)})`
          : rok === today
            ? `Rok danas: ${a.naslov}`
            : `Rok sutra: ${a.naslov}`;
      await this.enqueueNotification(tx, {
        kind: "action_reminder",
        recipientEmail: a.odgovoranEmail,
        recipientLabel: label,
        subject,
        relatedSastanakId: a.sastanakId,
        relatedAkcijaId: a.id,
        payload: {
          akcija_id: a.id,
          naslov: a.naslov,
          rok,
          rok_text: a.rokText,
          prioritet: a.prioritet,
          sastanak_id: a.sastanakId,
          odg_label: label,
          reminder_for: today,
        },
      });
      n++;
    }
    return n;
  }

  /**
   * Prepis `sastanci_enqueue_meeting_reminders()` — svakih 5 min.
   *
   * 🔴 TZ PRAVILO JE BILO PREDMET BUG-A („podsetnici nikad nisu stizali pre
   * sastanka") i zato se prepisuje DOSLOVNO: početak je naivni lokalni
   * `datum + COALESCE(vreme, '09:00')` PROTUMAČEN u Europe/Belgrade
   * (`belgradeTimeToUtc`), NIKAD u UTC-u i nikad u vremenu servera. Prozor je
   * 25–35 minuta unapred i SPREGNUT je sa kadencom posla (5 min): prozor mora
   * biti širi od kadence, inače tik preskoči sastanak.
   *
   * Dedup je 1 sat po (sastanak, primalac).
   */
  async enqueueMeetingReminders(
    tx: SastanciTx,
    at: Date = new Date(),
  ): Promise<number> {
    const sastanci = await tx.sastanak.findMany({
      where: { status: "planiran", vreme: { not: null } },
      select: {
        id: true,
        naslov: true,
        datum: true,
        vreme: true,
        mesto: true,
        tip: true,
        vodioEmail: true,
        createdByEmail: true,
      },
    });
    const od = at.getTime() + 25 * 60_000;
    const doo = at.getTime() + 35 * 60_000;
    const dedupOd = new Date(at.getTime() - 3600_000);
    let n = 0;

    for (const s of sastanci) {
      if (!s.vreme) continue;
      const d = this.ymd(s.datum);
      const t = this.hhmm(s.vreme) ?? "09:00";
      const startsAt = belgradeTimeToUtc(
        Number(d.slice(0, 4)),
        Number(d.slice(5, 7)),
        Number(d.slice(8, 10)),
        Number(t.slice(0, 2)),
        Number(t.slice(3, 5)),
      );
      const ms = startsAt.getTime();
      if (ms < od || ms > doo) continue;

      const ucesnici = await tx.sastanakUcesnik.findMany({
        where: { sastanakId: s.id },
        select: { email: true, label: true },
      });
      for (const u of ucesnici) {
        const recipient = this.norm(u.email);
        if (recipient === "") continue;
        if (
          await this.vecPoslato(
            tx,
            "meeting_reminder",
            recipient,
            { sastanakId: s.id },
            dedupOd,
          )
        ) {
          continue;
        }
        await this.enqueueNotification(tx, {
          kind: "meeting_reminder",
          recipientEmail: u.email,
          recipientLabel: u.label,
          subject: `Podsetnik: ${s.naslov} - ${this.ddmmyyyy(s.datum)} u ${t}`,
          relatedSastanakId: s.id,
          payload: {
            sastanak_id: s.id,
            naslov: s.naslov,
            datum: d,
            vreme: t,
            mesto: s.mesto,
            tip: s.tip,
            organizator: s.vodioEmail ?? s.createdByEmail,
            starts_at: startsAt.toISOString(),
          },
        });
        n++;
      }
    }
    return n;
  }

  // ==========================================================================
  // Dispatch (slanje iz outbox-a)
  // ==========================================================================

  /**
   * Prepis `sastanci_dispatch_dequeue(int, int)` — atomski claim reda.
   *
   * 🔴 `FOR UPDATE SKIP LOCKED` je OBAVEZAN: bez njega bi dva dispečera uzela
   * isti red i poslala duplikat. Izvor takođe NE pomera `next_attempt_at` na
   * claim-u (zabeleženo kao zamka u `.env.example`) — zadržano doslovno da se
   * ponašanje ne promeni usput; preklop mora biti atomski (jedan dispečer).
   */
  async dispatchDequeue(
    tx: SastanciTx,
    batchSize = 25,
    maxAttempts = 5,
  ): Promise<Record<string, unknown>[]> {
    return tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      WITH picked AS (
        SELECT id FROM public.sastanci_notification_log
        WHERE status IN ('queued', 'failed')
          AND next_attempt_at <= now()
          AND attempts < ${maxAttempts}
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.sastanci_notification_log n
         SET attempts = n.attempts + 1, last_attempt_at = now(), status = 'queued'
        FROM picked p
       WHERE n.id = p.id
      RETURNING n.*`);
  }

  /** Prepis `sastanci_dispatch_mark_sent(uuid[])` — vraća broj pogođenih redova. */
  async dispatchMarkSent(tx: SastanciTx, ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const { count } = await tx.sastanciNotificationLog.updateMany({
      where: { id: { in: ids } },
      data: { status: "sent", sentAt: new Date(), error: null },
    });
    return count;
  }

  /** Prepis `sastanci_dispatch_mark_failed(uuid, text, int)` — backoff min 5 s. */
  async dispatchMarkFailed(
    tx: SastanciTx,
    id: string,
    error: string,
    backoffSec = 60,
  ): Promise<void> {
    const sec = Math.max(backoffSec, 5);
    await tx.sastanciNotificationLog.updateMany({
      where: { id },
      data: {
        status: "failed",
        error: (error ?? "").slice(0, 1000),
        nextAttemptAt: new Date(Date.now() + sec * 1000),
      },
    });
  }

  // ==========================================================================
  // Ostalo (dashboard, direktorijum, AI model)
  // ==========================================================================

  /**
   * Prepis `sast_dashboard_stats()` — pet KPI brojki za Pregled.
   * `akcije_*` idu preko view-a `v_akcioni_plan` (zbog `effective_status`, koji
   * „kasni" izvodi iz roka i NE postoji kao kolona).
   */
  async dashboardStats(tx: SastanciTx): Promise<Record<string, number>> {
    const danas = new Date();
    const u14 = new Date(danas.getTime() + 14 * 86_400_000);
    const [upcoming, uToku, akcije, teme] = await Promise.all([
      tx.sastanak.count({
        where: {
          status: "planiran",
          datum: {
            gte: this.dbDate(this.ymd(danas)),
            lte: this.dbDate(this.ymd(u14)),
          },
        },
      }),
      tx.sastanak.count({ where: { status: "u_toku" } }),
      tx.$queryRaw<{ otvoreno: bigint; kasni: bigint }[]>(Prisma.sql`
        SELECT
          count(*) FILTER (WHERE effective_status IN ('otvoren','u_toku','kasni')) AS otvoreno,
          count(*) FILTER (WHERE effective_status = 'kasni') AS kasni
        FROM v_akcioni_plan`),
      tx.pmTema.count({ where: { status: "predlog" } }),
    ]);
    return {
      sastanc_upcoming: upcoming,
      sastanc_u_toku: uToku,
      akcije_otvoreno: Number(akcije[0]?.otvoreno ?? 0),
      akcije_kasni: Number(akcije[0]?.kasni ?? 0),
      pm_teme_na_cekanju: teme,
    };
  }

  /**
   * Prepis `get_sastanci_user_directory()` — autocomplete učesnika.
   * Gejt je `has_edit_role()` -> 42501 (403). Izvor čita sy15 `user_roles`
   * (mejl + full_name + rola, `is_active`); 3.0 parnjak je `users`.
   */
  async userDirectory(
    email: string,
  ): Promise<{ email: string; full_name: string; role: string }[]> {
    if (!(await this.authz.hasEditRole(email))) {
      throw new ForbiddenException("Nemate pravo na direktorijum korisnika.");
    }
    const rows = await this.prisma.user.findMany({
      where: { active: true },
      select: { email: true, fullName: true, role: true },
    });
    return rows
      .map((u) => ({
        email: u.email.toLowerCase(),
        full_name: u.fullName?.trim() || u.email.toLowerCase(),
        role: u.role,
      }))
      .sort((a, b) =>
        a.full_name === b.full_name
          ? a.email.localeCompare(b.email)
          : a.full_name.localeCompare(b.full_name),
      );
  }

  /** Prepis `set_sastanci_ai_model(text)` — admin gejt + zatvoren spisak modela. */
  async setAiModel(
    tx: SastanciTx,
    email: string,
    model: string,
  ): Promise<string> {
    if (!(await this.authz.isAdmin(email))) {
      throw new ForbiddenException("Nemate pravo da menjate AI model.");
    }
    const m = (model ?? "").trim().toLowerCase();
    if (!AI_MODELI.includes(m)) {
      throw new UnprocessableEntityException(`nepoznat model: ${model}`);
    }
    // `auth.uid()` iz izvora → 3.0 `users.id` po mejlu (mapa identiteta, §3.1).
    const u = await this.prisma.user.findFirst({
      where: { email: { equals: this.norm(email), mode: "insensitive" } },
      select: { id: true },
    });
    await tx.sastanciAiSettings.upsert({
      where: { id: 1 },
      create: { id: 1, model: m, updatedByUserId: u?.id ?? null },
      update: { model: m, updatedByUserId: u?.id ?? null, updatedAt: new Date() },
    });
    return m;
  }
}
