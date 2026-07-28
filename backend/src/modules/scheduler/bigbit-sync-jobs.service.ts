import { Injectable, Logger } from "@nestjs/common";
import { SyncService } from "../sync/sync.service";
import type { ScheduledJob } from "./scheduler.types";

/*
 * PRUGA P (docs/PLAN_AI_OS_2026-07.md §5; presuda Nenada 26.07.2026: „BigBit
 * noćni sync — UKLJUČITI ODMAH, paritet-guard ostaje").
 *
 * Do sada je BigBit master-data sync bio ISKLJUČIVO ručan (POST /api/v1/sync/run,
 * `sync.run` dozvola) — ukupno 3 povlačenja (08.07, 13.07, 22.07), pa 3.0/4.0
 * moduli rade nad zastarelim šifarnicima. Ovaj posao NE PRAVI NOV PUT PODATAKA:
 * zove ISTI `SyncService.run()` koji stoji iza dugmeta, samo sa `trigger:"cron"`.
 *
 * PUT PODATAKA (nepromenjen): BigBit Access front → njegov SQL Server backend
 * (`BIGBIT_DB_*`, Vasa-SQL:5765, read-only nalog `bridge_reader`, preko firmine
 * VPN mreže) → `MssqlClient` (samo SELECT) → per-entity syncer → Postgres +
 * dnevnik `bb_sync_log` / kursori `bb_sync_state`. Nema .mdb izvoza, nema pisanja
 * ka BigBit-u (BACKEND_RULES §4.7).
 *
 * IDEMPOTENTNOST (uslov za ponavljanje svake noći):
 *  • `incremental` synceri (watermark `PoslednjaIzmena`) rade `upsert` po PK →
 *    ponovljen prolaz daje isti rezultat; kursor napreduje tek posle uspeha.
 *  • `full_refresh` synceri rade `deleteMany` + `createMany` u jednoj transakciji
 *    → tabela je determinističko ogledalo izvora, takođe ponovljivo.
 * Oba oblika su bezbedna SAMO za tabele čiji je jedini pisac BigBit sync. Zato
 * postoji `NIGHTLY_SYNC_EXCLUDED` (ispod) i zato posao NIKAD ne šalje `force`
 * (koji bi probio zaštitu ServoSync-owned tabela iz `table-ownership.ts`).
 *
 * PARITET-GUARD PREDMETA OSTAJE NETAKNUT: `projects` je u
 * `ADDITIVE_REFRESH_TABLES` (briše se samo id koji izvor vrati, pa 3.0-native
 * predmet preživi) + `ADDITIVE_DEDUP_FIELDS.projects = "projectNumber"` (BigBit
 * kopija predmeta sa brojem koji već stoji na 3.0-native redu se PRESKAČE).
 * Noćni posao ide kroz isti `GenericSyncer`, pa nasleđuje obe zaštite — pinovano
 * testom u `bigbit-sync-jobs.service.spec.ts`.
 */

/** Ključ posla u `scheduled_job_runs.job_key` — ne menjati posle uvođenja. */
export const BIGBIT_NIGHTLY_SYNC_JOB_KEY = "bigbit-nightly-sync";

/**
 * Tokovi koje noćni posao NE DIRA (ručno `/sync/run` i dalje može, uz svesnu
 * odluku čoveka i nadzor nad ishodom).
 *
 * `items` (review 26.07.2026, nalaz [1]) — PRIVREMENO. Guard za duplikate
 * kataloškog broja (DB-081, uveden 25.07) NIJE još nijednom prošao preko
 * produkcijskih podataka: prvi prolaz briše ~2.300 duplikat-grupa, a sve meke
 * reference (`price_list_entries.item_id`, `work_order_item_components`) koje
 * gađaju „gubitnički" `id` postaju siročad — pod `session_replication_role=
 * 'replica'` FK to ne zaustavlja, a takav backup se ne restore-uje čisto.
 * ČIŠĆENJE JE U TOKU (Nenad prenosi jedinstvene kataloške brojeve u BigBit); kad
 * `items` ostane bez duplikata, ovaj red se briše i tok ulazi u noćni prolaz.
 * Do tada: ručni sync artikala se pokreće NADGLEDANO, uz pre-check upit iz
 * .env.example (aktivaciona beleška uz `BIGBIT_NIGHTLY_SYNC`).
 *
 * NAPOMENA: `tax_rates` VIŠE NIJE OVDE — presudom Nenada 26.07.2026 registar PDV
 * tarifa je 4.0-owned, pa je `R_Tarife` IZBAČEN iz `sync-map.generated.ts` (i
 * ručni „sync all" ga više ne poznaje). Isključenje na nivou noćnog posla bi bilo
 * polumera: brisao bi ga svaki ručni prolaz.
 */
export const NIGHTLY_SYNC_EXCLUDED = new Set<string>(["items"]);

/**
 * Gornja granica čekanja na jedan noćni prolaz. Tik scheduler-a je SEKVENCIJALAN
 * (`tickBusy`) — zaglavljen sync bi blokirao sve ostale poslove (06:00 prisustvo
 * ima catch-up od svega 55 min i propao bi). Race prekida ČEKANJE (run → FAILED +
 * retry po postojećem mehanizmu); sam sync se u pozadini dovršava ili padne na
 * svojim MSSQL/transakcionim timeout-ima, a in-process `running` guard u
 * `SyncService` spreči da se preklopi sa sledećim pokušajem (drugi pokušaj tada
 * padne sa „A sync run is already in progress" — vidljivo u dnevniku).
 * 45 min: start 03:30 → najkasniji kraj 04:15, komotno pre prvog jutarnjeg posla.
 */
const NIGHTLY_SYNC_TIMEOUT_MS = 45 * 60_000;

/** Oblik jednog entiteta u `bb_sync_log.metadata` (piše ga `SyncService.run`). */
interface EntityMeta {
  rowsFetched?: number;
  rowsUpserted?: number;
  rowsSkipped?: number;
  note?: string;
  error?: string;
}

@Injectable()
export class BigbitSyncJobs {
  private readonly logger = new Logger(BigbitSyncJobs.name);

  constructor(private readonly sync: SyncService) {}

  /**
   * Prekidač posla — isti obrazac kao `SCHEDULER_ENABLED`: bez njega je deploy
   * koda potpuno bezbedan. Razlika je namerna: dok je `false`, posao se i NE
   * REGISTRUJE (ne vidi se u `/scheduler/jobs`, ne može ni `run-now`), jer
   * automatsko povlačenje master podataka mora da bude svesna Nenadova radnja.
   */
  get enabled(): boolean {
    return process.env.BIGBIT_NIGHTLY_SYNC === "true";
  }

  /** Svi registrovani entiteti MINUS isključeni tokovi. */
  nightlyEntities(): string[] {
    return this.sync.availableEntities.filter(
      (e) => !NIGHTLY_SYNC_EXCLUDED.has(e),
    );
  }

  buildJobs(): ScheduledJob[] {
    if (!this.enabled) {
      this.logger.log(
        "BigBit noćni sync ISKLJUČEN (BIGBIT_NIGHTLY_SYNC != 'true') — posao nije registrovan; povlačenje ostaje ručno (POST /api/v1/sync/run).",
      );
      return [];
    }
    return [
      {
        key: BIGBIT_NIGHTLY_SYNC_JOB_KEY,
        description:
          "BigBit noćni sync: master podaci (MSSQL → Postgres) svih tokova osim " +
          `isključenih (${[...NIGHTLY_SYNC_EXCLUDED].join(", ") || "—"})`,
        // 03:30 — noćni backup starta u 02:30 (backend/scripts/backup-nightly.sh,
        // cron admnenad; monitor diže alarm ako pređe 15 min), pa je u 03:30
        // sinoćnja kopija sigurno gotova: ako sync donese pokvarene podatke,
        // povratak na stanje pre njega postoji u dump-u. `retention-cleanup` deli
        // isti termin, ali je registrovan RANIJE i u istom tiku se izvršava prvi
        // (brza brisanja), pa se ne preklapaju.
        schedule: { kind: "daily", at: "03:30" },
        // Catch-up 120 min (review [8]): default 180 bi u najgorem slučaju
        // startovao pun sync tek u 06:30 — tačno kad kreću jutarnji poslovi i
        // kad ljudi ulaze u sistem. 120 min drži prozor unutar noći (do 05:30).
        catchUpMinutes: 120,
        // Zaglavljen RUNNING se preuzima tek posle 60 min (review [7]): default
        // od 10 min je kraći od normalnog trajanja ovog posla, pa bi ga sam
        // scheduler pokrenuo drugi put dok prvi još radi. 60 > 45 min koliko
        // posao uopšte čeka na sync.
        staleAfterMinutes: 60,
        // Isti razlog za ručno okidanje (review [14]) — admin ne sme da startuje
        // drugi prolaz preko prvog koji još radi.
        runNowBlockMinutes: 60,
        run: async () => this.runNightly(),
      },
    ];
  }

  /**
   * Jedan noćni prolaz. Vraća summary za `scheduled_job_runs.summary`; BACA samo
   * kad je nešto stvarno palo (vidi ispod) — tada scheduler upiše FAILED i
   * ponavlja po postojećem backoff-u (MAX_ATTEMPTS=3, 10min × attempts).
   */
  private async runNightly(): Promise<string> {
    const entities = this.nightlyEntities();
    const log = await this.withTimeout(
      // Bez `strategy` (svaki syncer bira svoju: incremental gde ima watermark,
      // inače full refresh) i bez `force` (zaštita ServoSync-owned tabela ostaje).
      this.sync.run({ entities, trigger: "cron" }),
    );

    const meta = (log.metadata ?? {}) as Record<string, EntityMeta>;
    const failed: string[] = [];
    const perEntity: string[] = [];
    for (const entity of entities) {
      const m = meta[entity];
      if (!m) {
        perEntity.push(`${entity}=?`);
        continue;
      }
      if (m.error) {
        failed.push(`${entity}: ${m.error}`);
        perEntity.push(`${entity}=GREŠKA`);
        continue;
      }
      const skipped = m.rowsSkipped ? `,presk=${m.rowsSkipped}` : "";
      perEntity.push(
        `${entity}=${m.rowsFetched ?? 0}/${m.rowsUpserted ?? 0}${skipped}`,
      );
    }

    const head =
      `sync #${log.id} ${log.status}: povučeno=${log.rowsFetched} ` +
      `upisano=${log.rowsUpserted} preskočeno=${log.rowsSkipped} ` +
      `(${entities.length} tokova, isključeno ${NIGHTLY_SYNC_EXCLUDED.size})`;

    // Pad = ili ceo run (npr. BigBit nedostupan → svaki entitet baci) ili bar
    // jedan entitet sa greškom. `partial` SAM PO SEBI nije pad: `SyncService`
    // ga postavlja i kad su redovi samo PRESKOČENI (paritet-guard predmeta,
    // duplikat kataloškog broja DB-081) — to je očekivano stanje svake noći i
    // ne sme da okida retry ni alarm.
    if (log.status === "failed" || failed.length) {
      const detail = failed.length
        ? failed.join("; ").slice(0, 800)
        : (log.errorMessage ?? "bez detalja");
      throw new Error(
        `${head} — palo ${failed.length || "sve"} tokova: ${detail}`,
      );
    }

    return `${head}; ${perEntity.join(" ")}`;
  }

  /** Race koji oslobađa scheduler tik (vidi `NIGHTLY_SYNC_TIMEOUT_MS`). */
  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `BigBit sync nije završio za ${NIGHTLY_SYNC_TIMEOUT_MS / 60_000} min — čekanje prekinuto (sync se u pozadini dovršava; sledeći pokušaj će ga zateći kao „already in progress").`,
              ),
            ),
          NIGHTLY_SYNC_TIMEOUT_MS,
        ).unref?.(),
      ),
    ]);
  }
}
