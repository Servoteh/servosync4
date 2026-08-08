import { Injectable, Logger } from "@nestjs/common";
import { MailService } from "../../../common/mail/mail.service";
import { Sy15Service } from "../../../common/sy15/sy15.service";
import { Sy15StorageService } from "../../../common/sy15/sy15-storage.service";
import { PbSourceService } from "../../../common/sy15/pb-source.service";
import { OdrzavanjeSourceService } from "../../../common/sy15/odrzavanje-source.service";
import { OdrzavanjeFnService } from "../../odrzavanje/odrzavanje-fn.service";
import type { ScheduledJob } from "../scheduler.types";

/*
 * Talas A-2a — DISPATCH worker u 3.0 za TRI sy15 outbox-a (kadr / maint / pb).
 *
 * Stari dispečer = sy15-scheduler kontejner (dispatch-loop.sh) koji curl-uje edge
 * fn; one zovu sy15 RPC-ove. Ovaj servis radi ISTI POSAO iz NestJS-a: dequeue
 * kroz Sy15Service → slanje (email = MailService/Resend, whatsapp = Meta Graph
 * fetch) → per-row mark_sent/mark_failed ODMAH.
 *
 * ⚠️ AKTIVACIJA JE ATOMSKI PREKLOP, NE PARALELAN RAD. `FOR UPDATE SKIP LOCKED`
 * štiti SAMO claim transakciju — prozor slanja je VAN brave:
 *   • pb JESTE bezbedan: claim postavlja `status='processing'`, a dequeue bira
 *     samo `status='pending'`, pa red ispadne iz izbora dok se šalje.
 *   • kadr/maint NISU: claim radi samo `attempts+1`, `last_attempt_at=now()` i
 *     vraća `status='queued'` — `next_attempt_at` se NE pomera. Čim claim
 *     commit-uje, red ponovo zadovoljava uslov dequeue-a, pa ga drugi dispečer
 *     može pokupiti DOK prvi još šalje → duplirana poruka (sve do `attempts` cap-a).
 * ZATO REDOSLED AKTIVACIJE MORA BITI: (1) skini hr/maint/pb fn-ove iz
 * sy15-scheduler petlje, (2) TEK ONDA `DISPATCH_ENABLED=true`. Nikad oba u pogonu.
 *
 * RETRY ('failed' redovi) — RAZLIKUJE SE PO OUTBOX-u:
 *   • kadr/maint: dequeue bira `status IN ('queued','failed') AND
 *     next_attempt_at <= now() AND attempts < p_max_attempts`, pa je `mark_failed`
 *     + backoff pravi RE-ARM reda.
 *   • pb: dequeue bira SAMO `status='pending'` (važeća verzija fn-a —
 *     add_pb_notif_quiet_hours.sql), dok `mark_failed` upisuje
 *     'failed'/'dead_letter' → takav red je SLEPA ULICA dok ga neko ručno ne
 *     vrati u 'pending'. To je ZATEČENO 1.0 ponašanje (edge radi identično) —
 *     nije regresija ovog talasa, ali se ne sme opisivati kao retry.
 *
 * Sastanci outbox NIJE ovde: prešao je u 3.0 kao ZASEBAN worker
 * (dispatch/sastanci-dispatch.service.ts, Talas A-2b) sa sopstvenim prekidačem
 * `DISPATCH_SASTANCI_ENABLED` — svaki outbox se preklapa sa sy15 nezavisno.
 *
 * KANALI PO OUTBOX-u (usklađeno sa 1.0 edge kodom — vidi u repou
 * servoteh-plan-montaze: supabase/functions/{hr,maint,pb}-notify-dispatch/index.ts):
 *   • KADR:  email    → MailService (recipient je PRAVI mejl; + opcioni prilog iz
 *                       sy15 Storage-a preko payload.attachment_*),
 *            whatsapp → Meta Graph (telefon se NORMALIZUJE na 381…),
 *            ostalo (sms…) → DRY-RUN mark_sent (edge markira sent da ne blokira red).
 *   • MAINT: stub red (recipient='pending' && recipient_user_id IS NULL)
 *                     → fanout RPC (parent SAM postane 'sent' unutar fn),
 *            whatsapp → Meta Graph (recipient se koristi DIREKTNO, BEZ
 *                       normalizacije — tako radi maint edge),
 *            email/telegram/in_app/ostalo → DRY-RUN mark_sent.
 *            ⚠️ maint `email` red NOSI TELEFON kao recipient: `maint_dispatch_fanout`
 *            kopira `parent.channel` a `recipient = maint_user_profiles.phone`
 *            (bazni enum je 'telegram'|'email'|'in_app'). Zato ih edge NAMERNO
 *            DRY-RUN-uje — slanje mejlom bi palo na neispravnu adresu.
 *   • PB:    email    → MailService (telo je čist text → minimalni <pre> html;
 *                       digest grupisanje po pb_notification_config.digest_mode),
 *            ostalo (whatsapp…) → DRY-RUN mark_sent (edge: „PB nema WA").
 *
 * DOKUMENTOVANA ODSTUPANJA OD EDGE-a (svesna, nisu bugovi):
 *   1) maint grana „nepodržan kanal" (edge: `Unsupported channel` → mark_failed)
 *      je NEDOSTIŽNA: kolona je enum `maint_notification_channel`
 *      ('telegram'|'email'|'in_app') proširen sa 'whatsapp', a sve te vrednosti
 *      su gore pokrivene. Zato ovde nema retry-grane — sve što nije 'whatsapp'
 *      ide u DRY-RUN mark_sent (isti ishod, bez mrtvog koda).
 *   2) pb telo edge šalje kao `text:`, mi kao `html:` u <pre> (MailService nosi
 *      samo `html`). Razlika je u MIME delu, sadržaj je isti; HTML-escape je
 *      pokriven testom da telo sa < > & ne razbije mejl.
 *
 * DRY-RUN PARITET (važno): edge tretira „nema konfiguracije" kao USPEH (mark_sent),
 * ne kao grešku. `MailService.send()` vraća `false` I za DRY-RUN (nema
 * RESEND_API_KEY) I za pravu grešku — zato PRE slanja gledamo `mail.configured`:
 * nekonfigurisan mejler → mark_sent (kao edge), konfigurisan + false → mark_failed.
 *
 * Gate: SCHEDULER_ENABLED (pogon uopšte tika) + DISPATCH_ENABLED (poseban
 * prekidač za SLANJE). Bez DISPATCH_ENABLED posao je no-op uz debug log — deploy
 * koda je bezbedan i kad je scheduler već upaljen.
 *
 * ── SEOBA (05.08.2026, razdvojen prekidač 06.08.) ────────────────────────────
 * PB grana (`dispatchPb`) je u domenu prekidača `PB_IZVOR`, ali se PB u
 * ovom koraku NE seli (blokiran kadrovskom: `pb_current_employee_id` visi o
 * `employees`). Zato PB grana NIJE prepisana — samo prolazi kroz branjeni geter
 * `assertPorted`, da pod `3.0` GLASNO padne umesto da tiho nastavi da piše u
 * sy15. Kadrovska (`kadr_*`) NIJE ovaj domen i ostaje netaknuta — ima svoju
 * seobu (korak 4) i svoj prekidač.
 *
 * ── SEOBA ODRŽAVANJA (07.08.2026) ────────────────────────────────────────────
 * Maint grana (`dispatchMaint`) VIŠE NIJE brana nego SKRETNICA pod sopstvenim
 * prekidačem `ODRZAVANJE_IZVOR`: pod `3.0` prazni 3.0 `maint_notification_log`
 * kroz `OdrzavanjeFnService`, pod `sy15` netaknute DEFINER RPC-ove. Petlja je
 * JEDNA za oba izvora (`MaintOutboxPort`), da se edge paritet — stub/fanout,
 * backoff, per-row markiranje — ne održava dvaput.
 *
 * 🔴 Ovaj preklop je SPREGNUT sa poslom `maint-deadlines` (isti prekidač, v.
 * `sy15-cron-jobs.ts`): outbox-a su DVA. Da je prešao samo cron, novi redovi bi
 * nastajali u 3.0 dok radnik prazni sy15 — obaveštenja o kvarovima bi TIHO
 * prestala da stižu, bez ijedne greške u dnevniku. Zato su prešli u istom PR-u.
 *
 * 🔴 `PB_IZVOR` je NEZAVISAN od `SASTANCI_IZVOR` — i to je popravka incidenta
 * 06.08.2026: dok su delili jedan prekidač, preklop SASTANAKA na `3.0` obarao je
 * i ovaj posao (`pb-notify-dispatch` padao na svaka 2 min, ceo PB 503). Pod
 * `SASTANCI_IZVOR=3.0` + `PB_IZVOR=sy15` ova grana MORA da radi normalno.
 */

/** Redovi iz `*_dispatch_dequeue` (RETURNS SETOF <outbox>; čitamo šta koristimo). */
interface KadrRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
  payload: Record<string, unknown> | null;
}
interface MaintRow {
  id: string;
  channel: string;
  recipient: string;
  // 🔴 Unija tipa je posledica seobe: uuid na sy15, Int u 3.0. Radnik ga koristi
  // ISKLJUČIVO kao „ima/nema" (prepoznavanje stub reda), pa vrednost nikad ne
  // izlazi iz ove petlje.
  recipient_user_id: string | number | null;
  subject: string | null;
  body: string;
  attempts: number;
}

/**
 * Outbox održavanja iza jednog šava. Ista petlja `dispatchMaint()` radi nad oba
 * izvora — sy15 kroz DEFINER RPC-ove, 3.0 kroz `OdrzavanjeFnService`. Bez ovog
 * šava bi postojale DVE petlje i edge paritet (stub/fanout/backoff) bi morao da
 * se održava dvaput.
 */
interface MaintOutboxPort {
  dequeue(): Promise<MaintRow[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string, backoffSec: number): Promise<void>;
  /** Vraća broj dece; roditelja zatvara SAM (v. `dispatchMaint`). */
  fanout(id: string): Promise<number>;
  /**
   * 🔴 Da li izvor fanout BEZ IJEDNOG PRIMAOCA tretira kao NEUSPEH.
   *
   * `true` samo za 3.0 (`dispatchFanout` tamo zatvara roditelja kao `failed` sa
   * `FANOUT_NO_RECIPIENTS`). sy15 DEFINER fn i dalje piše `sent` /
   * `FANOUT_DONE: 0 recipients` — to je zatečeni defekt koji se NE dira, jer
   * `sy15` je PODRAZUMEVAN položaj prekidača i njegovo ponašanje (uključujući
   * brojeve u `scheduled_job_runs.summary`) mora ostati identično do gašenja.
   */
  readonly nulaPrimalacaJeNeuspeh: boolean;
}
interface PbRow {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
  attempts: number;
}

type SendResult = { ok: true } | { ok: false; error: string };

export interface DispatchSummary {
  processed: number;
  sent: number;
  failed: number;
  /** maint: broj stub redova raspisanih fanout-om. */
  fanouts?: number;
  /** Redovi tretirani kao DRY-RUN mark_sent (nepodržan/nekonfigurisan kanal). */
  skipped?: number;
  /** pb: da li je digest grupisanje bilo aktivno. */
  digest?: boolean;
}

// Batch/attempts — isti default-i kao 1.0 edge (HR/MAINT 25 i 8, PB 10).
const KADR_BATCH = 25;
const KADR_MAX_ATTEMPTS = 8;
const MAINT_BATCH = 25;
const MAINT_MAX_ATTEMPTS = 8;
const PB_BATCH = 10;

/** Meta Graph timeout (edge ga nema, ali viseći poziv ne sme da zakuca tik). */
const WA_FETCH_TIMEOUT_MS = 8000;

@Injectable()
export class NotifyDispatchService {
  private readonly logger = new Logger(NotifyDispatchService.name);

  constructor(
    private readonly sy15: Sy15Service,
    private readonly mail: MailService,
    private readonly storage: Sy15StorageService,
    private readonly izvor: PbSourceService,
    // Zaseban prekidač održavanja — `maint-notify-dispatch` ne sme da zavisi od
    // preklopa PB-a ni sastanaka (incident 06.08.2026).
    private readonly odrIzvor: OdrzavanjeSourceService,
    // Prepis maint outbox funkcija nad 3.0 bazom (dequeue/mark_sent/mark_failed/
    // fanout). Koristi se ISKLJUČIVO u `dispatchMaint()` pod `3.0`.
    private readonly odrFn: OdrzavanjeFnService,
  ) {}

  /** Poseban prekidač za SLANJE (uz SCHEDULER_ENABLED koji pali sam pogon). */
  get enabled(): boolean {
    return process.env.DISPATCH_ENABLED === "true";
  }

  /** Meta Graph WhatsApp konfiguracija (imena env-a ista kao u 1.0 edge kodu). */
  private waConfig(): {
    token: string;
    phoneId: string;
    template: string;
    lang: string;
  } | null {
    const token = process.env.WA_ACCESS_TOKEN ?? "";
    const phoneId = process.env.WA_PHONE_NUMBER_ID ?? "";
    const template = process.env.WA_TEMPLATE_NAME ?? "";
    if (!token || !phoneId || !template) return null;
    return {
      token,
      phoneId,
      template,
      lang: process.env.WA_TEMPLATE_LANG ?? "sr",
    };
  }

  // ── Poslovi za registraciju u SchedulerService (svaki na 5 min) ────────────
  buildJobs(): ScheduledJob[] {
    const job = (
      key: string,
      description: string,
      run: () => Promise<DispatchSummary>,
    ): ScheduledJob => ({
      key,
      description,
      schedule: { kind: "everyMinutes", minutes: 5 },
      run: async () => {
        if (!this.enabled) {
          this.logger.debug(
            `${key}: DISPATCH_ENABLED != 'true' — no-op (slanje isključeno).`,
          );
          return "dispatch OFF (DISPATCH_ENABLED)";
        }
        return this.fmt(await run());
      },
    });

    return [
      job(
        "kadr-notify-dispatch",
        "Kadrovska outbox → mejl/WhatsApp (kadr_notification_log)",
        () => this.dispatchKadr(),
      ),
      job(
        "maint-notify-dispatch",
        "Održavanje outbox → WhatsApp/fanout (maint_notification_log)",
        () => this.dispatchMaint(),
      ),
      job(
        "pb-notify-dispatch",
        "Projektni biro outbox → mejl (pb_notification_log, digest)",
        () => this.dispatchPb(),
      ),
    ];
  }

  private fmt(r: DispatchSummary): string {
    const extra = [
      r.fanouts != null ? `fanouts=${r.fanouts}` : "",
      r.skipped != null ? `skipped=${r.skipped}` : "",
      r.digest != null ? `digest=${r.digest}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `processed=${r.processed} sent=${r.sent} failed=${r.failed}${extra ? " " + extra : ""}`;
  }

  // ══ KADROVSKA ══════════════════════════════════════════════════════════════
  async dispatchKadr(): Promise<DispatchSummary> {
    const rows = await this.sy15.db.$queryRaw<KadrRow[]>`
      SELECT * FROM public.kadr_dispatch_dequeue(${KADR_BATCH}::int, ${KADR_MAX_ATTEMPTS}::int)`;
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const res = await this.sendKadr(row);
        if (res.ok) {
          // Mark sent ODMAH po slanju (ne batch na kraju): ako proces padne usred
          // batch-a, duplira se najviše 1 poruka umesto celog batch-a.
          await this.markSentKadr(row.id);
          sent++;
          if (row.channel !== "email" && row.channel !== "whatsapp") skipped++;
        } else {
          await this.markFailedKadr(
            row.id,
            res.error,
            this.kadrBackoff(row.attempts + 1),
          );
          failed++;
        }
      } catch (e) {
        await this.markFailedKadr(
          row.id,
          this.errStr(e),
          this.kadrBackoff(row.attempts + 1),
        );
        failed++;
      }
    }
    return { processed: rows.length, sent, failed, skipped };
  }

  private async sendKadr(row: KadrRow): Promise<SendResult> {
    if (row.channel === "whatsapp") return this.sendKadrWhatsApp(row);
    if (row.channel === "email") return this.sendKadrEmail(row);
    // sms i ostali kanali — DRY-RUN (edge markira sent da ne blokira red).
    this.logger.debug(
      `kadr DRY-RUN kanal='${row.channel}' → ${this.mask(row.recipient)}`,
    );
    return { ok: true };
  }

  private async sendKadrEmail(row: KadrRow): Promise<SendResult> {
    if (!this.mail.configured) {
      this.logger.debug(
        `kadr email DRY-RUN (RESEND nekonfigurisan) → ${this.mask(row.recipient)}`,
      );
      return { ok: true };
    }
    const attachments = await this.kadrAttachment(row.payload);
    const ok = await this.mail.send({
      to: row.recipient,
      subject: row.subject ?? "HR obaveštenje",
      html: row.body, // kadr telo je VEĆ gotov html
      ...(attachments ? { attachments } : {}),
    });
    return ok ? { ok: true } : { ok: false, error: "resend send failed" };
  }

  /**
   * Prilog iz sy15 Storage-a (javni gateway + SY15_SERVICE_KEY kroz
   * Sy15StorageService). `payload.attachment_path` je obavezan; bucket default
   * 'employee-docs', filename default 'dokument.pdf' (paritet edge
   * `fetchAttachment`). Greška pri dohvatu → mejl ide BEZ priloga (ne obara
   * slanje), takođe kao edge.
   */
  private async kadrAttachment(
    payload: Record<string, unknown> | null,
  ): Promise<Array<{ filename: string; content: Buffer }> | null> {
    const path =
      payload && typeof payload.attachment_path === "string"
        ? payload.attachment_path
        : "";
    if (!path) return null;
    const bucket =
      (payload &&
        typeof payload.attachment_bucket === "string" &&
        payload.attachment_bucket) ||
      "employee-docs";
    const filename =
      (payload &&
        typeof payload.attachment_filename === "string" &&
        payload.attachment_filename) ||
      "dokument.pdf";
    try {
      const bytes = await this.storage.download(bucket, path);
      return [{ filename, content: Buffer.from(bytes) }];
    } catch (e) {
      this.logger.warn(
        `kadr prilog nije dohvaćen (${bucket}/${path}) — mejl ide bez priloga: ${this.errStr(e)}`,
      );
      return null;
    }
  }

  private async sendKadrWhatsApp(row: KadrRow): Promise<SendResult> {
    const cfg = this.waConfig();
    if (!cfg) {
      this.logger.debug(
        `kadr whatsapp DRY-RUN (WA nekonfigurisan) → ${this.mask(row.recipient)}`,
      );
      return { ok: true };
    }
    const to = this.normalizeWaPhone(row.recipient);
    if (!to) {
      // Neispravan broj — retry nema smisla; red izlazi iz queue-a (edge paritet).
      this.logger.warn(
        `kadr whatsapp preskočen neispravan broj: ${this.mask(row.recipient)}`,
      );
      return { ok: true };
    }
    return this.sendWhatsAppTemplate(cfg, to, row.subject, row.body);
  }

  // ══ ODRŽAVANJE ═════════════════════════════════════════════════════════════
  /**
   * Izvor outbox-a održavanja za tekući položaj prekidača.
   *
   * 🔴 SAMO ova grana ide pod `ODRZAVANJE_IZVOR`. `dispatchKadr()` je kadrovska
   * (korak 4), `dispatchPb()` je pod `PB_IZVOR` — ni jedan ni drugi se ne diraju.
   */
  private maintPort(): MaintOutboxPort {
    if (this.odrIzvor.isThreeZero) {
      return {
        dequeue: () =>
          this.odrFn.dispatchDequeue(
            undefined,
            MAINT_BATCH,
            MAINT_MAX_ATTEMPTS,
          ),
        markSent: async (id) => {
          await this.odrFn.dispatchMarkSent(undefined, [id]);
        },
        markFailed: async (id, error, backoffSec) => {
          await this.odrFn.dispatchMarkFailed(undefined, id, error, backoffSec);
        },
        fanout: (id) => this.odrFn.dispatchFanout(undefined, id),
        nulaPrimalacaJeNeuspeh: true,
      };
    }
    return {
      dequeue: () => this.sy15.db.$queryRaw<MaintRow[]>`
        SELECT * FROM public.maint_dispatch_dequeue(${MAINT_BATCH}::int, ${MAINT_MAX_ATTEMPTS}::int)`,
      markSent: (id) => this.markSentMaint(id),
      markFailed: (id, error, backoffSec) =>
        this.markFailedMaint(id, error, backoffSec),
      fanout: (id) => this.maintFanout(id),
      nulaPrimalacaJeNeuspeh: false,
    };
  }

  async dispatchMaint(): Promise<DispatchSummary> {
    // Korak 2 gašenja sy15 (07.08.2026): outbox održavanja je prenet, pa ova
    // grana više nije brana nego SKRETNICA — pod `3.0` prazni 3.0
    // `maint_notification_log` kroz `OdrzavanjeFnService`, pod `sy15` netaknute
    // DEFINER RPC-ove. Petlja ispod je JEDNA za oba izvora.
    //
    // 🔴 Preklop je SPREGNUT sa poslom `maint-deadlines` (isti prekidač): outbox-a
    // su dva, i ako se preklopi samo jedno, novi redovi idu u 3.0 a radnik prazni
    // sy15 → obaveštenja o kvarovima TIHO prestanu da stižu (nema greške u logu,
    // red samo stoji). Zato su cron i radnik prešli u ISTOM PR-u.
    const port = this.maintPort();
    const rows = await port.dequeue();
    let sent = 0;
    let failed = 0;
    let fanouts = 0;
    let skipped = 0;
    for (const row of rows) {
      const isStub = row.recipient === "pending" && !row.recipient_user_id;
      try {
        if (isStub) {
          // Fanout raspiše na konkretne primaoce i SAM markira parent 'sent' —
          // worker NE sme da zove mark_sent za parent (edge paritet).
          const children = await port.fanout(row.id);
          if (children === 0 && port.nulaPrimalacaJeNeuspeh) {
            // 🔴 GUBITAK SE NE SME UPISATI KAO USPEH. Fanout bez ijednog
            // primaoca znači da obaveštenje o kvaru nije otišlo NIKOME —
            // najčešći uzrok je prazan `maint_user_profiles` (izmereno
            // 08.08.2026: 0 redova, prenos podataka nije pušten). Sam red je
            // brana već zatvorila kao `failed` sa `FANOUT_NO_RECIPIENTS`; ovde
            // se stara da i SUMMARY posla to kaže — inače bi `scheduled_job_runs`
            // pokazivao `failed=0` i ispad bi ostao nevidljiv u dnevniku.
            this.logger.error(
              `🔴 maint fanout ${this.mask(row.id)}: NULA primalaca — obaveštenje ` +
                "NIJE poslato nikome (proveri `maint_user_profiles`: aktivan profil " +
                "sa telefonom i rolom chief/management).",
            );
            failed++;
            continue;
          }
          this.logger.debug(
            `maint fanout ${this.mask(row.id)} → ${children} primalaca`,
          );
          fanouts++;
          continue;
        }
        const res = await this.sendMaint(row);
        if (res.ok) {
          await port.markSent(row.id);
          sent++;
          if (row.channel !== "whatsapp") skipped++;
        } else {
          await port.markFailed(
            row.id,
            res.error,
            this.maintBackoff(row.attempts + 1),
          );
          failed++;
        }
      } catch (e) {
        if (isStub) {
          // Parent nije markiran (fn pao) — dequeue ga vraća po next_attempt_at.
          this.logger.error(
            `maint fanout ${this.mask(row.id)} pao: ${this.errStr(e)}`,
          );
          failed++;
          continue;
        }
        await port.markFailed(
          row.id,
          this.errStr(e),
          this.maintBackoff(row.attempts + 1),
        );
        failed++;
      }
    }
    return { processed: rows.length, sent, failed, fanouts, skipped };
  }

  private async sendMaint(row: MaintRow): Promise<SendResult> {
    if (row.channel === "whatsapp") {
      const cfg = this.waConfig();
      if (!cfg) {
        this.logger.debug(
          `maint whatsapp DRY-RUN (WA nekonfigurisan) → ${this.mask(row.recipient)}`,
        );
        return { ok: true };
      }
      // maint koristi recipient DIREKTNO (već je telefon iz maint_user_profiles).
      return this.sendWhatsAppTemplate(
        cfg,
        row.recipient,
        row.subject,
        row.body,
      );
    }
    // email/telegram/in_app/ostalo → DRY-RUN mark_sent (recipient je telefon,
    // ne mejl — vidi zaglavlje; ovi kanali u maint-u nisu implementirani).
    this.logger.debug(
      `maint DRY-RUN kanal='${row.channel}' → ${this.mask(row.recipient)}`,
    );
    return { ok: true };
  }

  // ══ PROJEKTNI BIRO ═════════════════════════════════════════════════════════
  async dispatchPb(): Promise<DispatchSummary> {
    // PB outbox (`pb_dispatch_dequeue` / `_mark_sent` / `_mark_failed`) NIJE
    // prenet u 3.0 — brana je na ULAZU u granu, pre ijednog upisa, da pod `3.0`
    // dispečer padne sa 503 umesto da tiho piše u sy15 i razilazi dve baze.
    this.izvor.assertPorted("projektni biro: dispatch kroz sy15");

    const cfgRows = await this.sy15.db.$queryRaw<{ digest_mode: boolean }[]>`
      SELECT digest_mode FROM public.pb_notification_config WHERE id = 1`;
    const digest = Boolean(cfgRows[0]?.digest_mode);

    const rows = await this.sy15.db.$queryRaw<PbRow[]>`
      SELECT * FROM public.pb_dispatch_dequeue(${PB_BATCH}::int)`;
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    // Non-email kanali (whatsapp…) → DRY-RUN mark_sent („PB nema WA" — edge paritet).
    const emailRows: PbRow[] = [];
    for (const row of rows) {
      if (row.channel === "email") {
        emailRows.push(row);
        continue;
      }
      try {
        this.logger.debug(
          `pb DRY-RUN kanal='${row.channel}' → ${this.mask(row.recipient)}`,
        );
        await this.markSentPb(row.id);
        skipped++;
      } catch (e) {
        await this.markFailedPb(row.id, this.errStr(e));
        failed++;
      }
    }

    if (digest && emailRows.length > 1) {
      // Grupisanje po primaocu: više poruka istom čoveku → jedan kombinovani mejl.
      const groups = new Map<string, PbRow[]>();
      for (const r of emailRows) {
        const list = groups.get(r.recipient) ?? [];
        list.push(r);
        groups.set(r.recipient, list);
      }
      for (const [recipient, items] of groups) {
        if (items.length === 1) {
          const one = items[0];
          const r = await this.sendPbEmail(recipient, one.subject, one.body);
          if (r.ok) {
            await this.markSentPb(one.id);
            sent++;
          } else {
            await this.markFailedPb(one.id, r.error);
            failed++;
          }
          continue;
        }
        const combined = items
          .map((it) => `• ${it.subject || "(bez naslova)"}\n${it.body}`)
          .join("\n\n———\n\n");
        const r = await this.sendPbEmail(
          recipient,
          `Projektni biro — ${items.length} obaveštenja`,
          combined,
        );
        // Jedan mejl ↔ svi redovi grupe se markiraju pojedinačno (edge paritet).
        for (const it of items) {
          if (r.ok) {
            await this.markSentPb(it.id);
            sent++;
          } else {
            await this.markFailedPb(it.id, r.error);
            failed++;
          }
        }
      }
    } else {
      for (const row of emailRows) {
        try {
          const r = await this.sendPbEmail(
            row.recipient,
            row.subject,
            row.body,
          );
          if (r.ok) {
            await this.markSentPb(row.id);
            sent++;
          } else {
            await this.markFailedPb(row.id, r.error);
            failed++;
          }
        } catch (e) {
          await this.markFailedPb(row.id, this.errStr(e));
          failed++;
        }
      }
    }
    return { processed: rows.length, sent, failed, skipped, digest };
  }

  private async sendPbEmail(
    recipient: string,
    subject: string | null,
    body: string,
  ): Promise<SendResult> {
    if (!this.mail.configured) {
      this.logger.debug(
        `pb email DRY-RUN (RESEND nekonfigurisan) → ${this.mask(recipient)}`,
      );
      return { ok: true };
    }
    const ok = await this.mail.send({
      to: recipient,
      subject: subject ?? "Projektni biro",
      // PB telo je čist text (edge šalje `text:`) — MailService nosi samo `html`,
      // pa ga umotavamo u minimalni <pre> uz očuvan prelom.
      html: this.textToHtml(body),
    });
    return ok ? { ok: true } : { ok: false, error: "resend send failed" };
  }

  // ══ Zajedničko: WhatsApp Meta Graph v20 ════════════════════════════════════
  private async sendWhatsAppTemplate(
    cfg: { token: string; phoneId: string; template: string; lang: string },
    to: string,
    subject: string | null,
    body: string,
  ): Promise<SendResult> {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: cfg.template,
        language: { code: cfg.lang },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: subject ?? "" },
              { type: "text", text: body ?? "" },
            ],
          },
        ],
      },
    };
    try {
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${cfg.phoneId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.token}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(WA_FETCH_TIMEOUT_MS),
        },
      );
      if (res.ok) return { ok: true };
      return {
        ok: false,
        error: `WA ${res.status}: ${(await res.text()).slice(0, 800)}`,
      };
    } catch (e) {
      return { ok: false, error: `WA fetch: ${this.errStr(e)}` };
    }
  }

  /**
   * Telefon → WhatsApp/E.164 bez „+", pretpostavka Srbija. TAČAN port 1.0 edge
   * `normalizeWaPhone`: '0637774847' → '381637774847'; '+381 64 123 4567' →
   * '381641234567'; '00381…' → '381…'. Vraća '' ako nema dovoljno cifara.
   */
  private normalizeWaPhone(raw: string): string {
    let d = String(raw ?? "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("381")) {
      /* već međunarodni */
    } else if (d.startsWith("0")) {
      d = "381" + d.slice(1);
    } else if (d.length >= 8 && d.length <= 9) {
      d = "381" + d; // bez vodeće nule
    }
    return d.length >= 11 ? d : "";
  }

  // ── sy15 RPC omotači ───────────────────────────────────────────────────────
  // ⚠️ Pravilo iz sy15-cron-jobs.ts: `RETURNS VOID` fn se MORA zvati sa `::text`
  // cast-om (Prisma ne deserializuje void kolonu), a skalarne (INT) fn dobijaju
  // alias. Dequeue je `RETURNS SETOF <tabela>` → `SELECT * FROM fn(...)`.

  /** kadr_dispatch_mark_sent(uuid[]) RETURNS INT — batch potpis, zovemo po redu. */
  private async markSentKadr(id: string): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.kadr_dispatch_mark_sent(ARRAY[${id}::uuid]) AS n`;
  }

  /** maint_dispatch_mark_sent(uuid[]) RETURNS INT — isto. */
  private async markSentMaint(id: string): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.maint_dispatch_mark_sent(ARRAY[${id}::uuid]) AS n`;
  }

  /** kadr_dispatch_mark_failed(uuid,text,int) RETURNS VOID → ::text. */
  private async markFailedKadr(
    id: string,
    error: string,
    backoffSec: number,
  ): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.kadr_dispatch_mark_failed(${id}::uuid, ${error}, ${backoffSec}::int)::text AS r`;
  }

  /** maint_dispatch_mark_failed(uuid,text,int) RETURNS VOID → ::text. */
  private async markFailedMaint(
    id: string,
    error: string,
    backoffSec: number,
  ): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.maint_dispatch_mark_failed(${id}::uuid, ${error}, ${backoffSec}::int)::text AS r`;
  }

  /** maint_dispatch_fanout(uuid) RETURNS INT (broj dece; parent sam postaje 'sent'). */
  private async maintFanout(id: string): Promise<number> {
    const rows = await this.sy15.db.$queryRaw<{ children: number }[]>`
      SELECT public.maint_dispatch_fanout(${id}::uuid) AS children`;
    return Number(rows[0]?.children ?? 0);
  }

  /** pb_dispatch_mark_sent(uuid) RETURNS VOID → ::text. */
  private async markSentPb(id: string): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.pb_dispatch_mark_sent(${id}::uuid)::text AS r`;
  }

  /**
   * pb_dispatch_mark_failed(uuid,text) RETURNS VOID → ::text. BEZ backoff
   * parametra — fn interno postavlja next_attempt_at +30min i prelazi u
   * 'dead_letter' na attempts >= 5.
   */
  private async markFailedPb(id: string, error: string): Promise<void> {
    await this.sy15.db
      .$queryRaw`SELECT public.pb_dispatch_mark_failed(${id}::uuid, ${error})::text AS r`;
  }

  // ── Backoff (paritet edge) ─────────────────────────────────────────────────
  /** kadr: 5min, 10min, 20min… cap 6h. */
  private kadrBackoff(attempts: number): number {
    return Math.min(300 * Math.pow(2, Math.max(0, attempts - 1)), 6 * 60 * 60);
  }
  /** maint: 30s, 60s, 2min… cap 60min. */
  private maintBackoff(attempts: number): number {
    return Math.min(30 * Math.pow(2, Math.max(0, attempts - 1)), 60 * 60);
  }

  // ── Pomoćno ────────────────────────────────────────────────────────────────
  /** Čist text → minimalni html (HTML-escape + očuvan prelom) za PB mejlove. */
  private textToHtml(text: string): string {
    const esc = String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${esc}</pre>`;
  }

  /** NIKAD ne loguj pun mejl/telefon — samo skraćeni prefiks. */
  private mask(recipient: string): string {
    const s = String(recipient ?? "");
    return s.length <= 3 ? s : `${s.slice(0, 3)}…`;
  }

  private errStr(e: unknown): string {
    return (e instanceof Error ? e.message : String(e)).slice(0, 900);
  }
}
