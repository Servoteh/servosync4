import { Injectable, Logger } from "@nestjs/common";
import { Sy15Service } from "../../common/sy15/sy15.service";
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
 */

interface RawRow {
  [k: string]: unknown;
}

/** Viseći sy15 poziv (mrtva veza / lock na sy15) ne sme da zakuca ceo tik. */
const SY15_CALL_TIMEOUT_MS = 120_000;

@Injectable()
export class Sy15CronJobs {
  private readonly logger = new Logger(Sy15CronJobs.name);

  constructor(private readonly sy15: Sy15Service) {}

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
      j(
        "sast-action-reminders",
        "Akcione tačke: rok juče/danas/sutra → podsetnik odgovornom",
        { kind: "daily", at: "09:00" },
        "SELECT public.sastanci_enqueue_action_reminders();",
      ),
      j(
        "sast-meeting-reminders",
        "Sastanci: podsetnik učesnicima za sastanke koji počinju za 15–45 min",
        { kind: "everyMinutes", minutes: 30 },
        "SELECT public.sastanci_enqueue_meeting_reminders();",
      ),
      j(
        "sast-weekly-auto",
        "Sedmični kolegijum: auto-kreiranje petkom 08h (fn guard pet+08h; skip/prenos akcija u fn)",
        { kind: "weekly", isoDow: 5, at: "08:00" },
        "SELECT public.sast_auto_create_weekly();",
        55,
      ),
      // ── Održavanje / Projektni biro ───────────────────────────────────────
      j(
        "maint-deadlines",
        "CMMS rokovi: vozila+vozači+dokumenti+IT/objekti (lookahead 30d)",
        { kind: "daily", at: "09:00" },
        "SELECT * FROM public.maint_check_all_deadlines(30);",
      ),
      j(
        "pb-enqueue",
        "Projektni biro: dnevne notifikacije (rokovi zadataka)",
        { kind: "daily", at: "09:00" },
        "SELECT public.pb_enqueue_notifications();",
      ),
    ];
  }
}
