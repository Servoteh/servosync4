import { Injectable, Logger } from "@nestjs/common";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { SastanciPbSourceService } from "../../common/sy15/sastanci-pb-source.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  SastanciFnService,
  type SastanciTx,
} from "../sastanci/sastanci-fn.service";
import type { ScheduledJob } from "./scheduler.types";

/*
 * Talas A / A2 — poslovi: TANKI pozivi POSTOJEĆIH sy15 SECURITY DEFINER
 * funkcija (bitke-testiran 1.0 SQL ostaje jedina istina; 3.0 daje samo POGON).
 *
 * ⚠️ ŽIVA provera 24.07 (sy15-db cron.job + job_run_details): sve enqueue
 * automatike RADE na sy15 pg_cron-u — ovi poslovi su SEOBA POGONA u 3.0 radi
 * gašenja sy15 (F5), ne oživljavanje. Dupli rad u prelazu je BEZOPASAN: svaka
 * funkcija ima dedup guard (NOT EXISTS po danu/terminu, escalated_at flagovi,
 * anti-duplikat sedmičnog) — drugi pozivalac istog dana upiše 0 redova.
 * CUTOVER: uključi SCHEDULER_ENABLED → uporedi dan-dva → ugasi sy15 cron
 * poslove (`SELECT cron.unschedule(jobid)` — reverzibilno).
 *
 * Rasporedi su LOKALNI (Europe/Belgrade) — namera 1.0 UTC cron-ova prevedena:
 * 07:00 UTC letnje = 09:00 lokalno (radno jutro). Funkcije sa unutrašnjim
 * lokalnim guardovima (attendance 06h; digest pon 06h; sedmični pet 08h)
 * zakazane su TAČNO u guard-sat, pa dupli UTC slotovi iz 1.0 nisu potrebni.
 *
 * Dispatch (slanje mejlova iz outbox-a) je od Talasa A-2a/A-2b TAKOĐE u 3.0
 * (dispatch/notify-dispatch.service.ts za kadr/maint/pb, dispatch/
 * sastanci-dispatch.service.ts za sastanke), ali iza svojih prekidača
 * (`DISPATCH_ENABLED` / `DISPATCH_SASTANCI_ENABLED`). Dok su isključeni, šalje
 * i dalje sy15 (VM cron dispatch-loop.sh + edge fn) — vidi ODLUKE #39 / Talas F.
 *
 * ── SEOBA SASTANAKA (05.08.2026, docs/SEOBA_SASTANCI_PB_2026-08-05.md) ────────
 * TRI posla iz ovog registra diraju domen sastanaka (`sast-action-reminders`,
 * `sast-meeting-reminders`, `sast-weekly-auto`) i od sada POŠTUJU prekidač
 * `SASTANCI_PB_IZVOR`:
 *   • `sy15` (podrazumevano) — ponašanje NETAKNUTO: isti `SELECT public.<fn>()`.
 *   • `3.0`                  — isti posao kroz `SastanciFnService` nad 3.0 bazom.
 * Summary string je NAMERNO istog oblika u oba slučaja (`<ime_fn>=<vrednost>`),
 * da dnevnik (`scheduled_job_runs.summary`) ostane uporediv pre i posle preklopa.
 *
 * ⚠️ Ostali poslovi (kadrovska, održavanje, BigTehn kartice) NISU ovaj domen i
 * ostaju na sy15 putu bez prekidača. `pb-enqueue` JESTE domen prekidača, ali PB
 * se ne seli u ovom koraku (blokiran kadrovskom) — zato ide kroz branjeni geter
 * `assertPorted`, da pod `3.0` GLASNO padne umesto da tiho piše u sy15.
 */

interface RawRow {
  [k: string]: unknown;
}

/** Viseći sy15 poziv (mrtva veza / lock na sy15) ne sme da zakuca ceo tik. */
const SY15_CALL_TIMEOUT_MS = 120_000;

/** Koliko dana unapred se čitaju praznici za pomeranje sedmičnog termina. */
const PRAZNICI_PROZOR_DANA = 90;

@Injectable()
export class Sy15CronJobs {
  private readonly logger = new Logger(Sy15CronJobs.name);

  constructor(
    private readonly sy15: Sy15Service,
    private readonly izvor: SastanciPbSourceService,
    private readonly prisma: PrismaService,
    private readonly sastFn: SastanciFnService,
  ) {}

  /**
   * SELECT fn() na sy15 i sažmi rezultat u summary string.
   * ⚠️ Povratni tipovi (provereno na sy15-db 24.07): `void` fn se MORA zvati
   * sa `::text` cast-om (Prisma ne ume da deserializuje void kolonu — pao bi
   * SVAKI run), a TABLE fn kroz `SELECT * FROM` (record kolona isto puca).
   */
  private async call(fnSql: string): Promise<string> {
    // `this.sy15.db` baca ako SY15_DATABASE_URL nije podešen → run FAILED sa
    // jasnom porukom u dnevniku (namerno: ovi poslovi bez sy15 nemaju smisla).
    // Timeout: Promise.race prekida ČEKANJE (run → FAILED + retry); sama konekcija
    // može ostati zauzeta do TCP keepalive-a — za tvrdi prekid na serveru dodati
    // `options=-c statement_timeout=120000` u SY15_DATABASE_URL (vidi .env.example).
    const query = this.sy15.db.$queryRawUnsafe(fnSql) as Promise<RawRow[]>;
    const rows = await Promise.race([
      query,
      new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`sy15 poziv nije odgovorio za ${SY15_CALL_TIMEOUT_MS / 1000}s`)),
          SY15_CALL_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
    if (!rows?.length) return "ok (bez rezultata)";
    const fmt = (v: unknown): string =>
      v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    return rows
      .map((r) =>
        Object.entries(r)
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(" "),
      )
      .join("; ")
      .slice(0, 500);
  }

  /**
   * Posao domena SASTANAKA — jedina tačka na kojoj se bira izvor.
   *
   * Pod `sy15` prosleđuje netaknut `fnSql` u `call()` (isti SQL, isti summary).
   * Pod `3.0` izvršava `run` u JEDNOJ 3.0 transakciji (kao što je sy15 DEFINER fn
   * bila jedna transakcija) i sam sklapa summary u ISTOM obliku koji bi `call()`
   * dao za tu funkciju: `<ime_fn>=<vrednost>`. Bez toga bi dnevnik posle preklopa
   * promenio format i poređenje „pre/posle" ne bi radilo.
   */
  private async callSastanci(
    fnSql: string,
    fnName: string,
    // Prepisane fn vraćaju broj upisanih redova ili id/NULL — isti skup tipova
    // koji bi stigao i kao kolona sa sy15.
    run: (tx: SastanciTx) => Promise<number | string | null>,
  ): Promise<string> {
    if (!this.izvor.isThreeZero) return this.call(fnSql);
    const value = await this.prisma.$transaction((tx) => run(tx));
    // `??` (ne `||`): 0 upisanih redova je VALIDAN rezultat, ne „nema vrednosti".
    // NULL daje "null" — isto što `call()` upiše za NULL kolonu.
    return `${fnName}=${value ?? "null"}`;
  }

  /**
   * Neradni praznici (`is_workday = false`) u prozoru od danas + 90 dana, kao
   * skup 'YYYY-MM-DD'. Njima `sast_auto_create_weekly` pomera sedmični termin sa
   * praznika na prvi slobodan dan Pon..Pet.
   *
   * 🔴 OVO JE JEDINA PREOSTALA CROSS-BAZA ZAVISNOST SASTANAKA: `kadr_holidays`
   * je KADROVSKA tabela, a kadrovska je KORAK 4 seobe — u 3.0 je još nema. Zato
   * se praznici i pod `SASTANCI_PB_IZVOR=3.0` čitaju READ-ONLY sa sy15. Kad
   * kadrovska pređe, ovaj metod se BRIŠE i praznici se čitaju iz 3.0 (jedan
   * izvor); do tada je ovo jedini razlog zbog kog sastanci još dodiruju sy15.
   *
   * Bez `SY15_DATABASE_URL` (`sy15.db` baca 503) posao se NE obara: praznici
   * nisu dostupni, pa sedmični termin NEĆE biti pomeren sa praznika — što je
   * bezbedniji ishod od preskočene automatike (sastanak se ručno pomeri).
   */
  private async prazniciSaSy15(): Promise<ReadonlySet<string>> {
    const od = new Date();
    const doo = new Date(od.getTime() + PRAZNICI_PROZOR_DANA * 86_400_000);
    try {
      const rows = await this.sy15.db.kadrHoliday.findMany({
        where: { holidayDate: { gte: od, lte: doo }, isWorkday: false },
        select: { holidayDate: true },
      });
      return new Set(rows.map((r) => r.holidayDate.toISOString().slice(0, 10)));
    } catch (e) {
      this.logger.warn(
        "Praznici (sy15 kadr_holidays) nisu dostupni — sedmični sastanak NEĆE biti " +
          "pomeren sa praznika (ako termin padne na neradni dan, pomeriti ga ručno). " +
          `Uzrok: ${e instanceof Error ? e.message : String(e)}`,
      );
      return new Set<string>();
    }
  }

  /** Svi poslovi za registraciju u SchedulerService. */
  buildJobs(): ScheduledJob[] {
    const j = (
      key: string,
      description: string,
      schedule: ScheduledJob["schedule"],
      fnSql: string,
      catchUpMinutes?: number,
    ): ScheduledJob => ({
      key,
      description,
      schedule,
      catchUpMinutes,
      run: async () => this.call(fnSql),
    });

    return [
      // ── Kadrovska (outbox: kadr_notification_log; dispatch sy15) ──────────
      j(
        "kadr-hr-reminders",
        "HR podsetnici (lekarski/ugovori/rođendani/stranci/kartice — grane A–I)",
        { kind: "daily", at: "09:00" },
        // TABLE fn → obavezno SELECT * FROM (record kolona ruši Prisma raw).
        "SELECT * FROM public.kadr_schedule_hr_reminders();",
      ),
      j(
        "kadr-corrective",
        "Korektivne mere: probijen rok + follow-up danas",
        { kind: "daily", at: "09:30" },
        "SELECT public.kadr_schedule_corrective_reminders();",
      ),
      j(
        "kadr-onboarding",
        "Onboarding/offboarding: dnevni digest otvorenih zadataka",
        { kind: "daily", at: "09:00" },
        "SELECT public.kadr_schedule_onboarding_reminders();",
      ),
      j(
        "kadr-attendance-alerts",
        "Prisustvo: jučerašnje anomalije (zaboravljen izlaz, sati bez prolaza) — fn guard traži lokalno 06h",
        { kind: "daily", at: "06:00" },
        // void fn → ::text (Prisma ne deserializuje void); catch-up SAMO unutar
        // guard-sata fn-a (van 06h fn je no-op a run bi lažno bio DONE).
        "SELECT public.kadr_schedule_attendance_alerts()::text AS result;",
        55,
      ),
      j(
        "kadr-attendance-digest",
        "Prisustvo: sedmični digest (pon 06:30 — fn guard pon+06h)",
        { kind: "weekly", isoDow: 1, at: "06:30" },
        "SELECT public.kadr_schedule_attendance_weekly_digest()::text AS result;",
        25,
      ),
      j(
        "kadr-weekly-risk",
        "Nedeljni HR rizik-rezime (bolovanja/isteci ≤60d) na config primaoce",
        { kind: "weekly", isoDow: 1, at: "09:00" },
        "SELECT public.kadr_queue_weekly_risk_summary();",
      ),
      j(
        "kadr-qbt-cards",
        "Bedževi operatera iz BigTehn kartica (posle bridge sync-a) — nije outbox",
        { kind: "daily", at: "06:30" },
        "SELECT public.sync_qbigtehn_operator_cards()::text AS result;",
      ),
      // ── Sastanci (outbox: sastanci_notification_log) ──────────────────────
      // Ova TRI posla poštuju `SASTANCI_PB_IZVOR` (vidi `callSastanci`).
      {
        key: "sast-action-reminders",
        description:
          "Akcione tačke: rok juče/danas/sutra → podsetnik odgovornom",
        schedule: { kind: "daily", at: "09:00" },
        run: async () =>
          this.callSastanci(
            "SELECT public.sastanci_enqueue_action_reminders();",
            "sastanci_enqueue_action_reminders",
            (tx) => this.sastFn.enqueueActionReminders(tx),
          ),
      },
      {
        key: "sast-meeting-reminders",
        // 024/26 („podsetnik pola sata pred sastanak"): kadenca 5 min uz fn
        // prozor 25–35 min → mejl stiže ~30–35 min pre početka. ⚠️ KADENCA I
        // PROZOR SU SPREGNUTI (prozor mora biti širi od kadence, inače tik
        // preskoči sastanak) — prozor menja sy15 skripta
        // backend/docs/sql/sy15/sastanci-024-periodicni-2026-08-04/20_….
        // Dok skripta nije primenjena (prozor još 15–45), ista kadenca samo
        // šalje ~40–45 min ranije; dedup u fn (1 h) i dalje garantuje 1 mejl.
        // (3.0 prepis već nosi prozor 25–35 — `enqueueMeetingReminders`.)
        description:
          "Sastanci: podsetnik učesnicima ~30 min pre početka (fn prozor 25–35)",
        schedule: { kind: "everyMinutes", minutes: 5 },
        run: async () =>
          this.callSastanci(
            "SELECT public.sastanci_enqueue_meeting_reminders();",
            "sastanci_enqueue_meeting_reminders",
            (tx) => this.sastFn.enqueueMeetingReminders(tx),
          ),
      },
      {
        key: "sast-weekly-auto",
        description:
          "Sedmični kolegijum: auto-kreiranje petkom 08h (fn guard pet+08h; skip/prenos akcija u fn)",
        schedule: { kind: "weekly", isoDow: 5, at: "08:00" },
        catchUpMinutes: 55,
        run: async () => {
          // Praznici se učitavaju SAMO pod `3.0` (sy15 fn ih čita sama iz
          // `kadr_holidays`, u istoj bazi) — inače bi `sy15` put plaćao suvišan upit.
          const praznici = this.izvor.isThreeZero
            ? await this.prazniciSaSy15()
            : new Set<string>();
          return this.callSastanci(
            "SELECT public.sast_auto_create_weekly();",
            "sast_auto_create_weekly",
            (tx) => this.sastFn.autoCreateWeekly(tx, praznici),
          );
        },
      },
      // ── Održavanje / Projektni biro ───────────────────────────────────────
      j(
        "maint-deadlines",
        "CMMS rokovi: vozila+vozači+dokumenti+IT/objekti (lookahead 30d)",
        { kind: "daily", at: "09:00" },
        "SELECT * FROM public.maint_check_all_deadlines(30);",
      ),
      {
        key: "pb-enqueue",
        description: "Projektni biro: dnevne notifikacije (rokovi zadataka)",
        schedule: { kind: "daily", at: "09:00" },
        run: async () => {
          // PB se u ovom koraku NE seli (blokiran kadrovskom: `pb_current_employee_id`
          // visi o `employees`). Branjeni geter je tu da posao ne može TIHO da
          // zaobiđe prekidač — pod `3.0` pada sa 503 i imenom putanje u dnevniku,
          // umesto da nastavi da piše u sy15 i razilazi dve baze.
          this.izvor.assertPorted(
            "projektni biro: enqueue notifikacija kroz sy15",
          );
          return this.call("SELECT public.pb_enqueue_notifications();");
        },
      },
    ];
  }
}
