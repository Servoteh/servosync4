import { Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../../common/mail/mail.service";
import { Sy15Service } from "../../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../../common/sy15/sy15-storage.service";
import { SastanciSourceService } from "../../../common/sy15/sastanci-source.service";
import { sy15FunctionsBase } from "../../../common/sy15/sy15-functions-base";
import { PrismaService } from "../../../prisma/prisma.service";
import { SastanciFnService } from "../../sastanci/sastanci-fn.service";
import type { ScheduledJob } from "../scheduler.types";
import { buildEmailFor, sastanakLink, str } from "./sastanci-templates";

/*
 * Talas A-2b — DISPATCH worker za sastanci outbox (`sastanci_notification_log`).
 *
 * Stari dispečer = sy15-scheduler kontejner koji na svake 2 min curl-uje edge fn
 * `sastanci-notify-dispatch`. Ovaj servis radi ISTI POSAO iz NestJS-a:
 * dequeue kroz Sy15Service → render šablona (dispatch/sastanci-templates.ts) →
 * MailService/Resend → per-row mark_sent/mark_failed ODMAH. Obrazac je isti kao
 * A-2a (notify-dispatch.service.ts): dequeue omotači, `::text` za VOID fn,
 * mask() u logu, `mail.configured` DRY-RUN gate, try/catch po redu, fail-soft
 * prilozi.
 *
 * ⚠️ AKTIVACIJA JE ATOMSKI PREKLOP, NE PARALELAN RAD. `sastanci_dispatch_dequeue`
 * bira `status IN ('queued','failed') AND next_attempt_at <= now() AND
 * attempts < p_max_attempts`; claim radi samo `attempts+1` i NE pomera
 * `next_attempt_at` niti menja status. Čim claim commit-uje, red je ponovo
 * izborljiv — pa bi drugi dispečer (sy15) poslao duplikat DOK prvi još šalje.
 * REDOSLED: (1) skini `sastanci-notify-dispatch` iz sy15-scheduler petlje,
 * (2) TEK ONDA `DISPATCH_SASTANCI_ENABLED=true`. Gašenje = obrnuto.
 * (Parcijalni UNIQUE indeksi na tabeli štite od duplog ENQUEUE-a, ne od duplog
 * SLANJA — ne oslanjati se na njih ovde.)
 *
 * Prekidač je NAMERNO ODVOJEN od `DISPATCH_ENABLED` (kadr/maint/pb): sastanci se
 * gase na sy15 posebnom izmenom petlje, pa i preklop mora da bude nezavisan.
 *
 * ŽIVI UPITI (edge ih radi PostgREST-om, ovde su $queryRaw na sy15):
 *   • fetchResponsibilities — otvorena zaduženja primaoca iz `v_akcioni_plan`
 *     (meeting_invite + meeting_prep_reminder).
 *   • fetchRsvpToken — `sastanak_ucesnici` (JEDNINA „sastanak"!) za magic-link.
 *   • fetchDiffSummary — „šta se promenilo od prošlog zaključanog sastanka"
 *     (meeting_locked): prethodni zaključan sastanak + ceo v_akcioni_plan, pa
 *     brojanje u JS-u — verno edge-u (server-side agregacija bi bila druga
 *     istina i razišla bi se od 1.0 dok obe verzije rade).
 *   • fetchZapisnikAttachment — `sastanak_arhiva.zapisnik_storage_path` →
 *     Sy15StorageService.download('sastanci-arhiva', path). Edge radi
 *     sign-URL pa GET; rezultat je isti, korak manje.
 *
 * DOKUMENTOVANA ODSTUPANJA OD EDGE-a (svesna):
 *   1) DEEP-LINKOVI U MEJLU SU POPRAVLJENI — edge šalje `${APP_URL}sastanci/<uuid>`
 *      što na današnjem domenu vraća 404 (3.0 statički export nema `[id]` rute),
 *      tj. glavni CTA u svim sastanci mejlovima je MRTAV od domen-flipa
 *      (17.07.2026). Ovde je `${APP_URL}sastanci?open=<id>` (+ footer
 *      `?tab=podesavanja`) — oblik koji frontend zaista čita. Vidi
 *      sastanci-templates.ts zaglavlje.
 *   2) RSVP LINK JE POPRAVLJEN — edge ga gradi iz svog internog `SUPABASE_URL`
 *      (`http://<gateway>/functions/v1/…`), pa su „Dolazim / Ne dolazim" dugmad
 *      u pozivnici bila MRTVA za SVE primaoce. Ovde ide kroz `SY15_FUNCTIONS_URL`
 *      (javni gateway) — vidi `functionsBase()`. Pod `SASTANCI_IZVOR=3.0` link
 *      vodi na 3.0 javnu rutu `…/api/v1/sastanci-rsvp` (`rsvpBase30()`), jer je
 *      tada 3.0 baza vlasnik `sastanak_ucesnici` — vidi `SastanciRsvpController`.
 *   3) 4xx vs 5xx od Resend-a se NE razlikuje. Edge tretira 4xx kao permanent
 *      (backoff 1 godina), 5xx kao transient. `MailService.send()` vraća samo
 *      boolean (ne izlaže status), pa je svaki neuspeh slanja transient uz
 *      normalan backoff. Praktična razlika je mala: `p_max_attempts=5` svakako
 *      zaustavi red posle 5 pokušaja; menjanje MailService potpisa zbog ovoga
 *      diralo bi sve ostale pozivaoce.
 *   4) `meeting_cancel` NEMA .ics CANCEL (METHOD:CANCEL) — otkazani termin
 *      ostaje u kalendaru primaoca dok ga ručno ne obriše. To je ZATEČEN gap 1.0
 *      edge-a (ni on ga nema), zadržan radi pariteta. FOLLOW-UP: kad se sy15
 *      ugasi, dodati CANCEL VEVENT sa istim UID-om.
 *   5) `imaPrethodniZapisnik` je uvek `false`: edge ga računa iz
 *      `fetchPriorZapisnik`, koji je zahtevom 014/26 (24.07.2026) UGAŠEN
 *      (kačio je GLOBALNO poslednji zaključan zapisnik, pa je pozivnica nosila
 *      PDF nepovezanog sastanka). Polje je zadržano jer šablon na njega gleda.
 *
 * DRY-RUN PARITET: edge tretira „nema konfiguracije" kao USPEH (mark_sent), ne
 * kao grešku. `MailService.send()` vraća `false` I za DRY-RUN I za pravu grešku,
 * pa PRE slanja gledamo `mail.configured` (isto kao A-2a).
 *
 * Gate: SCHEDULER_ENABLED (pogon tika) + DISPATCH_SASTANCI_ENABLED (slanje).
 *
 * ── SEOBA (05.08.2026) ──────────────────────────────────────────────────────
 * TRI dodira sa outbox REDOM (`dequeue`, `mark_sent`, `mark_failed`) poštuju
 * `SASTANCI_IZVOR`: pod `sy15` idu na sy15 RPC (netaknuto), pod `3.0` kroz
 * `SastanciFnService` nad 3.0 bazom. Ostatak (gradnja mejla, .ics, RSVP) se NE
 * menja — `enrichPayload` i prilozi i dalje čitaju sy15 (`v_akcioni_plan`,
 * `sastanak_ucesnici`, arhiva), jer ti pogledi nisu preneti; svi su fail-soft,
 * pa pod `3.0` najgori ishod je mejl bez dopune, a ne izgubljen mejl.
 */

/** Bucket sa PDF zapisnicima (edge: `ARHIVA_BUCKET`). */
const ARHIVA_BUCKET = "sastanci-arhiva";

/** Batch/attempts — default-i 1.0 edge-a (SAST_DISPATCH_BATCH 25, MAX_ATTEMPTS 5). */
const SAST_BATCH = 25;
const SAST_MAX_ATTEMPTS = 5;

/** Permanent fail: next_attempt_at ~godinu dana napred (edge `365 * 24 * 3600`). */
const PERMANENT_BACKOFF_SEC = 365 * 24 * 3600;

/** meeting_locked: koliko puta se čeka da se PDF zapisnik generiše (edge: < 3). */
const PDF_DEFER_MAX_ATTEMPTS = 3;
/** Kratak backoff dok se čeka PDF (edge: 60s). */
const PDF_DEFER_BACKOFF_SEC = 60;

/** Koliko redova `v_akcioni_plan` edge učitava za diff (`limit=2000`). */
const DIFF_SCAN_LIMIT = 2000;

/** Redovi iz `sastanci_dispatch_dequeue` (RETURNS SETOF sastanci_notification_log). */
interface SastRow {
  id: string;
  kind: string;
  channel: string;
  recipient_email: string;
  recipient_label: string | null;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  related_sastanak_id: string | null;
  related_akcija_id: string | null;
  attempts: number;
  payload: Record<string, unknown> | null;
}

type Attachment = { filename: string; content: Buffer };

type DispatchResult =
  | { ok: true }
  | { ok: false; error: string; permanent?: boolean; backoffSec?: number };

export interface SastanciDispatchSummary {
  processed: number;
  sent: number;
  failed: number;
  /** Redovi tretirani kao DRY-RUN mark_sent (nepodržan kanal). */
  skipped: number;
  /** WhatsApp redovi oboreni kao permanent (kanal nije implementiran). */
  skippedWa: number;
}

@Injectable()
export class SastanciDispatchService {
  private readonly logger = new Logger(SastanciDispatchService.name);

  constructor(
    private readonly sy15: Sy15Service,
    private readonly mail: MailService,
    private readonly storage: Sy15StorageService,
    private readonly izvor: SastanciSourceService,
    private readonly prisma: PrismaService,
    private readonly sastFn: SastanciFnService,
  ) {}

  /** Poseban prekidač za SLANJE sastanci outbox-a (uz SCHEDULER_ENABLED). */
  get enabled(): boolean {
    return process.env.DISPATCH_SASTANCI_ENABLED === "true";
  }

  /**
   * Baza aplikacije za deep-linkove u mejlu; uvek se završava sa `/`.
   * `PUBLIC_APP_URL` je primarni (kako je i edge imao svoj VITE_PUBLIC_APP_URL),
   * uz nasleđe `SY15_APP_URL` koji prod već nosi za welcome/reset mejlove.
   */
  private appUrl(): string {
    const raw = (
      process.env.PUBLIC_APP_URL ||
      process.env.SY15_APP_URL ||
      "https://servosync.servoteh.com/"
    ).trim();
    return raw.replace(/\/?$/, "/");
  }

  /**
   * Baza sy15 edge funkcija (`…/functions/v1`) za RSVP magic-link pod `sy15`.
   * Lanac i razlozi su u `sy15FunctionsBase()` — izdvojen je jer isti URL gradi i
   * `SastanciRsvpController` kad pod `sy15` preusmeri klik na vlasnika podatka.
   */
  private functionsBase(): string {
    return sy15FunctionsBase();
  }

  /**
   * Puna adresa 3.0 RSVP rute (`…/api/v1/sastanci-rsvp`) — koristi se pod
   * `SASTANCI_IZVOR=3.0`, kad je vlasnik `sastanak_ucesnici` 3.0 baza.
   *
   * ⚠️ ZAŠTO NE `appUrl()` (PUBLIC_APP_URL → SY15_APP_URL → servosync…): ta
   * kaskada daje adresu FRONTA, a front i API su RAZLIČITI hostovi
   * (docs/infra/INFRASTRUKTURA.md §6: front `servosync2.servoteh.com` na
   * Cloudflare Workers, API `api.servosync2.servoteh.com` kroz tunel na
   * `localhost:3000`). Worker (`frontend/worker/index.ts`) NE proksira `/api` —
   * `${appUrl()}api/v1/sastanci-rsvp` bi pao na static export i vratio 404, tj.
   * dugmad bi opet bila mrtva. Zato zaseban env, sa produkcionom vrednošću kao
   * podrazumevanom (ista koju front već nosi u `NEXT_PUBLIC_API_URL`), da
   * preklop prekidača NE traži novo podešavanje na serveru.
   *
   * Vraća bez završne kose crte.
   */
  private rsvpBase30(): string {
    const raw = (
      process.env.PUBLIC_API_URL || "https://api.servosync2.servoteh.com/api"
    ).trim();
    return `${raw.replace(/\/+$/, "")}/v1/sastanci-rsvp`;
  }

  // ── Posao za registraciju u SchedulerService ───────────────────────────────
  buildJobs(): ScheduledJob[] {
    return [
      {
        key: "sastanci-notify-dispatch",
        description:
          "Sastanci outbox → mejl (sastanci_notification_log: pozivnice, zapisnici, podsetnici)",
        // Paritet stare kadence: sy15-scheduler je ovu fn zvao na 2 min.
        schedule: { kind: "everyMinutes", minutes: 2 },
        run: async () => {
          if (!this.enabled) {
            this.logger.debug(
              "sastanci-notify-dispatch: DISPATCH_SASTANCI_ENABLED != 'true' — no-op (slanje isključeno).",
            );
            return "dispatch OFF (DISPATCH_SASTANCI_ENABLED)";
          }
          const r = await this.dispatchSastanci();
          return `processed=${r.processed} sent=${r.sent} failed=${r.failed} skipped=${r.skipped} wa=${r.skippedWa}`;
        },
      },
    ];
  }

  // ══ Batch ══════════════════════════════════════════════════════════════════
  async dispatchSastanci(): Promise<SastanciDispatchSummary> {
    const rows = await this.dequeue();

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let skippedWa = 0;

    for (const row of rows) {
      try {
        const result = await this.dispatchOne(row);

        if (result.ok) {
          /* Mark sent ODMAH po slanju (ne batch na kraju): ako proces padne
             usred batch-a, duplira se najviše 1 mejl umesto celog batch-a. */
          await this.markSent(row.id);
          sent++;
          if (row.channel !== "email") skipped++;
          continue;
        }

        failed++;
        if (result.permanent) {
          if (row.channel === "whatsapp") skippedWa++;
          // Permanent: next_attempt_at daleko u budućnost (dequeue ga više ne bira).
          await this.markFailed(row.id, result.error, PERMANENT_BACKOFF_SEC);
        } else {
          await this.markFailed(
            row.id,
            result.error,
            result.backoffSec ?? this.backoffSec(row.attempts + 1),
          );
        }
      } catch (e) {
        failed++;
        await this.markFailed(
          row.id,
          this.errStr(e),
          this.backoffSec(row.attempts + 1),
        );
      }
    }

    return { processed: rows.length, sent, failed, skipped, skippedWa };
  }

  private async dispatchOne(row: SastRow): Promise<DispatchResult> {
    if (row.channel === "whatsapp") {
      // WhatsApp nije implementiran u sastanci modulu (Faza C) — permanent fail,
      // bez retry-ja. Isti ishod kao edge `dispatchWhatsApp`.
      return {
        ok: false,
        error: "WhatsApp not enabled in this version (Faza C)",
        permanent: true,
      };
    }
    if (row.channel === "email") return this.dispatchEmail(row);

    // Ostali kanali → DRY-RUN mark_sent (edge markira sent da ne blokira red).
    this.logger.debug(
      `sastanci DRY-RUN kanal='${row.channel}' → ${this.mask(row.recipient_email)}`,
    );
    return { ok: true };
  }

  // ══ Email ══════════════════════════════════════════════════════════════════
  private async dispatchEmail(row: SastRow): Promise<DispatchResult> {
    const payloadForTpl = await this.enrichPayload(row);
    const content = buildEmailFor(row.kind, payloadForTpl, this.appUrl());

    const subject = content.subject || row.subject;
    const bodyHtml = content.html || row.body_html || "";
    const bodyText = content.text || row.body_text || "";

    if (!this.mail.configured) {
      this.logger.debug(
        `sastanci email DRY-RUN (RESEND nekonfigurisan) kind='${row.kind}' → ${this.mask(row.recipient_email)}`,
      );
      return { ok: true };
    }

    const attachments: Attachment[] = [];

    // meeting_locked → PDF zapisnik kao prilog. Ako PDF još nije spreman (trka sa
    // generisanjem), odloži par puta pre nego što pošalješ samo-link verziju.
    if (row.kind === "meeting_locked" && row.related_sastanak_id) {
      const datum = str(row.payload?.datum);
      const att = await this.fetchZapisnikAttachment(
        row.related_sastanak_id,
        datum,
      );
      if (att) {
        attachments.push(att);
      } else if ((row.attempts || 0) < PDF_DEFER_MAX_ATTEMPTS) {
        return {
          ok: false,
          error: "PDF zapisnik još nije spreman — ponovni pokušaj",
          backoffSec: PDF_DEFER_BACKOFF_SEC,
        };
      }
      // attempts >= 3 → šalje se BEZ priloga (telo nosi link na aplikaciju).
    }

    // meeting_invite → .ics (kalendar) kao prilog. (Zahtev 014/26: prethodni
    // zapisnik se VIŠE NE kači uz pozivnicu.)
    if (row.kind === "meeting_invite") {
      const ics = this.buildIcs(row.payload, row.recipient_email);
      if (ics) attachments.push(ics);
    }

    const ok = await this.mail.send({
      to: row.recipient_email,
      subject,
      html: bodyHtml,
      text: bodyText,
      ...(content.replyTo ? { replyTo: content.replyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    return ok ? { ok: true } : { ok: false, error: "resend send failed" };
  }

  /**
   * Dopuna payload-a živim podacima pre rendera (edge `dispatchEmail` prvi deo).
   * Greške u dopuni NE obaraju mejl — svaki fetch je fail-soft.
   */
  private async enrichPayload(
    row: SastRow,
  ): Promise<Record<string, unknown> | null> {
    if (row.kind === "meeting_locked" && row.related_sastanak_id) {
      // Sidro rezimea je ZAKAZANI termin (`datum_termina`), NE datum zapisnika:
      // od 014/26 `payload.datum` nosi datum koji korisnik vidi (i koji
      // rukovodstvo sme da ispravi kroz `sastanci.zapisnik_datum`), pa bi njime
      // „prethodni zaključan sastanak" klizao i rezime u zvaničnom mejlu bio
      // pogrešan. `?? datum` je zbog redova ukvačenih pre te izmene.
      // Paritet sa 1.0 edge-om (a52ddd3, 25.07.2026) — payload oba polja nosi iz
      // `sast_zakljucaj_sastanak`. Naziv priloga i telo mejla i dalje idu na
      // `payload.datum`, to je i cilj.
      const sidroDatum = str(row.payload?.datum_termina ?? row.payload?.datum);
      const diff = await this.fetchDiffSummary(
        row.related_sastanak_id,
        sidroDatum,
      );
      return diff ? { ...(row.payload || {}), diff } : row.payload;
    }

    if (row.kind === "meeting_invite" || row.kind === "meeting_prep_reminder") {
      const zaduzenja = await this.fetchResponsibilities(row.recipient_email);
      const extra: Record<string, unknown> = {};
      if (row.kind === "meeting_invite" && row.related_sastanak_id) {
        const token = await this.fetchRsvpToken(
          row.related_sastanak_id,
          row.recipient_email,
        );
        if (token) {
          const t = encodeURIComponent(token);
          // Link mora da vodi u bazu koja je VLASNIK `sastanak_ucesnici`, jer
          // klik piše `rsvp_status`/`rsvp_at`. Pod `3.0` to je javna 3.0 ruta
          // (SastanciRsvpController), pod `sy15` i dalje edge fn `sastanci-rsvp`.
          // Tokeni su preneti DOSLOVNO, pa isti `t` radi u obe baze — ali upis
          // sme da ide samo u onu koja je izvor istine.
          const base = this.izvor.isThreeZero
            ? this.rsvpBase30()
            : `${this.functionsBase()}/sastanci-rsvp`;
          extra.rsvp_yes_url = `${base}?t=${t}&r=dolazim`;
          extra.rsvp_no_url = `${base}?t=${t}&r=ne_dolazim`;
        }
      }
      return {
        ...(row.payload || {}),
        zaduzenja,
        // Vidi odstupanje #4 u zaglavlju — prethodni zapisnik se ne kači.
        imaPrethodniZapisnik: false,
        ...extra,
      };
    }

    return row.payload;
  }

  // ══ Živi upiti (sy15) ══════════════════════════════════════════════════════

  /**
   * PDF zapisnik iz sy15 Storage-a. Vraća null ako PDF još nije generisan
   * (tada meeting_locked ili čeka, ili šalje samo-link verziju) ili ako dohvat
   * padne — mejl u tom slučaju ide bez priloga (fail-soft, kao edge).
   */
  private async fetchZapisnikAttachment(
    sastanakId: string,
    datum: string,
  ): Promise<Attachment | null> {
    try {
      const rows = await this.sy15.db.$queryRaw<
        { zapisnik_storage_path: string | null }[]
      >`
        SELECT zapisnik_storage_path
          FROM public.sastanak_arhiva
         WHERE sastanak_id = ${sastanakId}::uuid
         LIMIT 1`;
      const path = rows[0]?.zapisnik_storage_path;
      if (!path) return null;

      const bytes = await this.storage.download(ARHIVA_BUCKET, path);
      if (!bytes.length) return null;

      // '2026-07-24' → 'Zapisnik-24-07-2026.pdf' (paritet edge-a).
      const datumFmt = datum
        ? datum.split("-").reverse().join("-")
        : "zapisnik";
      return {
        filename: `Zapisnik-${datumFmt}.pdf`,
        content: Buffer.from(bytes),
      };
    } catch (e) {
      this.logger.warn(
        `sastanci zapisnik nije dohvaćen (${this.mask(sastanakId)}): ${this.errStr(e)}`,
      );
      return null;
    }
  }

  /**
   * Rezime „šta se promenilo" od prethodnog zaključanog sastanka (meeting_locked):
   * novo / završeno / kasni / aktivnih. null ako se ne može izračunati.
   * Brojanje je u JS-u nad celim `v_akcioni_plan` — verno edge-u.
   *
   * ⚠️ `datum` OVDE MORA BITI ZAKAZANI TERMIN (`sastanci.datum` = payload
   * `datum_termina`), jer se njime traži prethodni zaključan sastanak
   * (`datum < <datum>`). NE prosleđivati datum zapisnika (`payload.datum`) — on je
   * od 014/26 promenljiv, pa bi sidro klizalo i rezime bio pogrešan.
   */
  private async fetchDiffSummary(
    sastanakId: string,
    datum: string,
  ): Promise<{
    novo: number;
    zavrseno: number;
    kasni: number;
    aktivnih: number;
  } | null> {
    try {
      let sinceMs = NaN;
      if (datum) {
        const prev = await this.sy15.db.$queryRaw<{ zakljucan_at: unknown }[]>`
          SELECT zakljucan_at
            FROM public.sastanci
           WHERE status = 'zakljucan'
             AND datum < ${datum}::date
             AND id <> ${sastanakId}::uuid
           ORDER BY datum DESC
           LIMIT 1`;
        if (prev.length) sinceMs = this.toMs(prev[0].zakljucan_at);
      }

      const data = await this.sy15.db.$queryRaw<
        {
          status: string | null;
          effective_status: string | null;
          created_at: unknown;
          zatvoren_at: unknown;
        }[]
      >`
        SELECT status, effective_status, created_at, zatvoren_at
          FROM public.v_akcioni_plan
         LIMIT ${DIFF_SCAN_LIMIT}`;

      const hasSince = !Number.isNaN(sinceMs);
      const s = { novo: 0, zavrseno: 0, kasni: 0, aktivnih: 0 };
      for (const r of data) {
        const eff = r.effective_status || r.status;
        if (eff === "otvoren" || eff === "u_toku" || eff === "kasni")
          s.aktivnih++;
        if (eff === "kasni") s.kasni++;
        if (hasSince && r.created_at && this.toMs(r.created_at) > sinceMs)
          s.novo++;
        if (
          hasSince &&
          r.status === "zavrsen" &&
          r.zatvoren_at &&
          this.toMs(r.zatvoren_at) > sinceMs
        )
          s.zavrseno++;
      }
      return s;
    } catch (e) {
      this.logger.warn(`sastanci diff nije izračunat: ${this.errStr(e)}`);
      return null;
    }
  }

  /** Otvorena zaduženja primaoca (pozivnica / prep podsetnik): naslov + rok + status. */
  private async fetchResponsibilities(
    email: string,
  ): Promise<Array<{ naslov: string; rok: string; status: string }>> {
    try {
      const rows = await this.sy15.db.$queryRaw<
        {
          naslov: string | null;
          rok: string | null;
          rok_text: string | null;
          effective_status: string | null;
        }[]
      >`
        SELECT naslov, rok::text AS rok, rok_text, effective_status
          FROM public.v_akcioni_plan
         WHERE odgovoran_email = ${email.toLowerCase()}
           AND effective_status IN ('otvoren', 'u_toku', 'kasni')
         ORDER BY v_akcioni_plan.rok ASC NULLS LAST
         LIMIT 30`;
      return rows.map((x) => ({
        naslov: x.naslov || "",
        // `rok::text` daje 'YYYY-MM-DD' (PostgREST je vraćao isto) → 'DD.MM.YYYY'.
        rok:
          x.rok_text ||
          (x.rok ? String(x.rok).split("-").reverse().join(".") : ""),
        status: x.effective_status || "",
      }));
    } catch (e) {
      this.logger.warn(`sastanci zaduženja nisu dohvaćena: ${this.errStr(e)}`);
      return [];
    }
  }

  /**
   * RSVP token učesnika (magic-link „Dolazim / Ne dolazim").
   * ⚠️ Tabela je `sastanak_ucesnici` — JEDNINA, za razliku od `sastanci_*`.
   * Poređenje mejla je nad LOWERCASE ulazom, tačno kao edge (`email=eq.<lower>`);
   * ako je adresa u bazi upisana velikim slovima, token se ne nađe i pozivnica
   * ide bez RSVP dugmadi (zatečeno 1.0 ponašanje, ne regresija).
   *
   * ⚠️ Token se čita IZ ISTE baze u koju RSVP klik piše (`rsvpBase30()` /
   * `functionsBase()`). Postojeći tokeni su preneti DOSLOVNO, pa bi čitanje iz
   * sy15 i pod `3.0` „radilo" za zatečene učesnike — ali NE za onog ko je dodat
   * posle preklopa (njega u sy15 nema), pa bi mu pozivnica tiho stigla BEZ
   * dugmadi. Zato grana ide po prekidaču, ne po zatečenim podacima.
   */
  private async fetchRsvpToken(
    sastanakId: string,
    email: string,
  ): Promise<string | null> {
    try {
      if (!sastanakId || !email) return null;
      if (this.izvor.isThreeZero) {
        const row = await this.prisma.sastanakUcesnik.findFirst({
          where: { sastanakId, email: email.toLowerCase() },
          select: { rsvpToken: true },
        });
        return row?.rsvpToken || null;
      }
      const rows = await this.sy15.db.$queryRaw<
        { rsvp_token: string | null }[]
      >`
        SELECT rsvp_token
          FROM public.sastanak_ucesnici
         WHERE sastanak_id = ${sastanakId}::uuid
           AND email = ${email.toLowerCase()}
         LIMIT 1`;
      return rows[0]?.rsvp_token || null;
    } catch (e) {
      this.logger.warn(`sastanci rsvp token nije dohvaćen: ${this.errStr(e)}`);
      return null;
    }
  }

  // ══ .ics (kalendar) ════════════════════════════════════════════════════════

  private icsEscape(s: unknown): string {
    return str(s)
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n");
  }

  /**
   * .ics (VEVENT) prilog za pozivnicu — pada u Outlook/Google kalendar.
   * Trajanje 1h, TZID Europe/Belgrade (paritet edge `buildIcs`).
   * ⚠️ FOLLOW-UP: nema pandana za `meeting_cancel` (METHOD:CANCEL sa istim UID-om) —
   * otkazan sastanak ostaje u kalendaru. Zatečen gap 1.0 edge-a, zadržan namerno.
   */
  private buildIcs(
    p: Record<string, unknown> | null,
    recipient: string,
  ): Attachment | null {
    try {
      const datum = str(p?.datum);
      if (!/^\d{4}-\d{2}-\d{2}/.test(datum)) return null;
      const [Y, M, D] = datum.slice(0, 10).split("-");
      const vreme = str(p?.vreme ?? "09:00");
      const h = (vreme.split(":")[0] || "09").padStart(2, "0");
      const mi = (vreme.split(":")[1] || "00").padStart(2, "0");
      const start = `${Y}${M}${D}T${h}${mi}00`;
      const end = `${Y}${M}${D}T${String((Number(h) + 1) % 24).padStart(2, "0")}${mi}00`;
      const dtstamp =
        new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      const uid = `${str(p?.sastanak_id) || "sast"}@servosync.servoteh.com`;
      const org = str(p?.organizator || "");
      const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Servoteh//Sastanci//SR",
        "CALSCALE:GREGORIAN",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=Europe/Belgrade:${start}`,
        `DTEND;TZID=Europe/Belgrade:${end}`,
        `SUMMARY:${this.icsEscape(p?.naslov)}`,
        p?.mesto ? `LOCATION:${this.icsEscape(p.mesto)}` : "",
        // Link je 3.0 `?open=` oblik (edge je ovde imao istu mrtvu `sastanci/<id>` putanju).
        `DESCRIPTION:${this.icsEscape(
          "Sastanak — Servoteh. Otvori: " +
            sastanakLink(this.appUrl(), str(p?.sastanak_id)),
        )}`,
        org ? `ORGANIZER:mailto:${org}` : "",
        recipient
          ? `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${recipient}`
          : "",
        "STATUS:CONFIRMED",
        "END:VEVENT",
        "END:VCALENDAR",
      ].filter(Boolean);
      return {
        filename: "sastanak.ics",
        content: Buffer.from(lines.join("\r\n"), "utf8"),
      };
    } catch (e) {
      this.logger.warn(`sastanci .ics nije napravljen: ${this.errStr(e)}`);
      return null;
    }
  }

  // ── Dodiri sa outbox REDOM (jedine tri tačke koje biraju izvor) ────────────
  // ⚠️ Pravilo iz sy15-cron-jobs.ts (važi za `sy15` granu): `RETURNS VOID` fn se
  // MORA zvati sa `::text` cast-om (Prisma ne deserializuje void kolonu),
  // skalarne (INT) dobijaju alias, a dequeue je `RETURNS SETOF <tabela>` →
  // `SELECT * FROM fn(...)`. Pod `3.0` isti posao radi `SastanciFnService`
  // (prepis istih funkcija, uklj. `FOR UPDATE SKIP LOCKED` u dequeue-u).

  /** Atomski claim batch-a: sy15 `sastanci_dispatch_dequeue` ili 3.0 prepis. */
  private async dequeue(): Promise<SastRow[]> {
    if (this.izvor.isThreeZero) {
      const rows = await this.prisma.$transaction((tx) =>
        this.sastFn.dispatchDequeue(tx, SAST_BATCH, SAST_MAX_ATTEMPTS),
      );
      // Prepis vraća `RETURNING n.*` — iste snake_case kolone kao sy15 fn.
      return rows as unknown as SastRow[];
    }
    return this.sy15.db.$queryRaw<SastRow[]>`
      SELECT * FROM public.sastanci_dispatch_dequeue(${SAST_BATCH}::int, ${SAST_MAX_ATTEMPTS}::int)`;
  }

  /** sastanci_dispatch_mark_sent(uuid[]) RETURNS INT — batch potpis, zovemo po redu. */
  private async markSent(id: string): Promise<void> {
    if (this.izvor.isThreeZero) {
      await this.prisma.$transaction((tx) =>
        this.sastFn.dispatchMarkSent(tx, [id]),
      );
      return;
    }
    await this.sy15.db
      .$queryRaw`SELECT public.sastanci_dispatch_mark_sent(ARRAY[${id}::uuid]) AS n`;
  }

  /** sastanci_dispatch_mark_failed(uuid,text,int) RETURNS VOID → ::text. */
  private async markFailed(
    id: string,
    error: string,
    backoffSec: number,
  ): Promise<void> {
    if (this.izvor.isThreeZero) {
      await this.prisma.$transaction((tx) =>
        this.sastFn.dispatchMarkFailed(tx, id, error, backoffSec),
      );
      return;
    }
    await this.sy15.db
      .$queryRaw`SELECT public.sastanci_dispatch_mark_failed(${id}::uuid, ${error}, ${backoffSec}::int)::text AS r`;
  }

  // ── Pomoćno ────────────────────────────────────────────────────────────────
  /** Backoff (paritet edge): 5min → 10 → 20 → 40 → 80, cap 6h. */
  private backoffSec(attempts: number): number {
    return Math.min(300 * Math.pow(2, Math.max(0, attempts - 1)), 6 * 60 * 60);
  }

  /**
   * Vreme iz sy15 → ms. Prisma raw vraća `timestamptz` kao `Date` (PostgREST je
   * vraćao ISO string) — podržavamo oba da poređenje „posle prošlog sastanka"
   * radi isto.
   */
  private toMs(v: unknown): number {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string") return Date.parse(v);
    return NaN;
  }

  /** NIKAD ne loguj pun mejl/id — samo skraćeni prefiks. */
  private mask(recipient: string): string {
    const s = String(recipient ?? "");
    return s.length <= 3 ? s : `${s.slice(0, 3)}…`;
  }

  private errStr(e: unknown): string {
    return (e instanceof Error ? e.message : String(e)).slice(0, 900);
  }
}
