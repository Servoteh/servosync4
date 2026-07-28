import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  BIGBIT_MDB_SYNC_STATE_ENTITY,
  BIGBIT_MDB_SYNC_SWITCH,
  MAX_DROP_AGE_HOURS,
  switchDisabledReason,
} from "../../common/switches/bigbit-sync";

/**
 * KORAK 2 od noćnog BigBit uvoza: `bb_mdb_stage_*` -> 4.0 modeli.
 *
 * KORAK 1 (`backend/scripts/bigbit-mdb-export.sh`) radi NA HOSTU jer backend
 * kontejner ne vidi .mdb fajl (provereno 26.07.2026: `docker inspect
 * servosync-backend` -> Binds=[], nema docker socket-a, nema mdbtools-a). Host
 * napuni staging tabele i `bb_mdb_drops`; ovaj servis čita ISKLJUČIVO bazu.
 *
 * NAČELA
 *  • IDEMPOTENTNO: svaki korak je `INSERT ... ON CONFLICT DO UPDATE ... WHERE
 *    <red se STVARNO razlikuje>`. Poređenje NAMERNO ne uključuje
 *    `imported_drop_id` — on se menja sa svakim novim drop-om, pa bi ga svaka
 *    noć „razlikovala" i prepisala CELU glavnu knjigu. Tada bi brojači
 *    inserted/updated postali beskorisni („sve izmenjeno" svake noći) i STVARNA
 *    BigBitova ispravka bi se izgubila u šumu. Sada „ažurirano" znači ISKLJUČIVO
 *    da se sadržaj promenio u BigBitu.
 *  • U SERIJAMA: glavna knjiga ide keyset-om po `StavkaID` u serijama od
 *    `GK_BATCH`, svaka serija = zasebna transakcija.
 *  • OZNAKA POREKLA: svaki uvezeni red nosi `imported_drop_id` (iz kog je fajla
 *    PRVI put došao) i `bb_nalog_id`/`bb_stavka_id` (stabilan traceback ka
 *    BigBitu). `bb_stavka_id IS NULL` = red je nastao u 4.0.
 *  • NIŠTA TIHO: svaki izvorni red koji ne uđe se BROJI i imenuje (`filtered`
 *    sa razlogom, `skipped` sa razlogom). Sudar broja naloga i prazan izvoz
 *    OBARAJU posao — status DONE sme da znači samo „sve je stvarno ušlo".
 *  • NE DIRA MSSQL SYNC: `SyncService`/`SYNC_MAP` su zaseban put i rade dalje.
 *  • NE DIRA `customers`/`projects`: njih vozi živi MSSQL sync. Zabrana unosa iz
 *    stavke C je HTTP-nivo (korisnik), ne DB-nivo — uvoz je izuzet po definiciji.
 *
 * Uputstvo (ručno pokretanje, gašenje, kvarovi): docs/migration/BIGBIT_NOCNI_SYNC.md
 */

/** Serija za glavnu knjigu. 2.000 × ~15 kolona je udoban `INSERT ... SELECT`. */
const GK_BATCH = 2000;

/**
 * Posle koliko sati se `import_started_at` smatra ZAOSTALIM (proces ubijen,
 * kontejner restartovan) pa se claim sme preoteti. Mora biti IZNAD realnog
 * trajanja uvoza (danas ~5 s za 20k redova; puna istorija je red veličine minuta).
 */
const IMPORT_LOCK_STALE_HOURS = 2;

export interface MdbStepResult {
  entity: string;
  /** Redova u staging tabeli za ovaj drop (pre ijednog filtera). */
  staged: number;
  /** Novi redovi. */
  inserted: number;
  /** Postojeći redovi kojima se sadržaj STVARNO promenio u BigBitu. */
  updated: number;
  /** Postojeći redovi identični izvoru — Postgres nije pisao ništa. */
  unchanged: number;
  /** Redovi iz izvora koje smo namerno preskočili (uz razlog u `notes`). */
  skipped: number;
  /**
   * Redovi koje je filter izbacio PRE obrade (prazan datum, nenumerički ključ,
   * duplikat ključa). Ranije su tiho nestajali iz svih brojača — red koga izvor
   * ima, a 4.0 nema, ne sme da izgleda kao „nepromenjen".
   */
  filtered: number;
  /**
   * BRANA ZAKLJUČANIH NALOGA (stavka D, nalaz V6). Izmena iz BigBita koja bi
   * pogodila nalog u statusu `LOCKED` — dakle zaključan period, već predatu PDV
   * prijavu, već izračunat bilans. Uvoz je NE primenjuje, nego je upisuje u
   * `bb_import_rejected_changes` (staro → novo) i čeka ljudsku odluku.
   * Odvojeno od `skipped` NAMERNO: `skipped` (sudar broja naloga) obara ceo
   * uvoz, a odbijena izmena zaključanog naloga je normalno, očekivano stanje.
   */
  blockedLocked: number;
  durationMs: number;
  notes: string[];
}

export interface MdbImportResult {
  dropId: number | null;
  fileName: string | null;
  fileMtime: Date | null;
  fileSizeBytes: string | null;
  dropAgeHours: number | null;
  status: "DONE" | "SKIPPED" | "DISABLED" | "BUSY";
  steps: MdbStepResult[];
  /** Uvezeni redovi kojih u ovom drop-u VIŠE NEMA (obrisani/prekontirani u BigBitu). */
  vanished: { journalEntries: number; ledgerEntries: number };
  durationMs: number;
  summary: string;
}

/** Baca se kad kanal dostave ne radi — posao MORA da padne glasno, ne da prođe tiho. */
export class BigbitMdbDropStaleError extends Error {}

/** Baca se kad izvorni dokument NIJE mogao da uđe (sudar broja naloga). */
export class BigbitMdbConflictError extends Error {}

interface CountRow {
  staged: bigint | number;
  inserted: bigint | number;
  updated: bigint | number;
  skipped: bigint | number;
  fetched: bigint | number;
  /** Odbijene izmene nad ZAKLJUČANIM nalozima (stavka D); nema ga u koracima bez brane. */
  blocked_locked?: bigint | number;
  /** Koliko je odbijenih izmena PRVI put upisano u dnevnik u ovom prolazu. */
  logged_now?: bigint | number;
}

interface LedgerPageRow {
  page_rows: bigint | number;
  eligible: bigint | number;
  inserted: bigint | number;
  updated: bigint | number;
  blocked_locked: bigint | number;
  logged_now: bigint | number;
  max_key: bigint | number;
}

const n = (v: bigint | number | null | undefined): number => Number(v ?? 0);

@Injectable()
export class BigbitMdbImportService {
  private readonly logger = new Logger(BigbitMdbImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Uvezi najnoviji stagovan drop.
   *
   * @param opts.dropId    konkretan drop (default: najnoviji sa `stage_status='LOADED'`)
   * @param opts.force     uvezi i drop koji je već `import_status='DONE'`
   * @param opts.skipFreshnessCheck  SAMO za ručno vraćanje istorije; noćni posao ga NIKAD ne šalje
   * @param opts.maxAgeHours override praga svežine (ručno pokretanje)
   */
  async runImport(
    opts: {
      dropId?: number;
      force?: boolean;
      skipFreshnessCheck?: boolean;
      maxAgeHours?: number;
    } = {},
  ): Promise<MdbImportResult> {
    const startedAt = Date.now();
    const empty = {
      dropId: null,
      fileName: null,
      fileMtime: null,
      fileSizeBytes: null,
      dropAgeHours: null,
      steps: [],
      vanished: { journalEntries: 0, ledgerEntries: 0 },
    };

    // ── PREKIDAČ ────────────────────────────────────────────────────────────
    // Provera je i u scheduler-u (jedna kapija za sve poslove), ali stoji i ovde
    // NAMERNO: ovo je metoda koja stvarno piše u glavnu knjigu i nijedan budući
    // ulaz (test, skripta, novi kontroler) ne sme da je zaobiđe.
    if (!(await this.isEnabled())) {
      return {
        ...empty,
        status: "DISABLED",
        durationMs: Date.now() - startedAt,
        summary: `${switchDisabledReason(BIGBIT_MDB_SYNC_SWITCH)} Ništa nije uvezeno.`,
      };
    }

    const drop = await this.prisma.bbMdbDrop.findFirst({
      where: opts.dropId ? { id: opts.dropId } : { stageStatus: "LOADED" },
      orderBy: opts.dropId ? undefined : { fileMtime: "desc" },
    });

    // ── SVEŽINA (zahtev 2): tišina je najgori ishod ────────────────────────
    if (!drop) {
      throw new BigbitMdbDropStaleError(
        "Podaci iz BigBita nisu stigli — nema nijednog učitanog fajla. Uvoz je zaustavljen " +
          "da 4.0 ne bi računao PDV nad starim podacima. Problem je u dostavi iz BigBita, ne u 4.0. " +
          "[tehnički: `bb_mdb_drops` nema red sa stage_status='LOADED'; proveri systemd timer " +
          "`bigbit-mdb-export.timer` na ubuntusrv i folder /srv/bigbit-incoming/ — " +
          "docs/migration/BIGBIT_NOCNI_SYNC.md §Kad padne]",
      );
    }
    if (drop.stageStatus !== "LOADED") {
      throw new BigbitMdbDropStaleError(
        `Priprema podataka iz BigBita nije uspela — fajl "${drop.fileName}" nije učitan. ` +
          `Javite osobi zaduženoj za BigBit izvoz. ` +
          `[tehnički: stage_status=${drop.stageStatus}; greška koraka 1: ${drop.stageError ?? "(nije zabeležena)"}]`,
      );
    }

    const ageHours = (Date.now() - drop.fileMtime.getTime()) / (1000 * 60 * 60);
    const maxAge = opts.maxAgeHours ?? MAX_DROP_AGE_HOURS;
    if (!opts.skipFreshnessCheck && ageHours > maxAge) {
      throw new BigbitMdbDropStaleError(
        `Podaci iz BigBita nisu stigli od ${drop.fileMtime.toISOString().slice(0, 16).replace("T", " ")} ` +
          `(fajl "${drop.fileName}" je star ${ageHours.toFixed(1)} h, dozvoljeno je ${maxAge} h). ` +
          "Uvoz je zaustavljen da se PDV ne bi računao nad starim podacima. " +
          "Noćni izvoz iz BigBita ne radi — javite osobi zaduženoj za BigBit; kvar NIJE u 4.0. " +
          "[tehnički: docs/migration/BIGBIT_NOCNI_SYNC.md §Kad padne]",
      );
    }

    // LAŽNA SVEŽINA: `mtime` se pomeri i pukim `cp`-jem ili ponovnom isporukom
    // ISTOG fajla, pa bi dvonedeljni sadržaj izgledao „star 0,2 h" — tačno kvar
    // od koga brana svežine brani, samo maskiran. sha256 je do sada bio samo
    // upisan i nikad poređen.
    if (!opts.skipFreshnessCheck && drop.fileSha256) {
      const twin = await this.prisma.bbMdbDrop.findFirst({
        where: {
          id: { not: drop.id },
          fileSha256: drop.fileSha256,
          importStatus: "DONE",
        },
        orderBy: { importedAt: "desc" },
      });
      if (twin) {
        throw new BigbitMdbDropStaleError(
          `BigBit je ponovo isporučio ISTI fajl — sadržaj "${drop.fileName}" je bajt-u-bajt jednak ` +
            `fajlu "${twin.fileName}" koji je već uvezen ${twin.importedAt?.toISOString() ?? "?"}. ` +
            "Datum fajla je nov, ali podaci nisu — noćni izvoz iz BigBita verovatno ne radi, samo " +
            "prekopira staru kopiju. Javite osobi zaduženoj za BigBit. " +
            `[tehnički: sha256 ${drop.fileSha256.slice(0, 12)}… identičan drop-u ${twin.id}]`,
        );
      }
    }

    const common = {
      dropId: drop.id,
      fileName: drop.fileName,
      fileMtime: drop.fileMtime,
      fileSizeBytes: drop.fileSize.toString(),
      dropAgeHours: Number(ageHours.toFixed(1)),
    };

    if (drop.importStatus === "DONE" && !opts.force) {
      return {
        ...common,
        status: "SKIPPED",
        steps: [],
        vanished: { journalEntries: 0, ledgerEntries: 0 },
        durationMs: Date.now() - startedAt,
        summary:
          `drop ${drop.id} (${drop.fileName}) je već uvezen ` +
          `${drop.importedAt?.toISOString() ?? "?"} — ništa novo. ` +
          "Novi drop stiže sledećom noćnom dostavom.",
      };
    }

    // ── MUTEX (atomski CAS) ─────────────────────────────────────────────────
    // Scheduler-ov guard hvata samo RUNNING mlađi od 10 min; uvoz pune glavne
    // knjige to prelazi, pa su dva uvoza mogla da pišu jedan preko drugog.
    if (!(await this.claimDrop(drop.id))) {
      return {
        ...common,
        status: "BUSY",
        steps: [],
        vanished: { journalEntries: 0, ledgerEntries: 0 },
        durationMs: Date.now() - startedAt,
        summary:
          `uvoz drop-a ${drop.id} (${drop.fileName}) je VEĆ U TOKU (pokrenut ` +
          `${drop.importStartedAt?.toISOString() ?? "?"}) — ovo pokretanje ništa nije radilo. ` +
          "Sačekajte da se prvi završi.",
      };
    }

    const steps: MdbStepResult[] = [];
    let vanished = { journalEntries: 0, ledgerEntries: 0 };
    try {
      // ── PRAZAN IZVOZ NIJE USPEH ──────────────────────────────────────────
      // Polovično prekopiran 375 MB Access fajl daje ISPRAVNO zaglavlje i manje
      // redova; bez ove brane drop bi prošao kao DONE i nikad se ne bi ponovio.
      await this.assertStagingNotEmpty(drop.id);

      // Redosled je OBAVEZAN (zahtev 4 + FK lanac):
      //   accounts -> order_types -> saldakonto -> journal_entries -> ledger_entries
      steps.push(await this.importAccounts(drop.id));
      steps.push(await this.importOrderTypes(drop.id));
      steps.push(await this.importSaldakontoAccounts(drop.id));
      steps.push(await this.importJournalEntries(drop.id));
      steps.push(await this.importLedgerEntries(drop.id));
      // ZAKLJUČAVANJE IDE POSLEDNJE (ispravka posle drugog kruga pregleda 28.07.):
      // dok se BigBit-ova zastavica primenjivala u koraku zaglavlja, korak stavki je
      // isti nalog zaticao kao LOCKED i odbijao iznose IZ ISTOG FAJLA koji ga je
      // zaključao — zaglavlje preuzeto, iznosi stari. Sada stavke prvo uđu.
      steps.push(await this.applyBigbitLocks(drop.id));

      // ── NESTALO IZ BIGBITA ───────────────────────────────────────────────
      // Uvoz je čist upsert i NIKAD ne briše, pa nalog obrisan/prekontiran u
      // BigBitu zauvek ostaje u 4.0 i tiho diže PDV osnovicu. Ne brišemo
      // automatski (to je knjigovodstvena odluka) — ali se GLASNO broji.
      vanished = await this.countVanished(drop.id);

      // ── SUDAR BROJA NALOGA = KVAR, NE FUSNOTA ────────────────────────────
      // Preskočen nalog povuče i sve svoje GK stavke (JOIN po bb_nalog_id), pa
      // ceo dokument sa svojom PDV osnovicom nikad ne uđe. Ranije je to bio broj
      // u jednoj log liniji uz status DONE.
      const je = steps.find((s) => s.entity === "journal_entries");
      if (je && je.skipped > 0) {
        throw new BigbitMdbConflictError(
          `${je.skipped} BigBit nalog(a) NIJE moglo da uđe u 4.0 jer isti broj naloga ` +
            `(firma, vrsta, godina, broj) već drži nalog nastao u 4.0. Sa svakim takvim nalogom ` +
            "otpadaju i sve njegove stavke glavne knjige, pa poređenje PDV obračuna promašuje " +
            `baš tu razliku. Sudari: ${je.notes.filter((x) => x.startsWith("sudar:")).join(" | ") || "(vidi bb_mdb_drops.import_row_counts)"}. ` +
            "Rešenje: u 4.0 ne knjižiti u vrste naloga i godine koje vodi BigBit, ili preknjižiti " +
            "sporni 4.0 nalog na slobodan broj. [tehnički: uq_journal_entries_number]",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.bbMdbDrop.update({
        where: { id: drop.id },
        data: {
          importStatus: "FAILED",
          importStartedAt: null,
          importError: message.slice(0, 4000),
          importRowCounts: steps as unknown as Prisma.InputJsonValue,
          importDurationMs: Date.now() - startedAt,
        },
      });
      await this.recordFailure(drop, message);
      throw err;
    }

    const durationMs = Date.now() - startedAt;
    await this.prisma.bbMdbDrop.update({
      where: { id: drop.id },
      data: {
        importStatus: "DONE",
        importStartedAt: null,
        importedAt: new Date(),
        importDurationMs: durationMs,
        importRowCounts: {
          steps,
          vanished,
        } as unknown as Prisma.InputJsonValue,
        importError: null,
      },
    });

    const summary = this.describe(
      drop.fileName,
      ageHours,
      steps,
      vanished,
      durationMs,
    );
    // HEARTBEAT za ekran Podešavanja → Integracije. Bez ovog reda kartica doveka
    // piše „Još nije bilo uvoza" i kad uvoz uredno radi svake noći.
    await this.recordSuccess(drop, steps, summary);

    return {
      ...common,
      status: "DONE",
      steps,
      vanished,
      durationMs,
      summary,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PREKIDAČ / MUTEX / HEARTBEAT
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Prekidač iz Podešavanja. NEMA reda = UKLJUČENO (OFF-prekidač; odsustvo reda
   * ne sme tiho da ugasi noćni uvoz). Greška u čitanju se LOGUJE i takođe pušta
   * posao dalje — nedostupnost prekidača ne sme da bude razlog izostanka uvoza.
   */
  private async isEnabled(): Promise<boolean> {
    try {
      const row = await this.prisma.appSwitch.findUnique({
        where: { key: BIGBIT_MDB_SYNC_SWITCH },
      });
      return row ? row.enabled : true;
    } catch (e) {
      // Ranije je ovo bio nemi `catch { return true }` — gutao je i preimenovanu
      // kolonu, i uskraćen GRANT, i prekid konekcije. Prekidač koji ne radi mora
      // bar da ostavi trag.
      this.logger.error(
        `Prekidač „${BIGBIT_MDB_SYNC_SWITCH}" se ne može pročitati (uvoz se NASTAVLJA): ` +
          (e instanceof Error ? e.message : String(e)),
      );
      return true;
    }
  }

  /** Atomski claim drop-a. `false` = drugi uvoz ga već drži. */
  private async claimDrop(dropId: number): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<{ id: number }[]>`
      UPDATE bb_mdb_drops
         SET import_started_at = now()
       WHERE id = ${dropId}
         AND (import_started_at IS NULL
              -- ::int je OBAVEZAN: Prisma parametar stiže kao bigint, a
              -- make_interval(hours => bigint) ne postoji (42883).
              OR import_started_at < now() - make_interval(hours => ${IMPORT_LOCK_STALE_HOURS}::int))
      RETURNING id`;
    return rows.length > 0;
  }

  /** `bb_sync_state` heartbeat posle uspešnog uvoza (ugovor sa ekranom, stavka B). */
  private async recordSuccess(
    drop: { fileName: string; fileMtime: Date },
    steps: MdbStepResult[],
    summary: string,
  ): Promise<void> {
    const rowsImported = steps.reduce((a, s) => a + s.inserted + s.updated, 0);
    const cursor = {
      sourceFile: drop.fileName,
      // ISO sa zonom; ekran iz ovoga računa STAROST IZVORNOG FAJLA — jedina
      // zaštita od „uvoz uredno radi svake noći nad bajatim fajlom".
      sourceFileModifiedAt: drop.fileMtime.toISOString(),
      rowsImported,
      lastSummary: summary.slice(0, 500),
    };
    // Namerno kroz Prisma (`new Date()`), NIKAD kroz SQL `now()`: kolona je
    // legacy `Timestamp(6)` BEZ zone, pa bi `now()` na serveru u Europe/Belgrade
    // upisao vrednost 2 h u budućnosti i pragovi zastarelosti bi kasnili.
    await this.prisma.bbSyncState
      .upsert({
        where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
        create: {
          entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
          cursor,
          lastSuccessAt: new Date(),
          lastAttemptAt: new Date(),
          lastErrorMessage: null,
        },
        update: {
          cursor,
          lastSuccessAt: new Date(),
          lastAttemptAt: new Date(),
          lastErrorMessage: null,
        },
      })
      .catch((e: unknown) => {
        // Heartbeat je prikaz, ne podatak — njegov pad ne sme da poništi uvoz.
        this.logger.error(
          `bb_sync_state heartbeat nije upisan: ${e instanceof Error ? e.message : String(e)}`,
        );
      });
  }

  /** Trag o padu — da ekran ume da kaže i „poslednji pokušaj je pao, evo zašto". */
  private async recordFailure(
    drop: { fileName: string; fileMtime: Date },
    message: string,
  ): Promise<void> {
    await this.prisma.bbSyncState
      .upsert({
        where: { entity: BIGBIT_MDB_SYNC_STATE_ENTITY },
        create: {
          entity: BIGBIT_MDB_SYNC_STATE_ENTITY,
          cursor: {
            sourceFile: drop.fileName,
            sourceFileModifiedAt: drop.fileMtime.toISOString(),
          },
          lastAttemptAt: new Date(),
          lastErrorMessage: message.slice(0, 2000),
        },
        update: {
          lastAttemptAt: new Date(),
          lastErrorMessage: message.slice(0, 2000),
        },
      })
      .catch(() => undefined);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // BRANE I KONTROLE
  // ───────────────────────────────────────────────────────────────────────────

  /** Prazan/polovičan izvoz mora da PADNE, ne da se upiše kao uspeh sa nula redova. */
  private async assertStagingNotEmpty(dropId: number): Promise<void> {
    const [gk, nalozi, konta] = await Promise.all([
      this.prisma.bbMdbStageGk.count({ where: { dropId } }),
      this.prisma.bbMdbStageNalog.count({ where: { dropId } }),
      this.prisma.bbMdbStageAccount.count({ where: { dropId } }),
    ]);
    if (gk > 0 && nalozi > 0 && konta > 0) return;
    throw new BigbitMdbDropStaleError(
      "Fajl iz BigBita je prazan ili nepotpun — nema šta da se uveze " +
        `(glavna knjiga ${gk} redova, nalozi ${nalozi}, kontni plan ${konta}). ` +
        "Najčešći uzrok: kopiranje .mdb fajla nije bilo završeno kad je izvoz krenuo. " +
        "Uvoz je zaustavljen; sledeća noćna dostava se pokušava normalno. " +
        "Ako se ponovi, javite osobi zaduženoj za BigBit izvoz.",
    );
  }

  /**
   * Koliko RANIJE uvezenih redova ovaj drop VIŠE NE SADRŽI.
   *
   * Napomena o dosegu: poređenje ima smisla samo dok drop nosi CELU istoriju koju
   * je 4.0 uvezao (danas jeste — `T_Glavna knjiga` ide u celini). Ako se ikad
   * pređe na isporuku po periodu, ovaj brojač treba suziti na taj period.
   */
  private async countVanished(
    dropId: number,
  ): Promise<{ journalEntries: number; ledgerEntries: number }> {
    const [je] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      WITH seen AS (
        SELECT id_naloga::int AS id FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId} AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
      )
      SELECT count(*) AS c FROM journal_entries j
      WHERE j.bb_nalog_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.id = j.bb_nalog_id)`;
    const [le] = await this.prisma.$queryRaw<{ c: bigint }[]>`
      WITH seen AS (
        SELECT stavka_id::int AS id FROM bb_mdb_stage_gk
        WHERE drop_id = ${dropId} AND btrim(coalesce(stavka_id, '')) ~ '^[0-9]+$'
      )
      SELECT count(*) AS c FROM ledger_entries l
      WHERE l.bb_stavka_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM seen WHERE seen.id = l.bb_stavka_id)`;
    return { journalEntries: n(je?.c), ledgerEntries: n(le?.c) };
  }

  private describe(
    fileName: string,
    ageHours: number,
    steps: MdbStepResult[],
    vanished: { journalEntries: number; ledgerEntries: number },
    durationMs: number,
  ): string {
    const parts = steps.map(
      (s) =>
        `${s.entity} +${s.inserted}/~${s.updated}/=${s.unchanged}` +
        (s.skipped ? `/preskočeno ${s.skipped}` : "") +
        (s.filtered ? `/odbačeno ${s.filtered}` : "") +
        (s.blockedLocked ? `/zaključano ${s.blockedLocked}` : ""),
    );
    const locked = steps.reduce((a, s) => a + s.blockedLocked, 0);
    const lockedNote = locked
      ? ` ⚠ ${locked} izmena iz BigBita nad ZAKLJUČANIM nalozima NIJE preuzeta — čeka odluku ` +
        "(bb_import_rejected_changes)"
      : "";
    const van =
      vanished.journalEntries + vanished.ledgerEntries > 0
        ? ` ⚠ nestalo iz BigBita: ${vanished.journalEntries} nalog(a) / ${vanished.ledgerEntries} stavki (ostaju u 4.0 — proveri)`
        : "";
    return (
      `${fileName} (star ${ageHours.toFixed(1)} h) za ${(durationMs / 1000).toFixed(1)} s — ` +
      parts.join("; ") +
      " [novi/izmenjeni/nepromenjeni]" +
      lockedNote +
      van
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // KORACI
  // ───────────────────────────────────────────────────────────────────────────

  /** `Kontni plan` -> `accounts`. FK meta za `ledger_entries.account_code`. */
  private async importAccounts(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(konto))
          btrim(konto)                                    AS code,
          left(coalesce(btrim(opis), ''), 255)            AS name,
          nullif(btrim(coalesce(dugacki_opis, '')), '')   AS long_description,
          -- accountClass = prva cifra. Nenumeričke šifre POSTOJE ('02101-1',
          -- '02206C') ali sve počinju cifrom; ako se to ikad promeni, klasa 0 je
          -- bezbedan pad (kolona je NOT NULL, red ne sme da propadne).
          CASE WHEN btrim(konto) ~ '^[0-9]' THEN left(btrim(konto), 1)::int ELSE 0 END AS account_class,
          (btrim(coalesce(dozvoljen_unos_analitike, '0')) = '1') AS allows_analytics,
          left(nullif(btrim(coalesce(fajl_sifara, '')), ''), 64) AS codebook_file,
          left(nullif(btrim(coalesce(ino_konto, '')), ''), 10)   AS foreign_account
        FROM bb_mdb_stage_kontni_plan
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(konto, '')), '') IS NOT NULL
          -- IDENTITETSKE KOLONE SE NE SKRAĆUJU: 'accounts.code' je VARCHAR(10) i
          -- 'left()' bi tiho spojio dva različita konta u jedan red. Predugačak
          -- konto se ODBACUJE i broji u 'filtered'.
          AND length(btrim(konto)) <= 10
        ORDER BY btrim(konto)
      ),
      ins AS (
        INSERT INTO accounts (code, name, long_description, account_class,
                              allows_analytics, codebook_file, foreign_account,
                              imported_drop_id, created_at, updated_at)
        SELECT code, name, long_description, account_class,
               allows_analytics, codebook_file, foreign_account,
               ${dropId}, now(), now()
        FROM src
        ON CONFLICT (code) DO UPDATE SET
          name             = EXCLUDED.name,
          long_description = EXCLUDED.long_description,
          account_class    = EXCLUDED.account_class,
          allows_analytics = EXCLUDED.allows_analytics,
          codebook_file    = EXCLUDED.codebook_file,
          foreign_account  = EXCLUDED.foreign_account,
          updated_at       = now()
        -- 'imported_drop_id' NIJE u poređenju (menja se svake noći i prepisao bi
        -- sve). Zadržava vrednost PRVOG drop-a koji je red doneo.
        WHERE (accounts.name, accounts.long_description, accounts.account_class,
               accounts.allows_analytics, accounts.codebook_file,
               accounts.foreign_account)
          IS DISTINCT FROM
              (EXCLUDED.name, EXCLUDED.long_description, EXCLUDED.account_class,
               EXCLUDED.allows_analytics, EXCLUDED.codebook_file,
               EXCLUDED.foreign_account)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_kontni_plan WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("accounts", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} red(ova) kontnog plana odbačeno — prazan konto, duplikat konta ili konto duži od 10 znakova`,
      );
    return step;
  }

  /** `Vrsta naloga` -> `order_types`. Meta za `journal_entries.order_type_code`. */
  private async importOrderTypes(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(vrsta_naloga))
          btrim(vrsta_naloga)                                  AS code,
          left(nullif(btrim(coalesce(opis, '')), ''), 50)       AS description
        FROM bb_mdb_stage_vrsta_naloga
        WHERE drop_id = ${dropId}
          AND nullif(btrim(coalesce(vrsta_naloga, '')), '') IS NOT NULL
          -- Isti razlog kao kod konta: 'left(...,5)' bi TIHO spojio dve različite
          -- vrste naloga u jednu šifru, a time i njihove brojevne nizove — što
          -- vodi pravo u sudar broja naloga. Vrednost je već na granici (5/5).
          AND length(btrim(vrsta_naloga)) <= 5
        ORDER BY btrim(vrsta_naloga)
      ),
      ins AS (
        INSERT INTO order_types (code, description, imported_drop_id)
        SELECT code, description, ${dropId} FROM src
        ON CONFLICT (code) DO UPDATE SET
          description = EXCLUDED.description
        WHERE (order_types.description) IS DISTINCT FROM (EXCLUDED.description)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_vrsta_naloga WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             0::bigint                                       AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("order_types", row, t0, notes);
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} vrsta naloga odbačena — prazna, duplikat ili šifra duža od 5 znakova`,
      );
    return step;
  }

  /**
   * `PSF_AnalitickaKonta_T` -> `saldakonto_accounts`.
   *
   * OPREZ: ovu tabelu je već ručno seed-ovala migracija
   * 20260726100000_seed_saldakonto_i_seme_kontiranja, i tamo su `side`,
   * `partner_scope` i `control_account` DONETE ODLUKE koje BigBit uopšte ne zna
   * (npr. primljeni avansi 4300/4302 su `payable` ali KUPČEVI). Zato uvoz na
   * postojećem redu dira SAMO tri zastavice koje BigBit stvarno nosi.
   */
  private async importSaldakontoAccounts(
    dropId: number,
  ): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [
      "na postojećim redovima menja samo DinSaldo/DevSaldo/OTST — side, partner_scope i control_account su 4.0 odluke i ne prepisuju se",
    ];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (btrim(s.konto))
          btrim(s.konto)                                AS account,
          CASE WHEN left(btrim(s.konto), 1) = '4' THEN 'payable' ELSE 'receivable' END AS side,
          left(btrim(s.konto), 3)                       AS control_account,
          (btrim(coalesce(s.otst, '0')) = '1')          AS tracks_open_items,
          (btrim(coalesce(s.din_saldo, '0')) = '1')     AS holds_din_balance,
          (btrim(coalesce(s.dev_saldo, '0')) = '1')     AS holds_fx_balance
        FROM bb_mdb_stage_psf_konta s
        JOIN accounts a ON a.code = btrim(s.konto)
        WHERE s.drop_id = ${dropId}
        ORDER BY btrim(s.konto)
      ),
      ins AS (
        INSERT INTO saldakonto_accounts (account, side, control_account,
                                         tracks_open_items, holds_din_balance,
                                         holds_fx_balance, imported_drop_id)
        SELECT account, side, control_account, tracks_open_items,
               holds_din_balance, holds_fx_balance, ${dropId}
        FROM src
        ON CONFLICT (account) DO UPDATE SET
          tracks_open_items = EXCLUDED.tracks_open_items,
          holds_din_balance = EXCLUDED.holds_din_balance,
          holds_fx_balance  = EXCLUDED.holds_fx_balance
        WHERE (saldakonto_accounts.tracks_open_items, saldakonto_accounts.holds_din_balance,
               saldakonto_accounts.holds_fx_balance)
          IS DISTINCT FROM
              (EXCLUDED.tracks_open_items, EXCLUDED.holds_din_balance,
               EXCLUDED.holds_fx_balance)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_psf_konta WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             (SELECT count(*) FROM bb_mdb_stage_psf_konta p
                WHERE p.drop_id = ${dropId}
                  AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.code = btrim(p.konto)))::bigint AS skipped,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("saldakonto_accounts", row, t0, notes, true);
    if (step.skipped > 0)
      step.notes.push(
        `${step.skipped} saldakonto konto(a) nema svoj red u kontnom planu — preskočeno (FK fk_saldakonto_account)`,
      );
    return step;
  }

  /**
   * `T_Nalozi` -> `journal_entries` (zaglavlja). Ključ idempotencije = `bb_nalog_id`.
   *
   * STATUS: sve uvezeno je već proknjiženo u BigBitu, pa ulazi kao `POSTED`;
   * `Zakljucano=1` -> `LOCKED`. Nikad `DRAFT` — uvezen nalog se u 4.0 ne edituje.
   *
   * NEBALANSIRANI NALOZI (13 od 1.126 u snimku 11.07., ukupna razlika 0,10 RSD —
   * sve zaokruženja): uvoz ide SIROVIM SQL-om, ne kroz servis knjiženja, pa se
   * `LedgerNotBalancedException` uopšte ne okida. To je namerno — cilj je VERNA
   * KOPIJA BigBita radi poređenja, a ne prekontiranje istorije.
   */
  private async importJournalEntries(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (id_naloga::int)
          id_naloga::int                                        AS bb_nalog_id,
          btrim(coalesce(broj_naloga, ''))                      AS number,
          btrim(coalesce(vrsta_naloga, ''))                     AS order_type_code,
          coalesce(nullif(btrim(coalesce(godina, '')), '')::int, 0) AS year,
          coalesce(nullif(btrim(coalesce(id_firma, '')), '')::int, 0) AS company_id,
          (nullif(btrim(coalesce(datum_naloga, '')), '')::timestamp AT TIME ZONE 'UTC')    AS document_date,
          (nullif(btrim(coalesce(datum_knjizenja, '')), '')::timestamp AT TIME ZONE 'UTC') AS posting_date,
          CASE WHEN btrim(coalesce(zakljucano, '0')) = '1' THEN 'LOCKED' ELSE 'POSTED' END AS status,
          left(nullif(btrim(coalesce(opis_naloga, '')), ''), 255) AS description,
          left(nullif(btrim(coalesce(potpis, '')), ''), 50)       AS signature
        FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId}
          AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
          AND nullif(btrim(coalesce(datum_naloga, '')), '') IS NOT NULL
          AND nullif(btrim(coalesce(datum_knjizenja, '')), '') IS NOT NULL
          -- identitetske kolone se NE skraćuju (vidi importAccounts)
          AND length(btrim(coalesce(broj_naloga, ''))) <= 10
          AND length(btrim(coalesce(vrsta_naloga, ''))) <= 5
        ORDER BY id_naloga::int
      ),
      -- SUDAR UNUTAR ISTOG UVOZA: dva različita IDNaloga koja se svedu na isti
      -- (firma, vrsta, godina, broj) bi oborila ceo INSERT na unique indeksu
      -- ('ON CONFLICT (bb_nalog_id)' ga ne hvata) i uvoz bi padao SVAKE noći.
      -- Zato višak izlazi u 'dupe' i broji se kao sudar, umesto da ruši posao.
      ranked AS (
        SELECT s.*, row_number() OVER (
                 PARTITION BY company_id, order_type_code, year, number
                 ORDER BY bb_nalog_id) AS rn
        FROM src s
      ),
      -- PARITET-BRANA: broj koji već drži 4.0-native (ili drugi BigBit) nalog.
      blocked AS (
        SELECT r.bb_nalog_id
        FROM ranked r
        JOIN journal_entries j
          ON j.company_id = r.company_id AND j.order_type_code = r.order_type_code
         AND j.year = r.year AND j.number = r.number
        WHERE j.bb_nalog_id IS DISTINCT FROM r.bb_nalog_id
        UNION
        SELECT bb_nalog_id FROM ranked WHERE rn > 1
      ),
      -- BRANA ZAKLJUČANIH (stavka D, nalaz V6): nalog koji je u 4.0 LOCKED nosi
      -- zaključan period — na njemu stoje predata PDV prijava i izračunat bilans.
      -- Uvoz ga NE prepisuje; razlika se zapisuje i čeka ljudsku odluku.
      --
      -- ⚠️ STATUS SE NAMERNO NE POREDI (ispravka posle drugog kruga pregleda 28.07.):
      -- 4.0 ima SOPSTVENO zaključavanje perioda (gl-write.lockOlderThan, dugme
      -- „Zaključaj starije") koje uvezene naloge prevodi POSTED→LOCKED, dok BigBit za
      -- iste naloge i dalje šalje Zakljucano=0. Dok je status bio deo poređenja, ta
      -- razlika je bila TRAJNA: svaki takav nalog se SVAKE noći brojao kao „odbijena
      -- izmena" (mereno: 3/3, tj. 100% naloga u zaključanom periodu) i TRAJNO ispadao
      -- iz upsert-a, a dnevnik se punio redovima koje niko ne može da reši. Stvarna
      -- izmena bi se u toj buci izgubila. Status se ovde i ne sme preuzeti: 4.0
      -- zaključavanje je jače i BigBit ga ne sme skinuti (vidi CASE u DO UPDATE).
      locked AS (
        SELECT r.bb_nalog_id, j.id AS target_id,
               to_jsonb(j) - 'created_at' - 'updated_at' AS old_value,
               to_jsonb(r) - 'rn'                        AS new_value
        FROM ranked r
        JOIN journal_entries j ON j.bb_nalog_id = r.bb_nalog_id
        WHERE upper(j.status) = 'LOCKED'
          AND (j.number, j.order_type_code, j.year, j.company_id, j.document_date,
               j.posting_date, j.description, j.signature)
            IS DISTINCT FROM
              (r.number, r.order_type_code, r.year, r.company_id, r.document_date,
               r.posting_date, r.description, r.signature)
      ),
      -- Dnevnik odbijenih izmena. NOT EXISTS drži TAČNO JEDAN nerešen red po
      -- nalogu — inače bi svaka noć dodavala novi duplikat istog problema.
      logged AS (
        INSERT INTO bb_import_rejected_changes
          (drop_id, entity, bb_nalog_id, target_id, reason, old_value, new_value)
        SELECT ${dropId}, 'journal_entries', l.bb_nalog_id, l.target_id,
               'LOCKED_ENTRY', l.old_value, l.new_value
        FROM locked l
        WHERE NOT EXISTS (
          SELECT 1 FROM bb_import_rejected_changes x
           WHERE x.resolved_at IS NULL
             AND x.reason = 'LOCKED_ENTRY'
             AND x.entity = 'journal_entries'
             AND x.bb_nalog_id = l.bb_nalog_id)
        RETURNING 1
      ),
      ins AS (
        INSERT INTO journal_entries (bb_nalog_id, number, order_type_code, year, company_id,
                                     document_date, posting_date, status, description,
                                     signature, imported_drop_id, created_at, updated_at)
        SELECT bb_nalog_id, number, order_type_code, year, company_id,
               document_date, posting_date, status, description,
               signature, ${dropId}, now(), now()
        FROM ranked
        WHERE bb_nalog_id NOT IN (SELECT bb_nalog_id FROM blocked)
          AND bb_nalog_id NOT IN (SELECT bb_nalog_id FROM locked)
        ON CONFLICT (bb_nalog_id) DO UPDATE SET
          number           = EXCLUDED.number,
          order_type_code  = EXCLUDED.order_type_code,
          year             = EXCLUDED.year,
          company_id       = EXCLUDED.company_id,
          document_date    = EXCLUDED.document_date,
          posting_date     = EXCLUDED.posting_date,
          -- STATUS SE OVDE NE MENJA. Dva razloga, oba mereno:
          --  1) BigBit ne sme da SKINE 4.0 zaključavanje (lockOlderThan) — inače bi
          --     noćni uvoz tiho otključavao periode za koje je predata PDV prijava;
          --  2) ni da ga POSTAVI u ovom koraku: korak stavki ide POSLE ovog i status
          --     bi zatekao kao LOCKED, pa bi odbio iznose IZ ISTOG FAJLA koji je taj
          --     nalog i zaključao (mereno: zaglavlje preuzeto, iznos ostao stari).
          -- Zaključavanje po BigBit-ovoj zastavici radi poseban korak NA KRAJU uvoza
          -- (applyBigbitLocks), kad su stavke već unutra.
          status           = journal_entries.status,
          description      = EXCLUDED.description,
          signature        = EXCLUDED.signature,
          updated_at       = now()
        WHERE (journal_entries.number, journal_entries.order_type_code, journal_entries.year,
               journal_entries.company_id, journal_entries.document_date,
               journal_entries.posting_date,
               journal_entries.description, journal_entries.signature)
          IS DISTINCT FROM
              (EXCLUDED.number, EXCLUDED.order_type_code, EXCLUDED.year,
               EXCLUDED.company_id, EXCLUDED.document_date,
               EXCLUDED.posting_date,
               EXCLUDED.description, EXCLUDED.signature)
        RETURNING (xmax = 0) AS was_insert
      )
      SELECT (SELECT count(*) FROM bb_mdb_stage_nalozi WHERE drop_id = ${dropId}) AS staged,
             (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
             (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
             (SELECT count(*) FROM blocked)                  AS skipped,
             (SELECT count(*) FROM locked)                   AS blocked_locked,
             (SELECT count(*) FROM logged)                   AS logged_now,
             (SELECT count(*) FROM src)                      AS fetched`;
    const step = this.toStep("journal_entries", row, t0, notes);
    if (step.blockedLocked > 0)
      step.notes.push(
        `${step.blockedLocked} nalog(a) je izmenjen u BigBitu, ali je u 4.0 ZAKLJUČAN — izmena NIJE ` +
          `preuzeta (na zaključanom periodu stoje predata PDV prijava i izračunat bilans). ` +
          `Novo zapisano za odluku: ${n(row?.logged_now)}. Pregled i odjava: tabela ` +
          "bb_import_rejected_changes (reason='LOCKED_ENTRY', resolved_at IS NULL).",
      );

    if (step.filtered > 0) {
      // Razlog se traži SAMO kad nešto stvarno otpadne (retko) — nije na vrelom putu.
      const [why] = await this.prisma.$queryRaw<
        { no_id: bigint; no_date: bigint; too_long: bigint; dupe_id: bigint }[]
      >`
        SELECT
          count(*) FILTER (WHERE btrim(coalesce(id_naloga, '')) !~ '^[0-9]+$') AS no_id,
          count(*) FILTER (WHERE nullif(btrim(coalesce(datum_naloga, '')), '') IS NULL
                              OR nullif(btrim(coalesce(datum_knjizenja, '')), '') IS NULL) AS no_date,
          count(*) FILTER (WHERE length(btrim(coalesce(broj_naloga, ''))) > 10
                              OR length(btrim(coalesce(vrsta_naloga, ''))) > 5) AS too_long,
          (count(*) FILTER (WHERE btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$')
             - count(DISTINCT id_naloga::int) FILTER (WHERE btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$')) AS dupe_id
        FROM bb_mdb_stage_nalozi WHERE drop_id = ${dropId}`;
      step.notes.push(
        `${step.filtered} nalog(a) ODBAČENO iz izvora — bez IDNaloga: ${n(why?.no_id)}, ` +
          `bez datuma naloga/knjiženja: ${n(why?.no_date)}, predugačak broj/vrsta: ${n(why?.too_long)}, ` +
          `duplikat IDNaloga: ${n(why?.dupe_id)}. Ti dokumenti NISU u 4.0 i njihove GK stavke otpadaju.`,
      );
    }

    if (step.skipped > 0) {
      const examples = await this.prisma.$queryRaw<
        { number: string; order_type_code: string; year: number }[]
      >`
        SELECT DISTINCT btrim(coalesce(s.broj_naloga, '')) AS number,
               btrim(coalesce(s.vrsta_naloga, '')) AS order_type_code,
               coalesce(nullif(btrim(coalesce(s.godina, '')), '')::int, 0) AS year
        FROM bb_mdb_stage_nalozi s
        JOIN journal_entries j
          ON j.company_id = coalesce(nullif(btrim(coalesce(s.id_firma, '')), '')::int, 0)
         AND j.order_type_code = btrim(coalesce(s.vrsta_naloga, ''))
         AND j.year = coalesce(nullif(btrim(coalesce(s.godina, '')), '')::int, 0)
         AND j.number = btrim(coalesce(s.broj_naloga, ''))
        WHERE s.drop_id = ${dropId}
          AND j.bb_nalog_id IS DISTINCT FROM nullif(btrim(coalesce(s.id_naloga, '')), '')::int
        LIMIT 10`;
      for (const e of examples)
        step.notes.push(
          `sudar: ${e.order_type_code}/${e.year}/${e.number} — broj već drži drugi nalog u 4.0`,
        );
    }
    return step;
  }

  /**
   * `T_Glavna knjiga` -> `ledger_entries`, U SERIJAMA (zahtev 3).
   *
   * Keyset po `StavkaID` (monoton u izvoru) — svaka serija je zaseban `INSERT`
   * i time zasebna transakcija. `OFFSET` se namerno NE koristi.
   */
  private async importLedgerEntries(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const notes: string[] = [];
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let blockedLocked = 0; // odbijene izmene nad zaključanim nalozima (stavka D)
    let loggedNow = 0; // koliko ih je PRVI put ušlo u dnevnik odluka
    let processed = 0; // redovi koji su uopšte ušli u obradu (numerički stavka_id)
    let lastKey = 0;
    let batches = 0;

    for (;;) {
      const [row] = await this.prisma.$queryRaw<LedgerPageRow[]>`
        WITH page AS (
          SELECT *
          FROM bb_mdb_stage_gk
          WHERE drop_id = ${dropId}
            AND btrim(coalesce(stavka_id, '')) ~ '^[0-9]+$'
            AND stavka_id::int > ${lastKey}
          ORDER BY stavka_id::int
          LIMIT ${GK_BATCH}
        ),
        src AS (
          SELECT
            p.stavka_id::int                                   AS bb_stavka_id,
            j.id                                               AS journal_entry_id,
            btrim(p.konto)                                     AS account_code,
            nullif(coalesce(nullif(btrim(coalesce(p.analiticka_sifra, '')), ''), '0')::int, 0) AS analytical_code,
            coalesce(nullif(btrim(coalesce(p.duguje, '')), ''), '0')::numeric(19,4)    AS debit,
            coalesce(nullif(btrim(coalesce(p.potrazuje, '')), ''), '0')::numeric(19,4) AS credit,
            -- DEVIZE: DevDuguje/DevPotrazuje u većini redova samo PRESLIKAVAJU
            -- dinarski iznos (DevValuta = RSD). Puniti FX iz njih bez filtera po
            -- valuti daje besmislen devizni saldo — zato NULL kad je RSD.
            CASE WHEN cur.code <> 'RSD'
                 THEN coalesce(nullif(btrim(coalesce(p.dev_duguje, '')), ''), '0')::numeric(19,4) END    AS fx_debit,
            CASE WHEN cur.code <> 'RSD'
                 THEN coalesce(nullif(btrim(coalesce(p.dev_potrazuje, '')), ''), '0')::numeric(19,4) END AS fx_credit,
            CASE WHEN cur.code <> 'RSD' THEN cur.code END      AS fx_currency,
            cur.code                                           AS currency,
            left(nullif(btrim(coalesce(p.opis_dokumenta, '')), ''), 255) AS description,
            -- Pozicija NIJE mesto troška ('0'/'drugi'/'fiskalni' = poreklo
            -- ulaznog dokumenta za PDV/KEPU), pa ide u document_origin;
            -- cost_center ostaje NULL na uvezenim redovima.
            left(nullif(btrim(coalesce(p.pozicija, '')), ''), 20)  AS document_origin,
            left(nullif(btrim(coalesce(p.broj_dokumenta, '')), ''), 30) AS document_number,
            (nullif(btrim(coalesce(p.valuta_dokumenta, '')), '')::timestamp AT TIME ZONE 'UTC') AS due_date,
            nullif(coalesce(nullif(btrim(coalesce(p.id_dok_iz_robnog, '')), ''), '0')::int, 0)  AS source_goods_doc_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_dok_iz_usluga, '')), ''), '0')::int, 0)  AS source_service_doc_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_predmet, '')), ''), '0')::int, 0)        AS source_project_id,
            nullif(coalesce(nullif(btrim(coalesce(p.id_radni_nalog, '')), ''), '0')::int, 0)    AS source_work_order_id
          FROM page p
          -- NORMALIZACIJA VALUTE: izvor ima 9 varijanti (RSD/DIN/Din/rsd/eur/EUR/usd/USD/CNY).
          CROSS JOIN LATERAL (
            SELECT CASE
                     WHEN upper(btrim(coalesce(p.dev_valuta, ''))) IN ('', 'DIN', 'RSD') THEN 'RSD'
                     WHEN length(upper(btrim(p.dev_valuta))) = 3 THEN upper(btrim(p.dev_valuta))
                     ELSE 'RSD'
                   END AS code
          ) cur
          -- Tvrdi FK-ovi: bez naloga ili bez konta red NE MOŽE da uđe.
          JOIN journal_entries j ON j.bb_nalog_id = nullif(btrim(coalesce(p.id_naloga, '')), '')::int
          JOIN accounts a        ON a.code = btrim(p.konto)
        ),
        -- BRANA ZAKLJUČANIH (stavka D, nalaz V6): stavka čiji je nalog u 4.0
        -- LOCKED se ne dira — ni izmena postojeće, ni unos nove. Blokira se SAMO
        -- ako bi stvarno nešto promenila; identičan red prolazi kao i do sada,
        -- inače bi svaka noć prijavljivala hiljade „odbijenih" nepromenjenih redova.
        --
        -- PRVI UVOZ SAMOG NALOGA JE IZUZETAK, i to nije sitnica: BigBit svoje
        -- zaključane naloge donosi kao Zakljucano=1 → 4.0 ih upisuje kao LOCKED.
        -- Bez izuzetka bi zaključan nalog dobio zaglavlje BEZ IJEDNE STAVKE (u
        -- snimku 11.07. to je 10 naloga / 46 stavki), glavna knjiga ne bi zatvarala,
        -- a dnevnik odbijenih bi se napunio „izmenama" koje niko nije napravio.
        -- Zato: nalog koji je u knjigu ušao BAŠ OVIM drop-om (imported_drop_id =
        -- dropId; upsert zaglavlja tu kolonu NE prepisuje) sme da dobije svoje stavke.
        --
        -- DRUGI IZUZETAK — POPRAVKA PREKINUTOG UVOZA (nalaz drugog kruga pregleda):
        -- uvoz stavki je STRANIČEN (svaka stranica zaseban commit), pa pad usred
        -- koraka ostavlja zaključan nalog sa DELOM stavki. Sledeći fajl je drugi
        -- drop, izuzetak iznad više ne važi, i te stavke ne bi ušle NIKAD — nalog
        -- trajno ne zatvara, a uvoz vraća DONE. Zato: NEDOSTAJUĆA stavka (le.id IS
        -- NULL) sme da uđe na nalog koji trenutno NE ZBRAJA U NULU (ili nema nijednu
        -- stavku) — takav nalog je pokvaren i BigBit je izvor istine. Nalog koji
        -- zatvara ostaje netaknut, pa dopisivanje nove stavke na ispravan zaključan
        -- nalog i dalje pada u dnevnik.
        locked AS (
          SELECT s.bb_stavka_id, j.bb_nalog_id, le.id AS target_id,
                 to_jsonb(le) - 'created_at' AS old_value,
                 to_jsonb(s)                 AS new_value
          FROM src s
          JOIN journal_entries j ON j.id = s.journal_entry_id AND upper(j.status) = 'LOCKED'
          LEFT JOIN ledger_entries le ON le.bb_stavka_id = s.bb_stavka_id
          WHERE (le.id IS NULL
                 AND j.imported_drop_id IS DISTINCT FROM ${dropId}
                 AND NOT EXISTS (
                   SELECT 1
                   FROM ledger_entries x
                   WHERE x.journal_entry_id = j.id
                   HAVING coalesce(sum(x.debit), 0) <> coalesce(sum(x.credit), 0)
                          OR count(*) = 0))
             OR (le.id IS NOT NULL
             AND (le.journal_entry_id, le.account_code, le.analytical_code, le.debit, le.credit,
                 le.fx_debit, le.fx_credit, le.fx_currency, le.currency, le.description,
                 le.document_origin, le.document_number, le.due_date, le.source_goods_doc_id,
                 le.source_service_doc_id, le.source_project_id, le.source_work_order_id)
               IS DISTINCT FROM
                (s.journal_entry_id, s.account_code, s.analytical_code, s.debit, s.credit,
                 s.fx_debit, s.fx_credit, s.fx_currency, s.currency, s.description,
                 s.document_origin, s.document_number, s.due_date, s.source_goods_doc_id,
                 s.source_service_doc_id, s.source_project_id, s.source_work_order_id))
        ),
        logged AS (
          INSERT INTO bb_import_rejected_changes
            (drop_id, entity, bb_nalog_id, bb_stavka_id, target_id, reason, old_value, new_value)
          SELECT ${dropId}, 'ledger_entries', l.bb_nalog_id, l.bb_stavka_id, l.target_id,
                 'LOCKED_ENTRY', l.old_value, l.new_value
          FROM locked l
          WHERE NOT EXISTS (
            SELECT 1 FROM bb_import_rejected_changes x
             WHERE x.resolved_at IS NULL
               AND x.reason = 'LOCKED_ENTRY'
               AND x.entity = 'ledger_entries'
               AND x.bb_stavka_id = l.bb_stavka_id)
          RETURNING 1
        ),
        ins AS (
          INSERT INTO ledger_entries (bb_stavka_id, journal_entry_id, account_code, analytical_code,
                                      debit, credit, fx_debit, fx_credit, fx_currency, currency,
                                      description, document_origin, document_number, due_date,
                                      source_goods_doc_id, source_service_doc_id,
                                      source_project_id, source_work_order_id,
                                      imported_drop_id, created_at)
          SELECT bb_stavka_id, journal_entry_id, account_code, analytical_code,
                 debit, credit, fx_debit, fx_credit, fx_currency, currency,
                 description, document_origin, document_number, due_date,
                 source_goods_doc_id, source_service_doc_id,
                 source_project_id, source_work_order_id,
                 ${dropId}, now()
          FROM src
          WHERE bb_stavka_id NOT IN (SELECT bb_stavka_id FROM locked)
          ON CONFLICT (bb_stavka_id) DO UPDATE SET
            journal_entry_id      = EXCLUDED.journal_entry_id,
            account_code          = EXCLUDED.account_code,
            analytical_code       = EXCLUDED.analytical_code,
            debit                 = EXCLUDED.debit,
            credit                = EXCLUDED.credit,
            fx_debit              = EXCLUDED.fx_debit,
            fx_credit             = EXCLUDED.fx_credit,
            fx_currency           = EXCLUDED.fx_currency,
            currency              = EXCLUDED.currency,
            description           = EXCLUDED.description,
            document_origin       = EXCLUDED.document_origin,
            document_number       = EXCLUDED.document_number,
            due_date              = EXCLUDED.due_date,
            source_goods_doc_id   = EXCLUDED.source_goods_doc_id,
            source_service_doc_id = EXCLUDED.source_service_doc_id,
            source_project_id     = EXCLUDED.source_project_id,
            source_work_order_id  = EXCLUDED.source_work_order_id
          -- BEZ 'imported_drop_id' u poređenju: inače bi svaka noć „razlikovala"
          -- svih 20k+ redova i prepisala celu glavnu knjigu sa 6 indeksa.
          WHERE (ledger_entries.journal_entry_id, ledger_entries.account_code,
                 ledger_entries.analytical_code, ledger_entries.debit, ledger_entries.credit,
                 ledger_entries.fx_debit, ledger_entries.fx_credit, ledger_entries.fx_currency,
                 ledger_entries.currency, ledger_entries.description,
                 ledger_entries.document_origin, ledger_entries.document_number,
                 ledger_entries.due_date, ledger_entries.source_goods_doc_id,
                 ledger_entries.source_service_doc_id, ledger_entries.source_project_id,
                 ledger_entries.source_work_order_id)
            IS DISTINCT FROM
                (EXCLUDED.journal_entry_id, EXCLUDED.account_code,
                 EXCLUDED.analytical_code, EXCLUDED.debit, EXCLUDED.credit,
                 EXCLUDED.fx_debit, EXCLUDED.fx_credit, EXCLUDED.fx_currency,
                 EXCLUDED.currency, EXCLUDED.description,
                 EXCLUDED.document_origin, EXCLUDED.document_number,
                 EXCLUDED.due_date, EXCLUDED.source_goods_doc_id,
                 EXCLUDED.source_service_doc_id, EXCLUDED.source_project_id,
                 EXCLUDED.source_work_order_id)
          RETURNING (xmax = 0) AS was_insert
        )
        SELECT (SELECT count(*) FROM page)                     AS page_rows,
               (SELECT count(*) FROM src)                      AS eligible,
               (SELECT count(*) FROM ins WHERE was_insert)     AS inserted,
               (SELECT count(*) FROM ins WHERE NOT was_insert) AS updated,
               (SELECT count(*) FROM locked)                   AS blocked_locked,
               (SELECT count(*) FROM logged)                   AS logged_now,
               (SELECT coalesce(max(stavka_id::int), 0) FROM page) AS max_key`;

      const pageRows = n(row?.page_rows);
      const pageMax = n(row?.max_key);
      if (pageRows === 0 || pageMax <= lastKey) break;

      inserted += n(row?.inserted);
      updated += n(row?.updated);
      blockedLocked += n(row?.blocked_locked);
      loggedNow += n(row?.logged_now);
      skipped += pageRows - n(row?.eligible);
      processed += pageRows;
      lastKey = pageMax;
      batches++;
      if (batches > 10_000) {
        notes.push("prekinuto na 10.000 serija — proveri izvor");
        break;
      }
    }

    const staged = await this.prisma.bbMdbStageGk.count({ where: { dropId } });
    const step: MdbStepResult = {
      entity: "ledger_entries",
      staged,
      inserted,
      updated,
      // `unchanged` se računa nad OBRAĐENIM redovima, ne nad celim staging-om —
      // inače bi redovi koje filter nikad nije ni video ispali „nepromenjeni".
      unchanged: Math.max(
        0,
        processed - inserted - updated - skipped - blockedLocked,
      ),
      skipped,
      filtered: Math.max(0, staged - processed),
      blockedLocked,
      durationMs: Date.now() - t0,
      notes,
    };
    step.notes.push(`${batches} serija po ${GK_BATCH} redova`);
    if (blockedLocked > 0)
      step.notes.push(
        `${blockedLocked} stavki glavne knjige pripada nalogu koji je u 4.0 ZAKLJUČAN — izmena iz ` +
          `BigBita NIJE preuzeta (zaključan period nosi predatu PDV prijavu i izračunat bilans). ` +
          `Novo zapisano za odluku: ${loggedNow}. Pregled i odjava: tabela ` +
          "bb_import_rejected_changes (reason='LOCKED_ENTRY', resolved_at IS NULL).",
      );
    if (skipped > 0)
      step.notes.push(
        `${skipped} stavki preskočeno — nema nalog (bb_nalog_id) ili konto u kontnom planu`,
      );
    if (step.filtered > 0)
      step.notes.push(
        `${step.filtered} stavki ODBAČENO — StavkaID nije broj; te stavke NISU u 4.0`,
      );
    return step;
  }

  /**
   * ZAKLJUČAVANJE PO BIGBIT-OVOJ ZASTAVICI — POSLEDNJI korak uvoza.
   *
   * Zašto zaseban korak, a ne kolona u upsert-u zaglavlja (ispravka posle drugog
   * kruga nezavisnog pregleda, 28.07.2026): koraci uvoza idu redom
   * `journal_entries` → `ledger_entries`, svaki u svojoj transakciji. Dok se
   * `Zakljucano=1` primenjivao u prvom koraku, drugi korak je isti nalog zaticao kao
   * `LOCKED` i brana zaključanih je odbijala IZNOSE IZ ISTOG FAJLA koji je taj nalog
   * i zaključao. Ishod je bio najgori mogući: NOVO zaglavlje + STARI iznosi, uz zapis
   * u dnevniku o „odbijenoj izmeni" za sasvim običnu knjigovodstvenu radnju (ispravi
   * pa zaključi mesec). Mereno: BigBit šalje 777, u 4.0 ostaje 700.
   *
   * SMER JE JEDNOSMERAN: samo POSTED → LOCKED. Otključavanje se NE preuzima —
   * 4.0 ima sopstveno zaključavanje perioda (`lockOlderThan`) koje nosi predatu PDV
   * prijavu i izračunat bilans, i BigBit ga ne sme skinuti.
   */
  private async applyBigbitLocks(dropId: number): Promise<MdbStepResult> {
    const t0 = Date.now();
    const [row] = await this.prisma.$queryRaw<CountRow[]>`
      WITH src AS (
        SELECT DISTINCT ON (id_naloga::int) id_naloga::int AS bb_nalog_id
        FROM bb_mdb_stage_nalozi
        WHERE drop_id = ${dropId}
          AND btrim(coalesce(id_naloga, '')) ~ '^[0-9]+$'
          AND btrim(coalesce(zakljucano, '0')) = '1'
        ORDER BY id_naloga::int
      ),
      upd AS (
        UPDATE journal_entries j
           SET status = 'LOCKED', updated_at = now()
          FROM src s
         WHERE j.bb_nalog_id = s.bb_nalog_id
           AND upper(j.status) = 'POSTED'
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM src) AS staged,
             0                          AS inserted,
             (SELECT count(*) FROM upd) AS updated,
             0                          AS skipped,
             (SELECT count(*) FROM src) AS fetched`;
    const step = this.toStep("journal_entries_lock", row, t0, []);
    if (step.updated > 0)
      step.notes.push(
        `${step.updated} nalog(a) zaključano po BigBit-ovoj zastavici (Zakljucano=1), ` +
          "posle unosa stavki. Otključavanje se NE preuzima iz BigBita.",
      );
    return step;
  }

  /**
   * Brojači jednog koraka, tako da UVEK važi
   * `staged = inserted + updated + unchanged + skipped + filtered + blockedLocked`.
   *
   * `fetched` = redovi koji su ušli u upsert pokušaj (`src`). Dva koraka imaju
   * različit odnos `skipped` prema `src`, pa se to mora reći eksplicitno —
   * inače isti red uđe u dva brojača (ili nestane iz svih, što je i bio kvar):
   *  • `skippedOutsideSrc = false` (nalozi): sudari su PODSKUP `src`.
   *  • `skippedOutsideSrc = true`  (saldakonto): odbačeni nikad nisu ni ušli u `src`.
   */
  private toStep(
    entity: string,
    row: CountRow | undefined,
    t0: number,
    notes: string[],
    skippedOutsideSrc = false,
  ): MdbStepResult {
    const staged = n(row?.staged);
    const inserted = n(row?.inserted);
    const updated = n(row?.updated);
    const skipped = n(row?.skipped);
    const fetched = n(row?.fetched);
    // Odbijena izmena zaključanog naloga MORA da se odbije i od `unchanged` —
    // inače bi red koji se u BigBitu stvarno promenio izlazio kao „nepromenjen",
    // tj. tačno ona tišina zbog koje je brana i uvedena.
    const blockedLocked = n(row?.blocked_locked);
    const unchanged = skippedOutsideSrc
      ? fetched - inserted - updated - blockedLocked
      : fetched - inserted - updated - skipped - blockedLocked;
    const filtered = skippedOutsideSrc
      ? staged - fetched - skipped
      : staged - fetched;
    return {
      entity,
      staged,
      inserted,
      updated,
      unchanged: Math.max(0, unchanged),
      skipped,
      filtered: Math.max(0, filtered),
      blockedLocked,
      durationMs: Date.now() - t0,
      notes,
    };
  }
}
