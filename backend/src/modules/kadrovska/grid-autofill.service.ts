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
// JEDINI izvor istine za predlog sati: koriste ga i noćni auto-tik i ručno dugme
// „Popuni iz kapije" (kadrovska.service.ts) → oba puta predlažu identično.
/** Standardni pun dan. */
export const FULL_DAY_HOURS = 8;
/** Prisustvo >= ovo → pun dan (8). Isto pravilo za auto-tik i ručno „Popuni iz kapije";
 *  otvoreno nagore: i duži dan (npr. 9.5h uz prekovremeni) predlaže 8 REDOVNIH, a prekovremeni
 *  dodaje urednik (grid razdvaja redovne/prekovremene → auto ne pogađa prekovremeni). */
export const REGULAR_FULL_MIN = 7.6;
/** Prisustvo < ovo → preskoči (slučajno/kratko kucanje). Prag = shadow view `presence_hours > 1`. */
export const PRESENCE_FLOOR = 1.0;
/** Prisustvo > ovo → preskoči (anomalija / neuobičajeno duga smena → urednik ručno). */
export const PRESENCE_CEIL = 14.0;

/**
 * Zaokruživanje NANIŽE na pola sata (D2, zahtev 044/26): `Math.floor(x*2)/2` — POD,
 * ne najbliže. Prisustvo (kucanje: dolazak→odlazak) je GORNJA granica stvarnog rada,
 * pa se seče naniže: 6.52h → 6.5, 6.75h → 6.5, 5.05h → 5.0, 7.4h → 7.0.
 */
function roundToHalf(x: number): number {
  return Math.floor(x * 2) / 2;
}

/**
 * Predlog sati iz STVARNOG prisustva (kucanje) — čista funkcija (testabilna).
 *  - < FLOOR ili > CEIL → null (preskoči);
 *  - >= REGULAR_FULL_MIN → pun dan (8) — kapiranje redovnih na 8;
 *  - između → sečeno NANIŽE na pola sata (D2: 6.52h → 6.5, 6.75h → 6.5; skraćeno
 *    vreme Antić/Pavlović ~5h → 5.0, NE paušalnih 8h).
 */
export function proposeHoursFromPresence(
  presence: number | null,
): number | null {
  if (presence == null || !Number.isFinite(presence)) return null;
  if (presence < PRESENCE_FLOOR || presence > PRESENCE_CEIL) return null;
  if (presence >= REGULAR_FULL_MIN) return FULL_DAY_HOURS;
  const h = roundToHalf(presence);
  return h > 0 ? h : null;
}

/** Razlog preskakanja dana (za sažetak/brojače). */
export type ProposalSkipReason = "out_of_band" | "holiday_partial";

/** Ishod odluke za JEDAN dan: predlog sati ili razlog preskakanja. */
export interface DayProposal {
  /** Predlog sati; `null` = dan se NE upisuje automatski. */
  hours: number | null;
  /** Popunjeno SAMO kad je `hours === null`. */
  reason: ProposalSkipReason | null;
}

/**
 * Odluka za jedan dan = `proposeHoursFromPresence` (JEDINI izvor istine za SATE)
 * + DODATNA KAPIJA za NERADNE praznike. Koriste je OBA puta (noćni tik i ručno
 * dugme „Popuni iz kapije") → predlažu identično.
 *
 * ── ZAŠTO kapija za praznik (ispravka 044/26) ───────────────────────────────
 * `payroll-calc` na praznik koji pada u pon–pet radi ovako: ako dan IMA sate →
 * `praznikRadSati += h`; ako NEMA sate (i nema odsustva) → automatski priznaje
 * `praznikPlaceniSati += 8` (garantovani plaćeni neradni praznik). Znači: upis
 * DELIMIČNIH sati na neradni praznik TIHO UNIŠTAVA garantovanih 8h — npr. 2.5h
 * kucanja na Dan primirja bi radniku dalo 2.5h umesto 8h, a red se više nikad ne
 * revidira (`ON CONFLICT DO NOTHING` + dan postaje `grid_covered`).
 *
 * Zato: na NERADNOM prazniku (`kadr_holidays.is_workday = false`) auto predlaže
 * SAMO PUN DAN (8h) — pun praznični rad legitimno zamenjuje plaćeni praznik i
 * knjiži se kao `praznikRadSati` 8h (bez gubitka). DELIMIČNO kucanje se NE upisuje
 * nego ostaje kadrovskoj službi da ga unese svesno (vidi se u „Moje prisustvo").
 *
 * VIKENDI SU NETAKNUTI (D1, 044/26): vikend sa čistim kucanjem se i dalje predlaže
 * za bilo koje prisustvo u opsegu — payroll vikend h>0 vodi u `redovanRadSati`, pa
 * se nikakvo pravo ne gubi. Redovi sa `is_workday = true` (npr. naložena radna
 * subota) NISU praznik i uopšte ne ulaze u `holSet`.
 */
export function proposeHoursForDay(
  presence: number | null,
  isNonWorkingHoliday: boolean,
): DayProposal {
  const hours = proposeHoursFromPresence(presence);
  if (hours == null) return { hours: null, reason: "out_of_band" };
  if (isNonWorkingHoliday && hours !== FULL_DAY_HOURS)
    return { hours: null, reason: "holiday_partial" };
  return { hours, reason: null };
}

/**
 * Trenutni datum + sat (0–23) u pogonskoj zoni. Deljeno: interni tik i ručno dugme
 * (`kadrovska.service`) — TZ matematika postoji na JEDNOM mestu.
 */
export function belgradeNowParts(): { day: string; hour: number } {
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
export function shiftYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * „Juče" u pogonskoj zoni = GORNJA GRANICA svakog auto-predloga. DANAS se NIKAD ne
 * predlaže: dan još traje, pa bi kucanje u toku dana (npr. 08:00→10:00, izlaz već
 * upisan) dalo 2h koje niko posle ne ispravlja. Deljeno: noćni tik i ručno dugme.
 */
export function belgradeYesterday(): string {
  return shiftYmd(belgradeNowParts().day, -1);
}

/** Da li je dnevni auto-predlog uključen (env kill-switch; default UKLJUČEN). */
export function gridAutofillEnabled(): boolean {
  const v = (process.env.KADROVSKA_GRID_AUTOFILL ?? "true")
    .trim()
    .toLowerCase();
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
  /** Kandidati koji su dali validan predlog (posle opseg [FLOOR..CEIL] filtera). */
  proposed: number;
  /** Stvarno UPISANIH redova (ON CONFLICT DO NOTHING → već popunjeni dani se ne diraju). */
  inserted: number;
  /**
   * Dani preskočeni zbog pravila NERADNOG PRAZNIKA: praznik (`kadr_holidays.is_workday
   * = false`) sa DELIMIČNIM kucanjem (predlog < 8h) se NE upisuje — inače bi pojeo
   * garantovanih 8h plaćenog praznika (v. `proposeHoursForDay`). Kadrovska ih unosi
   * ručno. VIKENDI SE NE BROJE OVDE — oni se i dalje normalno predlažu (D1, 044/26);
   * ime polja je zadržano radi API-kompatibilnosti (`autofill-run` odgovor).
   */
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
 * `unref()`-ovan (ne drži proces u testu/boot-smoke) i gasi se na shutdown. Pokreće se
 * SAMO u produkciji (`NODE_ENV==='production'`) i uz uključen flag — dev/test/CI backend
 * NE sme autonomno da piše u živu sy15; svaka greška u tiku (uklj. sy15 nedostupan u boot
 * fazi) se LOGUJE, NIKAD ne ruši proces.
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

  /**
   * Pokreni interni dnevni tik — SAMO u produkciji i kad je flag uključen. Van produkcije
   * (dev/test/CI) je potpuno mrtav: lokalni/dev backend NE sme autonomno da piše u ŽIVU
   * sy15 `work_hours`. Ručni endpoint (`autofill-run`) ostaje dostupan svuda (uz flag).
   */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== "production") return; // tik SAMO u produkciji
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
          `van opsega ${data.skippedOutOfBand}, praznik-delimično ${data.skippedWeekendHoliday}.`,
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
    // KLAMP na juče (Europe/Belgrade): DANAS se NIKAD ne obrađuje. Delimičan (tekući) dan
    // bi upisao pogrešne sate koje sutrašnji tik NE ispravlja (dan je tad grid_covered) →
    // ostali bi trajno krivi. Gornja granica = min(opts.to, juče).
    const yesterday = belgradeYesterday();
    const requestedTo = (opts.to ?? yesterday).slice(0, 10);
    const to = requestedTo > yesterday ? yesterday : requestedTo;
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

    // 1b) NERADNI praznici u rasponu — potrebni samo kao KAPIJA za delimično kucanje
    //     (v. `proposeHoursForDay`). `isWorkday: false` je obavezan: red sa
    //     `is_workday = true` je radni-dan IZUZETAK (npr. naložena radna subota) i NIJE
    //     praznik. Upit se preskače kad nema kandidata (noć bez kucanja = 0 upita).
    const holSet = new Set<string>();
    if (rows.length > 0) {
      const holidays = await db.kadrHoliday.findMany({
        where: {
          isWorkday: false,
          holidayDate: {
            gte: new Date(`${from}T00:00:00Z`),
            lte: new Date(`${to}T00:00:00Z`),
          },
        },
        select: { holidayDate: true },
      });
      for (const h of holidays)
        holSet.add(h.holidayDate.toISOString().slice(0, 10));
    }

    // 2) Izračunaj predlog iz STVARNOG prisustva. VIKEND se NE preskače (D1, zahtev
    //    044/26): dan sa čistim kucanjem = REDOVNI sati, isto kao radni dan. Kucanje je
    //    dokaz da je čovek došao; ranije se preskakalo pa je Nikola vikende ručno unosio.
    //    NERADNI PRAZNIK ima dodatnu kapiju: predlaže se SAMO pun dan (8h), jer bi
    //    delimičan upis pojeo garantovanih 8h plaćenog praznika u obračunu.
    //    `ON CONFLICT DO NOTHING` i dalje štiti ručni unos/odsustvo. (Kandidatski SQL
    //    filter je već izbacio dane bez čistog kucanja.)
    const toInsert: { employeeId: string; workDate: string; hours: number }[] =
      [];
    for (const r of rows) {
      const ymd = r.day.toISOString().slice(0, 10);
      const presence =
        r.presence_hours == null ? null : Number(r.presence_hours);
      const { hours, reason } = proposeHoursForDay(presence, holSet.has(ymd));
      if (hours == null) {
        if (reason === "holiday_partial") summary.skippedWeekendHoliday++;
        else summary.skippedOutOfBand++;
        continue;
      }
      toInsert.push({ employeeId: r.employee_id, workDate: ymd, hours });
    }
    summary.proposed = toInsert.length;

    if (dryRun || toInsert.length === 0) return { data: summary };

    // 3) UPIS: INSERT … ON CONFLICT DO NOTHING (idempotentno; NIKAD ne gazi postojeći red).
    summary.inserted = await this.insertProposals(db, toInsert);
    this.logger.log(
      `Grid autofill ${from}..${to}: kandidata ${summary.candidates}, predloženo ${summary.proposed}, upisano ${summary.inserted}, praznik-delimično preskočeno ${summary.skippedWeekendHoliday} (marker ${GRID_AUTOFILL_MARKER}).`,
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

  /** Trenutni datum + sat (0–23) u pogonskoj zoni (za interni tik). */
  private belgradeNow(): { day: string; hour: number } {
    return belgradeNowParts();
  }

  /** Dodaj `n` dana na YYYY-MM-DD (radi na UTC ponoći → bez TZ pomeraja). */
  private addDays(ymd: string, n: number): string {
    return shiftYmd(ymd, n);
  }
}
