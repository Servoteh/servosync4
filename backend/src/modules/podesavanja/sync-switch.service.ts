import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BIGBIT_MDB_SYNC_JOB_KEY,
  BIGBIT_MDB_SYNC_STATE_ENTITY,
  BIGBIT_MDB_SYNC_SWITCH,
  dropDateFromFileName,
  IMPORT_CRITICAL_AFTER_HOURS,
  IMPORT_STALE_AFTER_HOURS,
  MAX_DROP_AGE_HOURS,
  NEVER_IMPORTED_GRACE_HOURS,
  RUN_STUCK_AFTER_HOURS,
  SOURCE_CRITICAL_AFTER_HOURS,
  SOURCE_STALE_AFTER_HOURS,
  switchDisabledReason,
} from "../../common/switches/bigbit-sync";

// Konstante žive u `common/switches/bigbit-sync.ts` (jedan izvor istine za sync,
// scheduler i ovaj ekran). Re-export je zbog postojećih uvoza — ne prekucavati.
export {
  BIGBIT_MDB_SYNC_JOB_KEY,
  BIGBIT_MDB_SYNC_STATE_ENTITY,
  BIGBIT_MDB_SYNC_SWITCH,
  IMPORT_CRITICAL_AFTER_HOURS,
  IMPORT_STALE_AFTER_HOURS,
  SOURCE_CRITICAL_AFTER_HOURS,
  SOURCE_STALE_AFTER_HOURS,
};

/**
 * Prekidač pozadinskih poslova (stavka B, 26.07.2026) + stanje noćnog BigBit uvoza.
 *
 * Vlasnik je tražio „check polje u podešavanju da mogu taj sync ručno da deaktiviram".
 * Stanje živi u app-owned tabeli `app_switches` (NE u env promenljivoj i NE u
 * `system_config`/`global_config` — te dve su BigBit ogledala koja full_refresh briše),
 * pa preklop važi ODMAH, bez restarta backenda.
 *
 * Ugovor za pozivaoce (sync/scheduler, stavka A ih povezuje):
 *  - zakazani posao poziva `runIfEnabled(BIGBIT_MDB_SYNC_SWITCH, fn)` i, kad je ugašeno,
 *    vraća `reason` kao svoj `summary` (status DONE, ne FAILED — nije kvar nego odluka);
 *  - svaki ručni ulaz (ruta `/sync/run`, `run-now`) poziva `assertEnabled(...)` i dobija
 *    409 sa jasnom srpskom porukom umesto da tiho ne uradi ništa.
 *
 * Ugovor za ono što posao MORA da upiše da bi ekran video stanje (nalaz 3 zahteva):
 *  - `scheduled_job_runs` sa `job_key = BIGBIT_MDB_SYNC_JOB_KEY` (scheduler to radi sam);
 *  - `bb_sync_state` red `entity = BIGBIT_MDB_SYNC_STATE_ENTITY` sa `lastSuccessAt`,
 *    `lastSuccessSyncLogId` (→ `bb_sync_log.rowsUpserted`) i `cursor` oblika
 *    `{ sourceFile, sourceFileModifiedAt, rowsImported? }` — odatle se čita starost
 *    IZVORNOG .mdb fajla, jedina zaštita od „drop je mrtav, a niko ne zna".
 * Sve je opciono na čitanju: dok stavka A ne sleti, ekran prikazuje „još nije bilo uvoza".
 */
@Injectable()
export class SyncSwitchService {
  private readonly logger = new Logger(SyncSwitchService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- generički prekidač

  /**
   * Da li je posao uključen. Red koji NE postoji = uključeno — prekidač je OFF-prekidač i
   * nedostatak reda (nova baza, neprimenjen seed) ne sme tiho da ugasi noćni uvoz.
   */
  async isEnabled(key: string): Promise<boolean> {
    try {
      const row = await this.prisma.appSwitch.findUnique({ where: { key } });
      return row ? row.enabled : true;
    } catch (e) {
      // Deklarisana semantika je fail-OPEN, a `findUnique` bez catch-a je bio
      // fail-CLOSED na svaku grešku baze (P2021 na bazi bez migracije, pad
      // konekcije) — prekidač uveden da bi se sync gasio gasio bi ga sam.
      this.logger.error(
        `Prekidač „${key}" se ne može pročitati (posao se PUŠTA dalje): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return true;
    }
  }

  /** Ceo red prekidača (ili `null` ako nikad nije diran). */
  getSwitch(key: string) {
    return this.prisma.appSwitch.findUnique({ where: { key } });
  }

  /**
   * Kapija za RUČNE ulaze (REST rute, `run-now`): ugašen prekidač → 409 sa razlogom.
   * Namerno NIJE tiho preskakanje — korisnik koji je pritisnuo dugme mora da vidi zašto
   * se ništa nije desilo.
   */
  async assertEnabled(key: string): Promise<void> {
    if (await this.isEnabled(key)) return;
    throw new ConflictException(this.disabledReason(key));
  }

  /**
   * Kapija za ZAKAZANE poslove: ako je ugašeno, `run` se NE poziva i vraća se razlog koji
   * posao upisuje u `scheduled_job_runs.summary` (vidljivo i u dnevniku i na ekranu).
   */
  async runIfEnabled<T>(
    key: string,
    run: () => Promise<T>,
  ): Promise<
    { skipped: true; reason: string } | { skipped: false; result: T }
  > {
    if (!(await this.isEnabled(key))) {
      const reason = this.disabledReason(key);
      this.logger.warn(`Posao „${key}" preskočen — ${reason}`);
      return { skipped: true, reason };
    }
    return { skipped: false, result: await run() };
  }

  /** Jedinstvena srpska poruka o ugašenom prekidaču (dnevnik, 409, ekran). */
  disabledReason(key: string): string {
    return switchDisabledReason(key);
  }

  /** Uključi/isključi prekidač. Upisuje ko je i kada menjao (vidi se na ekranu). */
  async setEnabled(
    key: string,
    enabled: boolean,
    actor: { userId?: number | null; email?: string | null },
    note?: string | null,
  ) {
    const cleanNote = typeof note === "string" ? note.trim() || null : null;
    const row = await this.prisma.appSwitch.upsert({
      where: { key },
      create: {
        key,
        enabled,
        note: cleanNote,
        updatedByUserId: actor.userId ?? null,
        updatedByEmail: actor.email ?? null,
      },
      update: {
        enabled,
        note: cleanNote,
        updatedByUserId: actor.userId ?? null,
        updatedByEmail: actor.email ?? null,
      },
    });
    this.logger.log(
      `Prekidač „${key}" → ${enabled ? "UKLJUČEN" : "ISKLJUČEN"} (${actor.email ?? "nepoznat korisnik"})`,
    );
    return row;
  }

  // ---------------------------------------------------------------- stanje BigBit uvoza

  /**
   * Stanje noćnog BigBit uvoza za ekran: prekidač + poslednji uvoz + starost izvornog fajla
   * + upozorenja na srpskom. Otporno je na to da stavka A još nije sletela — svaki izvor je
   * opcion i nedostatak se čita kao „još nije bilo uvoza", ne kao greška.
   */
  async bigbitStatus() {
    // SVAKI IZVOR NEZAVISNO TOLERANTAN: ekran je JEDINO mesto gde čovek vidi da
    // uvoz ne radi, pa pad JEDNOG upita (nova/restore baza bez neke tabele,
    // uskraćen GRANT) ne sme da obori ceo prikaz na 500. Bolje delimično stanje
    // uz jasno upozorenje nego prazan ekran.
    const degraded: string[] = [];
    const safe = async <T>(
      what: string,
      fn: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        degraded.push(what);
        this.logger.error(
          `bigbitStatus: izvor „${what}" nije čitljiv: ` +
            (e instanceof Error ? e.message : String(e)),
        );
        return null;
      }
    };

    const [sw, state, runsRaw] = await Promise.all([
      safe("prekidač", () => this.getSwitch(BIGBIT_MDB_SYNC_SWITCH)),
      safe("stanje uvoza", () =>
        this.prisma.bbSyncState.findUnique({
          where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
          include: { lastSuccessSyncLog: true },
        }),
      ),
      safe("dnevnik poslova", () =>
        this.prisma.scheduledJobRun.findMany({
          where: { jobKey: BIGBIT_MDB_SYNC_JOB_KEY },
          orderBy: { startedAt: "desc" },
          take: 5,
        }),
      ),
    ]);
    const runs = runsRaw ?? [];

    const enabled = sw ? sw.enabled : true;
    const cursor = parseCursor(state?.cursor);
    const now = Date.now();

    const lastSuccessAt = state?.lastSuccessAt ?? null;
    const rowsImported =
      cursor.rowsImported ?? state?.lastSuccessSyncLog?.rowsUpserted ?? null;

    // SVEŽINA PO DATUMU IZ IMENA FAJLA, ne po `mtime`-u — ISTA osnova kojom meri
    // i sam uvoz (ispravka 31.07.2026). `mtime` se kopiranjem nasleđuje od izvorne
    // baze, pa posle mirnog vikenda ekran pokaže crveno „izvor zastareo" i
    // nadzornik digne admine — dok uvoz (koji meri po imenu) uredno prolazi.
    // Dve istine o istom fajlu su gore od pogrešne jedne.
    const sourceModifiedAt = cursor.sourceFileModifiedAt;
    const sourceNameDate = dropDateFromFileName(cursor.sourceFile);
    const sourceFreshBasis = sourceNameDate ?? sourceModifiedAt;
    const source = cursor.sourceFile
      ? {
          fileName: cursor.sourceFile,
          modifiedAt: sourceModifiedAt ? sourceModifiedAt.toISOString() : null,
          ageHours: sourceFreshBasis ? hoursSince(sourceFreshBasis, now) : null,
        }
      : null;

    const lastRun = runs[0] ?? null;
    const warnings: SyncWarning[] = [];

    // Delimično stanje se PRIJAVLJUJE. Bez ovoga bi nedostajući izvor izgledao
    // isto kao „sve je u redu, samo još nije bilo uvoza".
    if (degraded.length)
      warnings.push({
        code: "STANJE_NECITLJIVO",
        level: "danger",
        message:
          `Stanje uvoza se ne može pročitati u celosti (${degraded.join(", ")}) — ` +
          "prikazani podaci NISU pouzdani. Javite IT.",
      });

    if (!enabled) {
      const since = sw?.updatedAt ? hoursSince(sw.updatedAt, now) : null;
      warnings.push({
        code: "PREKIDAC_ISKLJUCEN",
        level: "danger",
        message:
          "Noćni uvoz iz BigBita je ISKLJUČEN" +
          (since != null ? ` (${humanAge(since)})` : "") +
          ". Dok je isključen, podaci u 4.0 se ne osvežavaju i poređenje PDV obračuna sa " +
          "BigBitom nije verodostojno. Uključite kvačicu iznad da bi uvoz ponovo radio.",
      });
    }

    if (!lastSuccessAt) {
      // NAJGORE STANJE JE IMALO NAJBLAŽU BOJU: „nikad nije uspelo" je zauvek bilo
      // `warn` i čitalo se kao „čeka se prvi prolaz", pa nadzornik (koji okida na
      // `danger`) nikad ne bi javio da kanal uopšte nije prohodao.
      const waiting = sw?.createdAt ? hoursSince(sw.createdAt, now) : null;
      const fresh = waiting != null && waiting < NEVER_IMPORTED_GRACE_HOURS;
      warnings.push({
        code: "NIKAD_NIJE_PRORADIO",
        level: fresh ? "warn" : "danger",
        message: fresh
          ? "Uvoz iz BigBita još nijednom nije završen — čeka se prvi noćni prolaz."
          : "Uvoz iz BigBita NIJE PRORADIO NIJEDNOM" +
            (waiting != null
              ? ` (od pre ${Math.floor(waiting / 24)} dana)`
              : "") +
            ". To nije čekanje nego kvar. Proverite u Sistem → Zakazani poslovi da li posao " +
            `„${BIGBIT_MDB_SYNC_JOB_KEY}" postoji i da li je noćni izvoz na BigBit računaru uključen; ` +
            "ako ne umete, javite IT sa ovom porukom.",
      });
    } else {
      const age = hoursSince(lastSuccessAt, now);
      // Kad je prekidač ugašen, uvoz ne radi ZATO ŠTO ga je čovek ugasio —
      // slanje istog čoveka da traži kvar koji ne postoji je pogrešan savet.
      if (age >= IMPORT_STALE_AFTER_HOURS && enabled) {
        warnings.push({
          code: "UVOZ_ZASTAREO",
          level: age >= IMPORT_CRITICAL_AFTER_HOURS ? "danger" : "warn",
          message:
            `Poslednji uspešan uvoz je bio ${humanAge(age)}, a očekuje se svake noći. ` +
            "Pokušajte ručno pokretanje (Sistem → Zakazani poslovi → " +
            `„${BIGBIT_MDB_SYNC_JOB_KEY}" → Pokreni sada); ako i to padne, javite IT sa porukom greške.`,
        });
      }
      // Sat servera u budućnosti bi inače tiho dao starost 0 i upozorenje nikad
      // ne bi izašlo (`bb_sync_state` je jedina tabela u lancu bez zone).
      if (lastSuccessAt.getTime() - now > 5 * 60_000)
        warnings.push({
          code: "SAT_U_BUDUCNOSTI",
          level: "warn",
          message:
            "Vreme poslednjeg uvoza je u BUDUĆNOSTI — sat ili vremenska zona servera nisu tačni. " +
            "Dok se to ne sredi, upozorenja o zastarelosti nisu pouzdana. Javite IT.",
        });
    }

    if (sourceFreshBasis) {
      const age = hoursSince(sourceFreshBasis, now);
      // Tvrd prag (posao PADA) mora da se vidi kao takav — inače postoji prozor
      // u kome uvoz svake noći puca, a ekran pokazuje blago žuto upozorenje.
      if (age >= MAX_DROP_AGE_HOURS) {
        warnings.push({
          code: "IZVOR_ZASTAREO",
          level: "danger",
          message:
            `Podaci iz BigBita nisu stigli — poslednji fajl (${cursor.sourceFile ?? "nepoznat"}) je od ` +
            `${humanAge(age)} i uvoz se ZAUSTAVLJA (prag je ${MAX_DROP_AGE_HOURS} h), da se PDV ne bi ` +
            "računao nad starim podacima. Kvar je na strani BigBita: na BigBit računaru mora svake " +
            "noći da se napravi nov izvoz u drop folder. Javite osobi zaduženoj za BigBit izvoz.",
        });
      } else if (age >= SOURCE_STALE_AFTER_HOURS) {
        warnings.push({
          code: "IZVOR_ZASTAREO",
          level: age >= SOURCE_CRITICAL_AFTER_HOURS ? "danger" : "warn",
          message:
            `Izvorni fajl iz BigBita (${cursor.sourceFile ?? "nepoznat"}) star je ${humanAge(age)}. ` +
            `Uvoz još radi, ali posle ${MAX_DROP_AGE_HOURS} h staje. Proverite da li noćni izvoz na ` +
            "BigBit računaru ostavlja nov fajl.",
        });
      }
    }

    if (lastRun && lastRun.status === "FAILED") {
      warnings.push({
        code: "UVOZ_PAO",
        level: "danger",
        message:
          "Poslednji pokušaj uvoza je PAO. Pokušajte ručno pokretanje (Sistem → Zakazani poslovi); " +
          `ako opet padne, javite IT sa ovom porukom. Greška: ${lastRun.error ?? "nepoznata"}`,
      });
    }

    // ZAGLAVLJEN RUN: proces ubijen (OOM) ili kontejner restartovan usred obrade
    // ostavlja `status='RUNNING'` i `finished_at=NULL` ZAUVEK — nije FAILED, pa
    // nije bilo upozorenja, a `lastSuccessAt` je od juče pa ni ono nije stiglo.
    if (
      lastRun &&
      lastRun.status === "RUNNING" &&
      hoursSince(lastRun.startedAt, now) >= RUN_STUCK_AFTER_HOURS
    ) {
      warnings.push({
        code: "UVOZ_ZAGLAVLJEN",
        level: "danger",
        message:
          `Uvoz je počeo ${humanAge(hoursSince(lastRun.startedAt, now))} i nikad se nije završio — ` +
          "proces je verovatno prekinut (nedostatak memorije ili restart servera). " +
          "Pokrenite ga ručno (Sistem → Zakazani poslovi); ako se ponovi, javite IT.",
      });
    }

    return {
      data: {
        enabled,
        note: sw?.note ?? null,
        updatedAt: sw?.updatedAt?.toISOString() ?? null,
        updatedByEmail: sw?.updatedByEmail ?? null,
        lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
        lastAttemptAt: state?.lastAttemptAt
          ? state.lastAttemptAt.toISOString()
          : null,
        lastErrorMessage: state?.lastErrorMessage ?? null,
        rowsImported,
        source,
        lastRun: lastRun
          ? {
              status: lastRun.status,
              startedAt: lastRun.startedAt.toISOString(),
              finishedAt: lastRun.finishedAt
                ? lastRun.finishedAt.toISOString()
                : null,
              summary: lastRun.summary,
              error: lastRun.error,
            }
          : null,
        recentRuns: runs.map((r) => ({
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
          summary: r.summary,
          error: r.error,
        })),
        warnings,
      },
      meta: {
        switchKey: BIGBIT_MDB_SYNC_SWITCH,
        jobKey: BIGBIT_MDB_SYNC_JOB_KEY,
        importStaleAfterHours: IMPORT_STALE_AFTER_HOURS,
        sourceStaleAfterHours: SOURCE_STALE_AFTER_HOURS,
        /** Posle ovoliko sati starosti .mdb fajla uvoz NE upozorava nego PADA. */
        hardFailAfterHours: MAX_DROP_AGE_HOURS,
      },
    };
  }
}

// -------------------------------------------------------------------- tipovi / pomoćno

/**
 * Stabilna šifra upozorenja. Postoji da bi potrošači (jutarnji nadzornik) mogli da
 * razlikuju upozorenja BEZ poređenja srpskog teksta — prvo utišavanje nadzornika je
 * bilo napisano nad tekstom i nad ranim `return`-om, pa je gutalo i „poslednji uvoz
 * je PAO" (nalaz drugog kruga pregleda). Nedostatak šifre nije greška: upozorenja bez
 * nje se nikad ne utišavaju.
 */
export type SyncWarningCode =
  | "PREKIDAC_ISKLJUCEN"
  | "NIKAD_NIJE_PRORADIO"
  | "STANJE_NECITLJIVO"
  | "UVOZ_PAO"
  | "UVOZ_ZAGLAVLJEN"
  | "IZVOR_ZASTAREO"
  | "UVOZ_ZASTAREO"
  | "SAT_U_BUDUCNOSTI";

export interface SyncWarning {
  level: "warn" | "danger";
  message: string;
  /** Stabilna šifra (vidi `SyncWarningCode`); može izostati na starijim porukama. */
  code?: SyncWarningCode;
}

/** Ono što posao (stavka A) sme da ostavi u `bb_sync_state.cursor` za prikaz stanja. */
interface BigbitCursor {
  sourceFile?: string;
  sourceFileModifiedAt?: Date;
  rowsImported?: number;
}

/** Tolerantno čitanje kursora — nepoznat/nevalidan oblik ne ruši ekran. */
function parseCursor(raw: unknown): BigbitCursor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: BigbitCursor = {};
  if (typeof o.sourceFile === "string" && o.sourceFile)
    out.sourceFile = o.sourceFile;
  if (typeof o.sourceFileModifiedAt === "string") {
    const d = new Date(o.sourceFileModifiedAt);
    if (!Number.isNaN(d.getTime())) out.sourceFileModifiedAt = d;
  }
  if (typeof o.rowsImported === "number" && Number.isFinite(o.rowsImported))
    out.rowsImported = o.rowsImported;
  return out;
}

function hoursSince(d: Date, now: number): number {
  return Math.max(0, (now - d.getTime()) / 3_600_000);
}

/** „pre 5 sati" / „pre 3 dana" — poruka za čoveka, ne za programera. */
function humanAge(hours: number): string {
  if (hours < 1) return "pre manje od sat vremena";
  if (hours < 24)
    return `pre ${plural(Math.round(hours), "sat", "sata", "sati")}`;
  return `pre ${plural(Math.floor(hours / 24), "dan", "dana", "dana")}`;
}

/**
 * Srpska deklinacija po POSLEDNJOJ CIFRI. Ranije pravilo (`h < 5 ? "sata" : "sati"`)
 * je davalo „pre 21 sati" i „pre 22 sati" — tekst koji ide pravo korisniku.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return `${n} ${one}`;
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
