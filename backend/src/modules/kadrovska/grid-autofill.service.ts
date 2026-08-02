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

/**
 * Razlog preskakanja dana (za sažetak/brojače). Od 01.08.2026 postoji SAMO
 * `out_of_band` — razlog `holiday_partial` je ukinut zajedno sa prazničnom kapijom
 * (v. `proposeHoursForDay`).
 */
export type ProposalSkipReason = "out_of_band";

/** Ishod odluke za JEDAN dan: predlog sati ili razlog preskakanja. */
export interface DayProposal {
  /** Predlog sati; `null` = dan se NE upisuje automatski. */
  hours: number | null;
  /** Popunjeno SAMO kad je `hours === null`. */
  reason: ProposalSkipReason | null;
}

/**
 * Odluka za JEDAN dan — JEDINI izvor istine, koriste je OBA puta (noćni tik i ručno
 * dugme „Popuni iz kapije") → predlažu IDENTIČNO. Danas je to čist omotač oko
 * `proposeHoursFromPresence`: NIJEDAN kalendarski dan (radni, vikend, praznik) nema
 * poseban tretman — predlog je uvek prisustvo sečeno NANIŽE na pola sata, uz ≥7.6h → 8.
 *
 * ── UKINUTA KAPIJA ZA NERADNI PRAZNIK (01.08.2026) — PROČITAJ PRE „POPRAVKE" ────────
 * Do 01.08.2026 je ovde stajala dodatna kapija: na NERADNOM prazniku
 * (`kadr_holidays.is_workday = false`) predlagao se SAMO pun dan (8h), a delimično
 * kucanje se preskakalo sa razlogom `holiday_partial`. Lanac — zašto je postojala i
 * zašto je više NEMA:
 *
 *  1) STARO PONAŠANJE OBRAČUNA: `payroll-calc` je na praznik radnim danom radio
 *     `if (h > 0) { praznikRadSati += h; continue; }` — upis sati u kolonu „sati" je
 *     TIHO PREGAZIO garantovanih 8h plaćenog praznika. Delimično kucanje od 2.5h bi
 *     zamenilo 8h sa 2.5h, a red se posle nikad ne revidira (`ON CONFLICT DO NOTHING`
 *     + dan postaje `grid_covered`). Kapija je štitila baš od te tihe štete.
 *  2) O-1 (vlasnik 30.07.2026; u kodu 01.08.2026 — `263a4db6`, dokumentovano u
 *     `main b54bf26d`): rad na neradni praznik se plaća DUPLO, pa se sati sada DODAJU
 *     na 8h (`praznikRadSati += h` I `praznikPlaceniSati += 8`), ne zamenjuju ih.
 *     Zamka iz tačke 1 VIŠE NE POSTOJI — razlog za kapiju je otpao.
 *  3) O-4 (vlasnik 30.07.2026): kucanje na kapiji vikendom/praznikom je DOKAZ da je
 *     čovek dolazio i evidentira se SVIMA. Presuda vlasnika 01.08.2026 (zatvara Č-5):
 *     „nemoj da preskače, jednostavno nam treba evidencija iz automatike ko je dodatno
 *     radio za praznik. Nikola Mrkajić u svakom slučaju radi kontrolu sati i potvrdu
 *     za svaki mesec."
 *
 * ⚠️ POSLEDICA KOJU TREBA RAZUMETI, A NE „POPRAVITI": automatika sada može SAMA da
 * generiše DUPLU ISPLATU za praznik (8h plaćenog praznika + npr. 2.5h prazničnog rada)
 * bez ijednog ljudskog klika u trenutku upisa. TO JE NAMERNO I ODLUČENO. Brana više
 * nije tehnička nego LJUDSKA — Nikola Mrkajić mesečno kontroliše i potvrđuje grid, a
 * upis je i dalje samo PREDLOG (marker `auto:kapija`, `ON CONFLICT DO NOTHING` → nikad
 * ne gazi ručni unos ni dan sa odsustvom). Ako se kapija ikad bude vraćala, za to treba
 * NOVA vlasnička odluka upisana u `docs/ODLUKE_O_ZARADAMA.md` (O-1, O-4, Č-5) — ne
 * „popravka" u kodu.
 *
 * VIKENDI SU I DALJE NETAKNUTI (D1, 044/26); redovi `kadr_holidays` sa
 * `is_workday = true` (naložena radna subota) nikad nisu ni bili praznik, a sada su
 * bespredmetni jer autofill uopšte više ne gleda kalendar praznika.
 */
export function proposeHoursForDay(presence: number | null): DayProposal {
  const hours = proposeHoursFromPresence(presence);
  return hours == null
    ? { hours: null, reason: "out_of_band" }
    : { hours, reason: null };
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
   * ⚠️ ISTORIJSKO polje — od 01.08.2026 je TRAJNO 0 i nikad više ne raste.
   * Do tada je brojalo dane preskočene zbog kapije za NERADNI PRAZNIK (delimično
   * kucanje, predlog < 8h). Kapija je UKINUTA (v. `proposeHoursForDay`: O-1 je uklonio
   * razlog za nju, O-4 traži evidenciju) — takvi dani se sada normalno predlažu i
   * upisuju. Polje je ZADRŽANO namerno, da odgovor admin rute
   * `POST /kadrovska/grid/autofill-run` ostane kompatibilan (bez tihog nestanka polja).
   * VIKENDI se ovde nikad nisu ni brojali (D1, 044/26) — otud ime.
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
          `van opsega ${data.skippedOutOfBand}.`,
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
    //    ZAMENA DANA (31.07.2026): dan sa odobrenim 'dan_odmora' zahtevom se PRESKAČE —
    //    radnik za taj vikend-dan dobija +1 dan GO umesto plaćenih sati (nikad oboje);
    //    bez ovog filtera bi autofill vratio sate koje je kadr_grant_bonus_go obrisao
    //    (grant briše postojeći red na 0h, ali dan BEZ reda bi autofill ponovo upisao).
    const rows = await db.$queryRaw<VsGridRow[]>(Prisma.sql`
      SELECT v.employee_id, v.day, v.presence_hours
      FROM v_attendance_vs_grid v
      WHERE v.day >= ${from}::date AND v.day <= ${to}::date
        AND v.grid_covered = false
        AND v.absence_code IS NULL
        AND COALESCE(v.grid_field_hours, 0) = 0
        AND v.open_intervals = 0
        AND v.first_in IS NOT NULL
        AND v.last_out IS NOT NULL
        AND v.presence_hours IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM makeup_requests mr
          WHERE mr.employee_id = v.employee_id
            AND mr.compensation_type = 'dan_odmora'
            AND mr.status IN ('approved', 'completed')
            AND COALESCE(mr.weekend_work_date, mr.absence_date) = v.day
        )
      ORDER BY v.employee_id, v.day
    `);
    summary.candidates = rows.length;

    // 2) Izračunaj predlog iz STVARNOG prisustva — BEZ ijednog kalendarskog izuzetka.
    //    VIKEND se ne preskače (D1, zahtev 044/26): dan sa čistim kucanjem = REDOVNI
    //    sati, isto kao radni dan. NERADNI PRAZNIK se od 01.08.2026 tretira ISTO —
    //    ranija kapija „samo pun dan" je ukinuta (O-1 uklonio zamku, O-4 + presuda
    //    vlasnika traže evidenciju; detaljno obrazloženje: `proposeHoursForDay`). Zato
    //    ovde VIŠE NEMA upita nad `kadr_holidays` — kalendar praznika autofill-u nije
    //    potreban ni za šta. `ON CONFLICT DO NOTHING` i dalje štiti ručni unos/odsustvo.
    //    (Kandidatski SQL filter je već izbacio dane bez čistog kucanja.)
    const toInsert: { employeeId: string; workDate: string; hours: number }[] =
      [];
    for (const r of rows) {
      const ymd = r.day.toISOString().slice(0, 10);
      const presence =
        r.presence_hours == null ? null : Number(r.presence_hours);
      const { hours } = proposeHoursForDay(presence);
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
      `Grid autofill ${from}..${to}: kandidata ${summary.candidates}, predloženo ${summary.proposed}, upisano ${summary.inserted}, van opsega ${summary.skippedOutOfBand} (marker ${GRID_AUTOFILL_MARKER}).`,
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
