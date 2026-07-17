import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { Sy15Service } from "../../common/sy15/sy15.service";
import { MailService } from "../../common/mail/mail.service";
// Tip-only import generisanog sy15 klijenta (brise se u kompajlu — bez runtime zavisnosti;
// isti obrazac kao Sy15Service `db` getter). Koristi se samo za `$queryRawUnsafe` READ.
import type { PrismaClient as Sy15PrismaClient } from "@prisma-sy15/client";

/**
 * Pogonska vremenska zona (paritet A-4 / tech-processes.service `SHOP_TZ`). `event_ts_local`
 * je NAIVNI lokalni timestamp; `started_at` je `timestamptz` — poređenje se radi tako što
 * se `started_at` prevede u pogonsku zonu (`AT TIME ZONE`), a rezultat (`event_ts_local`)
 * vrati u `timestamptz` istom zonom pre upisa u `stopped_at`.
 */
const SHOP_TZ = "Europe/Belgrade";

/** Koliko nivoa sistematizacije da se penje tražeći nadređenog sa e-mailom. */
const MAX_BOSS_LEVELS = 4;

/** Viseća sesija (podskup `work_time_entries`) koju obrađujemo. */
interface HangingSession {
  id: number;
  workerId: number;
  startedAt: Date;
  identNumber: string;
  operationNumber: number;
  workCenterCode: string;
  worker: { fullName: string | null } | null;
}

/** Sažetak jednog prolaza. */
export interface SessionAutoCloseSummary {
  total: number;
  closedByGate: number;
  closedNeispravno: number;
  unmapped: number;
  olderThanHours: number;
}

/**
 * Q11 (Nenad 17.07) — AUTO-ZATVARANJE VISEĆIH RADNIH SESIJA preko evidencije kapije.
 *
 * Viseće sesije = `work_time_entries.stopped_at IS NULL` starije od praga (npr. zaboravljen
 * STOP preko noći). Za svaku:
 *  - radnik JE KUCAO IZLAZ na kapiji tog dana → sesija se zatvara VREMENOM IZLASKA
 *    (kao da je uredno zatvorio);
 *  - radnik NEMA izlaz → NEISPRAVNO KUCANJE: sesija se svejedno zatvara (0 trajanje, da ne
 *    visi 24h), upisuje se `note`, i njegovom ŠEFU ide e-mail;
 *  - radnik NIJE mapiran na kapiju → 0 trajanje + note „nije mapiran".
 *
 * Lanci (POTVRĐENO na prod):
 *  - 2.0 `workers.id` → `worker_employee_map.employee_id` (1.0 sy15 `employees.id` UUID).
 *  - KAPIJA: sy15 `attendance_events` (RAW, NIJE Prisma model): `employee_id`, `direction`
 *    ('in'/'out'), `event_ts_local`. Izlaz = poslednji `direction='out'` tog dana posle starta.
 *  - ŠEF: sy15 `employees.position` → `job_positions.name` = ta pozicija →
 *    `reports_to_line` (naziv NADREĐENE pozicije) → `employees` WHERE `position` = taj naziv →
 *    prvi ne-prazan `email` (ako nema, penje se još nivo gore; do MAX_BOSS_LEVELS).
 *
 * ⚠️ sy15 je READ-ONLY za 2.0 — ovaj servis u nju SAMO ČITA (`$queryRawUnsafe`). SVI UPISI idu
 * u 2.0 preko `PrismaService`. Graceful ako sy15 nije konfigurisan (client null) → viseće se
 * zatvaraju kao „bez kapije" (0 trajanje), bez pucanja. E-mail je best-effort (pad slanja NE
 * obara zatvaranje). Trigger ostaje endpoint (`POST /work/auto-close`, ODLUKE #24) — cron/systemd.
 */
@Injectable()
export class SessionAutoCloseService {
  private readonly logger = new Logger(SessionAutoCloseService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Sy15Service i MailService dolaze iz @Global modula (Sy15Module / MailModule) —
    // injektuju se bez posebnog importa u TechProcessesModule.
    private readonly sy15: Sy15Service,
    private readonly mail: MailService,
  ) {}

  /**
   * Zatvori sve viseće sesije starije od `olderThanHours` (default 12h).
   * Vraća sažetak: {total, closedByGate, closedNeispravno, unmapped, olderThanHours}.
   */
  async run(olderThanHours = 12): Promise<{ data: SessionAutoCloseSummary }> {
    const hours =
      Number.isFinite(olderThanHours) && olderThanHours > 0
        ? olderThanHours
        : 12;
    const cutoff = new Date(Date.now() - hours * 3_600_000);

    const sessions = (await this.prisma.workTimeEntry.findMany({
      where: { stoppedAt: null, startedAt: { lt: cutoff } },
      select: {
        id: true,
        workerId: true,
        startedAt: true,
        identNumber: true,
        operationNumber: true,
        workCenterCode: true,
        worker: { select: { fullName: true } },
      },
      orderBy: { id: "asc" },
    })) as HangingSession[];

    const summary: SessionAutoCloseSummary = {
      total: sessions.length,
      closedByGate: 0,
      closedNeispravno: 0,
      unmapped: 0,
      olderThanHours: hours,
    };
    if (!sessions.length) return { data: summary };

    // Mapiranje radnik → osoba (kapija) — jedan upit za sve radnike u paketu.
    const workerIds = [...new Set(sessions.map((s) => s.workerId))];
    const maps = await this.prisma.workerEmployeeMap.findMany({
      where: { workerId: { in: workerIds } },
      select: { workerId: true, employeeId: true },
    });
    const employeeByWorker = new Map(maps.map((m) => [m.workerId, m.employeeId]));

    // Kapija (sy15) — jednom po prolazu; ako nije konfigurisana, radimo graceful.
    const sy15Db = this.getSy15DbOrNull();
    if (!sy15Db) {
      this.logger.warn(
        "Q11 auto-close: sy15 (kapija) nedostupna — viseće sesije zatvaram kao 'bez kapije' (0 trajanje).",
      );
    }

    for (const s of sessions) {
      const employeeId = employeeByWorker.get(s.workerId) ?? null;

      // (a) nema mapiranja ILI nema kapije → 0 trajanje da ne visi, note objašnjava razlog.
      if (!employeeId || !sy15Db) {
        const note = !employeeId
          ? "auto-close: radnik nije mapiran na kapiju"
          : "auto-close: kapija nedostupna (sy15 nekonfigurisan)";
        await this.closeSession(s.id, s.startedAt, note);
        summary.unmapped++;
        continue;
      }

      // (b) poslednji IZLAZ na kapiji tog dana posle starta sesije.
      const lastExit = await this.findLastGateExit(sy15Db, employeeId, s.startedAt);

      if (lastExit) {
        // (c) uredan izlaz → zatvori vremenom izlaska.
        await this.closeSession(s.id, lastExit, "auto-close: izlaz na kapiji");
        summary.closedByGate++;
      } else {
        // (d) nema izlaza → NEISPRAVNO KUCANJE: zatvori 0-trajanje + e-mail šefu (best-effort).
        await this.closeSession(
          s.id,
          s.startedAt,
          "NEISPRAVNO KUCANJE: sesija bez izlaza na kapiji",
        );
        summary.closedNeispravno++;
        await this.notifyBoss(sy15Db, employeeId, s).catch((e: unknown) => {
          // Pad e-maila/razrešavanja šefa NE sme da obori zatvaranje (već je zatvoreno gore).
          this.logger.error(
            `Q11 auto-close: obaveštavanje šefa palo za sesiju ${s.id}: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        });
      }
    }

    this.logger.log(
      `Q11 auto-close (>${hours}h): ukupno ${summary.total}, izlaz-kapija ${summary.closedByGate}, ` +
        `neispravno ${summary.closedNeispravno}, bez-kapije/nemapiran ${summary.unmapped}`,
    );
    return { data: summary };
  }

  // ---------------------------------------------------------------- pomoćne

  /** `this.sy15.db` baca ServiceUnavailableException ako SY15_DATABASE_URL nije podešen —
   *  hvatamo ga i vraćamo null (graceful, bez pucanja). */
  private getSy15DbOrNull(): Sy15PrismaClient | null {
    try {
      return this.sy15.db;
    } catch {
      return null;
    }
  }

  /** Zatvori JEDNU sesiju u 2.0 (jedini upis; sy15 se NE dira). */
  private async closeSession(
    id: number,
    stoppedAt: Date,
    note: string,
  ): Promise<void> {
    await this.prisma.workTimeEntry.update({
      where: { id },
      data: { stoppedAt, autoClosed: true, note },
    });
  }

  /**
   * Poslednji `direction='out'` te osobe NA DAN sesije (lokalna zona) koji je posle starta.
   * `event_ts_local` (naivni lokalni) se poredi sa `started_at` prevedenim u pogonsku zonu;
   * rezultat se vraća u `timestamptz` (`AT TIME ZONE`) pa je spreman za `stopped_at`.
   * SAMO READ nad sy15.
   */
  private async findLastGateExit(
    sy15Db: Sy15PrismaClient,
    employeeId: string,
    startedAt: Date,
  ): Promise<Date | null> {
    const rows: { stopped_at: Date | null }[] = await sy15Db.$queryRawUnsafe(
      `SELECT (max(event_ts_local) AT TIME ZONE $2) AS stopped_at
         FROM attendance_events
        WHERE employee_id = $1::uuid
          AND direction = 'out'
          AND event_ts_local >= (($3::timestamptz) AT TIME ZONE $2)
          AND event_ts_local::date = (($3::timestamptz) AT TIME ZONE $2)::date`,
      employeeId,
      SHOP_TZ,
      startedAt,
    );
    const v = rows?.[0]?.stopped_at ?? null;
    return v ? new Date(v) : null;
  }

  /** Razreši šefa (sistematizacija) i pošalji e-mail — best-effort. SAMO READ nad sy15. */
  private async notifyBoss(
    sy15Db: Sy15PrismaClient,
    employeeId: string,
    s: HangingSession,
  ): Promise<void> {
    const boss = await this.resolveBossEmail(sy15Db, employeeId);
    const to = boss?.email ?? process.env.AUTOCLOSE_FALLBACK_EMAIL?.trim() ?? "";
    if (!to) {
      this.logger.warn(
        `Q11 auto-close: šef za osobu ${employeeId} nije razrešen (nema e-mail) — e-mail preskočen (sesija ${s.id}).`,
      );
      return;
    }

    const worker = s.worker?.fullName?.trim() || `radnik #${s.workerId}`;
    const started = this.fmt(s.startedAt);
    const subject = `Neispravno kucanje — ${worker} (RN ${s.identNumber})`;
    const html =
      `<p>Poštovani${boss?.fullName ? ` ${boss.fullName}` : ""},</p>` +
      `<p>Radna sesija operatera <b>${worker}</b> je zatvorena automatski jer <b>nema evidentiranog ` +
      `izlaza na kapiji</b> — <b>neispravno kucanje</b>. Molimo proverite.</p>` +
      `<ul>` +
      `<li><b>Radni nalog / ident:</b> ${s.identNumber}</li>` +
      `<li><b>Operacija:</b> br. ${s.operationNumber}, RC ${s.workCenterCode}</li>` +
      `<li><b>Početak rada:</b> ${started}</li>` +
      `</ul>` +
      `<p>Sesija je zatvorena bez utrošenog vremena (0 komada) da ne bi visela. ` +
      `Automatska poruka ServoSync — auto-zatvaranje sesija.</p>`;

    // MailService.send nikad ne baca (vraća boolean); ovde smo ionako u try/catch iz run().
    await this.mail.send({ to, subject, html });
  }

  /**
   * Šef iz sistematizacije: position → job_positions.reports_to_line → nadređeni sa e-mailom.
   * Penje se do MAX_BOSS_LEVELS nivoa (ako direktni nadređeni nema e-mail, gleda nivo iznad).
   * SAMO READ nad sy15.
   */
  private async resolveBossEmail(
    sy15Db: Sy15PrismaClient,
    employeeId: string,
  ): Promise<{ email: string; fullName: string | null } | null> {
    const posRows: { position: string | null }[] = await sy15Db.$queryRawUnsafe(
      `SELECT position FROM employees WHERE id = $1::uuid LIMIT 1`,
      employeeId,
    );
    let position: string | null = posRows?.[0]?.position?.trim() || null;
    if (!position) return null;

    for (let level = 0; level < MAX_BOSS_LEVELS && position; level++) {
      const lineRows: { reports_to_line: string | null }[] =
        await sy15Db.$queryRawUnsafe(
          `SELECT reports_to_line FROM job_positions WHERE name = $1 LIMIT 1`,
          position,
        );
      const superior: string | null =
        lineRows?.[0]?.reports_to_line?.trim() || null;
      if (!superior) return null;

      const empRows: { email: string | null; full_name: string | null }[] =
        await sy15Db.$queryRawUnsafe(
          `SELECT email, full_name FROM employees
          WHERE position = $1 AND email IS NOT NULL AND btrim(email) <> ''
            AND coalesce(is_active, true) = true
          ORDER BY email
          LIMIT 1`,
          superior,
        );
      const found = empRows?.[0];
      if (found?.email) {
        return { email: found.email, fullName: found.full_name ?? null };
      }
      // Nadređena pozicija nema (aktivnog) nosioca sa e-mailom → penji se dalje.
      position = superior;
    }
    return null;
  }

  /** Lokalni prikaz vremena za e-mail (pogonska zona). */
  private fmt(d: Date): string {
    return new Intl.DateTimeFormat("sr-RS", {
      timeZone: SHOP_TZ,
      dateStyle: "short",
      timeStyle: "short",
    }).format(d);
  }
}
