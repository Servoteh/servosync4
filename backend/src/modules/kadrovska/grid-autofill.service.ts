import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { Prisma } from "@prisma-sy15/client";
import { Sy15Service } from "../../common/sy15/sy15.service";

/** Pogonska zona (paritet Q11 SessionAutoCloseService) — „juče" i datumi grida su lokalni. */
const SHOP_TZ = "Europe/Belgrade";

/** Interni dnevni tik: perioda provere (~30 min) i najranije lokalno vreme obrade juče. */
const TICK_INTERVAL_MS = 30 * 60 * 1000;
const RUN_AFTER_HOUR = 5; // >= 05:00 Europe/Belgrade (juče je tad sigurno „zatvoreno")

/**
 * Marker koji stoji u `work_hours.last_edited_by` za AUTO-PREDLOGE iz kapije. Model
 * (`work_hours`) NEMA zaseban „predlog vs potvrđeno" red (izvor je jedan) — pa je izvor
 * unosa jedini razlučilac. Realni urednici pišu svoj e-mail; ovaj marker (nije e-mail)
 * je jasno razlučiv i preživljava dok ga urednik ne izmeni (`grid/batch` prepiše
 * `last_edited_by` na urednikov e-mail = „potvrđeno").
 */
export const GRID_AUTOFILL_MARKER = "auto:kapija";

// ── Pravila predloga sati (STVARNO prisustvo, NE paušalno 8h — presuda 24.07) ───────
/** Standardni pun dan. */
const FULL_DAY_HOURS = 8;
/** Prisustvo >= ovo → pun dan (8). Paritet postojećeg „Popuni iz kapije" (opseg [7.6,8.4]);
 *  otvoreno nagore: i duži dan (npr. 9.5h uz prekovremeni) predlaže 8 REDOVNIH, a prekovremeni
 *  dodaje urednik (grid razdvaja redovne/prekovremene → auto ne pogađa prekovremeni). */
const REGULAR_FULL_MIN = 7.6;
/** Prisustvo < ovo → preskoči (slučajno/kratko kucanje). Prag = shadow view `presence_hours > 1`. */
const PRESENCE_FLOOR = 1.0;
/** Prisustvo > ovo → preskoči (anomalija / neuobičajeno duga smena → urednik ručno). */
const PRESENCE_CEIL = 14.0;

/** Zaokruživanje na pola sata (skraćeno radno vreme: 5.05h → 5.0, 6.7h → 6.5). */
function roundToHalf(x: number): number {
  return Math.round(x * 2) / 2;
}

/**
 * Predlog sati iz STVARNOG prisustva (kucanje) — čista funkcija (testabilna).
 *  - < FLOOR ili > CEIL → null (preskoči);
 *  - >= REGULAR_FULL_MIN → pun dan (8) — paritet „Popuni iz kapije" + kapiranje redovnih na 8;
 *  - između → zaokruženo na pola sata (skraćeno vreme: Antić/Pavlović ~5h → 5.0, NE 8h).
 */
export function proposeHoursFromPresence(presence: number | null): number | null {
  if (presence == null || !Number.isFinite(presence)) return null;
  if (presence < PRESENCE_FLOOR || presence > PRESENCE_CEIL) return null;
  if (presence >= REGULAR_FULL_MIN) return FULL_DAY_HOURS;
  const h = roundToHalf(presence);
  return h > 0 ? h : null;
}

/** Da li je dnevni auto-predlog uključen (env kill-switch; default UKLJUČEN). */
export function gridAutofillEnabled(): boolean {
  const v = (process.env.KADROVSKA_GRID_AUTOFILL ?? "true").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(v);
}

/** Sažetak jednog prolaza (dnevni run ili backfill). */
export interface GridAutofillSummary {
  from: string;
  to: string;
  enabled: boolean;
  dryRun: boolean;
  /** Redovi iz v_attendance_vs_grid koji prođu SQL filter (prazan grid + ulaz/izlaz…). */
  candidates: number;
  /** Kandidati koji su dali validan predlog (posle vikend/praznik + opseg filtera). */
  proposed: number;
  /** Stvarno UPISANIH redova (ON CONFLICT DO NOTHING → već popunjeni dani se ne diraju). */
  inserted: number;
  skippedWeekendHoliday: number;
  skippedOutOfBand: number;
}

/** Red iz v_attendance_vs_grid — samo kolone koje job čita (BEZ ograničenog PII: JMBG/adresa/zarada). */
interface VsGridRow {
  employee_id: string;
  day: Date;
  presence_hours: unknown;
}

/**
 * Zahtev 012/26 (Duško Kostić; presuda Nenad 24.07) — DNEVNI AUTO-PREDLOG mesečnog grida
 * iz kucanja na kapiji.
 *
 * PROBLEM (utvrđeno na živim podacima): kancelarijska odeljenja (Inženjering/Finansije/
 * Projekti) imaju kucanja na kapiji (sy15 `attendance_events` → `v_attendance_daily`), ali
 * mesečni grid ima NULA popunjenih dana — allowlist urednici ručno pune samo proizvodnju.
 * Dvoje rade skraćeno (~5h) → paušalnih 8h bi bilo POGREŠNO.
 *
 * REŠENJE: sistem svakodnevno sam upiše PREDLOG sati iz STVARNOG prisustva za SVA odeljenja
 * gde je grid-dan prazan a kucanje postoji; urednici pregledaju/koriguju kroz postojeći UI.
 *
 * ── ODNOS PREMA „Popuni iz kapije" (5f20363) ────────────────────────────────────────
 * Isti IZVOR i ista pravila „regularnog dana" (`v_attendance_vs_grid`: prazan grid,
 * ulaz+izlaz, bez zaboravljenog izlaza/terena/odsustva). RAZLIKE (namerno, po presudi):
 *  1) STVARNO prisustvo umesto paušalnih 8h → opseg prisustva proširen naniže (FLOOR..CEIL)
 *     da uhvati i skraćeno vreme; `proposeHoursFromPresence` daje 5.0 za 5h radnika.
 *  2) UPIS `INSERT … ON CONFLICT (employee_id, work_date) DO NOTHING` umesto RPC
 *     `hr_upsert_work_hours_batch` (koji radi DO UPDATE). DO NOTHING je JEDINI način da se
 *     garantuje „nikad ne gazi ručni unos" pod konkurencijom (DO UPDATE bi prepisao red koji
 *     je urednik u međuvremenu upisao). Isti TABELA/kolone/konflikt-ključ kao RPC.
 *
 * ── IDENTITET / RLS (sistemski job — kao Q11 SessionAutoCloseService) ────────────────
 * Ovo je POZADINSKI job (ne korisnički zahtev), pa čita/piše kroz `this.sy15.db`
 * (konekciona rola `servosync2_app` = BYPASSRLS) — isti obrazac kao Q11 (čita
 * `attendance_events` direktno). Legitimno jer:
 *  - čita SAMO ne-ograničene kolone (`employee_id`, `day`, `presence_hours`) — bez
 *    JMBG/adrese/zarade (za razliku od korisničkog GET `grid/auto-fill` koji IDE kroz
 *    withUserRls jer vraća podatke korisniku);
 *  - mora da pokrije SVA odeljenja bez obzira na RLS opseg okidača (cron nije osoba);
 *  - upis je sistemski predlog (DO NOTHING + fiksni marker), gejt `can_edit_kadrovska_grid`
 *    je KORISNIČKA autorizacija koju sistemski job (kao Q11) legitimno zaobilazi.
 *
 * ── OKIDAČ: INTERNI DNEVNI TIK (ne spoljni cron) ────────────────────────────────────
 * ODLUKE #24: na serveru NE postoji cron/token mehanizam za okidanje endpointa. Zato job
 * ima INTERNI tik — obični `setInterval` (BEZ @nestjs/schedule/nove zavisnosti): svakih
 * ~30 min proveri da li je lokalno (Europe/Belgrade) vreme >= 05:00 i da JUČE još nije
 * obrađeno u ovom procesu (`lastRunDay` u memoriji); ako jeste — obradi juče (isti kod kao
 * endpoint bez tela). Restart aplikacije resetuje `lastRunDay` → ponovni run za juče je
 * NO-OP zbog `INSERT … ON CONFLICT DO NOTHING` (bezopasno, ne duplira/ne gazi). Tik je
 * `unref()`-ovan (ne drži proces u testu/boot-smoke) i gasi se na shutdown. U test
 * okruženju i pri isključenom flag-u se NE pokreće; svaka greška u tiku (uklj. sy15
 * nedostupan u boot fazi) se LOGUJE, NIKAD ne ruši proces.
 *
 * Ručni okidač (backfill jula / dry-run) OSTAJE admin endpoint `POST
 * /kadrovska/grid/autofill-run`.
 */
@Injectable()
export class KadrovskaGridAutofillService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(KadrovskaGridAutofillService.name);
  /** Interni dnevni tik (setInterval). null dok se ne pokrene / posle shutdown-a. */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Datum (YYYY-MM-DD) „juče" za koji je tik već uspešno obradio u OVOM procesu. */
  private lastRunDay: string | null = null;

  constructor(private readonly sy15: Sy15Service) {}

  /** Pokreni interni dnevni tik — osim u testu i kad je flag isključen (potpuno mrtav). */
  onModuleInit(): void {
    if (process.env.NODE_ENV === "test") return; // tik ne radi u testovima
    if (!gridAutofillEnabled()) {
      this.logger.log(
        "Grid autofill tik: isključen (KADROVSKA_GRID_AUTOFILL=false) — tik se ne pokreće.",
      );
      return;
    }
    this.tickTimer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // Ne drži proces živim (testovi / boot-smoke / graceful exit).
    this.tickTimer.unref?.();
    this.logger.log(
      `Grid autofill tik aktivan (~30 min; obrada „juče" posle ${String(RUN_AFTER_HOUR).padStart(2, "0")}:00 ${SHOP_TZ}).`,
    );
  }

  onModuleDestroy(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Jedan otkucaj: obradi „juče" ako je lokalno vreme >= 05:00 i taj dan još nije obrađen
   * u ovom procesu. SVE greške (uklj. sy15 nedostupan u boot fazi) se hvataju i loguju —
   * tik NIKAD ne ruši proces. `now` se injektuje SAMO u testu (inače pravo lokalno vreme).
   */
  private async tick(now?: { day: string; hour: number }): Promise<void> {
    try {
      if (!gridAutofillEnabled()) return; // flag može biti ugašen u toku rada
      const nowLocal = now ?? this.belgradeNow();
      if (nowLocal.hour < RUN_AFTER_HOUR) return; // prerano (juče možda još „traje")
      const yesterday = this.addDays(nowLocal.day, -1);
      if (this.lastRunDay === yesterday) return; // već obrađeno u ovom procesu
      const { data } = await this.run({ from: yesterday, to: yesterday });
      this.lastRunDay = yesterday; // uspeh → ne ponavljaj isti dan (do restarta)
      this.logger.log(
        `Grid autofill tik ${yesterday}: kandidata ${data.candidates}, upisano ${data.inserted}, ` +
          `preskočeno ${data.skippedWeekendHoliday + data.skippedOutOfBand}.`,
      );
    } catch (e) {
      this.logger.error(
        `Grid autofill tik pao (nastavlja se): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * Upiši auto-predloge za raspon [from, to] (uključivo). Bez raspona → SAMO juče
   * (dnevni režim). `dryRun` = izračunaj i prijavi, ali NE piši.
   */
  async run(
    opts: {
      actorEmail?: string;
      from?: string;
      to?: string;
      dryRun?: boolean;
    } = {},
  ): Promise<{ data: GridAutofillSummary }> {
    const enabled = gridAutofillEnabled();
    const today = this.belgradeToday();
    const to = (opts.to ?? this.addDays(today, -1)).slice(0, 10);
    const from = (opts.from ?? to).slice(0, 10);
    const dryRun = opts.dryRun ?? false;

    const summary: GridAutofillSummary = {
      from,
      to,
      enabled,
      dryRun,
      candidates: 0,
      proposed: 0,
      inserted: 0,
      skippedWeekendHoliday: 0,
      skippedOutOfBand: 0,
    };

    if (!enabled) {
      this.logger.log(
        "Grid autofill je isključen (KADROVSKA_GRID_AUTOFILL) — no-op.",
      );
      return { data: summary };
    }
    if (from > to) return { data: summary }; // prazan/obrnut raspon

    const db = this.sy15.db; // 503 ako sy15 nije konfigurisan (job zavisi od glavne baze)

    // 1) Kandidati: „regularni prazni dani" iz v_attendance_vs_grid (isti signali kao
    //    „Popuni iz kapije"; opseg prisustva se filtrira u JS-u da uhvati i skraćeno vreme).
    const rows = await db.$queryRaw<VsGridRow[]>(Prisma.sql`
      SELECT employee_id, day, presence_hours
      FROM v_attendance_vs_grid
      WHERE day >= ${from}::date AND day <= ${to}::date
        AND grid_covered = false
        AND absence_code IS NULL
        AND COALESCE(grid_field_hours, 0) = 0
        AND open_intervals = 0
        AND first_in IS NOT NULL
        AND last_out IS NOT NULL
        AND presence_hours IS NOT NULL
      ORDER BY employee_id, day
    `);
    summary.candidates = rows.length;

    // Praznici u rasponu (vikend/praznik ne diramo — nije redovan rad → ide ručno).
    const holidays = await db.kadrHoliday.findMany({
      where: {
        holidayDate: {
          gte: new Date(`${from}T00:00:00Z`),
          lte: new Date(`${to}T00:00:00Z`),
        },
      },
      select: { holidayDate: true },
    });
    const holSet = new Set(
      holidays.map((h) => h.holidayDate.toISOString().slice(0, 10)),
    );

    // 2) Filtriraj vikend/praznik + izračunaj predlog iz STVARNOG prisustva.
    const toInsert: { employeeId: string; workDate: string; hours: number }[] =
      [];
    for (const r of rows) {
      const ymd = r.day.toISOString().slice(0, 10);
      const dow = r.day.getUTCDay(); // 0=ned, 6=sub (date-kolona = UTC ponoć → DOW tačan)
      if (dow === 0 || dow === 6 || holSet.has(ymd)) {
        summary.skippedWeekendHoliday++;
        continue;
      }
      const presence =
        r.presence_hours == null ? null : Number(r.presence_hours);
      const hours = proposeHoursFromPresence(presence);
      if (hours == null) {
        summary.skippedOutOfBand++;
        continue;
      }
      toInsert.push({ employeeId: r.employee_id, workDate: ymd, hours });
    }
    summary.proposed = toInsert.length;

    if (dryRun || toInsert.length === 0) return { data: summary };

    // 3) UPIS: INSERT … ON CONFLICT DO NOTHING (idempotentno; NIKAD ne gazi postojeći red).
    summary.inserted = await this.insertProposals(db, toInsert);
    this.logger.log(
      `Grid autofill ${from}..${to}: kandidata ${summary.candidates}, predloženo ${summary.proposed}, upisano ${summary.inserted} (marker ${GRID_AUTOFILL_MARKER}).`,
    );
    return { data: summary };
  }

  /**
   * Grupni upis predloga. `unnest` tri paralelna niza → po red; `ON CONFLICT
   * (employee_id, work_date) DO NOTHING` = postojeći dan (ručni unos / odsustvo /
   * raniji auto) se NE dira. Vraća broj STVARNO upisanih redova.
   * `last_edited_by = 'auto:kapija'` (izvor); ostala polja = 0/prazno (kao RPC defaults).
   */
  private async insertProposals(
    db: Sy15Service["db"],
    rows: { employeeId: string; workDate: string; hours: number }[],
  ): Promise<number> {
    const empIds = rows.map((r) => r.employeeId);
    const dates = rows.map((r) => r.workDate);
    const hrs = rows.map((r) => r.hours);
    const affected = await db.$executeRaw(Prisma.sql`
      INSERT INTO work_hours
        (employee_id, work_date, hours, overtime_hours, field_hours, two_machine_hours,
         note, project_ref, last_edited_by, created_at, updated_at)
      SELECT emp, dt, hrs, 0, 0, 0, '', '', ${GRID_AUTOFILL_MARKER}, now(), now()
      FROM unnest(${empIds}::uuid[], ${dates}::date[], ${hrs}::numeric[])
        AS t(emp, dt, hrs)
      ON CONFLICT (employee_id, work_date) DO NOTHING
    `);
    return typeof affected === "number" ? affected : 0;
  }

  /** Današnji datum u pogonskoj zoni (YYYY-MM-DD). */
  private belgradeToday(): string {
    return this.belgradeNow().day;
  }

  /** Trenutni datum + sat (0–23) u pogonskoj zoni (za interni tik). */
  private belgradeNow(): { day: string; hour: number } {
    // en-CA daje ISO oblik YYYY-MM-DD; hour12:false → 00–23 (ponoć '24' → 0).
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: SHOP_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    let hour = Number(get("hour"));
    if (!Number.isFinite(hour) || hour === 24) hour = 0;
    return { day: `${get("year")}-${get("month")}-${get("day")}`, hour };
  }

  /** Dodaj `n` dana na YYYY-MM-DD (radi na UTC ponoći → bez TZ pomeraja). */
  private addDays(ymd: string, n: number): string {
    const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
}
